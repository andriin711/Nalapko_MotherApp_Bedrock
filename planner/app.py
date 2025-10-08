# planner/app.py
import os
import json
import datetime
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
load_dotenv()  # load repo-root .env

import boto3
from botocore.config import Config
from boto3.session import Session

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ====== Config (EU) ======
MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "eu.amazon.nova-pro-v1:0")
REGION   = os.getenv("AWS_REGION", "eu-north-1")

# Validate credentials early with a friendly error
_session = Session()
if not _session.get_credentials():
    raise RuntimeError(
        "No AWS credentials detected. Provide one of:\n"
        "- AWS_PROFILE in .env (recommended), configured via `aws configure` or `aws sso login`\n"
        "- or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN if temporary) in env/.env\n"
    )

# Bedrock runtime client
brt = boto3.client(
    "bedrock-runtime",
    region_name=REGION,
    config=Config(read_timeout=60, connect_timeout=10, retries={"max_attempts": 2}),
)

# Helpful diagnostics on startup
try:
    who = boto3.client("sts").get_caller_identity().get("Arn")
    print("👤 AWS Identity:", who)
except Exception as e:
    print("⚠️ Could not fetch STS caller identity:", e)
print("🕒 Local UTC:", datetime.datetime.utcnow().isoformat() + "Z")
print("🌍 Region:", REGION, "| 🧠 Model:", MODEL_ID)

app = FastAPI(title="Nova Pro Planner (EU)")

SYSTEM_PROMPT = """
You are a codegen agent for a Next.js (App Router + TypeScript) project.

Return your plan exclusively via tool "emit_plan" with valid JSON.
Supported actions: create_file, update_file, delete_file, run_command.

Rules:
- For update_file, ALWAYS include the complete new file in "contents" (no patches/diffs).
- Keep code compilable and lint-safe; in JSX text, do not use raw " or '. Use &ldquo; &rdquo; &rsquo; or &quot; &apos;.
- If the app is uninitialized, create app/layout.tsx and app/page.tsx (and Tailwind files if needed).
- After file writes, end with exactly one run_command (e.g., "npm run build" OR "npm run dev").
"""

EMIT_PLAN_TOOL = {
    "name": "emit_plan",
    "description": "Emit a JSON plan of actions to modify the Next.js project",
    "inputSchema": {
        "json": {
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "items": {
                        "anyOf": [
                            {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "const": "create_file"},
                                    "path": {"type": "string"},
                                    "contents": {"type": "string"},
                                },
                                "required": ["type", "path", "contents"],
                                "additionalProperties": False,
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "const": "update_file"},
                                    "path": {"type": "string"},
                                    "contents": {"type": "string"},
                                },
                                "required": ["type", "path", "contents"],
                                "additionalProperties": False,
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "const": "delete_file"},
                                    "path": {"type": "string"},
                                },
                                "required": ["type", "path"],
                                "additionalProperties": False,
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "type": {"type": "string", "const": "run_command"},
                                    "script": {"type": "string"},
                                },
                                "required": ["type", "script"],
                                "additionalProperties": False,
                            },
                        ]
                    },
                }
            },
            "required": ["actions"],
            "additionalProperties": False,
        }
    },
}

# ====== FastAPI models ======
class ContextModel(BaseModel):
    manifest: Dict[str, Any] = Field(default_factory=dict)
    tree: List[str] = Field(default_factory=list)
    snippets: Dict[str, str] = Field(default_factory=dict)

class InvokeBody(BaseModel):
    prompt: str
    context: Optional[ContextModel] = None

# ====== Helpers ======
def _payload(prompt_text: str, ctx: ContextModel) -> str:
    manifest = ctx.manifest or {"framework": "next", "router": "app", "typescript": True, "tailwind": True}
    return (
        "PROJECT_MANIFEST:\n" + json.dumps(manifest, indent=2) + "\n" +
        "FILE_TREE (truncated):\n" + "\n".join(ctx.tree or []) + "\n" +
        "SNIPPETS:\n" + "\n\n".join([f"{k}:\n{(v or '')[:2000]}" for k, v in (ctx.snippets or {}).items()]) +
        "\n\nTASK:\n" + prompt_text
    )

def _ask_bedrock_for_plan(prompt_text: str, ctx: ContextModel) -> Dict[str, Any]:
    # ✅ For Nova Converse, put system prompt in top-level "system", not as a message.
    req = {
        "modelId": MODEL_ID,
        "system": [
            {"text": SYSTEM_PROMPT}
        ],
        "messages": [
            {"role": "user", "content": [{"text": _payload(prompt_text, ctx)}]}
        ],
        "toolConfig": {"tools": [{"toolSpec": EMIT_PLAN_TOOL}]},
    }

    res = brt.converse(**req)
    msg = (res.get("output") or {}).get("message") or {}
    blocks = [b for b in (msg.get("content") or []) if "toolUse" in b]
    if not blocks:
        raise RuntimeError("Model did not emit toolUse; check model access or tighten prompt.")
    tu = blocks[0]["toolUse"]
    if tu.get("name") != "emit_plan":
        raise RuntimeError(f"Unexpected tool name: {tu.get('name')}")
    plan = tu.get("input") or {}

    # Guard: forbid empty update_file
    for i, a in enumerate(plan.get("actions", [])):
        if a.get("type") == "update_file" and not a.get("contents"):
            raise RuntimeError(f"Invalid update_file at index {i}: missing contents")
    return plan

# ====== Route ======
@app.post("/invocations")
def invocations(body: InvokeBody):
    try:
        ctx = body.context or ContextModel()
        plan = _ask_bedrock_for_plan(body.prompt, ctx)
        return {"plan": plan}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
