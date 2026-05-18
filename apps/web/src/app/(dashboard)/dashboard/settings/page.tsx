import type { Metadata } from "next";
import {
  Building2,
  Users,
  CreditCard,
  Shield,
  Bell,
  Key,
  ChevronRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Settings" };

const SETTING_SECTIONS = [
  {
    id: "general",
    icon: Building2,
    title: "General",
    description: "Business name, timezone, currency, and branding.",
    badge: null,
    available: true,
  },
  {
    id: "team",
    icon: Users,
    title: "Team & Permissions",
    description: "Invite team members, assign roles and permissions.",
    badge: "1 member",
    available: true,
  },
  {
    id: "billing",
    icon: CreditCard,
    title: "Billing & Plan",
    description: "Manage your subscription and payment method.",
    badge: "Professional",
    available: true,
  },
  {
    id: "security",
    icon: Shield,
    title: "Security",
    description: "Two-factor authentication, session management, and audit log.",
    badge: null,
    available: true,
  },
  {
    id: "notifications",
    icon: Bell,
    title: "Notifications",
    description: "Email and push notification preferences.",
    badge: null,
    available: true,
  },
  {
    id: "api-keys",
    icon: Key,
    title: "API Keys",
    description: "Create and manage API keys for external integrations.",
    badge: "Coming soon",
    available: false,
  },
];

export default function SettingsPage() {
  return (
    <div className="space-y-6 max-w-3xl">
      <div className="space-y-2">
        {SETTING_SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <Card
              key={section.id}
              className={`transition-shadow hover:shadow-card ${!section.available ? "opacity-60" : "cursor-pointer"}`}
            >
              <CardContent className="p-0">
                <button
                  className="flex w-full items-center gap-4 p-5 text-left"
                  disabled={!section.available}
                >
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-zinc-100">
                    <Icon className="h-4.5 w-4.5 text-zinc-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-zinc-900">{section.title}</p>
                      {section.badge && (
                        <Badge
                          variant={section.available ? "info" : "default"}
                          className="text-[10px]"
                        >
                          {section.badge}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500">{section.description}</p>
                  </div>
                  {section.available && (
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-zinc-400" />
                  )}
                </button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Danger zone */}
      <Card className="border-red-200">
        <CardContent className="p-5">
          <h3 className="text-sm font-semibold text-red-700">Danger Zone</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Irreversible and destructive actions. Proceed with caution.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="outline" size="sm" className="border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300">
              Delete workspace
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
