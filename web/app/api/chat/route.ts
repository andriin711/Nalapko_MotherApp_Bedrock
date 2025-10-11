import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard server-side cap so responses never hang forever
function withTimeout<T>(p: Promise<T>, ms: number) {
  return Promise.race<T>([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Server timeout after ${ms}ms`)), ms))
  ]);
}

export async function POST(req: NextRequest) {
  try {
    const { message } = await req.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Missing 'message'." }, { status: 400 });
    }

    const { runAgent } = await import("../../../server/agent-bridge");

    // 30s absolute server timeout
    const result = await withTimeout(runAgent(message), 30_000);

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[/api/chat] error:", err);
    return NextResponse.json(
      { error: err?.message || "Internal error (see server logs)" },
      { status: 500 }
    );
  }
}
