import { useQuery } from "@tanstack/react-query";

import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { readProductAnalyticsActivity } from "@/lib/product-analytics";
import type { ProductAnalyticsActivityEntry } from "../../../shared/product-analytics/activity";

const formatTime = (time: number) =>
  new Date(time).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });

function EventRow({ entry, state }: { entry: ProductAnalyticsActivityEntry; state: string }) {
  const { name, properties, value } = entry.event;
  const fields = Object.entries(properties).filter(([, field]) => field !== undefined);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-token-border-light py-1.5 last:border-b-0">
      <span className="truncate font-mono text-xs">{name}</span>
      <span className="text-xs text-token-description-foreground tabular-nums">
        {state} · {formatTime(entry.time)}
      </span>
      {fields.length > 0 || value !== undefined ? (
        <span className="col-span-2 font-mono text-[11px] break-words text-token-description-foreground">
          {[
            ...(value === undefined ? [] : [`value=${value}`]),
            ...fields.map(([key, field]) => `${key}=${String(field)}`),
          ].join(" ")}
        </span>
      ) : null}
    </li>
  );
}

/** The exact records this installation has reported or is about to report, read from Main. */
export function ProductAnalyticsActivityDialog({ onClose }: { readonly onClose: () => void }) {
  const { data: activity } = useQuery({
    queryKey: ["product-analytics-activity"],
    queryFn: readProductAnalyticsActivity,
    gcTime: 0,
  });
  const context = Object.entries(activity?.context ?? {});
  const entries = [
    ...(activity?.pending ?? []).map((entry) => ({ entry, state: "Waiting" })),
    ...(activity?.sent ?? []).map((entry) => ({ entry, state: "Sent" })),
  ].toSorted((left, right) => right.entry.time - left.entry.time);

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="wide">
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>What usage analytics send</NodexDialogTitle>
            <NodexDialogDescription>
              Every event carries the random ID and app details below, and nothing else about you.
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-xs">
              {activity?.installationId ? (
                <>
                  <dt className="text-token-description-foreground">id</dt>
                  <dd className="truncate">{activity.installationId}</dd>
                </>
              ) : null}
              {context.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-token-description-foreground">{key}</dt>
                  <dd className="truncate">{value}</dd>
                </div>
              ))}
            </dl>
            {entries.length > 0 ? (
              <ul className="mt-3 max-h-80 overflow-y-auto">
                {entries.map(({ entry, state }) => (
                  <EventRow
                    key={`${state}:${entry.time}:${entry.event.name}`}
                    entry={entry}
                    state={state}
                  />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-token-description-foreground">
                {activity?.active === false
                  ? "Nothing is being sent from this installation."
                  : "No events since Nodex started."}
              </p>
            )}
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction tone="primary" onClick={onClose} autoFocus>
              Done
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
