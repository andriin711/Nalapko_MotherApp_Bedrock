import "server-only";

export async function runAgent(prompt: string) {
  console.log("[agent-bridge] importing ../../agent/cli.mjs");
  // @ts-ignore importing ESM .mjs outside /web
  const mod = await import("../../agent/cli.mjs");
  console.log("[agent-bridge] imported agent. running runAgent(prompt) …");
  const result = await mod.runAgent(prompt, {});
  console.log("[agent-bridge] runAgent finished.");
  return result;
}
