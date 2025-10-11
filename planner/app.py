import os, json
from typing import Any, Dict, List
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
import boto3
from botocore.config import Config

load_dotenv()

REGION = os.getenv("AWS_REGION", os.getenv("BEDROCK_REGION", "eu-north-1"))
MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "eu.amazon.nova-pro-v1:0")

app = FastAPI(title="Planner", version="1.3.0")

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

Return JSON ONLY via the 'emit_plan' tool with fields:
{ "assistant_message": string, "actions": Action[] }
"""

TOOL_SCHEMA = {
    "name": "emit_plan",
    "description": "Emit the plan and the chat message",
    "input_schema": {
        "type": "object",
        "properties": {
            "assistant_message": {"type": "string"},
            "actions": {
                "type": "array",
                "items": {"oneOf": [
                    {"type":"object","properties":{
                        "type":{"type":"string","const":"create_file"},
                        "path":{"type":"string"},
                        "contents":{"type":"string"}}, "required":["type","path","contents"], "additionalProperties": False},
                    {"type":"object","properties":{
                        "type":{"type":"string","const":"update_file"},
                        "path":{"type":"string"},
                        "contents":{"type":"string"}}, "required":["type","path","contents"], "additionalProperties": False},
                    {"type":"object","properties":{
                        "type":{"type":"string","const":"delete_file"},
                        "path":{"type":"string"}}, "required":["type","path"], "additionalProperties": False},
                    {"type":"object","properties":{
                        "type":{"type":"string","const":"run_command"},
                        "command":{"type":"string"}}, "required":["type","command"], "additionalProperties": False}
                ]}
            }
        },
        "required": ["assistant_message", "actions"],
        "additionalProperties": False
    }
}

# Bedrock client with timeouts and light retries
br = boto3.client(
    "bedrock-runtime",
    region_name=REGION,
    config=Config(
        connect_timeout=3,
        read_timeout=12,
        retries={"max_attempts": 2, "mode": "standard"}
    ),
)

def call_bedrock(system: str, user: str, tools: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Some Bedrock models reject role='system'. Embed system text in the first 'user' message.
    """
    merged_prompt = f"# System instructions\n{system}\n\n# User request\n{user}\n"
    body = {
        "inferenceConfig": {"temperature": 0.2, "topP": 0.9},
        "toolConfig": {"tools": [{"toolSpec": tools[0]}]},
        "messages": [{"role": "user", "content": [{"text": merged_prompt}]}],
    }
    try:
        resp = br.invoke_model(modelId=MODEL_ID, body=json.dumps(body))
    except Exception as e:
        raise ValueError(f"Bedrock call failed: {e!s}")

    payload = json.loads(resp["body"].read() or "{}")

    # Expect a tool invocation with name 'emit_plan'
    output = payload.get("output") or {}
    toolCalls = output.get("toolCalls") or output.get("toolcalls") or []
    if not toolCalls:
        msgs = payload.get("messages") or []
        for m in msgs:
            for c in m.get("content", []):
                if "toolUse" in c:
                    toolCalls = [c["toolUse"]]
                    break
    if not toolCalls:
        raise ValueError(f"Model did not call tool. Raw: {json.dumps(payload)[:500]}")

    tc = toolCalls[0]
    tool_name = tc.get("toolName") or tc.get("name")
    if tool_name != "emit_plan":
        raise ValueError(f"Unexpected tool: {tool_name}")

    raw_args = tc.get("toolArguments") or tc.get("arguments") or tc.get("toolInput") or "{}"
    args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
    return args

@app.post("/invocations")
def invocations(req: PlanRequest):
    try:
        user_text = req.input
        if req.context:
            user_text += "\n\nAdditional context:\n" + json.dumps(req.context, indent=2)
        out = call_bedrock(SYSTEM_PROMPT, user_text, [TOOL_SCHEMA])

        if not isinstance(out, dict):
            raise ValueError("Planner output not an object.")
        if "assistant_message" not in out or "actions" not in out:
            raise ValueError("Planner output missing required fields.")
        if not isinstance(out["actions"], list):
            raise ValueError("actions must be an array.")

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

        return out
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/health")
def health():
    return {"ok": True, "region": REGION, "model": MODEL_ID}
