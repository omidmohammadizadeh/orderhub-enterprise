// One fetch wrapper for every call. Adds the customer token, turns the API's
// `{ message }` errors into an ApiError a screen can show as-is (the server
// already words them for customers), and times out instead of hanging —
// Render's free-tier cold start can take a while, but not forever.

import { API_URL } from "@/config";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let tokenProvider: () => string | null = () => null;
let onUnauthorized: () => void = () => {};

/** Wired by the session store so this module never imports it (no cycle). */
export function configureClient(opts: { getToken: () => string | null; onUnauthorized: () => void }) {
  tokenProvider = opts.getToken;
  onUnauthorized = opts.onUnauthorized;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  opts: { auth?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
  const token = tokenProvider();
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token && opts.auth !== false ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) {
      if (res.status === 401 && token) onUnauthorized();
      throw new ApiError(messageOf(json) ?? `Something went wrong (${res.status}).`, res.status);
    }
    return json as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error)?.name === "AbortError") {
      throw new ApiError("That took too long. Check your connection and try again.", 0);
    }
    throw new ApiError("You seem to be offline. Check your connection and try again.", 0);
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function messageOf(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const m = (json as { message?: unknown }).message;
  if (typeof m === "string") return m;
  // class-validator answers with an array of messages.
  if (Array.isArray(m) && typeof m[0] === "string") return m[0];
  return null;
}
