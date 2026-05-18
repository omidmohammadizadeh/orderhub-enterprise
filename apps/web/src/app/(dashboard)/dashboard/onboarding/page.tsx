"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Building2,
  Store,
  MapPin,
  Clock,
  Printer,
  Plug2,
  Users,
  CheckCircle2,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiClient } from "@/lib/api/client";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

// ── Step definitions ──────────────────────────────────────────────────────────

interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  optional?: boolean;
}

const STEPS: OnboardingStep[] = [
  { id: "brand", title: "Brand setup", description: "Create your restaurant brand", icon: Building2 },
  { id: "location", title: "First location", description: "Add your first restaurant location", icon: MapPin },
  { id: "hours", title: "Opening hours", description: "Set your trading hours", icon: Clock },
  { id: "menu", title: "Menu", description: "Create your first menu", icon: Store },
  { id: "printer", title: "Printer", description: "Set up receipt printing", icon: Printer, optional: true },
  { id: "integrations", title: "Integrations", description: "Connect delivery platforms", icon: Plug2, optional: true },
  { id: "team", title: "Invite team", description: "Add staff members", icon: Users, optional: true },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DEFAULT_HOURS = [
  { day: 1, open: "09:00", close: "22:00" },
  { day: 2, open: "09:00", close: "22:00" },
  { day: 3, open: "09:00", close: "22:00" },
  { day: 4, open: "09:00", close: "22:00" },
  { day: 5, open: "09:00", close: "23:00" },
  { day: 6, open: "10:00", close: "23:00" },
  { day: 0, open: "11:00", close: "21:00" },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState(0);
  const [completed, setCompleted] = useState<Set<string>>(new Set());

  // Form state
  const [brandName, setBrandName] = useState("");
  const [brandSlug, setBrandSlug] = useState("");
  const [locationName, setLocationName] = useState("");
  const [locationAddress, setLocationAddress] = useState("");
  const [locationCity, setLocationCity] = useState("");
  const [locationPostcode, setLocationPostcode] = useState("");
  const [locationPhone, setLocationPhone] = useState("");
  const [openingHours, setOpeningHours] = useState(DEFAULT_HOURS);
  const [printerName, setPrinterName] = useState("");
  const [printerIp, setPrinterIp] = useState("");
  const [inviteEmails, setInviteEmails] = useState("");

  // IDs created during onboarding
  const [brandId, setBrandId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);

  const brandMutation = useMutation({
    mutationFn: () =>
      apiClient.post("/v1/brands", { name: brandName, slug: brandSlug }).then((r) => r.data),
    onSuccess: (data) => {
      setBrandId(data.id);
      completeStep("brand");
    },
  });

  const locationMutation = useMutation({
    mutationFn: () =>
      apiClient.post("/v1/locations", {
        brandId,
        name: locationName,
        address: { line1: locationAddress, city: locationCity, postcode: locationPostcode },
        phone: locationPhone || undefined,
        slug: `${brandSlug}-${locationName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      }).then((r) => r.data),
    onSuccess: (data) => {
      setLocationId(data.id);
      completeStep("location");
    },
  });

  const hoursMutation = useMutation({
    mutationFn: () =>
      apiClient.patch(`/v1/locations/${locationId}`, { openingHours }).then((r) => r.data),
    onSuccess: () => completeStep("hours"),
  });

  const printerMutation = useMutation({
    mutationFn: () =>
      apiClient.post("/v1/printers", {
        locationId,
        name: printerName,
        type: "RECEIPT",
        connectionType: "LAN",
        ipAddress: printerIp,
        port: 9100,
        supportsReceipts: true,
      }, { params: { locationId } }).then((r) => r.data),
    onSuccess: () => completeStep("printer"),
  });

  const inviteMutation = useMutation({
    mutationFn: async () => {
      const emails = inviteEmails
        .split("\n")
        .map((e) => e.trim())
        .filter(Boolean);
      const results = await Promise.allSettled(
        emails.map((email) =>
          apiClient.post("/v1/users/invite", {
            email,
            firstName: email.split("@")[0] ?? "Team",
            lastName: "Member",
            role: "VIEWER",
          }).then((r) => r.data),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0 && failed === emails.length) {
        throw new Error("All invites failed to send");
      }
      return { sent: results.filter((r) => r.status === "fulfilled").length, failed };
    },
    onSuccess: () => completeStep("team"),
  });

  const completeStep = (stepId: string) => {
    setCompleted((p) => new Set([...p, stepId]));
    if (currentStep < STEPS.length - 1) {
      setCurrentStep((p) => p + 1);
    }
  };

  const skipStep = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep((p) => p + 1);
    }
  };

  const finishOnboarding = () => {
    router.push("/dashboard");
  };

  const step = STEPS[currentStep];
  const progress = ((currentStep) / (STEPS.length - 1)) * 100;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Progress header */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-lg font-semibold text-zinc-900">Account setup</h1>
          <span className="text-sm text-zinc-400">{currentStep + 1} of {STEPS.length}</span>
        </div>
        <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-orange-500 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Step indicators */}
      <div className="grid grid-cols-7 gap-1">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            onClick={() => i <= currentStep && setCurrentStep(i)}
            className={cn(
              "flex flex-col items-center gap-1 p-1 rounded-lg transition-colors",
              i === currentStep && "bg-orange-50",
              i < currentStep && "cursor-pointer hover:bg-zinc-50",
              i > currentStep && "cursor-default opacity-40",
            )}
          >
            <div className={cn(
              "h-8 w-8 rounded-full flex items-center justify-center",
              completed.has(s.id) ? "bg-emerald-100" : i === currentStep ? "bg-orange-100" : "bg-zinc-100",
            )}>
              {completed.has(s.id) ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <s.icon className={cn("h-4 w-4", i === currentStep ? "text-orange-600" : "text-zinc-400")} />
              )}
            </div>
            <span className={cn("text-[9px] font-medium text-center leading-tight hidden sm:block",
              i === currentStep ? "text-orange-600" : "text-zinc-400"
            )}>
              {s.title}
            </span>
          </button>
        ))}
      </div>

      {/* Active step card */}
      <Card className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-100">
            <step.icon className="h-5 w-5 text-orange-600" />
          </div>
          <div>
            <h2 className="font-semibold text-zinc-900">{step.title}</h2>
            <p className="text-sm text-zinc-400">{step.description}</p>
          </div>
          {step.optional && (
            <Badge className="ml-auto bg-zinc-100 text-zinc-500 text-[10px]">Optional</Badge>
          )}
        </div>

        {/* Step content */}
        {step.id === "brand" && (
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-zinc-500 mb-1">Brand name *</Label>
              <Input
                autoFocus
                placeholder="e.g. The Pizza Place"
                value={brandName}
                onChange={(e) => {
                  setBrandName(e.target.value);
                  setBrandSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
                }}
                className="h-10"
              />
            </div>
            <div>
              <Label className="text-xs text-zinc-500 mb-1">Brand slug (URL-friendly)</Label>
              <Input
                placeholder="the-pizza-place"
                value={brandSlug}
                onChange={(e) => setBrandSlug(e.target.value)}
                className="h-10 font-mono text-sm"
              />
              <p className="text-[11px] text-zinc-400 mt-1">Used in your online ordering URL: /order/{brandSlug}-...</p>
            </div>
            <StepActions
              onNext={() => brandMutation.mutate()}
              isLoading={brandMutation.isPending}
              disabled={!brandName.trim() || !brandSlug.trim()}
              error={brandMutation.isError ? "Failed to create brand. Try a different slug." : undefined}
            />
          </div>
        )}

        {step.id === "location" && (
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-zinc-500 mb-1">Location name *</Label>
              <Input autoFocus placeholder="e.g. Shoreditch" value={locationName} onChange={(e) => setLocationName(e.target.value)} className="h-10" />
            </div>
            <div>
              <Label className="text-xs text-zinc-500 mb-1">Address *</Label>
              <Input placeholder="123 High Street" value={locationAddress} onChange={(e) => setLocationAddress(e.target.value)} className="h-10" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs text-zinc-500 mb-1">City *</Label>
                <Input placeholder="London" value={locationCity} onChange={(e) => setLocationCity(e.target.value)} className="h-10" />
              </div>
              <div>
                <Label className="text-xs text-zinc-500 mb-1">Postcode *</Label>
                <Input placeholder="EC1A 1BB" value={locationPostcode} onChange={(e) => setLocationPostcode(e.target.value)} className="h-10" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-zinc-500 mb-1">Phone (optional)</Label>
              <Input placeholder="+44 20 7946 0000" type="tel" value={locationPhone} onChange={(e) => setLocationPhone(e.target.value)} className="h-10" />
            </div>
            <StepActions
              onNext={() => locationMutation.mutate()}
              isLoading={locationMutation.isPending}
              disabled={!locationName.trim() || !locationAddress.trim() || !locationCity.trim() || !locationPostcode.trim()}
              error={locationMutation.isError ? "Failed to create location." : undefined}
            />
          </div>
        )}

        {step.id === "hours" && (
          <div className="space-y-2">
            {DAY_NAMES.map((day, i) => {
              const dayNum = i;
              const hours = openingHours.find((h) => h.day === dayNum);
              const isOpen = !!hours;
              return (
                <div key={day} className="flex items-center gap-3 py-1">
                  <button
                    onClick={() => {
                      if (isOpen) {
                        setOpeningHours((prev) => prev.filter((h) => h.day !== dayNum));
                      } else {
                        setOpeningHours((prev) => [...prev, { day: dayNum, open: "09:00", close: "22:00" }]);
                      }
                    }}
                    className={cn(
                      "h-5 w-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors",
                      isOpen ? "bg-orange-500 border-orange-500" : "border-zinc-300"
                    )}
                  >
                    {isOpen && <CheckCircle2 className="h-3 w-3 text-white" />}
                  </button>
                  <span className="text-sm text-zinc-700 w-24 font-medium">{day}</span>
                  {isOpen ? (
                    <div className="flex items-center gap-2 flex-1">
                      <Input
                        type="time"
                        value={hours.open}
                        onChange={(e) => setOpeningHours((prev) =>
                          prev.map((h) => h.day === dayNum ? { ...h, open: e.target.value } : h)
                        )}
                        className="h-8 text-xs w-28"
                      />
                      <span className="text-zinc-400 text-xs">to</span>
                      <Input
                        type="time"
                        value={hours.close}
                        onChange={(e) => setOpeningHours((prev) =>
                          prev.map((h) => h.day === dayNum ? { ...h, close: e.target.value } : h)
                        )}
                        className="h-8 text-xs w-28"
                      />
                    </div>
                  ) : (
                    <span className="text-xs text-zinc-400">Closed</span>
                  )}
                </div>
              );
            })}
            <StepActions
              onNext={() => hoursMutation.mutate()}
              isLoading={hoursMutation.isPending}
              disabled={false}
            />
          </div>
        )}

        {step.id === "menu" && (
          <div className="text-center py-6">
            <Store className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
            <p className="font-medium text-zinc-700 mb-2">Your menu is where the magic happens</p>
            <p className="text-sm text-zinc-400 mb-6">
              You&apos;ll be redirected to the menu builder where you can create categories, add items, and set up modifiers.
            </p>
            <div className="flex gap-2 justify-center">
              <Button
                className="bg-orange-500 hover:bg-orange-600 text-white gap-1.5"
                onClick={() => {
                  completeStep("menu");
                }}
              >
                Go to menu builder <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={skipStep}>Skip for now</Button>
            </div>
          </div>
        )}

        {step.id === "printer" && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-500">
              Connect a LAN thermal printer to automatically print receipts and kitchen tickets when orders arrive.
            </p>
            <div>
              <Label className="text-xs text-zinc-500 mb-1">Printer name</Label>
              <Input placeholder="e.g. Front counter" value={printerName} onChange={(e) => setPrinterName(e.target.value)} className="h-10" />
            </div>
            <div>
              <Label className="text-xs text-zinc-500 mb-1">Printer IP address</Label>
              <Input placeholder="192.168.1.100" value={printerIp} onChange={(e) => setPrinterIp(e.target.value)} className="h-10 font-mono text-sm" />
            </div>
            <div className="flex gap-2 mt-5">
              <Button
                className="bg-orange-500 hover:bg-orange-600 text-white"
                size="sm"
                onClick={() => printerMutation.mutate()}
                disabled={!printerName.trim() || !printerIp.trim() || printerMutation.isPending}
              >
                {printerMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                Add printer
              </Button>
              <Button variant="outline" size="sm" onClick={skipStep}>Skip for now</Button>
            </div>
          </div>
        )}

        {step.id === "integrations" && (
          <div className="text-center py-4">
            <Plug2 className="h-10 w-10 text-zinc-300 mx-auto mb-3" />
            <p className="font-medium text-zinc-700 mb-1">Connect delivery platforms</p>
            <p className="text-sm text-zinc-400 mb-5">
              Uber Eats, Deliveroo, Just Eat, and HubRise integrations are configured in the Integrations section.
            </p>
            <div className="flex gap-2 justify-center">
              <Button
                className="bg-orange-500 hover:bg-orange-600 text-white gap-1.5"
                onClick={() => completeStep("integrations")}
              >
                Go to Integrations <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={skipStep}>Skip for now</Button>
            </div>
          </div>
        )}

        {step.id === "team" && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-500">
              Invite team members by email. They&apos;ll receive a setup link to create their password.
            </p>
            <div>
              <Label className="text-xs text-zinc-500 mb-1">Email addresses (one per line)</Label>
              <textarea
                className="w-full h-28 rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent resize-none"
                placeholder="manager@restaurant.com&#10;chef@restaurant.com"
                value={inviteEmails}
                onChange={(e) => setInviteEmails(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                className="bg-orange-500 hover:bg-orange-600 text-white"
                size="sm"
                disabled={!inviteEmails.trim() || inviteMutation.isPending}
                onClick={() => inviteMutation.mutate()}
              >
                {inviteMutation.isPending ? "Sending…" : "Send invites"}
              </Button>
              <Button variant="outline" size="sm" onClick={skipStep}>Skip for now</Button>
              {inviteMutation.isError && (
                <p className="text-xs text-red-500 self-center">
                  {inviteMutation.error instanceof Error ? inviteMutation.error.message : "Failed to send invites"}
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* Finish */}
      {currentStep === STEPS.length - 1 && completed.size > 0 && (
        <div className="flex justify-center">
          <Button
            size="lg"
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-8 gap-2"
            onClick={finishOnboarding}
          >
            <CheckCircle2 className="h-5 w-5" />
            Finish setup
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Step actions ──────────────────────────────────────────────────────────────

function StepActions({
  onNext,
  isLoading,
  disabled,
  error,
}: {
  onNext: () => void;
  isLoading: boolean;
  disabled: boolean;
  error?: string;
}) {
  return (
    <div className="mt-5">
      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}
      <Button
        className="bg-orange-500 hover:bg-orange-600 text-white gap-1.5"
        size="sm"
        onClick={onNext}
        disabled={disabled || isLoading}
      >
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Continue <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
