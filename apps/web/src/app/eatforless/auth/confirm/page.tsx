import type { Metadata } from "next";
import { Suspense } from "react";
import { ConfirmEmail } from "@/components/eatforless/order/confirm-email";

export const metadata: Metadata = { title: "Confirm your email", robots: { index: false, follow: false } };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ConfirmEmail />
    </Suspense>
  );
}
