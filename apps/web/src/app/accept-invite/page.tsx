import type { Metadata } from "next";
import { Suspense } from "react";
import { AcceptInviteForm } from "./accept-invite-form";

export const metadata: Metadata = { title: "Accept invitation — Order Hub" };
export const dynamic = "force-dynamic";

export default function AcceptInvitePage() {
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center justify-center p-4">
      <Suspense
        fallback={
          <div className="text-sm text-zinc-500">Loading invitation…</div>
        }
      >
        <AcceptInviteForm />
      </Suspense>
    </div>
  );
}
