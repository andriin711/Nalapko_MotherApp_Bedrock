// web/app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { message } = await req.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Missing 'message'." }, { status: 400 });
    }

    const { runAgent } = await import("../../../server/agent-bridge");
    const result = await runAgent(message); // { assistant, plan, logs, previewPath }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[/api/chat] error:", err);
    return NextResponse.json(
      { error: err?.message || "Internal error (see server logs)" },
      { status: 500 }
    );
  }
}
