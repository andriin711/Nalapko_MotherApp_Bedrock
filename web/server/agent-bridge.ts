// web/server/agent-bridge.ts
import "server-only";

export async function runAgent(prompt: string) {
  console.log("[agent-bridge] importing ../../agent/cli.mjs");
  // @ts-ignore ESM outside /web
  const mod = await import("../../agent/cli.mjs");
  console.log("[agent-bridge] imported agent; running …");
  const result = await mod.runAgent(prompt, {});
  console.log("[agent-bridge] runAgent finished.");
  return result;
}
