"use client";

// Admin business co-pilot (Phase 1 — read-only). A chat panel that asks the
// server-side agent, which inspects the business's own data (menus, products,
// orders, data quality) through read-only, tenant-scoped tools. It can
// diagnose and plan but changes nothing.

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bot, Send, Loader2, User, Wrench, Trash2 } from "lucide-react";
import { agentClient, type AgentTurn } from "@/lib/api/agent.client";

// Chat persists across navigation (it used to reset on unmount) so a long
// multi-step build isn't lost when the operator flips to another page.
const HISTORY_KEY = "orderhub.assistant.history";

const SUGGESTIONS = [
  "Build a new drinks menu for my brand",
  "Audit my menu — what needs fixing?",
  "Add a 'choose your sauce' option to my burgers",
  "86 the Halloumi Wrap at Clifton",
  "Why is order #6190 stuck?",
];

interface Msg extends AgentTurn {
  toolsUsed?: string[];
  error?: boolean;
}

export default function AssistantPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Restore prior conversation on mount; persist on every change.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setMessages(JSON.parse(raw));
    } catch {
      /* ignore malformed history */
    }
  }, []);
  useEffect(() => {
    try {
      // Keep the last ~40 turns so storage stays small.
      localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-40)));
    } catch {
      /* ignore quota errors */
    }
  }, [messages]);

  const clearHistory = () => {
    setMessages([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      /* ignore */
    }
  };

  const chat = useMutation({
    mutationFn: (history: AgentTurn[]) => agentClient.chat(history),
    onSuccess: (res) =>
      setMessages((m) => [
        ...m,
        { role: "assistant", text: res.reply, toolsUsed: res.toolsUsed },
      ]),
    onError: (err: any) =>
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          error: true,
          text:
            err?.response?.data?.message ??
            "Something went wrong. Try again in a moment.",
        },
      ]),
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, chat.isPending]);

  const send = (text: string) => {
    const clean = text.trim();
    if (!clean || chat.isPending) return;
    const next: Msg[] = [...messages, { role: "user", text: clean }];
    setMessages(next);
    setInput("");
    // Send only role/text turns to the server.
    chat.mutate(next.map((m) => ({ role: m.role, text: m.text })));
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-100 text-violet-700">
            <Bot className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold text-zinc-900">AI Assistant</h1>
            <p className="text-[11px] text-zinc-500">
              Your business co-pilot — build &amp; edit menus, sizes, modifiers,
              86 items, publish. It always confirms before making a change.
            </p>
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearHistory}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-zinc-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5">
        {messages.length === 0 ? (
          <div className="mx-auto max-w-lg pt-8 text-center">
            <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-violet-100 text-violet-700">
              <Bot className="h-6 w-6" />
            </span>
            <h2 className="text-sm font-semibold text-zinc-800">
              Ask about your business
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              I can read your menus, products, and orders to help you spot and
              plan fixes. Try one of these:
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="rounded-full border border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 hover:border-violet-400 hover:bg-violet-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-4">
            {messages.map((m, i) => (
              <div key={i} className="flex gap-3">
                <span
                  className={`mt-0.5 grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg ${
                    m.role === "user"
                      ? "bg-zinc-200 text-zinc-600"
                      : "bg-violet-100 text-violet-700"
                  }`}
                >
                  {m.role === "user" ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={`whitespace-pre-wrap text-sm ${
                      m.error ? "text-red-600" : "text-zinc-800"
                    }`}
                  >
                    {m.text}
                  </p>
                  {m.toolsUsed && m.toolsUsed.length > 0 && (
                    <p className="mt-1.5 flex items-center gap-1 text-[10px] text-zinc-400">
                      <Wrench className="h-3 w-3" />
                      looked up: {[...new Set(m.toolsUsed)].join(", ")}
                    </p>
                  )}
                </div>
              </div>
            ))}
            {chat.isPending && (
              <div className="flex gap-3">
                <span className="mt-0.5 grid h-7 w-7 place-items-center rounded-lg bg-violet-100 text-violet-700">
                  <Bot className="h-3.5 w-3.5" />
                </span>
                <p className="flex items-center gap-1.5 pt-1 text-sm text-zinc-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working on it —
                  big changes can take up to a minute…
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-zinc-200 px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder="Ask about your menus, products, or orders…"
            className="flex-1 resize-none rounded-xl border border-zinc-200 px-3.5 py-2.5 text-sm outline-none focus:border-violet-400"
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || chat.isPending}
            className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
        <p className="mx-auto mt-2 max-w-2xl text-center text-[10px] text-zinc-400">
          The assistant asks you to confirm before any change, and every change
          is logged. It can build/edit menus, 86 items and publish — it never
          deletes, refunds, or messages customers.
        </p>
      </div>
    </div>
  );
}
