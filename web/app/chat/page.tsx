"use client";

import { useEffect, useRef, useState } from "react";

type Message = { role: "user" | "assistant"; content: string };

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "Hey! I can chat and also edit this app. What should we build?" }
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string>("/");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setBusy(true);
    setStatus("Working on your request…");

    // Client-side timeout (35s) to guarantee the UI doesn't spin forever
    const timeout = (ms: number) =>
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Client timeout after ${ms}ms`)), ms));

    try {
      const res = await Promise.race([
        fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text })
        }),
        timeout(35_000)
      ]);

      const data = await (res as Response).json();

      if (!(res as Response).ok) {
        throw new Error(data?.error || "Request failed");
      }

      setMessages((m) => [...m, { role: "assistant", content: data.assistant || "(no reply)" }]);

      if (data.previewPath && typeof data.previewPath === "string") {
        const url = data.previewPath + (data.previewPath.includes("?") ? "&" : "?") + "_ts=" + Date.now();
        setPreviewSrc(url);
        setStatus(`Updated files. Previewing ${data.previewPath}`);
      } else {
        setStatus("Updated files.");
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${e.message}` }]);
      setStatus("Something went wrong. Check planner & AWS config.");
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(null), 3000);
    }
  }

  useEffect(() => {
    // If iframe points to same path, poke it to reload
    if (iframeRef.current && iframeRef.current.src) {
      try {
        iframeRef.current.contentWindow?.location.reload();
      } catch {}
    }
  }, [previewSrc]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-100 via-white to-cyan-100 text-slate-900">
      <div className="max-w-7xl mx-auto p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Chat pane */}
        <div className="flex flex-col rounded-3xl border border-slate-200 bg-white/80 backdrop-blur shadow-md overflow-hidden">
          <div className="px-5 py-4 border-b bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white">
            <h1 className="text-lg font-semibold tracking-wide">AI Dev Chat</h1>
            <p className="text-white/90 text-sm">Describe a change; I’ll implement it and preview it live.</p>
          </div>

          <div className="flex-1 overflow-auto p-4 space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    "max-w-[85%] rounded-2xl px-4 py-3 shadow-sm " +
                    (m.role === "user"
                      ? "bg-gradient-to-r from-cyan-500 to-sky-500 text-white"
                      : "bg-slate-50 border border-slate-200")
                  }
                >
                  <div className="whitespace-pre-wrap leading-relaxed">{m.content}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t p-3 bg-slate-50">
            <div className="flex gap-2">
              <input
                className="flex-1 border border-slate-300 rounded-xl px-3 py-3 outline-none focus:ring-2 focus:ring-violet-400"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
                placeholder='e.g. "Create a /features page with three cards"'
                disabled={busy}
              />
              <button
                onClick={send}
                disabled={busy || !input.trim()}
                className="px-5 py-3 rounded-xl font-semibold shadow-sm disabled:opacity-50
                  bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white hover:brightness-110 active:brightness-95"
                title="Send"
              >
                {busy ? "Working…" : "Send"}
              </button>
            </div>
            {status && (
              <div className="mt-3 text-sm text-slate-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
                {status}
              </div>
            )}
          </div>
        </div>

        {/* Live preview pane */}
        <div className="rounded-3xl border border-slate-200 bg-white shadow-md overflow-hidden flex flex-col">
          <div className="px-5 py-3 border-b bg-slate-50 flex items-center justify-between">
            <div className="font-medium">Live Preview</div>
            <div className="text-sm text-slate-500">Path: <code className="font-mono">{previewSrc.split("?")[0]}</code></div>
          </div>
          <iframe
            ref={iframeRef}
            title="Live Preview"
            src={previewSrc}
            className="w-full h-[70vh]"
          />
        </div>
      </div>
    </div>
  );
}
