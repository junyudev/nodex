import { useSyncExternalStore } from "react";
import { NodexButton } from "@/components/ui/button";
import { useCodexAppServerRegistry } from "../local-conversation-store";
import type { CodexTranscriptKey } from "../../../../shared/codex-transcript-projection";
import type { PendingArtifactRecovery } from "../local-conversation-pending-artifact-recovery";

export function PendingArtifactRecoveryStatus({
  recovery,
}: {
  readonly recovery: PendingArtifactRecovery;
}) {
  const status = useSyncExternalStore(recovery.subscribe, recovery.getStatus);
  return (
    <div
      role="status"
      data-content-search-skip="true"
      className="flex items-center gap-2 py-2 text-sm text-token-text-tertiary"
    >
      <span>
        {status === "loading"
          ? "Loading artifact…"
          : status === "failed"
            ? "Couldn’t load artifact"
            : "Artifact not available yet"}
      </span>
      {status !== "exhausted" && (
        <NodexButton
          variant="ghost"
          size="xs"
          disabled={status === "loading"}
          onClick={() => void recovery.hydrate("retry")}
        >
          Load older history
        </NodexButton>
      )}
    </div>
  );
}

export function LocalConversationPendingArtifact({
  ownerKey,
}: {
  readonly ownerKey: CodexTranscriptKey;
}) {
  const registry = useCodexAppServerRegistry();
  const manager = registry.getForHostId(ownerKey.hostId);
  return (
    <PendingArtifactRecoveryStatus
      recovery={manager.getPendingArtifactRecovery(ownerKey.threadId)}
    />
  );
}
