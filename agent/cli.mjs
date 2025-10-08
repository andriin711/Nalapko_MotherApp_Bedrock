#!/usr/bin/env node
// agent/cli.mjs

// Optional: load .env if dotenv is installed. Safe to leave as-is even if not installed.
try { await import('dotenv/config'); } catch (_) { /* no .env loader; env vars can still be set via shell */ }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as CP from "node:child_process";
import process from "node:process";
import { z } from "zod";

/* =========================
   CONFIG
========================= */

// Resolve the Next.js app folder *relative to this file* (no env needed)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "../web");
if (!fs.existsSync(WEB_ROOT) || !fs.statSync(WEB_ROOT).isDirectory()) {
  throw new Error(
    `WEB_ROOT not found at ${WEB_ROOT}\n` +
    `Expected layout:\n  <repo>/web  (Next.js app)\n  <repo>/agent/cli.mjs`
  );
}

// Planner URL (comes from your .env). Fallback provided.
const PLANNER_URL = process.env.PLANNER_URL || "http://localhost:8080/invocations";

// Whitelisted commands the agent is allowed to run
const CMD_WHITELIST = new Set([
  "npm run dev", "npm run build", "next dev", "next build",
  "next start", "npm run lint", "npm run typecheck"
]);

/* =========================
   TYPES (Zod)
========================= */

const CreateFile = z.object({
  type: z.literal("create_file"),
  path: z.string(),
  contents: z.string()
});

const UpdateFile = z.object({
  type: z.literal("update_file"),
  path: z.string(),
  contents: z.string() // strict: full-file replacement (prevents empty updates)
});

const DeleteFile = z.object({
  type: z.literal("delete_file"),
  path: z.string()
});

const RunCommand = z.object({
  type: z.literal("run_command"),
  script: z.string()
});

const ActionSchema = z.union([CreateFile, UpdateFile, DeleteFile, RunCommand]);
const PlanSchema = z.object({ actions: z.array(ActionSchema) });

/* =========================
   HELPERS
========================= */

function readTree(root = WEB_ROOT, max = 400) {
  const out = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      if (["node_modules", ".next", ".git"].includes(f)) continue;
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(path.relative(root, p));
    }
  })(root);
  return out.slice(0, max);
}

function readIfExists(rel) {
  const p = path.join(WEB_ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function safeWrite(rel, contents) {
  const full = path.join(WEB_ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  console.log("✏️ wrote", rel);
}

async function runCommand(script) {
  if (!CMD_WHITELIST.has(script)) throw new Error(`Command not allowed: ${script}`);
  const [cmd, ...args] = script.split(" ");
  await new Promise((resolve, reject) => {
    const child = CP.spawn(cmd, args, {
      cwd: WEB_ROOT,
      stdio: "inherit",
      shell: process.platform === "win32" // helps Windows find npm/next shims
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${script} failed (${code})`))));
  });
}

async function fetchPlan(promptText, context) {
  if (!PLANNER_URL) throw new Error("PLANNER_URL is not set. Add it to your .env or export it.");
  const res = await fetch(PLANNER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: promptText, context })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Planner HTTP ${res.status}: ${body}`);
  }
  const data = await res.json(); // { plan: { actions: [...] } }
  return PlanSchema.parse(data.plan);
}

/* =========================
   MAIN
========================= */

async function main() {
  const userTask = process.argv.slice(2).join(" ").trim();
  if (!userTask) {
    console.error('Usage: npm run agent -- "Make a simple page"');
    process.exit(1);
  }

  // Gather minimal context for better plans
  const manifest = { framework: "next", router: "app", typescript: true, tailwind: true };
  const tree = readTree();
  const snippets = {
    "app/layout.tsx": readIfExists("app/layout.tsx").slice(0, 2000),
    "app/page.tsx":   readIfExists("app/page.tsx").slice(0, 2000),
    "package.json":   readIfExists("package.json").slice(0, 2000)
  };

  // Ask the planner (FastAPI -> Bedrock Nova Pro) for a plan
  const plan = await fetchPlan(userTask, { manifest, tree, snippets });

  // Guard: forbid empty update_file (should never happen with our schema, but be safe)
  for (const [i, a] of plan.actions.entries()) {
    if (a.type === "update_file" && !a.contents) {
      console.error(`Invalid update_file at actions[${i}] for ${a.path}: missing contents`);
      console.error("Raw plan:", JSON.stringify(plan, null, 2));
      process.exit(1);
    }
  }

  // Execute actions
  for (const a of plan.actions) {
    if (a.type === "create_file") {
      safeWrite(a.path, a.contents);
    } else if (a.type === "update_file") {
      safeWrite(a.path, a.contents);
    } else if (a.type === "delete_file") {
      const full = path.join(WEB_ROOT, a.path);
      if (fs.existsSync(full)) {
        fs.unlinkSync(full);
        console.log("🗑️ deleted", a.path);
      }
    } else if (a.type === "run_command") {
      await runCommand(a.script);
    }
  }

  // Additionally start dev if any run_command happened but dev wasn't started explicitly
  const anyRunCmd = plan.actions.some(a => a.type === "run_command");
  const devRequested = plan.actions.some(
    a => a.type === "run_command" && /(^|\s)(next dev|npm run dev)(\s|$)/i.test(a.script)
  );
  if (anyRunCmd && !devRequested) {
    console.log("ℹ️ Plan ran a command but not dev. Launching `npm run dev`…");
    await runCommand("npm run dev");
  }

  console.log("\n🎉 Done.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
