// Where Stripe returns the client after a shared link is paid.
//
// A static path, so it takes precedence over /subscribe/[token] — "done" is
// never read as a token.

export default function SubscribeDonePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-zinc-900">
          You&apos;re all set
        </h1>
        <p className="mt-2 text-sm text-zinc-600">
          Thanks — your card is on file and the subscription is active. A
          receipt is on its way by email.
        </p>
      </div>
    </main>
  );
}
