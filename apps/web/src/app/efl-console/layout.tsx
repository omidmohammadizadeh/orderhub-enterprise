import type { Metadata } from "next";
import { AuthGuard } from "@/components/dashboard/auth-guard";
import { ConsoleShell } from "@/components/efl-console/console-shell";

// The Eat For Less Console. Lives in the OrderHub web app for now; it moves
// to console.eatforless.co.uk once that domain exists, which is a routing
// change, not a rebuild.
export const metadata: Metadata = {
  title: "Eat For Less Console",
  robots: { index: false, follow: false },
};

export default function EflConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <ConsoleShell>{children}</ConsoleShell>
    </AuthGuard>
  );
}
