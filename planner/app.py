import os
import json
import uuid
import logging
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv
import boto3
from botocore.config import Config

# -----------------------------
# Startup & Config
# -----------------------------
load_dotenv()

REGION = os.getenv("AWS_REGION", os.getenv("BEDROCK_REGION", "eu-north-1"))
MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "eu.amazon.nova-pro-v1:0")
USE_CONVERSE = os.getenv("PLANNER_USE_CONVERSE", "1") == "1"  # default to Converse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("app")

app = FastAPI(title="Planner + Chat + Codegen", version="3.0.0")

# -----------------------------
# Bedrock helper
# -----------------------------
class BedrockClient:
    def __init__(self, model_id: str, region: str):
        self.model_id = model_id
        self.client = boto3.client(
            "bedrock-runtime",
            region_name=region,
            config=Config(read_timeout=60, retries={"max_attempts": 3}),
        )

    def converse(
        self,
        system_prompt: Optional[str],
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_config: Optional[Dict[str, Any]] = None,
        inference_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Thin wrapper over bedrock-runtime.converse."""
        req: Dict[str, Any] = {
            "modelId": self.model_id,
            "messages": messages,
        }
        if system_prompt:
            req["system"] = [{"text": system_prompt}]
        if tools:
            req["tools"] = tools
        if tool_config:
            req["toolConfig"] = tool_config
        if inference_config:
            req["inferenceConfig"] = inference_config

        log.debug("Converse request: %s", json.dumps(req)[:1200])
        resp = self.client.converse(**req)
        log.debug("Converse response: %s", json.dumps(resp)[:1200])
        return resp


brx = BedrockClient(MODEL_ID, REGION)

# -----------------------------
# Prompts & Tools
# -----------------------------
PLANNER_SYSTEM = (
    "You are a software planning agent. Given a user goal, produce a structured plan."
)

CHAT_SYSTEM = (
    "You are a helpful, concise engineering assistant. Answer clearly."
)

CODEGEN_SYSTEM = (
    "You are a senior software engineer. When appropriate, use the emit_files tool to return complete files."
)

# Tool that returns files for codegen
EMIT_FILES_TOOL = [
    {
        "toolSpec": {
            "name": "emit_files",
            "description": "Return one or more files as JSON.",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "files": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "path": {"type": "string"},
                                    "contents": {"type": "string"},
                                },
                                "required": ["path", "contents"],
                            },
                        }
                    },
                    "required": ["files"],
                }
            },
        }
    }
]

# Tool that returns a structured plan
EMIT_PLAN_TOOL = [
    {
        "toolSpec": {
            "name": "emit_plan",
            "description": "Return a structured plan as JSON.",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "steps": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "assumptions": {"type": "array", "items": {"type": "string"}},
                        "risks": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["summary", "steps"],
                }
            },
        }
    }
]

# -----------------------------
# Models
# -----------------------------
class PlanRequest(BaseModel):
    input: str
    context: Optional[Dict[str, Any]] = None

class PlanResponse(BaseModel):
    plan: Dict[str, Any]

class ChatSendRequest(BaseModel):
    session_id: Optional[str] = None
    user_input: str
    context: Optional[Dict[str, Any]] = None

class ChatSendResponse(BaseModel):
    session_id: str
    assistant_output: str
    history_len: int

class CodeGenRequest(BaseModel):
    instructions: str
    language: Optional[str] = None
    context: Optional[Dict[str, Any]] = None

class CodeGenResponse(BaseModel):
    files: List[Dict[str, str]]  # { path, contents }

# -----------------------------
# In‑memory chat store (swap for Redis/DB later)
# -----------------------------
_SESSIONS: Dict[str, List[Dict[str, Any]]] = {}


def _new_session_id() -> str:
    return str(uuid.uuid4())


def _get_history(session_id: str) -> List[Dict[str, Any]]:
    return _SESSIONS.setdefault(session_id, [])


# -----------------------------
# Endpoints
# -----------------------------
@app.post("/invocations", response_model=PlanResponse)
def plan_endpoint(req: PlanRequest):
    """Single-shot planner (kept for backward compatibility)."""
    try:
        messages = [
            {"role": "user", "content": [{"text": req.input}]},
        ]
        resp = brx.converse(PLANNER_SYSTEM, messages, tools=EMIT_PLAN_TOOL)
        output = resp.get("output", {})
        tool_uses = output.get("message", {}).get("content", [])
        for c in tool_uses:
            if c.get("toolUse", {}).get("name") == "emit_plan":
                return PlanResponse(plan=c["toolUse"]["input"])
        # Fallback to plain text if no tool was used
        text_chunks = [c.get("text") for c in tool_uses if c.get("text")]
        return PlanResponse(plan={"summary": "\n".join(filter(None, text_chunks)) or "No plan returned." , "steps": []})
    except Exception as e:
        log.exception("Planner error")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/chat/send", response_model=ChatSendResponse)
def chat_send(req: ChatSendRequest):
    """Multi-turn chat backed by Bedrock. Maintains session history in-memory."""
    try:
        session_id = req.session_id or _new_session_id()
        history = _get_history(session_id)

        # Build message list in Bedrock format
        messages: List[Dict[str, Any]] = history + [{"role": "user", "content": [{"text": req.user_input}]}]

        resp = brx.converse(CHAT_SYSTEM, messages)
        output = resp.get("output", {})
        content = output.get("message", {}).get("content", [])
        assistant_text = "\n".join([c.get("text", "") for c in content if c.get("text")]).strip()
        if not assistant_text:
            assistant_text = "(no text output)"

        # Persist new turns
        history.append({"role": "user", "content": [{"text": req.user_input}]})
        history.append({"role": "assistant", "content": [{"text": assistant_text}]})
        _SESSIONS[session_id] = history

        return ChatSendResponse(session_id=session_id, assistant_output=assistant_text, history_len=len(history))
    except Exception as e:
        log.exception("Chat error")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/code/generate", response_model=CodeGenResponse)
def code_generate(req: CodeGenRequest):
    """One-shot code generation endpoint. Uses emit_files tool to return files."""
    try:
        prompt_lines = [req.instructions]
        if req.language:
            prompt_lines.append(f"Preferred language: {req.language}")
        if req.context:
            prompt_lines.append(f"Context: {json.dumps(req.context)[:1000]}")

        messages = [
            {"role": "user", "content": [{"text": "\n\n".join(prompt_lines)}]},
        ]

        resp = brx.converse(CODEGEN_SYSTEM, messages, tools=EMIT_FILES_TOOL)
        output = resp.get("output", {})
        parts = output.get("message", {}).get("content", [])

        files: List[Dict[str, str]] = []
        for p in parts:
            tu = p.get("toolUse")
            if tu and tu.get("name") == "emit_files":
                tool_input = tu.get("input", {})
                files = tool_input.get("files", [])
                break

        # Fallback: scrape plain text if no tool used
        if not files:
            text = "\n".join([p.get("text", "") for p in parts if p.get("text")]).strip()
            if text:
                files = [{"path": "OUTPUT.txt", "contents": text}]

        if not files:
            raise HTTPException(status_code=502, detail="Model did not return files or text.")

        return CodeGenResponse(files=files)
    except Exception as e:
        log.exception("Codegen error")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/chat/history/{session_id}")
def chat_history(session_id: str):
    """Return raw Bedrock-formatted history for a session (debug/dev only)."""
    return JSONResponse(content={"session_id": session_id, "history": _SESSIONS.get(session_id, [])})


# Healthcheck
@app.get("/healthz")
def healthz():
    return {"ok": True, "model": MODEL_ID, "region": REGION}
