import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    // Use the CLI-based runner (bypasses any bundler/import quirks)
    const { runAgentViaCLI } = await import("../../../server/run-agent-via-cli");

    // 30s hard cap from the server side
    const result = await withTimeout(runAgentViaCLI(message), 30_000);

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[/api/chat] error:", err);
    return NextResponse.json(
      { error: err?.message || "Internal error (see server logs)" },
      { status: 500 }
    );
  }
}
