// web/server/run-agent-via-cli.ts
import "server-only";
import cp from "node:child_process";
import path from "node:path";

export async function runAgentViaCLI(prompt: string) {
  // Path to your agent CLI entry
  const agentCli = path.resolve(process.cwd(), "..", "agent", "cli.mjs");

  // We’ll pass plain args; no need for JSON mode
  return new Promise<{ assistant: string; plan: any[]; logs: string[]; previewPath?: string }>((resolve, reject) => {
    const child = cp.spawn(process.execPath, [agentCli, prompt], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let out = "";
    let err = "";

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(err || `agent exited with code ${code}`));
      }

      // The CLI prints human text. We’ll detect the JSON block from our function’s return.
      // To make parsing robust, change your CLI to print a final JSON line starting with
      // "AGENT_JSON:" (see change below). Then we pick that line here.

      const line = out.split(/\r?\n/).find((l) => l.startsWith("AGENT_JSON:"));
      if (!line) {
        return reject(new Error("Agent did not produce AGENT_JSON output.\n" + out));
      }
      try {
        const json = JSON.parse(line.slice("AGENT_JSON:".length));
        resolve(json);
      } catch (e: any) {
        reject(new Error("Failed to parse agent JSON: " + e.message + "\n" + out));
      }
    });
  });
}
