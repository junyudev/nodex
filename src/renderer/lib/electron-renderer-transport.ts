import type {
  AppUpdateStatus,
  CodexEvent,
  CodexHostMessage,
  CodexRendererClientRequestMessage,
  DesktopNotificationActionInvocation,
} from "./types";
import type { RendererTransport } from "./renderer-transport";
import {
  COMMAND_KEYBINDINGS_CHANGED_CHANNEL,
  type CommandKeymapState,
} from "../../shared/command-keybindings";
import type {
  BoardChangeEvent,
  PersistedAtomEvent,
  ProjectSessionsChangeEvent,
  ProjectsChangeEvent,
} from "../../shared/ipc-api";
import type { DatabaseChangeEvent } from "../../shared/database-events";
import type { ProjectionScope, ProjectionStreamMessage } from "../../shared/projection-stream";
import type { ResourceRevocationMessage } from "../../shared/resource-revocation-stream";
import type { ContentAccessIdentity } from "../../shared/content-access-context";
import type { AcpBackendSessionChangedEvent } from "../../shared/agent-backend-api";
import {
  RECIPIENT_DELIVERY_VERSION,
  deliveryAddressKey,
  projectionScopeDeliveryAddress,
  type RecipientAdmissionResult,
  type RecipientDeliveryEnvelope,
} from "../../shared/recipient-delivery";
import {
  createElectronDocumentSyncAdapter,
  createElectronLibraryDocumentSyncAdapter,
} from "./electron-document-sync-adapter";
import { createElectronCanvasSceneSyncAdapter } from "./electron-canvas-scene-sync-adapter";
import type { ProjectAccessedDocumentDescriptor } from "../../shared/block-documents/contracts";
import type {
  DocumentMutationRequest,
  DocumentOperationCommandResult,
} from "../../shared/block-documents/document-operations";
import type { AdditionalDocumentCommandResult } from "../../shared/additional-document-commands";
import type { PublicAdditionalDocumentCommandRequest } from "../../shared/additional-document-command-transport";
import type {
  BlockTransferCommandResult,
  BlockTransferUndoCommandResult,
} from "../../shared/block-transfer";
import type {
  PublicBlockTransferIntent,
  PublicBlockTransferUndoIntent,
} from "../../shared/block-transfer-transport";
import type {
  DocumentVersionDetail,
  DocumentVersionSummary,
  GetDocumentVersion,
  ListDocumentVersions,
  PrepareDocumentVersionRestore,
} from "../../shared/block-documents/document-history";
import type { DocumentHistoryCommandResult } from "../../shared/block-documents/document-history-transport";
import type {
  PageLifecycleMutationCommandResultV2,
  PageLifecycleMutationRequestV2,
} from "../../shared/page-lifecycle-v2";
import type { PageLifecyclePreflightResultV2 } from "../../shared/page-lifecycle-v2-runtime";
import type { ListPageHistoryRequest } from "../../shared/page-history";
import type { PageHistoryCommandResult } from "../../shared/page-history-transport";
import { rendererLocalCommitIngress } from "./local-commit-ingress";

export type ElectronRendererBridge = NonNullable<Window["api"]>;

const recipientIngressBridges = new WeakSet<object>();
const audienceSubscriptions = new WeakMap<
  object,
  Map<
    string,
    { count: number; readonly address: ReturnType<typeof projectionScopeDeliveryAddress> }
  >
>();

const sameRecipientIdentity = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const acquireAudience = (bridge: ElectronRendererBridge, scope: ProjectionScope): (() => void) => {
  const address = projectionScopeDeliveryAddress(scope);
  const key = deliveryAddressKey(address);
  const subscriptions = audienceSubscriptions.get(bridge) ?? new Map();
  audienceSubscriptions.set(bridge, subscriptions);
  const existing = subscriptions.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    subscriptions.set(key, { count: 1, address });
    void bridge.invoke("local-commit-audience:subscribe", address);
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = subscriptions.get(key);
    if (!current) return;
    current.count -= 1;
    if (current.count > 0) return;
    subscriptions.delete(key);
    void bridge.invoke("local-commit-audience:unsubscribe", current.address);
  };
};

/** Atom observers own their scoped audience and re-read after a lost delivery interval. */
export const subscribeElectronRendererLocalCommitAtoms = (
  bridge: ElectronRendererBridge,
  scope: ProjectionScope,
  onAtom: Parameters<typeof rendererLocalCommitIngress.subscribeAtoms>[0],
  onReset: () => void,
): (() => void) => {
  initializeElectronRendererLocalCommitIngress(bridge);
  const address = projectionScopeDeliveryAddress(scope);
  const releaseAtoms = rendererLocalCommitIngress.subscribeAtoms((packet, atom) => {
    if (sameRecipientIdentity(packet.authorization_scope, address)) onAtom(packet, atom);
  });
  const releaseReset = rendererLocalCommitIngress.subscribeProjection(scope, (message) => {
    if (message.kind === "reset") onReset();
  });
  const releaseAudience = acquireAudience(bridge, scope);
  return () => {
    releaseAtoms();
    releaseReset();
    releaseAudience();
  };
};

export const initializeElectronRendererLocalCommitIngress = (
  bridge: ElectronRendererBridge,
): void => {
  if (recipientIngressBridges.has(bridge)) return;
  recipientIngressBridges.add(bridge);
  bridge.on("recipient-delivery:message", (...args: unknown[]) => {
    const envelope = args[0] as RecipientDeliveryEnvelope | undefined;
    void (async () => {
      let result: RecipientAdmissionResult | null = null;
      try {
        if (
          !envelope ||
          envelope.version !== RECIPIENT_DELIVERY_VERSION ||
          !/^[a-f0-9]{64}$/u.test(envelope.deliveryId) ||
          !/^[a-f0-9]{64}$/u.test(envelope.recipientLeaseId) ||
          !sameRecipientIdentity(envelope.deliveryAddress, envelope.authorizationScope)
        ) {
          throw new TypeError("Recipient delivery envelope is invalid");
        }
        if (envelope.payload.kind === "packet") {
          const packet = envelope.payload.packet;
          if (
            !sameRecipientIdentity(packet.delivery_address, envelope.deliveryAddress) ||
            !sameRecipientIdentity(packet.authorization_scope, envelope.authorizationScope)
          )
            throw new TypeError("Recipient packet identity is invalid");
          await rendererLocalCommitIngress.admitPacket(packet);
        } else {
          const reset = envelope.payload.reset;
          if (
            reset.reset_id !== envelope.deliveryId ||
            reset.recipient_lease_id !== envelope.recipientLeaseId ||
            !sameRecipientIdentity(reset.delivery_address, envelope.deliveryAddress) ||
            !sameRecipientIdentity(reset.authorization_scope, envelope.authorizationScope)
          )
            throw new TypeError("Recipient reset identity is invalid");
          rendererLocalCommitIngress.admitAddressReset(reset);
        }
        result = {
          version: RECIPIENT_DELIVERY_VERSION,
          deliveryId: envelope.deliveryId,
          outcome: "ack",
        };
      } catch {
        if (envelope && /^[a-f0-9]{64}$/u.test(envelope.deliveryId)) {
          result = {
            version: RECIPIENT_DELIVERY_VERSION,
            deliveryId: envelope.deliveryId,
            outcome: "nack",
            reason: "invalid_message",
          };
        }
      }
      if (!result) return;
      await bridge.invoke("recipient-delivery:admit", result);
    })().catch(() => undefined);
  });
};

export function createElectronRendererTransport(bridge: ElectronRendererBridge): RendererTransport {
  return {
    sendGitWorkerMessage(
      message: import("../../shared/git-worker-protocol").GitWorkerMessageFromView,
    ) {
      const send = bridge.sendGitWorkerMessage;
      if (!send) return Promise.reject(new Error("Git worker bridge is unavailable"));
      return send(message);
    },
    subscribeGitWorkerMessages(
      callback: (
        message: import("../../shared/git-worker-protocol").GitWorkerMessageForView,
      ) => void,
    ) {
      return bridge.onGitWorkerMessage?.(callback) ?? (() => {});
    },
    readPageLifecyclePreflight(projectId: string, pageId: string) {
      return bridge.invoke(
        "pages:lifecycle:preflight",
        projectId,
        pageId,
      ) as Promise<PageLifecyclePreflightResultV2>;
    },
    mutatePageLifecycle(projectId: string, request: PageLifecycleMutationRequestV2) {
      return bridge.invoke(
        "pages:lifecycle:apply",
        projectId,
        request,
      ) as Promise<PageLifecycleMutationCommandResultV2>;
    },
    listPageHistory(request: ListPageHistoryRequest) {
      return bridge.invoke("pages:history:list", request) as Promise<PageHistoryCommandResult>;
    },
    getOwnedDocumentDescriptor(projectId: string, ownerBlockId: string) {
      return bridge.invoke(
        "block-document:owned:get",
        projectId,
        ownerBlockId,
      ) as Promise<ProjectAccessedDocumentDescriptor>;
    },
    createDocumentSyncAdapter(projectId: string) {
      return createElectronDocumentSyncAdapter(bridge, projectId);
    },
    createLibraryDocumentSyncAdapter() {
      return createElectronLibraryDocumentSyncAdapter(bridge);
    },
    createCanvasSceneSyncAdapter(identity: ContentAccessIdentity) {
      return createElectronCanvasSceneSyncAdapter(bridge, identity);
    },
    mutateDocument(projectId: string, documentId: string, request: DocumentMutationRequest) {
      return bridge.invoke(
        "block-documents:mutate",
        projectId,
        documentId,
        request,
      ) as Promise<DocumentOperationCommandResult>;
    },
    applyAdditionalDocumentCommand(
      projectId: string,
      request: PublicAdditionalDocumentCommandRequest,
    ) {
      return bridge.invoke(
        "block-documents:command",
        projectId,
        request,
      ) as Promise<AdditionalDocumentCommandResult>;
    },
    transferBlocks(projectId: string, intent: PublicBlockTransferIntent) {
      return bridge.invoke(
        "blocks:transfer",
        projectId,
        intent,
      ) as Promise<BlockTransferCommandResult>;
    },
    undoBlockTransfer(projectId: string, intent: PublicBlockTransferUndoIntent) {
      return bridge.invoke(
        "blocks:transfer:undo",
        projectId,
        intent,
      ) as Promise<BlockTransferUndoCommandResult>;
    },
    listDocumentVersions(request: ListDocumentVersions) {
      return bridge.invoke("block-documents:history:list", request) as Promise<
        DocumentHistoryCommandResult<readonly DocumentVersionSummary[]>
      >;
    },
    getDocumentVersion(request: GetDocumentVersion) {
      return bridge.invoke("block-documents:history:get", request) as Promise<
        DocumentHistoryCommandResult<DocumentVersionDetail>
      >;
    },
    restoreDocumentVersion(
      projectId: string,
      documentId: string,
      request: PrepareDocumentVersionRestore,
    ) {
      return bridge.invoke(
        "block-documents:history:restore",
        projectId,
        documentId,
        request,
      ) as Promise<DocumentOperationCommandResult>;
    },
    subscribeBoardChanges(projectId: string, callback: (event: BoardChangeEvent) => void) {
      return bridge.on("board-changed", (...args: unknown[]) => {
        const payload = args[0] as BoardChangeEvent | undefined;
        if (!payload || payload.projectId !== projectId) return;
        callback(payload);
      });
    },
    subscribeProjectionStream(
      scope: ProjectionScope,
      callback: (message: ProjectionStreamMessage) => void,
    ) {
      let active = true;
      const removeLocalListener = rendererLocalCommitIngress.subscribeProjection(scope, callback);
      const releaseAudience = acquireAudience(bridge, scope);
      return () => {
        if (!active) return;
        active = false;
        removeLocalListener();
        releaseAudience();
      };
    },
    subscribeResourceRevocations(
      scope: ProjectionScope,
      callback: (message: ResourceRevocationMessage) => void,
    ) {
      let active = true;
      const removeLocalListener = rendererLocalCommitIngress.subscribeRevocation(scope, callback);
      const releaseAudience = acquireAudience(bridge, scope);
      return () => {
        if (!active) return;
        active = false;
        removeLocalListener();
        releaseAudience();
      };
    },
    subscribePageOwnershipPathChanges(
      _projectId: string,
      callback: (
        event: import("../../shared/page-ownership-path-events").PageOwnershipPathsChangedEvent,
      ) => void,
    ) {
      return bridge.on("page-ownership-paths-changed", (...args: unknown[]) => {
        const payload = args[0] as
          | import("../../shared/page-ownership-path-events").PageOwnershipPathsChangedEvent
          | undefined;
        if (!payload) return;
        callback(payload);
      });
    },
    subscribeDatabaseChanges(projectId: string, callback: (event: DatabaseChangeEvent) => void) {
      return bridge.on("database-changed", (...args: unknown[]) => {
        const payload = args[0] as DatabaseChangeEvent | undefined;
        if (!payload || payload.projectId !== projectId) return;
        callback(payload);
      });
    },
    subscribeLibraryChanges(
      callback: (
        event: import("../../shared/library-events").LibraryNavigationChangedEvent,
      ) => void,
    ) {
      return bridge.on("library-navigation-changed", (...args: unknown[]) => {
        const payload = args[0] as
          | import("../../shared/library-events").LibraryNavigationChangedEvent
          | undefined;
        if (!payload) return;
        callback(payload);
      });
    },
    subscribeProjectSessionChanges(callback: (event: ProjectSessionsChangeEvent) => void) {
      return bridge.on("project-sessions-changed", (...args: unknown[]) => {
        const payload = args[0] as ProjectSessionsChangeEvent | undefined;
        if (!payload) return;
        callback(payload);
      });
    },
    subscribeProjectChanges(callback: (event: ProjectsChangeEvent) => void) {
      return bridge.on("projects-changed", (...args: unknown[]) => {
        const payload = args[0] as ProjectsChangeEvent | undefined;
        if (!payload) return;
        callback(payload);
      });
    },
    subscribeAcpBackendSessionChanges(callback: (event: AcpBackendSessionChangedEvent) => void) {
      return bridge.on("agent-backend:acp:session-changed", (...args: unknown[]) => {
        const payload = args[0] as AcpBackendSessionChangedEvent | undefined;
        if (!payload || payload.delta.backend !== "acp") return;
        callback(payload);
      });
    },
    subscribeCodexHostMessages(callback: (message: CodexHostMessage) => void) {
      return bridge.on("codex:host-message", (...args: unknown[]) => {
        const payload = args[0] as CodexHostMessage | undefined;
        if (!payload) return;
        callback(payload);
      });
    },
    subscribeCodexEvents(callback: (event: CodexEvent) => void) {
      if (!bridge.on) return () => {};
      return bridge.on("codex:event", (...args: unknown[]) => {
        const payload = args[0] as CodexEvent | undefined;
        if (!payload || typeof payload.type !== "string") return;
        callback(payload);
      });
    },
    subscribeCodexRendererClientRequests(
      callback: (message: CodexRendererClientRequestMessage) => void,
    ) {
      return bridge.on("codex:renderer-client:request", (...args: unknown[]) => {
        const payload = args[0] as CodexRendererClientRequestMessage | undefined;
        if (!payload || typeof payload.requestId !== "string" || typeof payload.method !== "string")
          return;
        callback(payload);
      });
    },
    subscribeDesktopNotificationActions(
      callback: (message: DesktopNotificationActionInvocation) => void,
    ) {
      if (!bridge.on) return () => {};
      return bridge.on("desktop-notification:action", (...args: unknown[]) => {
        const payload = args[0] as Partial<DesktopNotificationActionInvocation> | undefined;
        if (!payload || typeof payload.notificationId !== "string") return;
        if (
          payload.actionType !== "open" &&
          payload.actionType !== "reply" &&
          payload.actionType !== "approve" &&
          payload.actionType !== "approve-for-session" &&
          payload.actionType !== "decline"
        )
          return;
        if (payload.actionId !== null && typeof payload.actionId !== "string") return;
        if (typeof payload.hostId !== "string" || payload.hostId.trim().length === 0) return;
        if (payload.conversationId !== null && typeof payload.conversationId !== "string") return;
        if (payload.navigationPath !== null && typeof payload.navigationPath !== "string") return;
        if (payload.activateTabId !== null && typeof payload.activateTabId !== "string") return;
        if (
          payload.requestId !== null &&
          typeof payload.requestId !== "string" &&
          typeof payload.requestId !== "number"
        )
          return;
        if (payload.reply !== undefined && typeof payload.reply !== "string") return;
        callback(payload as DesktopNotificationActionInvocation);
      });
    },
    subscribeWorkspaceFileChanges(
      callback: (event: import("../../shared/types").WorkspaceFileChangedEvent) => void,
    ) {
      return bridge.on("workspace-file:changed", (...args: unknown[]) => {
        const payload = args[0] as
          | import("../../shared/types").WorkspaceFileChangedEvent
          | undefined;
        if (
          !payload ||
          typeof payload.subscriptionId !== "string" ||
          typeof payload.path !== "string"
        ) {
          return;
        }
        callback(payload);
      });
    },
    subscribeAppUpdateStatus(callback: (status: AppUpdateStatus) => void) {
      return bridge.on("app:update-status", (...args: unknown[]) => {
        const payload = args[0] as AppUpdateStatus | undefined;
        if (!payload || typeof payload.status !== "string") return;
        callback(payload);
      });
    },
    subscribeCommandKeymapChanges(callback: (state: CommandKeymapState) => void) {
      return bridge.on(COMMAND_KEYBINDINGS_CHANGED_CHANNEL, (...args: unknown[]) => {
        const payload = args[0] as CommandKeymapState | undefined;
        if (!payload || payload.version !== 1 || !Array.isArray(payload.entries)) return;
        callback(payload);
      });
    },
    subscribeCodexScheduledAutomationChanges(
      callback: (event: import("./types").CodexScheduledAutomationChangedEvent) => void,
    ) {
      return bridge.on("codex:scheduled-automations:changed", (...args: unknown[]) => {
        const payload = args[0] as
          | import("./types").CodexScheduledAutomationChangedEvent
          | undefined;
        if (!payload || typeof payload.automationId !== "string") return;
        callback(payload);
      });
    },
    subscribeCodexAutomationRunsUpdates(
      callback: (event: import("./types").CodexAutomationRunsUpdatedEvent) => void,
    ) {
      return bridge.on("codex:automation-runs:updated", (...args: unknown[]) => {
        const payload = args[0] as import("./types").CodexAutomationRunsUpdatedEvent | undefined;
        if (!payload || typeof payload.reason !== "string") return;
        callback(payload);
      });
    },
    subscribeCodexHooksChanged(
      callback: (event: import("../../shared/codex-hooks").CodexHooksChangedEvent) => void,
    ) {
      return bridge.on("codex:hooks:changed", (...args: unknown[]) => {
        const payload = args[0] as
          | import("../../shared/codex-hooks").CodexHooksChangedEvent
          | undefined;
        if (!payload || typeof payload.hostId !== "string") return;
        callback(payload);
      });
    },
    subscribeCodexPendingWorktreesChanged(
      callback: (
        event: import("../../shared/codex-pending-worktree").CodexPendingWorktreesChangedEvent,
      ) => void,
    ) {
      return bridge.on("codex:pending-worktrees:changed", (...args: unknown[]) => {
        const payload = args[0];
        if (!Array.isArray(payload)) return;
        callback(
          payload as import("../../shared/codex-pending-worktree").CodexPendingWorktreesChangedEvent,
        );
      });
    },
    subscribeCodexPendingWorktreeWarnings(
      callback: (
        event: import("../../shared/codex-pending-worktree").CodexPendingWorktreeWarningEvent,
      ) => void,
    ) {
      return bridge.on("codex:pending-worktree:warning", (...args: unknown[]) => {
        const payload = args[0] as
          | import("../../shared/codex-pending-worktree").CodexPendingWorktreeWarningEvent
          | undefined;
        if (!payload || payload.kind !== "heartbeat-automation-create-failed") return;
        callback(payload);
      });
    },
    subscribePersistedAtomUpdates(callback: (update: PersistedAtomEvent) => void) {
      return bridge.on("persisted-atom:updated", (...args: unknown[]) => {
        const payload = args[0] as PersistedAtomEvent | undefined;
        if (
          !payload ||
          typeof payload.key !== "string" ||
          typeof payload.mutationId !== "string" ||
          typeof payload.revision !== "number"
        )
          return;
        callback(payload);
      });
    },
    getWindowFocusState() {
      return bridge.invoke("electron-window:focus:get") as Promise<boolean>;
    },
    subscribeWindowFocusChanges(callback: (isFocused: boolean) => void) {
      return bridge.on("electron-window:focus-changed", (...args: unknown[]) => {
        const payload = args[0] as { isFocused?: boolean } | undefined;
        callback(payload?.isFocused === true);
      });
    },
    getUserInputAutoResolutionSnapshot() {
      return bridge.invoke("codex:user-input:auto-resolution:snapshot") as Promise<
        import("../../shared/codex-user-input-auto-resolution").CodexUserInputAutoResolutionEntry[]
      >;
    },
    recordUserInputAutoResolutionActivity(conversationId: string) {
      return bridge.invoke("codex:user-input:auto-resolution:activity", {
        conversationId,
      }) as Promise<boolean>;
    },
    snoozeUserInputAutoResolution(
      target: import("../../shared/codex-user-input-auto-resolution").CodexUserInputAutoResolutionTarget,
    ) {
      return bridge.invoke("codex:user-input:auto-resolution:snooze", target) as Promise<boolean>;
    },
    subscribeUserInputAutoResolutionChanges(
      callback: (
        change: import("../../shared/codex-user-input-auto-resolution").CodexUserInputAutoResolutionChange,
      ) => void,
    ) {
      return bridge.on("codex:user-input:auto-resolution:changed", (...args: unknown[]) => {
        const change = args[0] as
          | import("../../shared/codex-user-input-auto-resolution").CodexUserInputAutoResolutionChange
          | undefined;
        if (!change) return;
        callback(change);
      });
    },
  };
}
