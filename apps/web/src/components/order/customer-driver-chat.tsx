"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { Send } from "lucide-react";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "https://orderhub-api-0re6.onrender.com/api";

interface Msg {
  id: string;
  senderType: "CUSTOMER" | "DRIVER" | "OPERATOR";
  senderName: string | null;
  body: string;
  createdAt: string;
}

// Public customer ↔ driver chat for an order (polling, no auth — scoped by the
// hard-to-guess order id).
export function CustomerDriverChat({ orderId, driverName }: { orderId: string; driverName?: string | null }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const query = useQuery({
    queryKey: ["customer-chat", orderId],
    queryFn: () =>
      axios.get<{ messages: Msg[] }>(`${API_BASE}/v1/chat/track/${orderId}`).then((r) => r.data.messages),
    refetchInterval: 3000,
  });
  const messages = query.data ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function onSend() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText("");
    try {
      await axios.post(`${API_BASE}/v1/chat/track/${orderId}`, { body });
      await query.refetch();
    } catch {
      setText(body);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <div className="border-b border-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-800">
        Chat with {driverName ?? "your driver"}
      </div>
      <div className="max-h-64 min-h-[8rem] flex-1 space-y-2 overflow-auto bg-zinc-50 p-3">
        {messages.length === 0 ? (
          <p className="pt-6 text-center text-xs text-zinc-400">
            Send your driver a message — e.g. gate code or directions.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.senderType === "CUSTOMER";
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm ${
                    mine
                      ? "rounded-br-sm bg-orange-500 text-white"
                      : "rounded-bl-sm border border-zinc-200 bg-white text-zinc-900"
                  }`}
                >
                  <div>{m.body}</div>
                  <div className={`mt-0.5 text-right text-[10px] ${mine ? "text-white/70" : "text-zinc-400"}`}>
                    {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>
      <div className="flex items-end gap-2 border-t border-zinc-100 p-2">
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
          placeholder="Message your driver…"
          className="max-h-24 flex-1 resize-none rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-orange-400"
        />
        <button
          onClick={onSend}
          disabled={!text.trim() || sending}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-white disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
