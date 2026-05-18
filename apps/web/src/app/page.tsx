import { redirect } from "next/navigation";

// Root redirect — send unauthenticated users to /login.
// The dashboard layout handles authenticated redirect to /dashboard/orders.
export default function RootPage() {
  redirect("/login");
}
