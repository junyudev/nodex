import { useState } from "react";
import { NodexButton } from "@/components/ui/button";
import { FileIcon } from "@/components/shared/icons";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { openExternalUrl } from "@/lib/file-system-operations";
import {
  resolveThreadSummaryPanelOutputOpenTarget,
  type ThreadSummaryPanelOutputRow,
} from "../projection/thread-summary-panel-output-model";

export function LocalConversationEndResources({
  resources,
  hostId,
  cwd,
  workspaceRoot,
}: {
  readonly resources: readonly ThreadSummaryPanelOutputRow[];
  readonly hostId: string;
  readonly cwd?: string | null;
  readonly workspaceRoot?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const files = useFileReferenceRouter();
  if (resources.length === 0) return null;
  const visible = expanded || resources.length <= 4 ? resources : resources.slice(0, 3);
  const hiddenCount = resources.length - visible.length;
  const open = async (resource: ThreadSummaryPanelOutputRow) => {
    const target = resolveThreadSummaryPanelOutputOpenTarget(resource);
    if (target.type === "url") {
      await openExternalUrl(target.url);
      return;
    }
    await files.open({ path: target.path }, { hostId, cwd, workspaceRoot, title: resource.label });
  };
  return (
    <div
      data-content-search-skip="true"
      className="flex flex-col divide-y-[0.5px] divide-token-border"
    >
      {visible.map((resource) => (
        <NodexButton
          key={resource.id}
          variant="ghost"
          className="h-auto w-full justify-start rounded-none px-0 py-2"
          onClick={() => {
            void open(resource).catch(() => undefined);
          }}
        >
          <FileIcon className="icon-sm shrink-0" />
          <span className="min-w-0 truncate text-sm">{resource.label}</span>
        </NodexButton>
      ))}
      {hiddenCount > 0 ? (
        <NodexButton
          variant="ghost"
          className="w-full justify-start rounded-none px-0"
          onClick={() => setExpanded(true)}
        >
          Show {hiddenCount} more
        </NodexButton>
      ) : null}
    </div>
  );
}
