import { getIntl } from "@/lib/i18n";
import type {
  AgentAccountBackend,
  AgentAccountOperations,
  AgentAccountState,
} from "../../../shared/agent-accounts-api";
import type {
  AgentManagementFailure,
  AgentManagementResult,
} from "../../../shared/agent-management-result";
import type { AgentAccountsRuntime } from "../../lib/agent-accounts-runtime";
import { settleAgentManagement as settle } from "../../lib/agent-management-result";

export interface AgentAccountView {
  readonly state: AgentAccountState | null;
  readonly request: "read" | "start" | "respond" | "cancel" | "sign-out" | null;
  readonly failure: {
    readonly failure: AgentManagementFailure;
    readonly context: "sign-in" | "sign-out";
  } | null;
}
export interface AgentAccountOwner {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => AgentAccountView | null;
  /** The last released surface cancels the flow started in this window. */
  readonly retain: () => () => void;
  readonly read: () => void;
  readonly signIn: (methodId?: string) => void;
  readonly respondBrowser: (accept: boolean) => Promise<boolean>;
  readonly submitCredentials: (values: Record<string, string>) => void;
  readonly complete: (callbackUrl: string) => void;
  readonly terminalInput: (data: string) => void;
  readonly terminalResize: (size: { cols: number; rows: number }) => void;
  readonly cancelSignIn: () => void;
  readonly signOut: () => void;
}

export const isAgentAuthActive = (state: AgentAccountState | null | undefined): boolean =>
  state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying";

const AUTH_POLL_MS = 300;
const TERMINAL_CHUNK = 4_096;
const expired = (): AgentManagementFailure => ({
  reason: "operation_expired",
  message: getIntl().formatMessage({
    id: "agentAccount.flowExpired",
    defaultMessage: "This sign-in flow is no longer active. Start sign-in again.",
  }),
});

type Flow = { readonly flowId: string; readonly interactionId: string };
type TerminalResponse = Extract<
  AgentAccountOperations["respond"]["input"]["response"],
  { type: "terminal" }
>;

/** One saved Account in one renderer. Intent and flow identities fence late answers and input. */
export function createAgentAccountOwner({
  backend,
  runtime,
  onSignedIn,
  onSignedOut,
}: {
  readonly backend: AgentAccountBackend;
  readonly runtime: AgentAccountsRuntime;
  readonly onSignedIn?: () => void;
  readonly onSignedOut?: () => void;
}): AgentAccountOwner {
  let view: AgentAccountView | null = null;
  let viewers = 0;
  let epoch = 0;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let startedFlow: { readonly id: string; readonly generation: string } | null = null;
  let queue: { readonly flow: Flow; readonly response: TerminalResponse }[] = [];
  let sending = false;
  const listeners = new Set<() => void>();
  const publish = (next: AgentAccountView | null) => {
    view = next;
    for (const listener of [...listeners]) listener();
  };
  const patch = (value: Partial<AgentAccountView>) =>
    publish({ state: null, request: null, failure: null, ...view, ...value });
  const clearPoll = () => {
    clearTimeout(poll);
    poll = undefined;
  };
  const supersede = () => {
    ++epoch;
    queue = [];
    startedFlow = null;
    clearPoll();
    return epoch;
  };
  const ownedFlow = (state: AgentAccountState | null | undefined) =>
    state?.cancellable && isAgentAuthActive(state) ? state.flowId : null;
  const cancel = (flowId: string) => runtime.cancel({ backend, flowId });
  const cancelOrphan = (state: AgentAccountState | null) => {
    const flowId = ownedFlow(state);
    if (flowId && flowId !== ownedFlow(view?.state)) void settle(() => cancel(flowId));
  };
  const schedule = () => {
    clearPoll();
    if (!isAgentAuthActive(view?.state) || view?.request || sending) return;
    const captured = epoch;
    poll = setTimeout(() => void pollState(captured), AUTH_POLL_MS);
  };
  const fail = (failure: AgentManagementFailure, context: "sign-in" | "sign-out" = "sign-in") => {
    const state = view?.state;
    if (!state || !isAgentAuthActive(state)) {
      patch({ request: null, failure: { failure, context } });
      return;
    }
    const flowId = ownedFlow(state);
    supersede();
    patch({
      state: {
        ...state,
        phase: "failed",
        flowId: null,
        interaction: null,
        message: null,
        cancellable: false,
      },
      request: null,
      failure: { failure, context },
    });
    if (flowId && failure.reason !== "operation_expired") void settle(() => cancel(flowId));
  };
  const admit = (state: AgentAccountState | null, request: AgentAccountView["request"] = null) => {
    const previous = view?.state;
    if (isAgentAuthActive(previous) && state?.runtimeGeneration !== previous?.runtimeGeneration) {
      fail(expired());
      return false;
    }
    // Concurrent provider updates can return an older revision within the same Runtime.
    if (
      state &&
      previous &&
      state.runtimeGeneration === previous.runtimeGeneration &&
      state.flowId === previous.flowId &&
      state.revision < previous.revision
    ) {
      patch({ request });
      schedule();
      return false;
    }
    patch({ state, request, failure: null });
    if (!isAgentAuthActive(state)) queue = [];
    schedule();
    if (
      state?.phase === "succeeded" &&
      startedFlow &&
      state.flowId === startedFlow.id &&
      state.runtimeGeneration === startedFlow.generation
    ) {
      startedFlow = null;
      onSignedIn?.();
    }
    return true;
  };
  async function pollState(captured: number) {
    const before = view;
    const result = await settle(() => runtime.read({ backend }));
    if (captured !== epoch || view !== before || sending) return;
    if (result.ok) admit(result.value);
    else fail(result.error);
  }

  const request = async (
    action: NonNullable<AgentAccountView["request"]>,
    run: () => Promise<AgentManagementResult<AgentAccountState | null>>,
  ) => {
    const captured =
      action === "start" || action === "cancel" || action === "sign-out" ? supersede() : epoch;
    clearPoll();
    patch({ request: action, failure: null });
    const result = await settle(run);
    if (captured !== epoch) {
      if (action === "start" && result.ok) cancelOrphan(result.value);
      return false;
    }
    if (!result.ok) {
      fail(result.error, action === "sign-out" ? "sign-out" : "sign-in");
      return false;
    }
    const state = result.value;
    if (action === "start" && state?.flowId)
      startedFlow = { id: state.flowId, generation: state.runtimeGeneration };
    const accepted = admit(state);
    if (accepted && action === "sign-out" && state?.phase !== "failed") onSignedOut?.();
    return accepted;
  };

  const interactionOf = (): Flow | null => {
    const state = view?.state;
    return state?.flowId && state.interaction && ownedFlow(state)
      ? { flowId: state.flowId, interactionId: state.interaction.id }
      : null;
  };
  const respond = (response: AgentAccountOperations["respond"]["input"]["response"]) => {
    const flow = interactionOf();
    if (!flow || view?.request) return Promise.resolve(false);
    return request("respond", () => runtime.respond({ backend, ...flow, response }));
  };
  const flushTerminal = async () => {
    if (sending) return;
    sending = true;
    clearPoll();
    try {
      for (;;) {
        const chunk = queue.shift();
        if (!chunk) break;
        const active = interactionOf();
        if (
          active?.flowId !== chunk.flow.flowId ||
          active.interactionId !== chunk.flow.interactionId
        )
          continue;
        const captured = epoch;
        const result = await settle(() =>
          runtime.respond({ backend, ...chunk.flow, response: chunk.response }),
        );
        if (captured !== epoch) continue;
        if (result.ok) admit(result.value, view?.request);
        else if (!chunk.response.size) fail(result.error);
      }
    } finally {
      sending = false;
      schedule();
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => view,
    retain: () => {
      viewers += 1;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        viewers -= 1;
        if (viewers) return;
        const flowId = ownedFlow(view?.state);
        const cancelling = view?.request === "cancel";
        supersede();
        publish(null);
        if (flowId && !cancelling) void settle(() => cancel(flowId));
      };
    },
    read: () => {
      if (!view?.request) void request("read", () => runtime.read({ backend }));
    },
    signIn: (methodId) => {
      if ((view?.request && view.request !== "read") || isAgentAuthActive(view?.state)) return;
      void request("start", () => runtime.start({ backend, ...(methodId ? { methodId } : {}) }));
    },
    respondBrowser: (accept) => respond({ type: "browser", action: accept ? "accept" : "decline" }),
    submitCredentials: (values) => void respond({ type: "credentials", values }),
    complete: (callbackUrl) => {
      const flow = interactionOf();
      if (flow && !view?.request)
        void request("respond", () =>
          runtime.complete({ backend, flowId: flow.flowId, callbackUrl }),
        );
    },
    terminalInput: (data) => {
      const flow = interactionOf();
      if (!flow || view?.request === "cancel") return;
      for (let offset = 0; offset < data.length; offset += TERMINAL_CHUNK) {
        queue.push({
          flow,
          response: { type: "terminal", data: data.slice(offset, offset + TERMINAL_CHUNK) },
        });
      }
      void flushTerminal();
    },
    terminalResize: (size) => {
      const flow = interactionOf();
      if (!flow || view?.request === "cancel") return;
      queue.push({ flow, response: { type: "terminal", data: "", size } });
      void flushTerminal();
    },
    cancelSignIn: () => {
      if (view?.request === "cancel") return;
      const flowId = ownedFlow(view?.state);
      if (flowId) {
        void request("cancel", () => cancel(flowId));
        return;
      }
      if (view?.request === "start") {
        supersede();
        patch({ request: null });
      }
    },
    signOut: () => {
      if (!view?.request && !isAgentAuthActive(view?.state))
        void request("sign-out", () => runtime.logout({ backend }));
    },
  };
}
