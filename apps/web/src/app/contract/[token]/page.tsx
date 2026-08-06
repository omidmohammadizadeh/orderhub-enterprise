"use client";

// The signing page — what the counterparty sees.
//
// The token in the URL is the only credential; there is no login here and
// never will be, the same rule the QR-at-table and payment-link pages follow.
// Everything on screen comes from one public endpoint keyed by that token.

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { PdfPages } from "@/components/contracts/pdf-pages";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Lock,
  PenLine,
  XCircle,
} from "lucide-react";

const API_BASE =
  process.env.NEXT_PUBLIC_SOCKET_URL ?? "https://orderhub-api-0re6.onrender.com";

interface ContractView {
  title: string;
  bodyHtml: string | null;
  fileUrl: string | null;
  fileName: string | null;
  recipientName: string;
  recipientEmail: string;
  recipientCompany: string | null;
  locationName: string | null;
  subscriptionAmountPence: number | null;
  status: "DRAFT" | "SENT" | "OPENED" | "SIGNED" | "VOIDED";
  signedAt: string | null;
  signerName: string | null;
  subscriptionStartedAt: string | null;
  canSubscribe: boolean;
  fields?: SignField[];
}

interface SignField {
  id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: "TEXT" | "DATE" | "SIGNATURE" | "CHECKBOX";
  assignee: "SENDER" | "RECIPIENT";
  label: string | null;
  required: boolean;
  fontSize: number;
  value: string | null;
}

export default function SignContractPage() {
  const params = useParams<{ token: string }>();
  const token = String(params.token);

  const [contract, setContract] = useState<ContractView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [signerName, setSignerName] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  const [subscribing, setSubscribing] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/sign/${token}`);
      if (!res.ok) {
        setLoadError(
          res.status === 404
            ? "This link isn't valid. Please check with whoever sent it."
            : "Couldn't load this contract. Please try again shortly.",
        );
        return;
      }
      const data = (await res.json()) as ContractView;
      setContract(data);
      setSignerName((prev) => prev || data.recipientName || "");
    } catch {
      setLoadError("Couldn't reach the server. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const sign = async () => {
    setSignError(null);
    setSigning(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/sign/${token}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signerName: signerName.trim(),
          fieldValues,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSignError(data?.message ?? "Couldn't record your signature.");
        return;
      }
      await load();
    } catch {
      setSignError("Couldn't reach the server. Please try again.");
    } finally {
      setSigning(false);
    }
  };

  const subscribe = async () => {
    setSubError(null);
    setSubscribing(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/sign/${token}/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.checkoutUrl) {
        setSubError(data?.message ?? "Couldn't start the subscription.");
        return;
      }
      window.location.href = data.checkoutUrl;
    } catch {
      setSubError("Couldn't reach the server. Please try again.");
    } finally {
      setSubscribing(false);
    }
  };

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-2 py-20 text-zinc-400">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading…
        </div>
      </Shell>
    );
  }

  if (loadError || !contract) {
    return (
      <Shell>
        <div className="py-16 text-center">
          <XCircle className="mx-auto h-8 w-8 text-zinc-300" />
          <p className="mt-3 text-sm text-zinc-600">{loadError}</p>
        </div>
      </Shell>
    );
  }

  if (contract.status === "VOIDED") {
    return (
      <Shell>
        <div className="py-16 text-center">
          <XCircle className="mx-auto h-8 w-8 text-red-400" />
          <h1 className="mt-3 text-lg font-semibold text-zinc-900">
            This agreement was withdrawn
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            It can no longer be signed. Please contact whoever sent it to you.
          </p>
        </div>
      </Shell>
    );
  }

  const isSigned = contract.status === "SIGNED";

  return (
    <Shell>
      <header className="mb-5 border-b border-zinc-200 pb-4">
        {/* Letterhead. A stranger opening a link off WhatsApp should be able
            to tell at a glance who sent it before reading a word. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/orderhub-logo.png"
          alt="Order Hub"
          className="mb-3 h-10 w-auto"
        />
        <h1 className="text-xl font-bold text-zinc-900">{contract.title}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Prepared for {contract.recipientName}
          {contract.recipientCompany ? ` · ${contract.recipientCompany}` : ""}
          {contract.locationName ? ` · ${contract.locationName}` : ""}
        </p>
        {isSigned && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Signed by {contract.signerName} on{" "}
              {contract.signedAt
                ? new Date(contract.signedAt).toLocaleString("en-GB")
                : ""}
            </span>
            {/* A plain link, not a fetch+blob: this route is public, so the
                browser can download it directly with no header to attach. */}
            <a
              href={`${API_BASE}/api/v1/sign/${token}/pdf`}
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-700 hover:border-zinc-400"
            >
              <Download className="h-3.5 w-3.5" />
              Download signed copy
            </a>
          </div>
        )}
      </header>

      {/* The document */}
      {contract.fileUrl ? (
        <div className="mb-6">
          {/* Phones do not embed PDFs. Neither iOS Safari nor Android Chrome
              renders <object type="application/pdf"> — Android draws an empty
              grey box the height of the element, which is what "your browser
              can't show the document inline" sitting above a blank rectangle
              actually was.

              Split by CSS rather than sniffing the user agent: no JS, no
              hydration mismatch, and a small desktop window degrades to the
              same honest button instead of a broken frame. */}
          <a
            href={contract.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm active:bg-zinc-50 sm:hidden ${
              (contract.fields?.length ?? 0) > 0 ? "hidden" : "flex"
            }`}
          >
            <span className="grid h-11 w-11 flex-shrink-0 place-items-center rounded-lg bg-orange-50">
              <FileText className="h-5 w-5 text-orange-600" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-zinc-900">
                Read the agreement
              </span>
              <span className="block truncate text-xs text-zinc-500">
                {contract.fileName ?? "Opens the document"}
              </span>
            </span>
            <ExternalLink className="h-4 w-4 flex-shrink-0 text-zinc-400" />
          </a>

          {/* With placed fields the document is rendered by pdf.js and the
              boxes overlaid as real inputs, on every screen size — a phone
              has to be able to fill them, which the native PDF viewer cannot
              do. Without fields it stays a plain embed. */}
          {(contract.fields?.length ?? 0) > 0 ? (
            <div className="-mx-2">
              <PdfPages
                fileUrl={contract.fileUrl}
                renderOverlay={(box) => (
                  <div className="absolute inset-0">
                    {(contract.fields ?? [])
                      .filter((f) => f.page === box.page)
                      .map((f) => (
                        <FieldInput
                          key={f.id}
                          field={f}
                          disabled={isSigned}
                          value={
                            fieldValues[f.id] ??
                            f.value ??
                            (f.type === "SIGNATURE" && isSigned
                              ? contract.signerName ?? ""
                              : "")
                          }
                          onChange={(v) =>
                            setFieldValues((s) => ({ ...s, [f.id]: v }))
                          }
                        />
                      ))}
                  </div>
                )}
              />
            </div>
          ) : (
          <object
            data={contract.fileUrl}
            type="application/pdf"
            className="hidden h-[70vh] w-full rounded-lg border border-zinc-200 sm:block"
          >
            <div className="rounded-lg border border-zinc-200 p-6 text-center">
              <FileText className="mx-auto h-7 w-7 text-zinc-300" />
              <a
                href={contract.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-sm font-semibold text-orange-600 underline"
              >
                Open {contract.fileName ?? "the document"}
              </a>
            </div>
          </object>
          )}
        </div>
      ) : (
        <article
          className="contract-body mb-6 text-[15px] leading-relaxed text-zinc-800"
          // The body is authored by the platform operator in the template
          // editor, not by any client — it is our own content, rendered back
          // to the person we sent it to.
          dangerouslySetInnerHTML={{ __html: contract.bodyHtml ?? "" }}
        />
      )}

      {/* Sign */}
      {!isSigned ? (
        <section className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
            <PenLine className="h-4 w-4" />
            Sign this agreement
          </h2>

          <label className="mt-3 block text-xs font-semibold text-zinc-700">
            Type your full name
          </label>
          <input
            value={signerName}
            onChange={(e) => setSignerName(e.target.value)}
            placeholder="Your full name"
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base focus:border-zinc-900 focus:outline-none"
          />
          {signerName.trim() && (
            <p className="mt-2 font-[cursive] text-2xl text-zinc-900">
              {signerName.trim()}
            </p>
          )}

          <label className="mt-3 flex items-start gap-2 text-[13px] leading-snug text-zinc-700">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I have read this agreement and I intend my typed name above to be
              my electronic signature, legally equivalent to signing by hand.
            </span>
          </label>

          {signError && (
            <p className="mt-2 text-xs text-red-600">{signError}</p>
          )}

          <button
            onClick={sign}
            disabled={!signerName.trim() || !agreed || signing}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {signing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            )}
            Sign agreement
          </button>
          <p className="mt-2 text-center text-[11px] text-zinc-500">
            Your name, the time, and your IP address are recorded as proof of
            signature.
          </p>
        </section>
      ) : contract.canSubscribe ? (
        <section className="rounded-xl border border-orange-200 bg-orange-50 p-4">
          <h2 className="text-sm font-semibold text-zinc-900">
            Start your subscription
          </h2>
          <p className="mt-1 text-sm text-zinc-600">
            {contract.locationName ?? "Your location"} —{" "}
            <strong>
              £{((contract.subscriptionAmountPence ?? 0) / 100).toFixed(2)}
            </strong>{" "}
            per month.
          </p>
          {contract.subscriptionStartedAt && (
            <p className="mt-2 text-xs text-zinc-500">
              You already started this on{" "}
              {new Date(contract.subscriptionStartedAt).toLocaleDateString(
                "en-GB",
              )}
              . Using the button again will take you back to checkout.
            </p>
          )}
          {subError && <p className="mt-2 text-xs text-red-600">{subError}</p>}
          <button
            onClick={subscribe}
            disabled={subscribing}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-orange-500 px-4 py-3 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {subscribing && <Loader2 className="h-4 w-4 animate-spin" />}
            Subscribe &amp; enter card details
          </button>
          <p className="mt-2 text-center text-[11px] text-zinc-500">
            Payment is handled securely by Stripe.
          </p>
        </section>
      ) : (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
          <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-600" />
          <p className="mt-2 text-sm font-semibold text-zinc-900">
            All done — thank you
          </p>
          <p className="mt-1 text-xs text-zinc-600">
            A copy has been emailed to {contract.recipientEmail}.
          </p>
        </section>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-100 py-6 sm:py-10">
      <div className="mx-auto max-w-2xl px-4">
        <div className="rounded-2xl bg-white p-5 shadow-sm sm:p-8">
          {children}
        </div>
        <p className="mt-4 text-center text-[11px] text-zinc-400">
          Sent securely via Order Hub
        </p>
      </div>
      {/* The template body is plain HTML with no classes of its own, so it
          needs base typography or every heading renders at body size. */}
      <style jsx global>{`
        .contract-body h1,
        .contract-body h2 {
          font-size: 1.15rem;
          font-weight: 700;
          margin: 1.4em 0 0.5em;
        }
        .contract-body h3 {
          font-size: 1rem;
          font-weight: 600;
          margin: 1.2em 0 0.4em;
        }
        .contract-body p {
          margin: 0 0 0.9em;
        }
        .contract-body ul,
        .contract-body ol {
          margin: 0 0 0.9em 1.25em;
          list-style: revert;
        }
        .contract-body strong {
          font-weight: 600;
        }
      `}</style>
    </div>
  );
}


/**
 * One placed box, rendered over the page as something you can actually tap.
 *
 * Sender-filled boxes render as flat text: they are part of the document, not
 * a question. The server enforces the same rule at sign time, so this is
 * presentation rather than protection.
 */
function FieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SignField;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const style: React.CSSProperties = {
    left: `${field.x * 100}%`,
    top: `${field.y * 100}%`,
    width: `${field.w * 100}%`,
    height: `${field.h * 100}%`,
  };

  if (field.assignee === "SENDER" || disabled) {
    return (
      <span
        style={style}
        className="absolute flex items-center overflow-hidden px-1 text-[11px] text-zinc-900"
      >
        <span className={field.type === "SIGNATURE" ? "italic" : ""}>
          {value}
        </span>
      </span>
    );
  }

  const shared =
    "absolute rounded border-2 border-blue-400 bg-blue-50/70 px-1 text-[11px] text-zinc-900 outline-none focus:border-orange-500 focus:bg-orange-50";

  if (field.type === "CHECKBOX") {
    return (
      <button
        type="button"
        style={style}
        onClick={() => onChange(value === "true" ? "" : "true")}
        className={`${shared} grid place-items-center`}
        aria-label={field.label ?? "Tick box"}
      >
        {value === "true" ? "✓" : ""}
      </button>
    );
  }

  return (
    <input
      style={style}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.label ?? ""}
      type={field.type === "DATE" ? "date" : "text"}
      className={`${shared} ${field.type === "SIGNATURE" ? "italic" : ""}`}
    />
  );
}
