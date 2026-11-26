import { FormattedMessage, getIntl, useIntl, type IntlShape } from "@/lib/i18n";
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
  /** The Agent's opaque cursor, passed back exactly; only null ends the list, and "" is a cursor. */
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
  intl: IntlShape = getIntl(),
): {
  readonly ok: boolean;
  readonly reason: string | null;
  /** Whether listing becomes possible once the Agent is connected. */
  readonly needsConnection: boolean;
} =>
  !instance.enabled
    ? {
        ok: false,
        reason: intl.formatMessage({
          id: "acpAgents.acpNativeConversationsSection.off",
          defaultMessage: "Off",
        }),
        needsConnection: false,
      }
    : !provider || !acpProviderDiscovered(provider)
      ? {
          ok: false,
          reason: intl.formatMessage({
            id: "acpAgents.acpNativeConversationsSection.notConnected",
            defaultMessage: "Not connected",
          }),
          needsConnection: true,
        }
      : provider.nativeSessions?.canList
        ? { ok: true, reason: null, needsConnection: false }
        : {
            ok: false,
            reason: intl.formatMessage({
              id: "acpAgents.acpNativeConversationsSection.doesnTListConversations",
              defaultMessage: "Doesn't list conversations",
            }),
            needsConnection: false,
          };

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
  const intl = useIntl();
  const imported = session.importedThreadId !== null;
  const busy =
    state?.kind === "preparing" ||
    state?.kind === "importing" ||
    state?.kind === "opening" ||
    state?.kind === "deleting";
  const updatedAt = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
  return (
    <div
      role="group"
      aria-label={conversationTitle(session.title ?? "", intl)}
      className="flex flex-col"
    >
      <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="min-w-0 truncate text-sm text-token-text-primary">
            {conversationTitle(session.title ?? "", intl)}
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
          <NodexButton size="toolbar" variant="secondary" disabled={busy} onClick={onOpen}>
            {state?.kind === "opening"
              ? intl.formatMessage({
                  id: "acpAgents.acpNativeConversationsSection.opening",
                  defaultMessage: "Opening…",
                })
              : intl.formatMessage({
                  id: "acpAgents.acpNativeConversationsSection.open",
                  defaultMessage: "Open",
                })}
          </NodexButton>
        ) : (
          <>
            {canDelete && state?.kind !== "confirm-delete" ? (
              <NodexIconButton
                size="sm"
                icon={DeleteIcon}
                ariaLabel={intl.formatMessage(
                  {
                    id: "acpAgents.acpNativeConversationsSection.deleteFromValue",
                    defaultMessage: "Delete from {value1}",
                  },
                  { value1: agentName },
                )}
                disabled={busy}
                onClick={onDelete}
              />
            ) : null}
            <NodexButton
              size="toolbar"
              variant="secondary"
              disabled={busy || state?.kind === "confirm-resume"}
              onClick={onImport}
            >
              {state?.kind === "preparing" || state?.kind === "importing"
                ? intl.formatMessage({
                    id: "acpAgents.acpNativeConversationsSection.importing",
                    defaultMessage: "Importing…",
                  })
                : intl.formatMessage({
                    id: "acpAgents.acpNativeConversationsSection.import",
                    defaultMessage: "Import",
                  })}
            </NodexButton>
          </>
        )}
      </div>
      {state?.kind === "confirm-resume" ? (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 text-xs">
          <span className="min-w-0 flex-1 text-token-text-secondary">
            {intl.formatMessage(
              {
                id: "acpAgents.acpNativeConversationsSection.resumeDetails",
                defaultMessage:
                  "{agent} can continue this conversation but can't show its earlier messages. The chat keeps its history from here on.",
              },
              { agent: agentName },
            )}
          </span>
          <NodexButton size="toolbar" variant="ghost" onClick={onDismiss}>
            <FormattedMessage
              id="acpAgents.acpNativeConversationsSection.cancel"
              defaultMessage="Cancel"
            />
          </NodexButton>
          <NodexButton size="toolbar" variant="secondary" onClick={onConfirmResume}>
            <FormattedMessage
              id="acpAgents.acpNativeConversationsSection.import"
              defaultMessage="Import"
            />
          </NodexButton>
        </div>
      ) : state?.kind === "confirm-delete" ? (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 text-xs">
          <span className="min-w-0 flex-1 text-token-text-secondary">
            {intl.formatMessage(
              {
                id: "acpAgents.acpNativeConversationsSection.deleteConfirm",
                defaultMessage: "Delete this conversation from {agent}? This can't be undone.",
              },
              { agent: agentName },
            )}
          </span>
          <NodexButton size="toolbar" variant="ghost" onClick={onDismiss}>
            <FormattedMessage
              id="acpAgents.acpNativeConversationsSection.keep"
              defaultMessage="Keep"
            />
          </NodexButton>
          <NodexButton size="toolbar" variant="destructive" onClick={onConfirmDelete}>
            <FormattedMessage
              id="acpAgents.acpNativeConversationsSection.delete"
              defaultMessage="Delete"
            />
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
  const intl = useIntl();
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
    owner.listSessions({ instanceId, projectId, ...(cursor === null ? {} : { cursor }) });
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
        message: intl.formatMessage(
          {
            id: "acpAgents.acpNativeConversationsSection.valueCanTReopenThis",
            defaultMessage: "{value1} can't reopen this conversation.",
          },
          { value1: agentName },
        ),
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

  const hasMore = listing.nextCursor !== null;
  return (
    <>
      {listing.sessions.length === 0 && !listing.failure ? (
        <p className="px-4 py-3 text-xs text-token-description-foreground">
          {hasMore
            ? intl.formatMessage(
                {
                  id: "acpAgents.acpNativeConversationsSection.valueHasnTListedAny",
                  defaultMessage: "{value1} hasn't listed any conversations yet.",
                },
                { value1: agentName },
              )
            : listing.loading
              ? intl.formatMessage({
                  id: "acpAgents.acpNativeConversationsSection.loading",
                  defaultMessage: "Loading…",
                })
              : intl.formatMessage(
                  {
                    id: "acpAgents.acpNativeConversationsSection.valueHasNoSavedConversations",
                    defaultMessage: "{value1} has no saved conversations for this folder.",
                  },
                  { value1: agentName },
                )}
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
      {/* An Agent may return an empty page that still has more; a failed page retries its cursor. */}
      {hasMore || listing.failure ? (
        <div className="flex items-center gap-2 px-4 py-2.5">
          {listing.failure ? (
            <span role="alert" className="min-w-0 flex-1 text-xs text-danger">
              {acpFailureText(listing.failure, "history")}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <NodexButton
            size="toolbar"
            variant="ghost"
            disabled={listing.loading}
            onClick={() => {
              setListing((existing) => ({ ...existing, loading: true, failure: null }));
              void readPage(listing.nextCursor).then(accept);
            }}
          >
            {listing.loading
              ? intl.formatMessage({
                  id: "acpAgents.acpNativeConversationsSection.loading",
                  defaultMessage: "Loading…",
                })
              : listing.failure
                ? intl.formatMessage({
                    id: "acpAgents.acpNativeConversationsSection.tryAgain",
                    defaultMessage: "Try again",
                  })
                : intl.formatMessage({
                    id: "acpAgents.acpNativeConversationsSection.loadMore",
                    defaultMessage: "Load more",
                  })}
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
  const intl = useIntl();
  const snapshot = useAcpAgents(owner);
  const instances = snapshot.settings?.instances ?? [];
  const candidates = instances.map((instance) => ({
    instance,
    ...listable(instance, snapshot.providers.get(instance.id), intl),
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
    <NodexSettingsSection
      id="acp-conversations"
      title={intl.formatMessage({
        id: "acpAgents.acpNativeConversationsSection.aCPAgents",
        defaultMessage: "ACP Agents",
      })}
    >
      <NodexSettingsRow
        label={intl.formatMessage({
          id: "acpAgents.acpNativeConversationsSection.savedByTheAgent",
          defaultMessage: "Saved by the Agent",
        })}
        description={intl.formatMessage({
          id: "acpAgents.acpNativeConversationsSection.conversationsTheAgentKeepsFor",
          defaultMessage:
            "Conversations the Agent keeps for the chosen Project's folder. Importing sends nothing to the Agent.",
        })}
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
            <NodexSettingsDropdownTrigger
              aria-label={intl.formatMessage({
                id: "acpAgents.acpNativeConversationsSection.aCPAgent",
                defaultMessage: "ACP Agent",
              })}
            >
              {instance?.displayName ??
                intl.formatMessage({
                  id: "acpAgents.acpNativeConversationsSection.chooseAgent",
                  defaultMessage: "Choose an Agent",
                })}
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
          ariaLabel={intl.formatMessage({
            id: "acpAgents.acpNativeConversationsSection.refreshConversations",
            defaultMessage: "Refresh conversations",
          })}
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
          <FormattedMessage
            id="acpAgents.acpNativeConversationsSection.connectedAgentsThatListTheir"
            defaultMessage="Connected Agents that list their conversations appear here."
          />
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
                size="toolbar"
                variant="secondary"
                disabled={connecting}
                onClick={() => {
                  setChosen(candidate.id);
                  owner.connect(candidate.id);
                }}
              >
                {connecting
                  ? intl.formatMessage({
                      id: "acpAgents.acpNativeConversationsSection.connecting",
                      defaultMessage: "Connecting…",
                    })
                  : intl.formatMessage({
                      id: "acpAgents.acpNativeConversationsSection.connect",
                      defaultMessage: "Connect",
                    })}
              </NodexButton>
            </NodexSettingsRow>
          );
        })}
    </NodexSettingsSection>
  );
}
