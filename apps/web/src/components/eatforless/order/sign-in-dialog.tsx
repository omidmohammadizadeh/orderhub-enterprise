"use client";

// Signing in on the website: Google, or email and password. The same account
// as the app. Google here is Google's own button (Google Identity Services)
// on Eat For Less's web client, which hands back an ID token that
// /customer-auth/native exchanges exactly as it does for the app.

import { useEffect, useRef, useState } from "react";
import { Loader2, Mail, X } from "lucide-react";
import { eflCustomerApi, EflApiError } from "@/lib/api/efl-customer";
import { FOCUS } from "../efl-styles";
import { EflWordmark } from "../efl-logo";
import { useEflSession } from "./session";

/** Eat For Less's Google web client (public; it's in every page that uses it). */
const GOOGLE_CLIENT_ID =
  process.env.NEXT_PUBLIC_EFL_GOOGLE_CLIENT_ID ?? "937109589461-5l7j1hdsld04gi1tstjk14v8cocsrkbn.apps.googleusercontent.com";

type GoogleId = {
  initialize: (opts: { client_id: string; callback: (r: { credential?: string }) => void; ux_mode?: "popup" }) => void;
  renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
};

let gsiPromise: Promise<GoogleId | null> | null = null;
function loadGoogle(): Promise<GoogleId | null> {
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise((resolve) => {
    const existing = (window as unknown as { google?: { accounts?: { id?: GoogleId } } }).google?.accounts?.id;
    if (existing) return resolve(existing);
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve((window as unknown as { google?: { accounts?: { id?: GoogleId } } }).google?.accounts?.id ?? null);
    s.onerror = () => {
      gsiPromise = null;
      resolve(null);
    };
    document.head.appendChild(s);
  });
  return gsiPromise;
}

function GoogleButton({ onToken, onError }: { onToken: (idToken: string) => void; onError: (m: string) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // The latest handlers, so Google's one-time callback never calls a stale one.
  const handlers = useRef({ onToken, onError });
  handlers.current = { onToken, onError };

  useEffect(() => {
    let live = true;
    void loadGoogle().then((g) => {
      if (!live || !slot.current) return;
      if (!g) {
        setFailed(true);
        return;
      }
      g.initialize({
        client_id: GOOGLE_CLIENT_ID,
        ux_mode: "popup",
        callback: (r) => {
          if (r.credential) handlers.current.onToken(r.credential);
          else handlers.current.onError("Google didn't sign you in. Please try again.");
        },
      });
      const width = Math.min(400, slot.current.clientWidth || 320);
      g.renderButton(slot.current, { type: "standard", theme: "outline", size: "large", shape: "pill", text: "continue_with", width });
    });
    return () => {
      live = false;
    };
  }, []);

  if (failed) {
    return <p className="m-0 text-center text-sm text-[#5E5E5E]">Google sign-in couldn&rsquo;t load. Use your email below.</p>;
  }
  return <div ref={slot} className="flex min-h-[44px] w-full justify-center" />;
}

type Mode = "choose" | "signin" | "signup" | "sent";

export function SignInDialog({ open, onClose, reason }: { open: boolean; onClose: () => void; reason?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="efl-signin-h"
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-[24px] bg-white p-0 text-[#0B0B0B] backdrop:bg-black/50 sm:m-auto sm:w-[440px] sm:rounded-[24px]"
    >
      {open ? <SignInBody onDone={onClose} reason={reason} /> : null}
    </dialog>
  );
}

function SignInBody({ onDone, reason }: { onDone: () => void; reason?: string }) {
  const signIn = useEflSession((s) => s.signIn);
  const [mode, setMode] = useState<Mode>("choose");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [offers, setOffers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (err: unknown) => setError(err instanceof EflApiError ? err.message : "Something went wrong. Please try again.");

  const google = async (idToken: string) => {
    setBusy(true);
    setError(null);
    try {
      signIn(await eflCustomerApi.signInGoogle(idToken));
      onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        const res = await eflCustomerApi.signupEmail({
          email: email.trim(),
          password,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          marketingOptIn: offers,
        });
        setEmail(res.email);
        setMode("sent");
      } else {
        signIn(await eflCustomerApi.loginEmail(email.trim(), password));
        onDone();
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const input = `min-h-[48px] w-full rounded-xl border border-[#D6D6D6] px-4 text-base ${FOCUS}`;
  const primary = `efl-press flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-[#0B0B0B] px-5 text-[15px] font-extrabold text-white disabled:opacity-50 ${FOCUS}`;

  return (
    <div className="flex flex-col gap-5 px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-6">
      <div className="flex items-start justify-between gap-3">
        <EflWordmark size={28} />
        <button
          type="button"
          onClick={onDone}
          aria-label="Close"
          className={`efl-press -mr-2 -mt-2 flex h-11 w-11 items-center justify-center rounded-full hover:bg-[#F3F3F3] ${FOCUS}`}
        >
          <X aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>

      {mode === "sent" ? (
        <div className="flex flex-col gap-3">
          <h2 id="efl-signin-h" className="m-0 text-[26px] font-extrabold leading-tight tracking-[-0.02em]">
            Check your inbox
          </h2>
          <p className="m-0 text-[15px] leading-relaxed text-[#5E5E5E]">
            We sent a link to <strong className="text-[#0B0B0B]">{email}</strong>. Open it to confirm your email and you&rsquo;ll be signed
            in. Your basket will still be here.
          </p>
          <button type="button" onClick={() => setMode("signin")} className={primary}>
            I&rsquo;ve confirmed, sign in
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <h2 id="efl-signin-h" className="m-0 text-[26px] font-extrabold leading-tight tracking-[-0.02em]">
              {mode === "signup" ? "Create your account" : mode === "signin" ? "Sign in with email" : "Sign in to order"}
            </h2>
            <p className="m-0 text-[15px] text-[#5E5E5E]">
              {reason ?? "One account for the website and the Eat For Less app."}
            </p>
          </div>

          {mode === "choose" ? (
            <div className="flex flex-col gap-3">
              <GoogleButton onToken={google} onError={setError} />
              <button
                type="button"
                onClick={() => setMode("signin")}
                className={`efl-press flex min-h-[48px] w-full items-center justify-center gap-2 rounded-full border border-[#D6D6D6] px-5 text-[15px] font-bold hover:bg-[#F7F7F7] ${FOCUS}`}
              >
                <Mail aria-hidden="true" className="h-5 w-5" />
                Continue with email
              </button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3" noValidate={false}>
              {mode === "signup" ? (
                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-sm font-bold">
                    First name
                    <input required autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} className={input} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-bold">
                    Last name
                    <input required autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} className={input} />
                  </label>
                </div>
              ) : null}
              <label className="flex flex-col gap-1 text-sm font-bold">
                Email
                <input
                  required
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  spellCheck={false}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={input}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-bold">
                Password
                <input
                  required
                  type="password"
                  minLength={mode === "signup" ? 8 : 1}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={input}
                />
                {mode === "signup" ? (
                  <span className="text-xs font-normal text-[#5E5E5E]">At least 8 characters, with a capital letter and a number.</span>
                ) : null}
              </label>
              {mode === "signup" ? (
                <label className="flex min-h-[44px] items-center gap-3 text-sm">
                  <input type="checkbox" checked={offers} onChange={(e) => setOffers(e.target.checked)} className="h-5 w-5 accent-[#0B0B0B]" />
                  Send me Eat For Less offers by email
                </label>
              ) : null}
              <button type="submit" disabled={busy} className={primary}>
                {busy ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" /> : null}
                {mode === "signup" ? "Create account" : "Sign in"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setMode(mode === "signup" ? "signin" : "signup");
                }}
                className={`efl-press min-h-[44px] rounded-full text-sm font-bold underline underline-offset-4 ${FOCUS}`}
              >
                {mode === "signup" ? "I already have an account" : "New here? Create an account"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setMode("choose");
                }}
                className={`efl-press min-h-[44px] rounded-full text-sm font-semibold text-[#5E5E5E] ${FOCUS}`}
              >
                Other ways to sign in
              </button>
            </form>
          )}

          {busy && mode === "choose" ? (
            <p role="status" className="m-0 flex items-center justify-center gap-2 text-sm text-[#5E5E5E]">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> Signing you in…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="m-0 rounded-xl bg-[#FDECEC] px-4 py-3 text-sm font-semibold text-[#9B1C1C]">
              {error}
            </p>
          ) : null}
          <p className="m-0 text-center text-xs text-[#5E5E5E]">By continuing you agree to Eat For Less&rsquo;s Terms and Privacy Policy.</p>
        </>
      )}
    </div>
  );
}
