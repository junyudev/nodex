import { useQuery } from "@tanstack/react-query";
import { ordinal } from "@/lib/page-turn-phrase";
import type { ConversationProviderPresentation } from "../thread-stage-types";

export function QueuedRunLabel({ position }: { readonly position: number }) {
  return (
    <span role="status" className="shrink-0 text-xs text-token-description-foreground">
      Queued · {ordinal(position)}
    </span>
  );
}

/** Queue positions are machine-wide and can change while this Thread emits no events. */
export function QueuedRunStatus({
  queue,
}: {
  readonly queue: NonNullable<ConversationProviderPresentation["admissionQueue"]>;
}) {
  const result = useQuery({
    queryKey: ["agent-runtime", "admission", queue.runId],
    queryFn: queue.read,
    refetchInterval: 1000,
  });
  return result.data ? <QueuedRunLabel position={result.data.position} /> : null;
}
