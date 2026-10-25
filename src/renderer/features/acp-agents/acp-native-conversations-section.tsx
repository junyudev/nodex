import { useEffect, useEffectEvent, useState } from "react";
import { DeleteIcon, RefreshIcon } from "@/components/shared/icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { NodexSettingsRow, NodexSettingsSection } from "@/components/ui/settings";
import {
  ConversationImportDestinationPicker,
  conversationTitle,
  type ConversationImportDestinations,
} from "@/components/workbench/conversation-import-list";
import type { SettingsOpenThread } from "@/components/workbench/workbench-settings-page-registry";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import type { AcpFailure, AcpResult } from "../../../shared/acp-api";
import type { AcpAgentInstanceConfig } from "../../../shared/acp-agent-settings";
import { createUuidV7 } from "../../../shared/uuid-v7";
import {
  acpFailureText,
  acpProviderDiscovered,
  type AcpNativeSession,
  type AcpNativeSessionPage,
  type AcpProviderSnapshot,
} from "./acp-agent-model";
import type { AcpAgentsOwner } from "./acp-agents-owner";
import { acpAgentsOwner, useAcpAgents } from "./use-acp-agents";

type RowState =
  | { readonly kind: "preparing" | "importing" | "opening" | "deleting" | "confirm-delete" }
  | { readonly kind: "confirm-resume" }
  | { readonly kind: "failed"; readonly message: string };

interface Listing {
  readonly sessions: readonly AcpNativeSession[];
  readonly nextCursor: string | null;
  readonly capabilities: Pick<AcpNativeSessionPage, "canLoad" | "canResume" | "canDelete"> | null;
  readonly loading: boolean;
  readonly failure: AcpFailure | null;
}

/** An import request keeps its identity for retries while this window is open. */
const importRequests = new Map<
  string,
  { readonly requestId: string; readonly acceptedAt: number }
>();
const importRequest = (key: string) => {
  const existing = importRequests.get(key);
  if (existing) return existing;
  const created = { requestId: createUuidV7(), acceptedAt: Date.now() };
  importRequests.set(key, created);
  return created;
};

/** Listing is known once a real connection reported the Agent's session capabilities. */
const listable = (
  instance: AcpAgentInstanceConfig,
  provider: AcpProviderSnapshot | undefined,
): {
  readonly ok: boolean;
  readonly reason: string | null;
  /** Whether listing becomes possible once the Agent is connected. */
  readonly needsConnection: boolean;
} =>
  !instance.enabled
    ? { ok: false, reason: "Off", needsConnection: false }
    : !provider || !acpProviderDiscovered(provider)
      ? { ok: false, reason: "Not connected", needsConnection: true }
      : provider.nativeSessions?.canList
        ? { ok: true, reason: null, needsConnection: false }
        : { ok: false, reason: "Doesn't list conversations", needsConnection: false };

function SessionRow({
  session,
  agentName,
  canDelete,
  state,
  onImport,
  onConfirmResume,
  onOpen,
  onDelete,
  onConfirmDelete,
  onDismiss,
}: {
  readonly session: AcpNativeSession;
  readonly agentName: string;
  readonly canDelete: boolean;
  readonly state: RowState | undefined;
  readonly onImport: () => void;
  readonly onConfirmResume: () => void;
  readonly onOpen: () => void;
  readonly onDelete: () => void;
  readonly onConfirmDelete: () => void;
  readonly onDismiss: () => void;
}) {
  const imported = session.importedThreadId !== null;
  const busy =
    state?.kind === "preparing" ||
    state?.kind === "importing" ||
    state?.kind === "opening" ||
    state?.kind === "deleting";
  const updatedAt = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
  return (
    <div role="group" aria-label={conversationTitle(session.title ?? "")} className="flex flex-col">
      <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="min-w-0 truncate text-sm text-token-text-primary">
            {conversationTitle(session.title ?? "")}
          </span>
          <span className="block min-w-0 truncate text-left text-xs text-token-text-secondary [direction:rtl]">
            <bdi dir="ltr">{session.cwd}</bdi>
          </span>
        </div>
        {Number.isFinite(updatedAt) ? (
          <time
            className="shrink-0 text-xs text-token-description-foreground tabular-nums"
            dateTime={new Date(updatedAt).toISOString()}
          >
            {formatCompactRelativeTime(updatedAt)}
          </time>
        ) : null}
        {imported ? (
          <NodexButton size="sm" variant="secondary" disabled={busy} onClick={onOpen}>
            {state?.kind === "opening" ? "Opening…" : "Open"}
          </NodexButton>
        ) : (
          <>
            {canDelete && state?.kind !== "confirm-delete" ? (
              <NodexIconButton
                size="sm"
                icon={DeleteIcon}
                ariaLabel={`Delete from ${agentName}`}
                disabled={busy}
                onClick={onDelete}
              />
            ) : null}
            <NodexButton
              size="sm"
              variant="secondary"
              disabled={busy || state?.kind === "confirm-resume"}
              onClick={onImport}
            >
              {state?.kind === "preparing" || state?.kind === "importing" ? "Importing…" : "Import"}
            </NodexButton>
          </>
        )}
      </div>
      {state?.kind === "confirm-resume" ? (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 text-xs">
          <span className="min-w-0 flex-1 text-token-text-secondary">
            {agentName} can continue this conversation but can't show its earlier messages. The chat
            keeps its history from here on.
          </span>
          <NodexButton size="xs" variant="ghost" onClick={onDismiss}>
            Cancel
          </NodexButton>
          <NodexButton size="xs" variant="secondary" onClick={onConfirmResume}>
            Import
          </NodexButton>
        </div>
      ) : state?.kind === "confirm-delete" ? (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 text-xs">
          <span className="min-w-0 flex-1 text-token-text-secondary">
            Delete this conversation from {agentName}? This can't be undone.
          </span>
          <NodexButton size="xs" variant="ghost" onClick={onDismiss}>
            Keep
          </NodexButton>
          <NodexButton size="xs" variant="destructive" onClick={onConfirmDelete}>
            Delete
          </NodexButton>
        </div>
      ) : state?.kind === "failed" ? (
        <p role="alert" className="px-4 pb-2.5 text-xs text-danger">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

/** One Agent's saved conversations for one folder; a new Agent or folder mounts a fresh list. */
function SessionList({
  owner,
  instanceId,
  agentName,
  projectId,
  onOpenThread,
}: {
  readonly owner: AcpAgentsOwner;
  readonly instanceId: string;
  readonly agentName: string;
  readonly projectId: string | null;
  readonly onOpenThread?: SettingsOpenThread;
}) {
  const [listing, setListing] = useState<Listing>({
    sessions: [],
    nextCursor: null,
    capabilities: null,
    loading: true,
    failure: null,
  });
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
  const setRow = (sessionId: string, state: RowState | undefined) =>
    setRows((map) => {
      const next = new Map(map);
      if (state) next.set(sessionId, state);
      else next.delete(sessionId);
      return next;
    });

  const accept = (result: AcpResult<AcpNativeSessionPage>) =>
    setListing((existing) =>
      result.ok
        ? {
            sessions: [
              ...existing.sessions,
              ...result.value.sessions.filter(
                (session) =>
                  !existing.sessions.some((seen) => seen.sessionId === session.sessionId),
              ),
            ],
            nextCursor: result.value.nextCursor,
            capabilities: {
              canLoad: result.value.canLoad,
              canResume: result.value.canResume,
              canDelete: result.value.canDelete,
            },
            loading: false,
            failure: null,
          }
        : { ...existing, loading: false, failure: result.error },
    );
  const readPage = (cursor: string | null) =>
    owner.listSessions({ instanceId, projectId, ...(cursor ? { cursor } : {}) });
  const acceptFirstPage = useEffectEvent(accept);
  useEffect(() => {
    let active = true;
    void owner.listSessions({ instanceId, projectId }).then((result) => {
      if (active) acceptFirstPage(result);
    });
    return () => {
      active = false;
    };
  }, [owner, instanceId, projectId]);

  const open = async (session: AcpNativeSession, state: "importing" | "opening") => {
    setRow(session.sessionId, { kind: state });
    const request = importRequest(JSON.stringify([instanceId, session.sessionId, projectId]));
    const result = await owner.importSession({
      instanceId,
      projectId,
      sessionId: session.sessionId,
      ...request,
    });
    if (!result.ok) {
      setRow(session.sessionId, {
        kind: "failed",
        message: acpFailureText(result.error, "import"),
      });
      return;
    }
    setListing((existing) => ({
      ...existing,
      sessions: existing.sessions.map((entry) =>
        entry.sessionId === session.sessionId
          ? { ...entry, importedThreadId: result.value.threadId }
          : entry,
      ),
    }));
    setRow(session.sessionId, undefined);
    await onOpenThread?.(result.value.threadId, { runtimeSessionId: result.value.sessionId });
  };

  const startImport = async (session: AcpNativeSession) => {
    setRow(session.sessionId, { kind: "preparing" });
    const prepared = await owner.prepareImport({
      instanceId,
      projectId,
      sessionId: session.sessionId,
    });
    if (!prepared.ok) {
      setRow(session.sessionId, {
        kind: "failed",
        message: acpFailureText(prepared.error, "import"),
      });
      return;
    }
    if (prepared.value.canLoad || prepared.value.imported) void open(session, "importing");
    else if (prepared.value.canResume) setRow(session.sessionId, { kind: "confirm-resume" });
    else
      setRow(session.sessionId, {
        kind: "failed",
        message: `${agentName} can't reopen this conversation.`,
      });
  };

  const remove = async (session: AcpNativeSession) => {
    setRow(session.sessionId, { kind: "deleting" });
    const result = await owner.deleteSession({
      instanceId,
      projectId,
      sessionId: session.sessionId,
    });
    if (!result.ok) {
      setRow(session.sessionId, {
        kind: "failed",
        message: acpFailureText(result.error, "delete"),
      });
      return;
    }
    setRow(session.sessionId, undefined);
    setListing((existing) => ({
      ...existing,
      sessions: existing.sessions.filter((entry) => entry.sessionId !== session.sessionId),
    }));
  };

  return (
    <>
      {listing.sessions.length === 0 && !listing.failure ? (
        <p className="px-4 py-3 text-xs text-token-description-foreground">
          {listing.nextCursor
            ? `${agentName} hasn't listed any conversations yet.`
            : listing.loading
              ? "Loading…"
              : `${agentName} has no saved conversations for this folder.`}
        </p>
      ) : null}
      {listing.sessions.map((session) => (
        <SessionRow
          key={session.sessionId}
          session={session}
          agentName={agentName}
          canDelete={listing.capabilities?.canDelete === true}
          state={rows.get(session.sessionId)}
          onImport={() => void startImport(session)}
          onConfirmResume={() => void open(session, "importing")}
          onOpen={() => void open(session, "opening")}
          onDelete={() => setRow(session.sessionId, { kind: "confirm-delete" })}
          onConfirmDelete={() => void remove(session)}
          onDismiss={() => setRow(session.sessionId, undefined)}
        />
      ))}
      {/* An Agent may return an empty page that still has more; a failed first page can retry. */}
      {listing.nextCursor || listing.failure ? (
        <div className="flex items-center gap-2 px-4 py-2.5">
          {listing.failure ? (
            <span role="alert" className="min-w-0 flex-1 text-xs text-danger">
              {acpFailureText(listing.failure, "history")}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <NodexButton
            size="sm"
            variant="ghost"
            disabled={listing.loading}
            onClick={() => {
              setListing((existing) => ({ ...existing, loading: true, failure: null }));
              void readPage(listing.nextCursor).then(accept);
            }}
          >
            {listing.loading ? "Loading…" : listing.failure ? "Try again" : "Load more"}
          </NodexButton>
        </div>
      ) : null}
    </>
  );
}

/**
 * Conversations an ACP Agent saved itself, for Agents that list them. Importing binds the
 * Agent's conversation to a new chat without sending anything; continuing it goes through the
 * Agent, which reports when it can no longer restore the conversation.
 */
export function AcpNativeConversationsSection({
  owner = acpAgentsOwner,
  defaultProjectId,
  destinations,
  onOpenThread,
}: {
  readonly owner?: AcpAgentsOwner;
  readonly defaultProjectId: string | null;
  readonly destinations: (selected: string | null) => ConversationImportDestinations;
  readonly onOpenThread?: SettingsOpenThread;
}) {
  const snapshot = useAcpAgents(owner);
  const instances = snapshot.settings?.instances ?? [];
  const candidates = instances.map((instance) => ({
    instance,
    ...listable(instance, snapshot.providers.get(instance.id)),
  }));
  const [chosen, setChosen] = useState<string | null>(null);
  const instance =
    candidates.find((entry) => entry.instance.id === chosen && entry.ok)?.instance ??
    candidates.find((entry) => entry.ok)?.instance ??
    null;
  const [projectChoice, setProjectChoice] = useState<string | null | undefined>(undefined);
  const projectId = projectChoice === undefined ? defaultProjectId : projectChoice;
  const [reload, setReload] = useState(0);

  if (instances.length === 0) return null;
  return (
    <NodexSettingsSection id="acp-conversations" title="ACP Agents">
      <NodexSettingsRow
        label="Saved by the Agent"
        description="Conversations the Agent keeps for the chosen Project's folder. Importing sends nothing to the Agent."
      >
        <NodexOptionPicker
          value={instance?.id ?? ""}
          options={candidates.map((entry) => ({
            value: entry.instance.id,
            label: entry.instance.displayName,
            disabled: !entry.ok,
            ...(entry.reason ? { subText: entry.reason } : {}),
          }))}
          onValueChange={setChosen}
          triggerButton={
            <NodexSettingsDropdownTrigger aria-label="ACP Agent">
              {instance?.displayName ?? "Choose an Agent"}
            </NodexSettingsDropdownTrigger>
          }
        />
        <ConversationImportDestinationPicker
          destinations={destinations(projectId)}
          value={projectId}
          onValueChange={setProjectChoice}
          disabled={!instance}
        />
        <NodexIconButton
          size="sm"
          icon={RefreshIcon}
          ariaLabel="Refresh conversations"
          disabled={!instance}
          onClick={() => setReload((value) => value + 1)}
        />
      </NodexSettingsRow>
      {instance ? (
        <SessionList
          key={JSON.stringify([instance.id, projectId, reload])}
          owner={owner}
          instanceId={instance.id}
          agentName={instance.displayName}
          projectId={projectId}
          onOpenThread={onOpenThread}
        />
      ) : (
        <p className="px-4 py-3 text-xs text-token-description-foreground">
          Connected Agents that list their conversations appear here.
        </p>
      )}
      {/* What an Agent can list is known only after connecting to it; it opens once connected. */}
      {candidates
        .filter((entry) => entry.needsConnection)
        .map(({ instance: candidate }) => {
          const activity = snapshot.activities.get(candidate.id);
          const connecting = activity?.phase === "running" || activity?.phase === "starting";
          return (
            <NodexSettingsRow
              key={candidate.id}
              variant="nested"
              label={candidate.displayName}
              description={
                activity?.phase === "failed" && activity.failure
                  ? acpFailureText(activity.failure, "connect")
                  : undefined
              }
            >
              <NodexButton
                size="sm"
                variant="secondary"
                disabled={connecting}
                onClick={() => {
                  setChosen(candidate.id);
                  owner.connect(candidate.id);
                }}
              >
                {connecting ? "Connecting…" : "Connect"}
              </NodexButton>
            </NodexSettingsRow>
          );
        })}
    </NodexSettingsSection>
  );
}
