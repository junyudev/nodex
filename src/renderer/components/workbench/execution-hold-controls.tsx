import { PauseIcon as Pause, PlayIcon as Play } from "@/components/shared/icons/canonical-icons";
import { useExecutionHold } from "@/lib/execution-holds-runtime";
import { NodexDropdownItem } from "@/components/ui/dropdown";
import { ToolbarIconButton } from "./workbench-panel-controls";
import { toast } from "@/components/ui/toast";
const failed = (error: unknown) =>
  toast.danger(error instanceof Error ? error.message : "Work pause could not be updated");
export function PageExecutionHoldItem({ pageId }: { readonly pageId: string }) {
  const hold = useExecutionHold({ kind: "page", page_id: pageId });
  return (
    <NodexDropdownItem
      leftSlot={hold.paused ? <Play className="icon-2xs" /> : <Pause className="icon-2xs" />}
      onSelect={() => void hold.setPaused(!hold.paused).catch(failed)}
    >
      {hold.paused ? "Resume work" : "Pause work"}
    </NodexDropdownItem>
  );
}
export function SpaceExecutionHoldControl() {
  const hold = useExecutionHold({ kind: "space" });
  if (hold.paused)
    return (
      <button
        type="button"
        className="rounded-full px-2 py-1 text-xs text-token-text-secondary hover:bg-token-foreground/5"
        onClick={() => void hold.setPaused(false).catch(failed)}
      >
        Paused · Resume
      </button>
    );
  return (
    <ToolbarIconButton
      label="Pause all Agent work"
      onClick={() => void hold.setPaused(true).catch(failed)}
    >
      <Pause className="size-3.5" />
    </ToolbarIconButton>
  );
}
