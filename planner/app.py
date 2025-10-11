# planner/app.py
import os, json, time, uuid, logging
from typing import Any, Dict, List
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
import boto3
from botocore.config import Config

load_dotenv()

REGION = os.getenv("AWS_REGION", os.getenv("BEDROCK_REGION", "eu-north-1"))
MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "eu.amazon.nova-pro-v1:0")
PLANNER_FAKE = os.getenv("PLANNER_FAKE", "0") == "1"
USE_CONVERSE = os.getenv("PLANNER_USE_CONVERSE", "1") == "1"  # ← default to Converse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="Planner", version="1.6.0")

class PlanRequest(BaseModel):
    input: str
    context: Dict[str, Any] | None = None

SYSTEM_PROMPT = """
You are a software planning agent. You must return:
- assistant_message: a concise, friendly message to show in chat.
- actions: a minimal sequence of steps to fulfill the user's request.

Allowed actions (emit as JSON with exact fields):
1) create_file { "type":"create_file", "path":"app/page.tsx", "contents":"..." }
2) update_file { "type":"update_file", "path":"app/page.tsx", "contents":"FULL new file contents" }
3) delete_file { "type":"delete_file", "path":"app/old.tsx" }
4) run_command { "type":"run_command", "command":"npm run build" }

Rules:
- Never write outside the 'web/' project; paths are relative to that folder.
- Prefer smallest viable change.
- If chat-only, actions may be [].
- If code changes, provide BOTH assistant_message and actions.
- DO NOT include long-running commands like "npm run dev", "next dev", or "next start".
- Only short, terminating commands are allowed (e.g., "npm run build", "npm run lint", "npm run typecheck", "next build").

Return JSON ONLY via the 'emit_plan' tool with fields:
{ "assistant_message": string, "actions": Action[] }
"""

# Nova tool schema (Converse & Invoke both accept camelCase + json wrapper)
TOOL_SCHEMA = {
    "name": "emit_plan",
    "description": "Emit the plan and the chat message",
    "inputSchema": {
        "json": {
            "type": "object",
            "properties": {
                "assistant_message": {"type": "string"},
                "actions": {
                    "type": "array",
                    "items": {
                        "oneOf": [
                            {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "const": "create_file"},
                                    "path": {"type": "string"},
                                    "contents": {"type": "string"}
                                },
                                "required": ["type", "path", "contents"],
                                "additionalProperties": False
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "const": "update_file"},
                                    "path": {"type": "string"},
                                    "contents": {"type": "string"}
                                },
                                "required": ["type", "path", "contents"],
                                "additionalProperties": False
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "const": "delete_file"},
                                    "path": {"type": "string"}
                                },
                                "required": ["type", "path"],
                                "additionalProperties": False
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "const": "run_command"},
                                    "command": {"type": "string"}
                                },
                                "required": ["type", "command"],
                                "additionalProperties": False
                            }
                        ]
                    }
                }
            },
            "required": ["assistant_message", "actions"],
            "additionalProperties": False
        }
    }
}

# Bedrock clients with timeouts & retries
cfg = Config(connect_timeout=5, read_timeout=20, retries={"max_attempts": 2, "mode": "standard"})
br = boto3.client("bedrock-runtime", region_name=REGION, config=cfg)         # for invoke_model
brc = boto3.client("bedrock-runtime", region_name=REGION, config=cfg)        # Converse uses same service in recent SDKs

def parse_tool_args_from_converse(resp_json: Dict[str, Any]) -> Dict[str, Any]:
    """
    Converse response shape:
    resp = client.converse(...); resp['output']['message']['content'] -> list
    Find the item with 'toolUse' and parse its 'input' (already an object).
    """
    output = resp_json.get("output") or {}
    message = output.get("message") or {}
    content = message.get("content") or []
    for item in content:
        tu = item.get("toolUse")
        if tu:
            name = tu.get("name") or tu.get("toolName")
            if name != "emit_plan":
                raise ValueError(f"Unexpected tool: {name}")
            args = tu.get("input") or tu.get("toolInput") or {}
            return args
    # Some variants return in 'stopReason'/'apiResponse' etc.—log what we saw:
    raise ValueError(f"Model did not call tool (converse). Raw: {json.dumps(resp_json)[:500]}")

def parse_tool_args_from_invoke(resp_json: Dict[str, Any]) -> Dict[str, Any]:
    """
    Invoke response shape (Nova): output.toolCalls[0].(name|toolName,input|arguments|toolInput)
    """
    output = resp_json.get("output") or {}
    calls = output.get("toolCalls") or output.get("toolcalls") or []
    if not calls:
        # Some models put toolUse under messages[].content[]
        for m in resp_json.get("messages", []):
            for c in m.get("content", []):
                if "toolUse" in c:
                    calls = [c["toolUse"]]
                    break
    if not calls:
        raise ValueError(f"Model did not call tool (invoke). Raw: {json.dumps(resp_json)[:500]}")
    tc = calls[0]
    name = tc.get("name") or tc.get("toolName")
    if name != "emit_plan":
        raise ValueError(f"Unexpected tool: {name}")
    raw = tc.get("input") or tc.get("arguments") or tc.get("toolInput") or {}
    return json.loads(raw) if isinstance(raw, str) else raw

def call_bedrock_converse(system: str, user: str, rid: str) -> Dict[str, Any]:
    """
    Use Converse API. This model does NOT accept role='system'.
    Workaround: prepend system instructions into the first user message.
    Tools stay under toolConfig.tools[].toolSpec.
    """
    merged_user = f"# System instructions\n{system}\n\n# User request\n{user}\n"

    t0 = time.time()
    logging.info(f"[{rid}] Converse invoke model={MODEL_ID} region={REGION}")
    try:
        resp = brc.converse(
            modelId=MODEL_ID,
            # No 'system' role here
            messages=[
                {"role": "user", "content": [{"text": merged_user}]}
            ],
            inferenceConfig={"temperature": 0.2, "topP": 0.9},
            toolConfig={
                "tools": [{"toolSpec": TOOL_SCHEMA}]  # Converse expects toolSpec wrapper
            },
        )
    except Exception as e:
        logging.error(f"[{rid}] Converse error after {time.time()-t0:.2f}s: {e!s}")
        raise ValueError(f"Bedrock converse failed: {e!s}")

    logging.info(f"[{rid}] Converse responded in {time.time()-t0:.2f}s")
    resp_json = json.loads(json.dumps(resp, default=str))
    return parse_tool_args_from_converse(resp_json)

def call_bedrock_invoke(system: str, user: str, rid: str) -> Dict[str, Any]:
    """
    Use invoke_model with Nova tool use.
    - Tools must be wrapped in toolSpec (with inputSchema.json inside).
    - Some deployments are picky about 'system' role; safest is to fold it into the first user turn.
    """
    merged_prompt = f"# System instructions\n{system}\n\n# User request\n{user}\n"

    body = {
        "inferenceConfig": {"temperature": 0.2, "topP": 0.9},
        # ✅ FIX: tools must be [{ "toolSpec": TOOL_SCHEMA }]
        "toolConfig": {"tools": [{"toolSpec": TOOL_SCHEMA}]},
        # Keep 'system' text inside the first user message to avoid role validation issues
        "messages": [
            {"role": "user", "content": [{"text": merged_prompt}]}
        ],
        # (Optional) You can include toolChoice.auto: {} if you like; Nova defaults to auto
        # "toolChoice": {"auto": {}},
    }

    t0 = time.time()
    logging.info(f"[{rid}] Invoke invoke_model model={MODEL_ID} region={REGION}")
    try:
        resp = br.invoke_model(modelId=MODEL_ID, body=json.dumps(body))
    except Exception as e:
        logging.error(f"[{rid}] Invoke error after {time.time()-t0:.2f}s: {e!s}")
        raise ValueError(f"Bedrock call failed: {e!s}")
    logging.info(f"[{rid}] Invoke responded in {time.time()-t0:.2f}s")

    payload = json.loads(resp["body"].read() or "{}")
    return parse_tool_args_from_invoke(payload)

@app.post("/invocations")
def invocations(req: PlanRequest):
    rid = uuid.uuid4().hex[:8]
    try:
        logging.info(f"[{rid}] /invocations start use_converse={USE_CONVERSE} fake={PLANNER_FAKE}")
        user_text = req.input
        if req.context:
            user_text += "\n\nAdditional context:\n" + json.dumps(req.context, indent=2)

        if PLANNER_FAKE:
            logging.warning(f"[{rid}] PLANNER_FAKE=1 active; bypassing Bedrock.")
            return {
                "assistant_message": "🤖 (FAKE) I would create /hello",
                "actions": [{
                    "type": "create_file",
                    "path": "app/hello/page.tsx",
                    "contents": "<div style={{padding:20}}><h1>Hello from FAKE planner</h1></div>"
                }],
                "debug": {"rid": rid, "fake": True}
            }

        # ---- Real Bedrock call (Converse preferred) ----
        if USE_CONVERSE:
            out = call_bedrock_converse(SYSTEM_PROMPT, user_text, rid)
        else:
            out = call_bedrock_invoke(SYSTEM_PROMPT, user_text, rid)

        # Validate required fields
        if not isinstance(out, dict):
            raise ValueError("Planner output not an object.")
        if "assistant_message" not in out or "actions" not in out:
            raise ValueError("Planner output missing required fields.")
        if not isinstance(out["actions"], list):
            raise ValueError("actions must be an array.")

        # Action shape checks
        for a in out["actions"]:
            t = a.get("type")
            if t in ("create_file", "update_file"):
                if not a.get("path"): raise ValueError(f"{t} missing path")
                if not isinstance(a.get("contents"), str) or not a["contents"].strip():
                    raise ValueError(f"{t} must include non-empty contents for {a.get('path')}")
            elif t == "delete_file":
                if not a.get("path"): raise ValueError("delete_file missing path")
            elif t == "run_command":
                if not a.get("command"): raise ValueError("run_command missing command")
            else:
                raise ValueError(f"Unknown action type: {t}")

        out["debug"] = {"rid": rid, "fake": False, "use_converse": USE_CONVERSE}
        logging.info(f"[{rid}] /invocations done")
        return out
    except Exception as e:
        logging.exception(f"[{rid}] /invocations error: {e!s}")
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/health")
def health():
    return {"ok": True, "region": REGION, "model": MODEL_ID, "use_converse": USE_CONVERSE}

@app.get("/echo")
def echo(q: str = ""):
    return {"ok": True, "q": q}
