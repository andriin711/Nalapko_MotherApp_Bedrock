"use client";

import { useEffect, useRef, useState } from "react";

type ChatItem = { role: "user" | "assistant" | "system"; content: string; meta?: any };
type ChatResult = {
  assistant?: string;
  plan?: any[];
  logs?: string[];
  previewPath?: string;
  error?: string;
  serverMs?: number;
};

export default function ChatWindow() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatItem[]>([
    { role: "system", content: "Bedrock code agent ready. Ask me to create or modify pages." },
  ]);
  const [lastResult, setLastResult] = useState<ChatResult | null>(null);
  const previewRef = useRef<HTMLIFrameElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");

    setMessages((m) => [...m, { role: "user", content: text }]);
    setBusy(true);
    setLastResult(null);

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const j: ChatResult = await r.json();

      if (j.error) {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: `⚠️ ${j.error}`, meta: { error: true } },
        ]);
      } else {
        // append assistant message
        const assistantText = j.assistant || "Done.";
        setMessages((m) => [...m, { role: "assistant", content: assistantText, meta: j }]);
        setLastResult(j);
      }
    } catch (e: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `⚠️ ${e?.message || "Request failed"}`, meta: { error: true } },
      ]);
    } finally {
      setBusy(false);
    }
  }

  // Auto-scroll chat to bottom on new messages
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // Navigate preview iframe when previewPath updates
  useEffect(() => {
    if (lastResult?.previewPath && previewRef.current) {
      previewRef.current.src = lastResult.previewPath || "/";
    }
  }, [lastResult?.previewPath]);

  return (
    <div className="min-h-[100dvh] bg-slate-950 text-white">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 lg:p-6">

        {/* LEFT: Chat window */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 lg:p-5 shadow-xl flex flex-col">
          <header className="mb-3">
            <h1 className="text-2xl font-extrabold tracking-tight">
              Chat Window <span className="text-indigo-300">· Bedrock Agent</span>
            </h1>
            {lastResult?.serverMs != null && (
              <div className="text-xs text-slate-400 mt-1">server: {lastResult.serverMs} ms</div>
            )}
          </header>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto pr-1 space-y-3">
            {messages.map((m, i) => (
              <ChatBubble key={i} role={m.role} text={m.content} meta={m.meta} />
            ))}
            <div ref={scrollRef} />
          </div>

          {/* Composer */}
          <div className="mt-4 flex gap-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="e.g. Create a /hello page with a big title"
              className="flex-1 rounded-xl bg-slate-800/80 px-4 py-3 outline-none ring-2 ring-transparent focus:ring-indigo-500 placeholder:text-slate-400"
            />
            <button
              onClick={send}
              disabled={busy}
              className="rounded-xl px-5 py-3 font-semibold bg-indigo-500 hover:bg-indigo-400 disabled:opacity-60 disabled:cursor-not-allowed shadow-lg shadow-indigo-900/40"
            >
              {busy ? "Working…" : "Send"}
            </button>
          </div>
        </section>

        {/* RIGHT: Live preview + details */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden shadow-xl flex flex-col">
          <div className="px-4 py-2 text-slate-300 text-sm border-b border-slate-800">
            Preview {lastResult?.previewPath ? `— ${lastResult.previewPath}` : ""}
          </div>
          <iframe
            ref={previewRef}
            title="Preview"
            src="/"
            className="w-full h-[54vh] lg:h-[70vh] bg-white"
          />
          {/* Plan & Logs (collapsible) */}
          {!!lastResult?.plan?.length && (
            <details className="border-t border-slate-800">
              <summary className="px-4 py-2 text-slate-300 cursor-pointer">Plan</summary>
              <div className="px-4 pb-4">
                <ol className="list-decimal pl-5 space-y-1">
                  {lastResult.plan!.map((a: any, i: number) => (
                    <li key={i} className="text-slate-200/90">
                      <code className="bg-slate-800/80 rounded px-2 py-1">{a.type}</code>{" "}
                      {a.path ? <span className="text-slate-300">— {a.path}</span> : null}
                      {a.command ? <span className="text-slate-300"> — {a.command}</span> : null}
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          )}
          {!!lastResult?.logs?.length && (
            <details className="border-t border-slate-800">
              <summary className="px-4 py-2 text-slate-300 cursor-pointer">Logs</summary>
              <div className="px-4 pb-4">
                <pre className="text-slate-200/90 text-sm whitespace-pre-wrap">
                  {lastResult.logs!.join("\n\n")}
                </pre>
              </div>
            </details>
          )}
        </section>

      </div>
    </div>
  );
}

function ChatBubble({
  role,
  text,
  meta,
}: {
  role: "user" | "assistant" | "system";
  text: string;
  meta?: any;
}) {
  const isUser = role === "user";
  const isSystem = role === "system";
  return (
    <div className={`max-w-[92%] sm:max-w-[85%] md:max-w-[75%] ${isUser ? "ml-auto" : ""}`}>
      <div
        className={[
          "rounded-2xl px-4 py-3 shadow",
          isSystem
            ? "bg-slate-800/70 text-slate-300 border border-slate-700"
            : isUser
            ? "bg-indigo-600 text-white"
            : meta?.error
            ? "bg-red-900/50 text-red-100 border border-red-500/40"
            : "bg-slate-800/80 text-slate-100 border border-slate-700",
        ].join(" ")}
      >
        <div className="whitespace-pre-wrap leading-relaxed">{text}</div>
      </div>
    </div>
  );
}
