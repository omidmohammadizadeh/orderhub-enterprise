"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle, ChevronDown, ChevronLeft, Send } from "lucide-react";
import {
  getChatThreads,
  getDriverChat,
  sendDriverChat,
  type ChatThread,
} from "@/lib/api/dispatch.client";

// Floating operator chat — a customer-service-style widget docked bottom-right.
// Collapsed = a bubble with the total unread badge; expanded = driver inbox →
// per-driver conversation. Polls (threads 5s, open conversation 2s).
export function DispatchChatWidget({
  /** The shop the dashboard is showing. Omitted = every shop the user can
   *  reach, which the API decides — this prop can only narrow. */
  locationId,
}: { locationId?: string } = {}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ChatThread | null>(null);

  const threadsQuery = useQuery({
    queryKey: ["chat-threads", locationId ?? "accessible"],
    queryFn: () => getChatThreads(locationId),
    refetchInterval: 5000,
  });
  const threads = threadsQuery.data ?? [];
  const totalUnread = threads.reduce((n, t) => n + t.unread, 0);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xl ring-1 ring-black/5 transition hover:scale-105"
        aria-label="Open driver chat"
      >
        <MessageCircle className="h-6 w-6" />
        {totalUnread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold text-white">
            {totalUnread}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-50 flex h-[30rem] w-80 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white text-neutral-900 shadow-2xl ring-1 ring-black/5 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-primary px-3 py-2.5 text-primary-foreground dark:border-neutral-700">
        {active ? (
          <button onClick={() => setActive(null)} className="rounded p-0.5 hover:bg-white/15">
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : (
          <MessageCircle className="h-5 w-5" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{active ? active.name : "Driver chat"}</div>
          {active && (
            <div className="text-[11px] opacity-80">
              {active.status === "ON_JOB" ? "On a job" : active.status === "ONLINE" ? "Online" : "Offline"}
            </div>
          )}
        </div>
        <button onClick={() => setOpen(false)} className="rounded p-0.5 hover:bg-white/15" aria-label="Minimize">
          <ChevronDown className="h-5 w-5" />
        </button>
      </div>

      {active ? (
        <Conversation thread={active} />
      ) : (
        <div className="flex-1 overflow-auto">
          {threads.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">No drivers yet.</p>
          ) : (
            threads.map((t) => (
              <button
                key={t.driverId}
                onClick={() => setActive(t)}
                className="flex w-full items-center gap-3 border-b border-neutral-100 px-3 py-2.5 text-left hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800"
              >
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                    t.status === "ONLINE" ? "bg-green-500" : t.status === "ON_JOB" ? "bg-amber-500" : "bg-slate-300"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between">
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    {t.lastAt && (
                      <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                        {new Date(t.lastAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {t.lastBody ?? "No messages yet"}
                  </span>
                </span>
                {t.unread > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold text-white">
                    {t.unread}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Conversation({ thread }: { thread: ChatThread }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const messagesQuery = useQuery({
    queryKey: ["chat-driver", thread.driverId],
    queryFn: () => getDriverChat(thread.driverId),
    refetchInterval: 2000,
  });
  const messages = messagesQuery.data ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function onSend() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText("");
    try {
      await sendDriverChat(thread.driverId, body);
      await messagesQuery.refetch();
    } catch {
      setText(body);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="flex-1 space-y-2 overflow-auto bg-neutral-50 p-3 dark:bg-neutral-950">
        {messages.length === 0 ? (
          <p className="pt-8 text-center text-xs text-muted-foreground">No messages yet. Say hello 👋</p>
        ) : (
          messages.map((m) => {
            const mine = m.senderType === "OPERATOR";
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm ${
                    mine
                      ? "rounded-br-sm bg-primary text-primary-foreground"
                      : "rounded-bl-sm bg-white text-neutral-900 ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700"
                  }`}
                >
                  <div>{m.body}</div>
                  <div className={`mt-0.5 text-right text-[10px] ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                    {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>
      <div className="flex items-end gap-2 border-t border-neutral-200 p-2 dark:border-neutral-700">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          placeholder="Message the driver…"
          className="max-h-24 flex-1 resize-none rounded-lg border border-neutral-200 bg-background px-3 py-2 text-sm outline-none focus:border-primary dark:border-neutral-700"
        />
        <button
          onClick={onSend}
          disabled={!text.trim() || sending}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </>
  );
}
