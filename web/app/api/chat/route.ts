// web/app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function withTimeout<T>(p: Promise<T>, ms: number) {
  return Promise.race<T>([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`Server timeout after ${ms}ms`)), ms)
    ),
  ]);
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const { message } = await req.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Missing 'message'." }, { status: 400 });
    }

    console.log("[/api/chat] START:", message);

    // Import the agent bridge (ESM) and call the agent with a server-side timeout
    const { runAgent } = await import("../../../server/agent-bridge");
    const result: any = await withTimeout(runAgent(message), 30_000); // 30s cap

    result.serverMs = Date.now() - t0;
    console.log("[/api/chat] DONE in", result.serverMs, "ms preview:", result.previewPath);
    return NextResponse.json(result);
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error("[/api/chat] ERROR after", Date.now() - t0, "ms:", msg);
    // Always return a JSON error so the client can stop spinning
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
