import { AuthGuard } from "@/components/dashboard/auth-guard";
import { Sidebar } from "@/components/dashboard/sidebar";
import { Topbar } from "@/components/dashboard/topbar";

// This layout wraps every route inside (dashboard)/ — which includes
// all /dashboard/* pages. AuthGuard enforces authentication before
// any page content is rendered.
//
// Structure:
//   ┌──────────┬──────────────────────────────┐
//   │ Sidebar  │ Topbar                        │
//   │          ├──────────────────────────────┤
//   │          │ {children}                   │
//   └──────────┴──────────────────────────────┘
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex h-screen overflow-hidden bg-zinc-50">
        <Sidebar />
        <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
          <Topbar />
          <main className="flex-1 overflow-y-auto">
            <div className="page-enter p-6 max-w-screen-2xl">
              {children}
            </div>
          </main>
        </div>
      </div>
    </AuthGuard>
  );
}
