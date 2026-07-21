// Short payment-link redirect: /p/<code>
//
// We text customers this tiny URL instead of the long hosted Stripe checkout
// URL so a payment SMS fits in a single Twilio segment (7p). This handler
// resolves the code via the API (which mints a fresh Stripe session so an
// expired one never dead-ends the customer) and 302-redirects to it.

import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ code: string }> },
) {
  const { code } = await ctx.params;
  const apiBase = (
    process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000"
  ).replace(/\/+$/, "");

  try {
    const res = await fetch(
      `${apiBase}/api/v1/payments/pay/${encodeURIComponent(code)}`,
      { cache: "no-store" },
    );
    if (res.ok) {
      const data = (await res.json()) as { url?: string; paid?: boolean };
      if (data?.url) {
        return NextResponse.redirect(data.url, 302);
      }
      if (data?.paid) {
        // Already settled — send them somewhere friendly rather than Stripe.
        return NextResponse.redirect(
          new URL("/?paid=1", req.nextUrl.origin),
          302,
        );
      }
    }
  } catch {
    /* fall through to the friendly fallback below */
  }

  // Unknown / expired code, or the API was unreachable.
  return NextResponse.redirect(new URL("/?payErr=1", req.nextUrl.origin), 302);
}
