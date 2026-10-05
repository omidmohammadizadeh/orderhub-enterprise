import type { EmailCampaignStatus } from "@/lib/api/email-marketing.client";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<EmailCampaignStatus, string> = {
  DRAFT: "bg-zinc-100 text-zinc-700",
  SCHEDULED: "bg-sky-100 text-sky-800",
  SENDING: "bg-amber-100 text-amber-800",
  SENT: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-zinc-100 text-zinc-500",
  FAILED: "bg-rose-100 text-rose-800",
};

export function EmailStatusBadge({ status }: { status: EmailCampaignStatus }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        STATUS_STYLE[status],
      )}
    >
      {status.toLowerCase()}
    </span>
  );
}
