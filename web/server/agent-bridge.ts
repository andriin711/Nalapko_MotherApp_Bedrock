// web/server/agent-bridge.ts
import "server-only";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Import ../../agent/cli.mjs from the monorepo root safely at runtime.
 * This only runs on the server (Node.js), so fs/child_process are available.
 */
export async function runAgent(prompt: string) {
  const agentPath = path.resolve(process.cwd(), "..", "agent", "cli.mjs");
  const mod = await import(pathToFileURL(agentPath).href); // ESM-safe
  return mod.runAgent(prompt, {});
}
