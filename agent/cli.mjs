import fs from "node:fs/promises";
import path from "node:path";
import cp from "node:child_process";
import fetch from "node-fetch";

const WEB_ROOT = path.join(process.cwd(), "web");
const WEB_ROOT_WITH_SEP = WEB_ROOT + path.sep;

async function buildContextForPlanner() {
  async function safeRead(rel) {
    try { return await fs.readFile(path.join(WEB_ROOT, rel), "utf8"); } catch { return null; }
  }
  const files = {};
  for (const rel of [
    "package.json",
    "next.config.js", "next.config.ts",
    "app/page.tsx", "app/layout.tsx", "app/global.css",
    "pages/index.tsx"
  ]) {
    const c = await safeRead(rel);
    if (c != null) files[rel] = c;
  }
  return { files };
}

function validatePlan(actions) {
  const allowed = new Set(["create_file", "update_file", "delete_file", "run_command"]);
  if (!Array.isArray(actions)) throw new Error("actions must be an array");
  for (const a of actions) {
    if (!allowed.has(a.type)) throw new Error(`Disallowed action: ${a.type}`);
    if ((a.type === "create_file" || a.type === "update_file") && typeof a.contents !== "string") {
      throw new Error(`${a.type} requires contents`);
    }
  }
  return actions;
}

function runWhitelistedCommand(command) {
  const whitelist = [
    "npm run dev", "npm run build", "npm run lint", "npm run typecheck",
    "next dev", "next build", "next start"
  ];
  if (!whitelist.includes(command)) throw new Error(`Command not allowed: ${command}`);
  return new Promise((resolve, reject) => {
    cp.exec(command, { cwd: WEB_ROOT }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(`$ ${command}\n${stdout}\n${stderr}`);
    });
  });
}

function resolveInsideWeb(relPath) {
  const abs = path.resolve(WEB_ROOT, relPath);
  if (!abs.startsWith(WEB_ROOT_WITH_SEP)) throw new Error(`Refusing to touch outside web/: ${relPath}`);
  return abs;
}

function inferPreviewPathFromActions(actions) {
  const touched = [...actions].reverse();
  for (const a of touched) {
    if (!("path" in a)) continue;
    const p = a.path.replace(/\\/g, "/");

    if (p.startsWith("app/") && p.endsWith("/page.tsx")) {
      const sub = p.slice("app/".length, -"/page.tsx".length);
      const cleaned = sub.split("/").filter(s => !(s.startsWith("(") && s.endsWith(")"))).join("/");
      return "/" + cleaned;
    }
    if (p.startsWith("pages/") && p.endsWith(".tsx")) {
      const sub = p.slice("pages/".length, -".tsx".length);
      if (sub === "index") return "/";
      return "/" + sub.replace(/\/index$/, "");
    }
  }
  if (touched.some(a => a.path === "app/page.tsx" || a.path === "pages/index.tsx")) return "/";
  return null;
}

// --------- PUBLIC API ----------
export async function runAgent(userPrompt, { plannerUrl } = {}) {
  const url = plannerUrl || process.env.PLANNER_URL || "http://localhost:8080/invocations";
  const context = await buildContextForPlanner();

  // 20s timeout to avoid hanging if planner is down
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("Planner request timed out")), 20_000);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: userPrompt, context }),
      signal: ac.signal
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) throw new Error(`Planner error: ${res.status} ${await res.text()}`);
  const { assistant_message, actions } = await res.json();

  const plan = validatePlan(actions);

  const logs = [];
  for (const step of plan) {
    if (step.type === "create_file" || step.type === "update_file") {
      const target = resolveInsideWeb(step.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, step.contents, "utf8");
      logs.push(`wrote ${step.path}`);
    } else if (step.type === "delete_file") {
      const target = resolveInsideWeb(step.path);
      await fs.rm(target, { force: true });
      logs.push(`deleted ${step.path}`);
    } else if (step.type === "run_command") {
      logs.push(await runWhitelistedCommand(step.command));
    }
  }

  const previewPath = inferPreviewPathFromActions(plan) || "/";

  return { assistant: assistant_message, plan, logs, previewPath };
}

// --------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error("Usage: npm run agent -- \"your prompt\"");
    process.exit(1);
  }
  runAgent(prompt)
    .then((result) => {
      const { assistant, plan, previewPath } = result;
      console.log("\nAssistant:\n", assistant);
      console.log("\nPlan:\n", JSON.stringify(plan, null, 2));
      console.log("\nPreview:\n", previewPath);
      // Emit a final, easy-to-parse JSON line for the web server:
      console.log("AGENT_JSON:" + JSON.stringify(result));
    })
    .catch((err) => {
      console.error(err && err.stack || String(err));
      process.exit(1);
    });
}

