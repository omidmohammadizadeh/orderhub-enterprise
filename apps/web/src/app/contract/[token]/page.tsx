"use client";

// The signing page — what the counterparty sees.
//
// The token in the URL is the only credential; there is no login here and
// never will be, the same rule the QR-at-table and payment-link pages follow.
// Everything on screen comes from one public endpoint keyed by that token.

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  CheckCircle2,
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
}

export default function SignContractPage() {
  const params = useParams<{ token: string }>();
  const token = String(params.token);

  const [contract, setContract] = useState<ContractView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [signerName, setSignerName] = useState("");
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
        body: JSON.stringify({ signerName: signerName.trim() }),
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
        <h1 className="text-xl font-bold text-zinc-900">{contract.title}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Prepared for {contract.recipientName}
          {contract.recipientCompany ? ` · ${contract.recipientCompany}` : ""}
          {contract.locationName ? ` · ${contract.locationName}` : ""}
        </p>
        {isSigned && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Signed by {contract.signerName} on{" "}
            {contract.signedAt
              ? new Date(contract.signedAt).toLocaleString("en-GB")
              : ""}
          </div>
        )}
      </header>

      {/* The document */}
      {contract.fileUrl ? (
        <div className="mb-6">
          <object
            data={contract.fileUrl}
            type="application/pdf"
            className="h-[70vh] w-full rounded-lg border border-zinc-200"
          >
            {/* iOS Safari won't render an inline PDF object, so give it a link
                rather than an empty grey box. */}
            <div className="rounded-lg border border-zinc-200 p-6 text-center">
              <FileText className="mx-auto h-7 w-7 text-zinc-300" />
              <p className="mt-2 text-sm text-zinc-600">
                Your browser can&apos;t show the document inline.
              </p>
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
