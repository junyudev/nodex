import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
import { PauseIcon as Pause, PlayIcon as Play } from "@/components/shared/icons/canonical-icons";
import { useExecutionHold } from "@/lib/execution-holds-runtime";
import { NodexDropdownItem } from "@/components/ui/dropdown";
import { ToolbarIconButton } from "./workbench-panel-controls";
import { toast } from "@/components/ui/toast";
const failed = (error: unknown) =>
  toast.danger(
    error instanceof Error
      ? error.message
      : getIntl().formatMessage({
          id: "workbench.executionHoldControls.updateFailed",
          defaultMessage: "Work pause could not be updated",
        }),
  );
export function PageExecutionHoldItem({ pageId }: { readonly pageId: string }) {
  const intl = useIntl();
  const hold = useExecutionHold({ kind: "page", page_id: pageId });
  return (
    <NodexDropdownItem
      leftSlot={hold.paused ? <Play className="icon-2xs" /> : <Pause className="icon-2xs" />}
      onSelect={() => void hold.setPaused(!hold.paused).catch(failed)}
    >
      {hold.paused
        ? intl.formatMessage({
            id: "workbench.executionHoldControls.resume",
            defaultMessage: "Resume work",
          })
        : intl.formatMessage({
            id: "workbench.executionHoldControls.pause",
            defaultMessage: "Pause work",
          })}
    </NodexDropdownItem>
  );
}
/**
 * While all Agent work is paused, says so and resumes it. It is the Space's state, so a toolbar
 * keeps it in view when it gathers its tools into a menu.
 */
export function SpaceExecutionResume() {
  const hold = useExecutionHold({ kind: "space" });
  if (!hold.paused) return null;
  return (
    <button
      type="button"
      className="shrink-0 rounded-full px-2 py-1 text-xs whitespace-nowrap text-token-text-secondary hover:bg-token-foreground/5"
      onClick={() => void hold.setPaused(false).catch(failed)}
    >
      <FormattedMessage
        id="workbench.executionHoldControls.pausedResume"
        defaultMessage={"Paused · Resume"}
      />
    </button>
  );
}

/** While Agent work runs, pauses all of it: a toolbar tool, or an item of a toolbar's menu. */
export function SpaceExecutionPause({ item = false }: { readonly item?: boolean }) {
  const intl = useIntl();
  const hold = useExecutionHold({ kind: "space" });
  if (hold.paused) return null;
  const label = intl.formatMessage({
    id: "workbench.executionHoldControls.pauseAllAgentWork",
    defaultMessage: "Pause all Agent work",
  });
  const pause = () => void hold.setPaused(true).catch(failed);
  return item ? (
    <NodexDropdownItem leftSlot={<Pause className="icon-xs" />} onSelect={pause}>
      {label}
    </NodexDropdownItem>
  ) : (
    <ToolbarIconButton label={label} onClick={pause}>
      <Pause className="size-3.5" />
    </ToolbarIconButton>
  );
}
