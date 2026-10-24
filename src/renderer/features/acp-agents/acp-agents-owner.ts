import type { AcpFailure, AcpResult } from "../../../shared/acp-api";
import type {
  AcpAgentConfigurationStatus,
  AcpAgentInstanceInput,
  AcpAgentSettings,
} from "../../../shared/acp-agent-settings";
import type { AcpAgentsRuntime } from "../../lib/acp-agents-runtime";
import {
  acpInstanceInput,
  acpProviderDiscovered,
  acpProviderId,
  describeAcpCause,
  isAcpAuthActive,
  settle,
  type AcpActivity,
  type AcpAuthState,
  type AcpDistributionChoice,
  type AcpInspectionState,
  type AcpInstallPreview,
  type AcpModelServices,
  type AcpNativeSessionPage,
  type AcpOperation,
  type AcpProviderSnapshot,
  type AcpRegistryAgent,
} from "./acp-agent-model";

type AcpRegistrySearch = { readonly agents: readonly AcpRegistryAgent[] };

export interface AcpAuthView {
  /** The latest flow state from the Runtime; null until the first read answers. */
  readonly state: AcpAuthState | null;
  readonly request: "read" | "start" | "respond" | "cancel" | "sign-out" | null;
  readonly failure: {
    readonly failure: AcpFailure;
    readonly context: "sign-in" | "sign-out";
  } | null;
}

export interface AcpAgentsSnapshot {
  readonly settings: AcpAgentSettings | null;
  readonly loadError: string | null;
  readonly saving: boolean;
  /** Instances whose saved changes wait for current work to finish, as Main last reported. */
  readonly deferred: ReadonlySet<string>;
  /** Saved settings could not reach the Agent runtime yet; never presented as applied. */
  readonly configurationFailed: boolean;
  readonly providers: ReadonlyMap<string, AcpProviderSnapshot>;
  readonly inspections: ReadonlyMap<string, AcpInspectionState>;
  readonly activities: ReadonlyMap<string, AcpActivity>;
  readonly auth: ReadonlyMap<string, AcpAuthView>;
}

export type AcpSaveOutcome =
  | { readonly ok: true; readonly deferred: boolean; readonly configurationFailed: boolean }
  | { readonly ok: false; readonly message: string };

export interface AcpInstallRequest {
  readonly agentId: string;
  readonly distribution: AcpDistributionChoice;
  /** The reviewed preview; a changed catalog fails before anything is downloaded. */
  readonly expectedInstallationId?: string;
}

export interface AcpAgentsOwner {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => AcpAgentsSnapshot;
  /** Re-reads settings, known Runtime state and passive installation state. */
  readonly refresh: () => void;
  /** Adds an instance; saving queues behind earlier saves and keeps their results. */
  readonly addInstance: (instance: AcpAgentInstanceInput) => Promise<AcpSaveOutcome>;
  /**
   * Edits one saved instance. The edit applies to the instance as saved when its turn comes, so
   * a concurrent save (such as a newly pinned installation) is never overwritten by an old copy.
   */
  readonly updateInstance: (
    instanceId: string,
    edit: (saved: AcpAgentInstanceInput) => AcpAgentInstanceInput,
  ) => Promise<AcpSaveOutcome>;
  readonly removeInstance: (instanceId: string) => Promise<AcpSaveOutcome>;
  /** Asks Main again whether saved settings reached the Agent runtime. */
  readonly checkConfiguration: () => void;
  readonly setEnabled: (instanceId: string, enabled: boolean) => Promise<AcpSaveOutcome>;
  /** Installs, pins the receipt to the instance, then connects when asked to. */
  readonly install: (
    instanceId: string,
    request: AcpInstallRequest,
    continuation: "connect" | "none",
  ) => void;
  readonly connect: (instanceId: string) => void;
  readonly cancel: (instanceId: string) => void;
  readonly dismiss: (instanceId: string) => void;
  /**
   * Removes Nodex's installed files for an Agent no instance uses. Right after installing, the
   * Runtime briefly reserves them; that refusal names no chats and is retried a few times.
   */
  readonly uninstall: (agentId: string) => Promise<AcpResult<unknown>>;
  readonly readAuth: (instanceId: string) => void;
  readonly signIn: (instanceId: string, methodId?: string) => void;
  readonly respondBrowser: (instanceId: string, accept: boolean) => Promise<boolean>;
  readonly submitCredentials: (instanceId: string, values: Record<string, string>) => void;
  readonly terminalInput: (instanceId: string, data: string) => void;
  readonly terminalResize: (instanceId: string, size: { cols: number; rows: number }) => void;
  readonly cancelSignIn: (instanceId: string) => void;
  readonly signOut: (instanceId: string) => void;
  readonly acceptUrlAuth: (
    instanceId: string,
    elicitationId: string,
  ) => Promise<AcpResult<boolean>>;
  /** A mounted sign-in surface. Releasing the last one cancels its active flow. */
  readonly retainAuth: (instanceId: string) => () => void;
  /** Passive catalog reads; neither installs nor starts an Agent. */
  readonly search: (query: string) => Promise<AcpResult<AcpRegistrySearch>>;
  readonly previewInstall: (
    agentId: string,
    distribution: AcpDistributionChoice,
  ) => Promise<AcpResult<AcpInstallPreview>>;
  readonly listSessions: (
    input: RuntimeInput<"listSessions">,
  ) => Promise<AcpResult<AcpNativeSessionPage>>;
  readonly prepareImport: (input: RuntimeInput<"prepareImport">) => RuntimeOutput<"prepareImport">;
  readonly importSession: (input: RuntimeInput<"importSession">) => RuntimeOutput<"importSession">;
  readonly deleteSession: (input: RuntimeInput<"deleteSession">) => RuntimeOutput<"deleteSession">;
  readonly listModelServices: (
    input: RuntimeInput<"listModelProviders">,
  ) => Promise<AcpResult<AcpModelServices>>;
  /** Model-service writes change the Agent's catalog, so its known models are re-read. */
  readonly setModelService: (
    input: RuntimeInput<"setModelProvider">,
  ) => Promise<AcpResult<AcpModelServices>>;
  readonly disableModelService: (
    input: RuntimeInput<"disableModelProvider">,
  ) => Promise<AcpResult<AcpModelServices>>;
}

type RuntimeInput<Method extends keyof AcpAgentsRuntime> = Parameters<AcpAgentsRuntime[Method]>[0];
type RuntimeOutput<Method extends keyof AcpAgentsRuntime> = ReturnType<AcpAgentsRuntime[Method]>;

export interface AcpOperationJournal {
  readonly read: () => string | null;
  readonly write: (value: string | null) => void;
}

interface JournalEntry {
  readonly instanceId: string;
  readonly kind: AcpActivity["kind"];
  readonly operationId: string;
  readonly agentId?: string;
  /** What follows a successful install; journaled so it survives a reload. */
  readonly continuation?: "connect" | "none";
}

const OPERATION_POLL_MS = 500;
const AUTH_POLL_MS = 300;
const TERMINAL_CHUNK = 4_096;
/** The Runtime's post-install reservation is bounded; four tries span it. */
const UNINSTALL_ATTEMPTS = 4;
const UNINSTALL_RETRY_MS = 10_000;
/** Pending changes apply as soon as the Agent goes idle; a failed reconcile retries slower. */
const CONFIGURATION_POLL_MS = { deferred: 2_000, failed: 10_000 } as const;

interface TerminalChunk {
  readonly flowId: string;
  readonly interactionId: string;
  readonly data: string;
}

/** Per-instance sign-in control: a new intent advances the epoch and fences older answers. */
interface AuthControl {
  epoch: number;
  queue: TerminalChunk[];
  sending: boolean;
  /** The flow this window started; only its success counts as a new sign-in. */
  startedFlowId: string | null;
}

const sameInput = (left: AcpAgentInstanceInput, right: AcpAgentInstanceInput) =>
  JSON.stringify(left) === JSON.stringify(right);

const EMPTY_SNAPSHOT: AcpAgentsSnapshot = {
  settings: null,
  loadError: null,
  saving: false,
  deferred: new Set(),
  configurationFailed: false,
  providers: new Map(),
  inspections: new Map(),
  activities: new Map(),
  auth: new Map(),
};

const withEntry = <Key, Value>(
  map: ReadonlyMap<Key, Value>,
  key: Key,
  value: Value | undefined,
) => {
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
};

/**
 * One window's view of ACP Agent management. Main stays the only writer of settings and the
 * Runtime the only owner of installation, connection and sign-in; this module tracks the
 * operations this window started, keeps them across a renderer reload, and fences late answers
 * by operation and flow identity.
 */
export function createAcpAgentsOwner(input: {
  readonly runtime: AcpAgentsRuntime;
  readonly subscribeChanges: (listener: () => void) => () => void;
  readonly journal: AcpOperationJournal;
  readonly createId?: () => string;
  readonly now?: () => number;
}): AcpAgentsOwner {
  const { runtime, journal } = input;
  const createId = input.createId ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_SNAPSHOT;
  let stopChanges: (() => void) | null = null;
  let refreshing = false;
  let refreshAgain = false;
  let saveChain: Promise<unknown> = Promise.resolve();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const authViewers = new Map<string, number>();
  const authControls = new Map<string, AuthControl>();
  let journalEntries: JournalEntry[] = readJournal();

  function readJournal(): JournalEntry[] {
    try {
      const value = JSON.parse(journal.read() ?? "[]") as unknown;
      return Array.isArray(value) ? (value as JournalEntry[]).slice(0, 32) : [];
    } catch {
      return [];
    }
  }
  const writeJournal = (entries: JournalEntry[]) => {
    journalEntries = entries;
    try {
      journal.write(entries.length ? JSON.stringify(entries) : null);
    } catch {
      /* Session storage is a reload convenience; operations continue in the Runtime. */
    }
  };

  const publish = (patch: Partial<AcpAgentsSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const setActivity = (instanceId: string, activity: AcpActivity | undefined) =>
    publish({ activities: withEntry(snapshot.activities, instanceId, activity) });
  const patchAuth = (instanceId: string, patch: Partial<AcpAuthView>) =>
    publish({
      auth: withEntry(snapshot.auth, instanceId, {
        state: null,
        request: null,
        failure: null,
        ...snapshot.auth.get(instanceId),
        ...patch,
      }),
    });
  const instanceOf = (instanceId: string) =>
    snapshot.settings?.instances.find((entry) => entry.id === instanceId);

  const readInspection = async (instanceId: string) => {
    if (!snapshot.inspections.has(instanceId))
      publish({
        inspections: withEntry(snapshot.inspections, instanceId, { status: "loading" }),
      });
    const result = await settle(() => runtime.inspect({ instanceId }));
    if (!instanceOf(instanceId)) return;
    publish({
      inspections: withEntry(
        snapshot.inspections,
        instanceId,
        result.ok
          ? { status: "ready", value: result.value }
          : { status: "failed", failure: result.error },
      ),
    });
  };

  const readProviders = async () => {
    const providers = await runtime.knownProviders().catch(() => null);
    const instances = snapshot.settings?.instances ?? [];
    const next = new Map<string, AcpProviderSnapshot>();
    for (const instance of instances) {
      const id = acpProviderId(instance);
      const provider = providers?.find((entry) => entry.instanceId === id);
      if (provider) next.set(instance.id, provider);
    }
    publish({ providers: next });
  };

  const acceptSettings = (settings: AcpAgentSettings) => {
    const ids = new Set(settings.instances.map(({ id }) => id));
    const keep = <Value>(map: ReadonlyMap<string, Value>) =>
      new Map([...map].filter(([id]) => ids.has(id)));
    publish({
      settings,
      loadError: null,
      inspections: keep(snapshot.inspections),
      providers: keep(snapshot.providers),
      activities: keep(snapshot.activities),
      auth: keep(snapshot.auth),
      deferred: new Set([...snapshot.deferred].filter((id) => ids.has(id))),
    });
  };

  const refresh = () => {
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    void (async () => {
      try {
        const settings = await runtime.readSettings();
        acceptSettings(settings);
        await Promise.all([
          readProviders(),
          readConfiguration(),
          ...settings.instances.map((instance) => readInspection(instance.id)),
        ]);
      } catch (cause) {
        if (!snapshot.settings) publish({ loadError: describeAcpCause(cause) });
      } finally {
        refreshing = false;
        if (refreshAgain) {
          refreshAgain = false;
          refresh();
        }
      }
    })();
  };

  const acceptConfiguration = (status: AcpAgentConfigurationStatus) => {
    const ids = new Set(snapshot.settings?.instances.map(({ id }) => id) ?? []);
    publish({
      deferred: new Set(status.deferredInstanceIds.filter((id) => ids.has(id))),
      configurationFailed: status.configurationStatus === "failed",
    });
    scheduleConfiguration();
  };
  async function readConfiguration() {
    try {
      acceptConfiguration(await runtime.readConfigurationStatus());
    } catch {
      /* Status is advisory; the next save or refresh reads it again. */
    }
  }
  // Only unsettled configuration is re-read, and only while someone is looking.
  function scheduleConfiguration() {
    const delay = snapshot.configurationFailed
      ? CONFIGURATION_POLL_MS.failed
      : snapshot.deferred.size > 0
        ? CONFIGURATION_POLL_MS.deferred
        : null;
    if (delay === null || listeners.size === 0) clearTimer("configuration");
    else schedule("configuration", delay, () => void readConfiguration());
  }

  /**
   * Main takes complete instance lists, so every save is computed from the settings as they are
   * when its turn comes, after earlier saves have returned their results.
   */
  const save = (
    mutate: (
      instances: readonly AcpAgentInstanceInput[],
    ) => readonly AcpAgentInstanceInput[] | null,
  ): Promise<AcpSaveOutcome> => {
    const run = async (): Promise<AcpSaveOutcome> => {
      const current = currentInputs();
      const next = mutate(current);
      if (next === null)
        return {
          ok: true,
          deferred: false,
          configurationFailed: snapshot.configurationFailed,
        };
      publish({ saving: true });
      try {
        const result = await runtime.updateSettings({ instances: [...next] });
        publish({ saving: false });
        acceptSettings({ instances: result.instances });
        acceptConfiguration(result);
        void readProviders();
        for (const instance of result.instances) void readInspection(instance.id);
        return {
          ok: true,
          deferred: result.configurationStatus === "deferred",
          configurationFailed: result.configurationStatus === "failed",
        };
      } catch (cause) {
        publish({ saving: false });
        return { ok: false, message: describeAcpCause(cause) };
      }
    };
    const next = saveChain.then(run, run);
    saveChain = next;
    return next;
  };
  const currentInputs = () => (snapshot.settings?.instances ?? []).map(acpInstanceInput);
  const updateInstance = (
    instanceId: string,
    edit: (saved: AcpAgentInstanceInput) => AcpAgentInstanceInput,
  ) =>
    save((instances) => {
      const saved = instances.find(({ id }) => id === instanceId);
      if (!saved) return null;
      const edited = edit(saved);
      return sameInput(saved, edited)
        ? null
        : instances.map((entry) => (entry.id === instanceId ? edited : entry));
    }).then((outcome) =>
      outcome.ok || instanceOf(instanceId)
        ? outcome
        : { ok: false as const, message: "This Agent no longer exists." },
    );

  const clearTimer = (key: string) => {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  };
  const schedule = (key: string, delay: number, run: () => void) => {
    clearTimer(key);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        run();
      }, delay),
    );
  };

  const forget = (operationId: string) =>
    writeJournal(journalEntries.filter((entry) => entry.operationId !== operationId));

  const pinInstallation = async (entry: JournalEntry, operation: AcpOperation) => {
    const result = operation.result;
    const instance = instanceOf(entry.instanceId);
    if (!result || !("installationId" in result) || !result.installationId) return true;
    if (!instance || instance.source.kind !== "registry") return false;
    if (instance.source.agentId !== result.agentId) return false;
    if (instance.source.installationId === result.installationId) return true;
    const installationId = result.installationId;
    const outcome = await updateInstance(entry.instanceId, (saved) =>
      saved.source.kind === "registry" && saved.source.agentId === result.agentId
        ? { ...saved, source: { ...saved.source, installationId } }
        : saved,
    );
    if (!outcome.ok)
      setActivity(entry.instanceId, {
        kind: "install",
        operationId: operation.operationId,
        phase: "failed",
        failure: { reason: "install_failed", message: outcome.message },
        result: operation.result,
        cancelling: false,
      });
    return outcome.ok;
  };

  const admitOperation = (entry: JournalEntry, operation: AcpOperation) => {
    const current = snapshot.activities.get(entry.instanceId);
    // A newer operation for the same instance owns its status; this answer is stale.
    if (current && current.operationId !== entry.operationId) {
      forget(entry.operationId);
      return;
    }
    setActivity(entry.instanceId, {
      kind: entry.kind,
      operationId: entry.operationId,
      phase: operation.phase,
      ...(operation.progress ? { progress: operation.progress } : {}),
      failure: operation.error,
      result: operation.result,
      cancelling: current?.cancelling === true && operation.phase === "running",
    });
    if (operation.phase === "running") {
      schedule(`operation:${entry.operationId}`, OPERATION_POLL_MS, () => void poll(entry));
      return;
    }
    forget(entry.operationId);
    if (operation.phase !== "succeeded") return;
    if (entry.kind === "install")
      void pinInstallation(entry, operation).then((pinned) => {
        void readInspection(entry.instanceId);
        if (pinned && entry.continuation === "connect") connect(entry.instanceId);
      });
    else {
      void readProviders();
      void readInspection(entry.instanceId);
    }
  };

  const poll = async (entry: JournalEntry) => {
    const result = await settle(() => runtime.readOperation({ operationId: entry.operationId }));
    if (snapshot.activities.get(entry.instanceId)?.operationId !== entry.operationId) {
      forget(entry.operationId);
      return;
    }
    if (result.ok) admitOperation(entry, result.value);
    else {
      forget(entry.operationId);
      setActivity(entry.instanceId, {
        kind: entry.kind,
        operationId: entry.operationId,
        phase: "failed",
        failure: result.error,
        result: null,
        cancelling: false,
      });
    }
  };

  const startOperation = (
    entry: Omit<JournalEntry, "operationId">,
    start: (operationId: string) => Promise<AcpResult<AcpOperation>>,
  ) => {
    const running = snapshot.activities.get(entry.instanceId);
    if (running && (running.phase === "running" || running.phase === "starting")) return;
    const operationId = createId();
    const journaled: JournalEntry = { ...entry, operationId };
    writeJournal([
      ...journalEntries.filter((item) => item.instanceId !== entry.instanceId),
      journaled,
    ]);
    setActivity(entry.instanceId, {
      kind: entry.kind,
      operationId,
      phase: "starting",
      failure: null,
      result: null,
      cancelling: false,
    });
    void settle(() => start(operationId)).then((result) => {
      if (snapshot.activities.get(entry.instanceId)?.operationId !== operationId) return;
      if (result.ok) admitOperation(journaled, result.value);
      else {
        forget(operationId);
        setActivity(entry.instanceId, {
          kind: entry.kind,
          operationId,
          phase: "failed",
          failure: result.error,
          result: null,
          cancelling: false,
        });
      }
    });
  };

  const connect = (instanceId: string) =>
    startOperation({ instanceId, kind: "connect" }, (operationId) =>
      runtime.connect({ instanceId, operationId }),
    );

  const cancel = (instanceId: string) => {
    const activity = snapshot.activities.get(instanceId);
    if (!activity || activity.cancelling || activity.phase !== "running") return;
    setActivity(instanceId, { ...activity, cancelling: true });
    void settle(() => runtime.cancelOperation({ operationId: activity.operationId })).then(
      (result) => {
        const entry = journalEntries.find((item) => item.operationId === activity.operationId);
        if (result.ok && entry) admitOperation(entry, result.value);
        else if (!result.ok) {
          const current = snapshot.activities.get(instanceId);
          if (current?.operationId === activity.operationId)
            setActivity(instanceId, { ...current, cancelling: false });
        }
      },
    );
  };

  // Auth flows -------------------------------------------------------------------------------

  const authControl = (instanceId: string) => {
    let control = authControls.get(instanceId);
    if (!control) {
      control = { epoch: 0, queue: [], sending: false, startedFlowId: null };
      authControls.set(instanceId, control);
    }
    return control;
  };
  /** Starts a new intent: older answers, polls and typed input no longer apply. */
  const supersede = (instanceId: string) => {
    const control = authControl(instanceId);
    control.epoch += 1;
    control.queue = [];
    control.startedFlowId = null;
    clearTimer(`auth:${instanceId}`);
    return control.epoch;
  };
  const currentFlowId = (instanceId: string) => {
    const state = snapshot.auth.get(instanceId)?.state;
    return state && isAcpAuthActive(state) ? state.flowId : null;
  };
  /** A flow nobody is looking at any more, such as one whose start returned after closing. */
  const cancelOrphan = (instanceId: string, state: AcpAuthState) => {
    if (!state.flowId || !isAcpAuthActive(state) || state.flowId === currentFlowId(instanceId))
      return;
    void settle(() => runtime.cancelAuth({ instanceId, flowId: state.flowId! }));
  };

  const admitAuth = (instanceId: string, state: AcpAuthState, request: AcpAuthView["request"]) => {
    const previous = snapshot.auth.get(instanceId)?.state;
    patchAuth(instanceId, { state, request, failure: null });
    if (isAcpAuthActive(state)) {
      const epoch = authControl(instanceId).epoch;
      schedule(`auth:${instanceId}`, AUTH_POLL_MS, () => void pollAuth(instanceId, epoch));
    } else {
      clearTimer(`auth:${instanceId}`);
      authControl(instanceId).queue = [];
    }
    // A passive read can report an earlier flow's success; only the flow started here is news.
    const control = authControl(instanceId);
    const completedHere =
      state.phase === "succeeded" &&
      state.flowId !== null &&
      state.flowId === control.startedFlowId &&
      previous?.phase !== "succeeded";
    if (completedHere) {
      control.startedFlowId = null;
      // Verified sign-in answers the Connect that asked for it; other failures stay current.
      const activity = snapshot.activities.get(instanceId);
      const answered =
        activity?.phase === "failed" && activity.failure?.reason === "authentication_failed";
      if (answered) setActivity(instanceId, undefined);
      void readInspection(instanceId);
      // Signing in was the step before using the Agent: read its models unless already known.
      void readProviders().then(() => {
        const provider = snapshot.providers.get(instanceId);
        const current = snapshot.activities.get(instanceId);
        // A live operation or an unrelated failure keeps its place.
        if (current && current.phase !== "succeeded") return;
        if (!provider || !acpProviderDiscovered(provider)) connect(instanceId);
      });
    }
  };
  /**
   * A failed read or answer means the flow this view shows can't continue (it expired, the
   * configuration changed, or the request was refused). The view settles so sign-in can start
   * again; a flow the Runtime may still hold is cancelled rather than left without a surface.
   */
  const failAuth = (
    instanceId: string,
    failure: AcpFailure,
    context: "sign-in" | "sign-out" = "sign-in",
  ) => {
    const state = snapshot.auth.get(instanceId)?.state ?? null;
    if (!state || !isAcpAuthActive(state)) {
      patchAuth(instanceId, { request: null, failure: { failure, context } });
      return;
    }
    const flowId = state.flowId;
    supersede(instanceId);
    patchAuth(instanceId, {
      state: { ...state, phase: "failed", flowId: null, interaction: null, message: null },
      request: null,
      failure: { failure, context },
    });
    if (flowId && failure.reason !== "operation_expired")
      void settle(() => runtime.cancelAuth({ instanceId, flowId }));
  };

  const pollAuth = async (instanceId: string, epoch: number) => {
    const result = await settle(() => runtime.readAuth({ instanceId }));
    if (authControl(instanceId).epoch !== epoch || !snapshot.auth.has(instanceId)) return;
    if (result.ok)
      admitAuth(instanceId, result.value, snapshot.auth.get(instanceId)?.request ?? null);
    else failAuth(instanceId, result.error);
  };

  /**
   * Runs one sign-in request. A superseding request (start, cancel, sign-out) begins a new
   * intent; any answer that returns after a newer intent began is discarded, and a flow it
   * started is cancelled so no terminal or browser wait outlives its surface.
   */
  const authRequest = async (
    instanceId: string,
    request: NonNullable<AcpAuthView["request"]>,
    run: () => Promise<AcpResult<AcpAuthState>>,
    options: { readonly supersedes: boolean; readonly context?: "sign-in" | "sign-out" },
  ): Promise<boolean> => {
    const epoch = options.supersedes ? supersede(instanceId) : authControl(instanceId).epoch;
    patchAuth(instanceId, { request, failure: null });
    const result = await settle(run);
    if (authControl(instanceId).epoch !== epoch) {
      if (result.ok) cancelOrphan(instanceId, result.value);
      return false;
    }
    if (result.ok) {
      if (request === "start") authControl(instanceId).startedFlowId = result.value.flowId;
      admitAuth(instanceId, result.value, null);
    } else failAuth(instanceId, result.error, options.context ?? "sign-in");
    return result.ok;
  };

  const flowOf = (instanceId: string) => {
    const state = snapshot.auth.get(instanceId)?.state;
    return state?.flowId && state.interaction && isAcpAuthActive(state)
      ? { flowId: state.flowId, interactionId: state.interaction.id }
      : null;
  };

  /** Sends typed input in order, each chunk only to the interaction that received it. */
  const flushTerminal = async (instanceId: string) => {
    const control = authControl(instanceId);
    if (control.sending) return;
    control.sending = true;
    try {
      for (;;) {
        const chunk = control.queue.shift();
        if (!chunk) break;
        const flow = flowOf(instanceId);
        if (flow?.flowId !== chunk.flowId || flow.interactionId !== chunk.interactionId) {
          control.queue = control.queue.filter((entry) => entry.flowId !== chunk.flowId);
          continue;
        }
        const epoch = control.epoch;
        const result = await settle(() =>
          runtime.respondAuth({
            instanceId,
            flowId: chunk.flowId,
            interactionId: chunk.interactionId,
            response: { type: "terminal", data: chunk.data },
          }),
        );
        if (control.epoch !== epoch) continue;
        if (!result.ok) {
          control.queue = [];
          failAuth(instanceId, result.error);
          break;
        }
        admitAuth(instanceId, result.value, snapshot.auth.get(instanceId)?.request ?? null);
      }
    } finally {
      control.sending = false;
    }
  };

  const cancelSignIn = (instanceId: string) => {
    const view = snapshot.auth.get(instanceId);
    const flowId = currentFlowId(instanceId);
    if (!flowId) {
      // A start still on its way is abandoned; its flow is cancelled when it arrives.
      if (view?.request === "start") {
        supersede(instanceId);
        patchAuth(instanceId, { request: null });
      }
      return;
    }
    void authRequest(instanceId, "cancel", () => runtime.cancelAuth({ instanceId, flowId }), {
      supersedes: true,
    });
  };

  /** The last sign-in surface closed: end its flow and forget the view, so reopening reads fresh. */
  const closeAuth = (instanceId: string) => {
    const flowId = currentFlowId(instanceId);
    supersede(instanceId);
    publish({ auth: withEntry(snapshot.auth, instanceId, undefined) });
    if (flowId) void settle(() => runtime.cancelAuth({ instanceId, flowId }));
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        try {
          stopChanges = input.subscribeChanges(refresh);
        } catch (cause) {
          snapshot = { ...snapshot, loadError: describeAcpCause(cause) };
        }
        refresh();
        for (const entry of journalEntries)
          if (!snapshot.activities.has(entry.instanceId)) {
            setActivity(entry.instanceId, {
              kind: entry.kind,
              operationId: entry.operationId,
              phase: "running",
              failure: null,
              result: null,
              cancelling: false,
            });
            void poll(entry);
          }
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopChanges?.();
        stopChanges = null;
        clearTimer("configuration");
      };
    },
    getSnapshot: () => snapshot,
    refresh,
    addInstance: (instance) =>
      save((instances) =>
        instances.some(({ id }) => id === instance.id) ? null : [...instances, instance],
      ),
    updateInstance,
    removeInstance: (instanceId) =>
      save((instances) =>
        instances.some(({ id }) => id === instanceId)
          ? instances.filter(({ id }) => id !== instanceId)
          : null,
      ),
    setEnabled: (instanceId, enabled) =>
      updateInstance(instanceId, (saved) => ({ ...saved, enabled })),
    checkConfiguration: () => void readConfiguration(),
    install: (instanceId, request, continuation) =>
      startOperation(
        { instanceId, kind: "install", agentId: request.agentId, continuation },
        (operationId) =>
          runtime.install({
            operationId,
            agentId: request.agentId,
            distribution: request.distribution,
            ...(request.expectedInstallationId
              ? { expectedInstallationId: request.expectedInstallationId }
              : {}),
          }),
      ),
    connect,
    cancel,
    dismiss: (instanceId) => {
      const activity = snapshot.activities.get(instanceId);
      if (activity && activity.phase !== "running" && activity.phase !== "starting")
        setActivity(instanceId, undefined);
    },
    uninstall: async (agentId) => {
      let result = await settle(() => runtime.uninstall({ agentId }));
      for (
        let attempt = 1;
        attempt < UNINSTALL_ATTEMPTS &&
        !result.ok &&
        result.error.reason === "busy" &&
        !result.error.affectedSessions?.length &&
        !result.error.affectedThreadIds?.length;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, UNINSTALL_RETRY_MS));
        result = await settle(() => runtime.uninstall({ agentId }));
      }
      if (result.ok)
        for (const instance of snapshot.settings?.instances ?? [])
          if (instance.source.kind === "registry" && instance.source.agentId === agentId)
            void readInspection(instance.id);
      return result;
    },
    readAuth: (instanceId) => {
      if (snapshot.auth.get(instanceId)?.request) return;
      void authRequest(instanceId, "read", () => runtime.readAuth({ instanceId }), {
        supersedes: false,
      });
    },
    signIn: (instanceId, methodId) => {
      const view = snapshot.auth.get(instanceId);
      if (view?.request === "start" || isAcpAuthActive(view?.state)) return;
      void authRequest(
        instanceId,
        "start",
        () => runtime.startAuth({ instanceId, ...(methodId ? { methodId } : {}) }),
        { supersedes: true },
      );
    },
    respondBrowser: async (instanceId, accept) => {
      const flow = flowOf(instanceId);
      if (!flow) return false;
      return authRequest(
        instanceId,
        "respond",
        () =>
          runtime.respondAuth({
            instanceId,
            ...flow,
            response: { type: "browser", action: accept ? "accept" : "decline" },
          }),
        { supersedes: false },
      );
    },
    submitCredentials: (instanceId, values) => {
      const flow = flowOf(instanceId);
      if (!flow) return;
      void authRequest(
        instanceId,
        "respond",
        () =>
          runtime.respondAuth({ instanceId, ...flow, response: { type: "credentials", values } }),
        { supersedes: false },
      );
    },
    terminalInput: (instanceId, data) => {
      const flow = flowOf(instanceId);
      if (!flow) return;
      const control = authControl(instanceId);
      for (let offset = 0; offset < data.length; offset += TERMINAL_CHUNK)
        control.queue.push({ ...flow, data: data.slice(offset, offset + TERMINAL_CHUNK) });
      void flushTerminal(instanceId);
    },
    terminalResize: (instanceId, size) => {
      const flow = flowOf(instanceId);
      if (!flow) return;
      void settle(() =>
        runtime.respondAuth({
          instanceId,
          ...flow,
          response: { type: "terminal", data: "", size },
        }),
      );
    },
    cancelSignIn,
    signOut: (instanceId) => {
      void authRequest(instanceId, "sign-out", () => runtime.logout({ instanceId }), {
        supersedes: true,
        context: "sign-out",
      }).then((ok) => {
        if (!ok) return;
        void readProviders();
        void readInspection(instanceId);
      });
    },
    acceptUrlAuth: async (instanceId, elicitationId) => {
      const result = await settle(() => runtime.acceptUrlAuth({ instanceId, elicitationId }));
      return result.ok ? { ok: true, value: result.value.accepted } : result;
    },
    retainAuth: (instanceId) => {
      authViewers.set(instanceId, (authViewers.get(instanceId) ?? 0) + 1);
      let retained = true;
      return () => {
        if (!retained) return;
        retained = false;
        const remaining = (authViewers.get(instanceId) ?? 1) - 1;
        if (remaining > 0) {
          authViewers.set(instanceId, remaining);
          return;
        }
        authViewers.delete(instanceId);
        closeAuth(instanceId);
      };
    },
    search: (query) => settle(() => runtime.search({ query })),
    previewInstall: (agentId, distribution) =>
      settle(() => runtime.previewInstall({ agentId, distribution })),
    listSessions: (request) => settle(() => runtime.listSessions(request)),
    prepareImport: (request) => settle(() => runtime.prepareImport(request)),
    importSession: (request) => settle(() => runtime.importSession(request)),
    deleteSession: (request) => settle(() => runtime.deleteSession(request)),
    listModelServices: (request) => settle(() => runtime.listModelProviders(request)),
    setModelService: async (request) => {
      const result = await settle(() => runtime.setModelProvider(request));
      if (result.ok) void readProviders();
      return result;
    },
    disableModelService: async (request) => {
      const result = await settle(() => runtime.disableModelProvider(request));
      if (result.ok) void readProviders();
      return result;
    },
  };
}
