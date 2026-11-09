import { DeniedCircleIcon, SuccessCircleIcon } from "@/components/shared/icons";
import { SlashCircleIcon, WarningCircleIcon } from "@/components/shared/icons/plugin-detail-icons";
import type { WorkReportOutcome } from "@/lib/work-report";
import { cn } from "@/lib/utils";
const CHIPS = {
  ready: { icon: SuccessCircleIcon, tone: "text-info" },
  blocked: { icon: WarningCircleIcon, tone: "text-token-warning-foreground" },
  failed: { icon: DeniedCircleIcon, tone: "text-danger" },
  dropped: { icon: SlashCircleIcon, tone: "text-tertiary" },
};
export function WorkReportGlyph({
  outcome,
  className,
}: {
  readonly outcome: WorkReportOutcome;
  readonly className?: string;
}) {
  const chip = CHIPS[outcome];
  const Icon = chip.icon;
  return (
    <span aria-hidden="true" className={cn("flex shrink-0", chip.tone, className)}>
      <Icon className="size-3" />
    </span>
  );
}
