import {
  WORKBENCH_AGENT_CANCEL_CHANNEL,
  WORKBENCH_AGENT_MAX_REPLY_BYTES,
  WORKBENCH_AGENT_REQUEST_CHANNEL,
  WorkbenchAgentCancelSchema,
  WorkbenchAgentReplySchema,
  WorkbenchAgentRequestSchema,
  WorkbenchWindowReferenceSchema,
  type WorkbenchAgentReply,
  type WorkbenchAgentRequest,
  type WorkbenchAgentResult,
  type WorkbenchSubmitPresentation,
  type WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import { invokeRendererControlThrough } from "./renderer-query-control";
import {
  discoverWorkbenchAgentScenes,
  readWorkbenchAgentContext,
  readWorkbenchSubmitPresentation,
  type WorkbenchAgentContextOptions,
} from "./workbench-agent-context";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";
import { createWorkbenchAgentCommands } from "./workbench-agent-commands";
import type { WorkbenchSceneCommandExecutor } from "./workbench-scene-commands";
import { createWorkbenchPageContent } from "./workbench-page-content";
import { captureWorkbenchViewContent } from "./workbench-view-content";

export interface WorkbenchAgentBridgePort {
  readonly subscribeRequests: (listener: (message: unknown) => void) => () => void;
  readonly subscribeCancellations: (listener: (message: unknown) => void) => () => void;
  readonly register: (input: { readonly ownerId: string }) => Promise<WorkbenchWindowReference>;
  readonly release: (reference: WorkbenchWindowReference) => Promise<void>;
  readonly reply: (reply: WorkbenchAgentReply) => Promise<boolean>;
}

/** Named renderer Adapter for the exact Workbench registration and request/reply capability. */
export function createElectronWorkbenchAgentBridgePort(
  bridge: Pick<NonNullable<Window["api"]>, "on" | "invoke">,
): WorkbenchAgentBridgePort {
  return {
    subscribeRequests: (listener) => bridge.on(WORKBENCH_AGENT_REQUEST_CHANNEL, listener),
    subscribeCancellations: (listener) => bridge.on(WORKBENCH_AGENT_CANCEL_CHANNEL, listener),
    register: (input) => invokeRendererControlThrough(bridge, "workbench-agent:register", input),
    release: (reference) =>
      invokeRendererControlThrough(bridge, "workbench-agent:release", reference),
    reply: (reply) => invokeRendererControlThrough(bridge, "workbench-agent:reply", reply),
  };
}

interface RegisteredWorkbenchAgentBridge {
  readonly ready: Promise<WorkbenchWindowReference | null>;
  readonly captureSubmitPresentation: () => WorkbenchSubmitPresentation | null;
  readonly dispose: () => void;
}

// Stores one registered capability per live owner. Scene and presentation state stay in that owner.
const registeredBridges = new WeakMap<WorkbenchWindowOwner, RegisteredWorkbenchAgentBridge>();
const MAX_PENDING_REQUESTS = 16;

const sameReference = (left: WorkbenchWindowReference, right: WorkbenchWindowReference) =>
  left.windowSessionId === right.windowSessionId &&
  left.rendererGeneration === right.rendererGeneration;

function boundedReply(
  request: WorkbenchAgentRequest,
  result: WorkbenchAgentResult,
): WorkbenchAgentReply {
  const reply: WorkbenchAgentReply = {
    windowSessionId: request.windowSessionId,
    rendererGeneration: request.rendererGeneration,
    requestId: request.requestId,
    outcome: { ok: true, result },
  };
  const encoded = JSON.stringify(reply);
  if (
    new TextEncoder().encode(encoded).byteLength > WORKBENCH_AGENT_MAX_REPLY_BYTES ||
    !WorkbenchAgentReplySchema.safeParse(reply).success
  ) {
    return { ...reply, outcome: { ok: false, error: "result_too_large" } };
  }
  return reply;
}

/** Register after listeners attach; every queued callback belongs to this exact mount and generation. */
export function createWorkbenchAgentBridge(
  owner: WorkbenchWindowOwner,
  port: WorkbenchAgentBridgePort,
  options: {
    readonly ownerId?: string;
    readonly context?: () => WorkbenchAgentContextOptions;
    readonly onError?: (error: unknown) => void;
    readonly commands?: WorkbenchSceneCommandExecutor;
  } = {},
): RegisteredWorkbenchAgentBridge {
  if (registeredBridges.has(owner)) throw new Error("Workbench Agent bridge already has an owner");
  let disposed = false;
  let reference: WorkbenchWindowReference | null = null;
  let registration: Promise<WorkbenchWindowReference | null> = Promise.resolve(null);
  const pending = new Map<
    string,
    {
      readonly request: WorkbenchAgentRequest;
      readonly cancellation: AbortController;
      cancelled: boolean;
    }
  >();
  const reportError = (error: unknown) => options.onError?.(error);
  const context = (): WorkbenchAgentContextOptions => ({
    ...options.context?.(),
    resolveDatabaseView: owner.resolveDatabaseView,
  });
  const commands = options.commands ? createWorkbenchAgentCommands(owner, options.commands) : null;
  const pageContent = createWorkbenchPageContent(owner);
  const release = (target: WorkbenchWindowReference) => port.release(target).catch(reportError);
  const isActive = () => !disposed && registeredBridges.get(owner) === capability;
  const isCurrent = (request: WorkbenchWindowReference) =>
    isActive() && reference !== null && sameReference(reference, request);

  const receive = (message: unknown) => {
    const parsed = WorkbenchAgentRequestSchema.safeParse(message);
    if (!parsed.success || !isActive()) return;
    const request = parsed.data;
    if (pending.has(request.requestId) || pending.size >= MAX_PENDING_REQUESTS) return;
    const entry = { request, cancellation: new AbortController(), cancelled: false };
    pending.set(request.requestId, entry);
    void Promise.resolve()
      .then(async () => {
        await registration;
        if (entry.cancelled || !isCurrent(request)) return;
        let reply: WorkbenchAgentReply;
        try {
          const state = owner.read();
          let result: WorkbenchAgentResult;
          if (request.body.kind === "discover") {
            result = discoverWorkbenchAgentScenes(state, request.body.sessionId);
          } else if (request.body.kind === "observe") {
            result = {
              kind: "observe",
              observation: readWorkbenchAgentContext(state, request.body.sceneOwner, context()),
            };
          } else if (request.body.kind === "prepare_content") {
            result = {
              kind: "prepare_content",
              preparation: await pageContent.prepare(
                request.body,
                entry.cancellation.signal,
                () => !entry.cancelled && isCurrent(request),
              ),
            };
          } else if (request.body.kind === "validate_content") {
            result = {
              kind: "validate_content",
              validation: pageContent.validate(
                request.body.token,
                () => !entry.cancelled && isCurrent(request),
              ),
            };
          } else if (request.body.kind === "capture_view") {
            result = {
              kind: "capture_view",
              capture: captureWorkbenchViewContent(
                owner,
                request.body,
                () => !entry.cancelled && isCurrent(request),
              ),
            };
          } else {
            if (!commands) throw new Error("Workbench command executor is unavailable");
            result = {
              kind: "command",
              receipt: await commands.execute(
                request.body.envelope,
                () => !entry.cancelled && isCurrent(request),
              ),
            };
          }
          reply = boundedReply(request, result);
        } catch (error) {
          reportError(error);
          reply = {
            windowSessionId: request.windowSessionId,
            rendererGeneration: request.rendererGeneration,
            requestId: request.requestId,
            outcome: { ok: false, error: "failed" },
          };
        }
        if (entry.cancelled || !isCurrent(request)) return;
        await port.reply(reply).catch(reportError);
      })
      .catch((error: unknown) => {
        if (isActive()) reportError(error);
      })
      .finally(() => {
        if (pending.get(request.requestId) === entry) pending.delete(request.requestId);
      });
  };
  const cancel = (message: unknown) => {
    const parsed = WorkbenchAgentCancelSchema.safeParse(message);
    if (!parsed.success) return;
    const entry = pending.get(parsed.data.requestId);
    if (!entry || !sameReference(entry.request, parsed.data)) return;
    entry.cancelled = true;
    entry.cancellation.abort();
    pending.delete(parsed.data.requestId);
  };
  let unsubscribeRequests = () => {};
  let unsubscribeCancellations = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribeRequests();
    unsubscribeCancellations();
    for (const entry of pending.values()) {
      entry.cancelled = true;
      entry.cancellation.abort();
    }
    pending.clear();
    pageContent.dispose();
    if (registeredBridges.get(owner) === capability) registeredBridges.delete(owner);
    const previousReference = reference;
    reference = null;
    if (previousReference) void release(previousReference);
  };
  const capability: RegisteredWorkbenchAgentBridge = {
    get ready() {
      return registration;
    },
    captureSubmitPresentation: () => {
      if (!isActive() || !reference) return null;
      return readWorkbenchSubmitPresentation(owner.read(), reference.rendererGeneration, context());
    },
    dispose,
  };
  registeredBridges.set(owner, capability);
  try {
    unsubscribeRequests = port.subscribeRequests(receive);
    unsubscribeCancellations = port.subscribeCancellations(cancel);
    registration = (async () => {
      const registered = WorkbenchWindowReferenceSchema.parse(
        await port.register({ ownerId: options.ownerId ?? crypto.randomUUID() }),
      );
      if (!isActive()) {
        await release(registered);
        return null;
      }
      reference = registered;
      return registered;
    })();
  } catch (error) {
    dispose();
    throw error;
  }
  void registration.catch((error: unknown) => {
    reportError(error);
    dispose();
  });
  return capability;
}

/** The submitter uses only its own active registration; absence never falls back to another window. */
export function captureWorkbenchSubmitPresentation(
  owner: WorkbenchWindowOwner,
): WorkbenchSubmitPresentation | null {
  return registeredBridges.get(owner)?.captureSubmitPresentation() ?? null;
}
