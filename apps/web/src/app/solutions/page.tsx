import type { Metadata } from "next";
import { SolutionsOverview } from "@/components/marketing/detail/solutions-overview";

export const metadata: Metadata = {
  title: "Solutions — Order Hub",
  description:
    "POS, direct online ordering, menu management, your own driver app, dispatch and WhatsApp AI ordering — one connected platform for restaurants and takeaways.",
};

export default function SolutionsPage() {
  return <SolutionsOverview />;
}
