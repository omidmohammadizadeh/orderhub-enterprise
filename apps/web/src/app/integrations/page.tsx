import type { Metadata } from "next";
import { IntegrationsOverview } from "@/components/marketing/detail/integrations-overview";

export const metadata: Metadata = {
  title: "Integrations — Order Hub",
  description:
    "Uber Eats, Deliveroo, Uber Direct, Stuart, HubRise, Just Eat, Stripe and the Order Hub POS — every channel connected into one board.",
};

export default function IntegrationsPage() {
  return <IntegrationsOverview />;
}
