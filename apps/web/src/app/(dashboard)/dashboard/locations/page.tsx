import type { Metadata } from "next";
import { MapPin, Plus, CheckCircle2, Settings } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Locations" };

// Seeded demo location — matches packages/database/prisma/seed.ts
const DEMO_LOCATION = {
  id: "loc_demo_001",
  name: "Burger Co — London Bridge",
  brand: "Burger Co",
  address: "1 London Bridge St, London SE1 9BG",
  timezone: "Europe/London",
  isActive: true,
  integrations: 0,
  openOrders: 0,
};

export default function LocationsPage() {
  return (
    <div className="space-y-6">
      {/* Actions */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          <span className="font-semibold text-zinc-900">1</span> location
        </p>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" />
          Add location
        </Button>
      </div>

      {/* Locations list */}
      <div className="space-y-3">
        <Card className="hover:shadow-card transition-shadow">
          <CardContent className="p-5">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-zinc-100">
                <MapPin className="h-5 w-5 text-zinc-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">{DEMO_LOCATION.name}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">{DEMO_LOCATION.address}</p>
                    <p className="text-xs text-zinc-400 mt-0.5">
                      {DEMO_LOCATION.timezone} · Brand: {DEMO_LOCATION.brand}
                    </p>
                  </div>
                  <Badge
                    variant={DEMO_LOCATION.isActive ? "success" : "default"}
                    className="flex-shrink-0 gap-1"
                  >
                    {DEMO_LOCATION.isActive && <CheckCircle2 className="h-2.5 w-2.5" />}
                    {DEMO_LOCATION.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
                <div className="mt-4 flex items-center gap-4">
                  <span className="text-xs text-zinc-400">
                    <span className="font-medium text-zinc-700">{DEMO_LOCATION.integrations}</span>{" "}
                    integrations connected
                  </span>
                  <span className="text-xs text-zinc-400">
                    <span className="font-medium text-zinc-700">{DEMO_LOCATION.openOrders}</span>{" "}
                    open orders
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <Button variant="outline" size="sm">
                      <Settings className="h-3.5 w-3.5" />
                      Manage
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Add more CTA */}
      <Card className="border-dashed">
        <CardContent className="flex items-center justify-center py-8">
          <div className="text-center">
            <p className="text-sm font-medium text-zinc-600">Add another location</p>
            <p className="mt-0.5 text-xs text-zinc-400">
              Each location can have its own menus, integrations, and KDS.
            </p>
            <Button variant="outline" size="sm" className="mt-3">
              <Plus className="h-3.5 w-3.5" />
              Add location
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
