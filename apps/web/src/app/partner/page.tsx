import type { Metadata } from "next";
import { PartnerPage } from "@/components/efl-partner/partner-page";

export const metadata: Metadata = {
  title: { absolute: "Partner with Eat For Less" },
  description:
    "List your takeaway on Eat For Less alongside the apps you already use. Weekly payouts, your drivers or ours, no new till. Apply in about 5 minutes.",
};

export default function Page() {
  return <PartnerPage />;
}
