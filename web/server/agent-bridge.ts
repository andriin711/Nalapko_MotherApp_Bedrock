import "server-only";

/**
 * Use a STATIC relative import so Next can analyze it.
 * Requires next.config.js → experimental.externalDir = true
 */
export async function runAgent(prompt: string) {
  // @ts-ignore: importing ESM .mjs from outside /web
  const mod = await import("../../agent/cli.mjs");
  return mod.runAgent(prompt, {});
}
