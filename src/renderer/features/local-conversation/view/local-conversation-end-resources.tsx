import { useState } from "react";
import { OpenInIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import {
  describeThreadOutput,
  isExternalThreadOutputOpen,
  type ThreadOutputPresentation,
} from "../projection/thread-output-presentation";
import type { ThreadSummaryPanelOutputRow } from "../projection/thread-summary-panel-output-model";
import {
  ThreadResourceCard,
  ThreadResourceCardGrid,
  ThreadResourceCardMore,
} from "./shared/thread-resource-card";
import {
  isContextMenuKey,
  ThreadOutputIcon,
  useThreadOutputOpener,
  type ThreadOutputScope,
} from "./use-thread-output-opener";

/** Kind first, then the folder; the innermost folder survives truncation. */
function ThreadOutputDetail({ presentation }: { readonly presentation: ThreadOutputPresentation }) {
  const { kind, location } = presentation;
  return (
    <span className="flex min-w-0 text-sm text-token-description-foreground">
      <span className="shrink-0">{kind}</span>
      {location ? (
        <>
          <span className="shrink-0 px-1" aria-hidden>
            ·
          </span>
          <span className="truncate">{location.head}</span>
          <span className="max-w-full shrink-0 truncate">{location.tail}</span>
        </>
      ) : null}
    </span>
  );
}

/** The deliverables a completed turn produced, as cards after its response. */
export function LocalConversationEndResources({
  resources,
  hostId,
  cwd,
  workspaceRoot,
}: {
  readonly resources: readonly ThreadSummaryPanelOutputRow[];
} & ThreadOutputScope) {
  const [expanded, setExpanded] = useState(false);
  const outputs = useThreadOutputOpener({ hostId, cwd, workspaceRoot });
  if (resources.length === 0) return null;
  const visible = expanded || resources.length <= 4 ? resources : resources.slice(0, 3);
  const hiddenCount = resources.length - visible.length;
  return (
    <div data-content-search-skip="true" className="flex flex-col gap-2">
      <ThreadResourceCardGrid>
        {visible.map((resource) => {
          const presentation = describeThreadOutput(resource, cwd);
          return (
            <ThreadResourceCard
              key={resource.id}
              aria-label={`Open ${presentation.title}`}
              icon={<ThreadOutputIcon row={resource} className="size-5" />}
              title={presentation.title}
              detail={<ThreadOutputDetail presentation={presentation} />}
              trailing={
                isExternalThreadOutputOpen(resource, hostId) ? (
                  <OpenInIcon className="icon-xs" aria-hidden />
                ) : undefined
              }
              onClick={(event) => {
                const origin = event.currentTarget;
                void outputs.open(resource, origin).then((opened) => {
                  if (!opened && origin.isConnected)
                    toast.danger(`Couldn’t open ${presentation.title}`);
                });
              }}
              onContextMenu={(event) => outputs.openContextMenu(resource, event)}
              onKeyDown={(event) => {
                if (isContextMenuKey(event)) outputs.openContextMenu(resource, event);
              }}
            />
          );
        })}
      </ThreadResourceCardGrid>
      {hiddenCount > 0 ? (
        <ThreadResourceCardMore
          label={`Show ${hiddenCount} more`}
          onClick={() => setExpanded(true)}
        />
      ) : null}
      {outputs.preview}
    </div>
  );
}
