import { redirect } from "next/navigation";

// /dashboard redirects to /dashboard/orders — the primary view.
export default function DashboardPage() {
  redirect("/dashboard/orders");
}
