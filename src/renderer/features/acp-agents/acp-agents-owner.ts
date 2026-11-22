import { newAgentInstanceId } from "../../../shared/agents/instance-id";
import { agentAccountsRuntime, type AgentAccountsRuntime } from "../../lib/agent-accounts-runtime";
import {
  createAgentAccountOwner,
  type AgentAccountOwner,
} from "../agent-account/agent-account-owner";
import { getIntl } from "@/lib/i18n";
import type { AcpResult } from "../../../shared/acp-api";
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
  settle,
  type AcpActivity,
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
  readonly account: (instanceId: string) => AgentAccountOwner;
  readonly acceptUrlAuth: (
    instanceId: string,
    elicitationId: string,
  ) => Promise<AcpResult<boolean>>;
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
/** The Runtime's post-install reservation is bounded; four tries span it. */
const UNINSTALL_ATTEMPTS = 4;
const UNINSTALL_RETRY_MS = 10_000;
/** Pending changes apply as soon as the Agent goes idle; a failed reconcile retries slower. */
const CONFIGURATION_POLL_MS = { deferred: 2_000, failed: 10_000 } as const;

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
  readonly accountRuntime?: AgentAccountsRuntime;
  readonly subscribeChanges: (listener: () => void) => () => void;
  readonly journal: AcpOperationJournal;
  readonly createId?: () => string;
  readonly now?: () => number;
}): AcpAgentsOwner {
  const { runtime, journal } = input;
  const createId = input.createId ?? (() => newAgentInstanceId("acpRegistry"));
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_SNAPSHOT;
  let stopChanges: (() => void) | null = null;
  let refreshing = false;
  let refreshAgain = false;
  let saveChain: Promise<unknown> = Promise.resolve();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const accounts = new Map<string, AgentAccountOwner>();
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
    for (const id of accounts.keys()) if (!ids.has(id)) accounts.delete(id);
    publish({
      settings,
      loadError: null,
      inspections: keep(snapshot.inspections),
      providers: keep(snapshot.providers),
      activities: keep(snapshot.activities),
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
        : {
            ok: false as const,
            message: getIntl().formatMessage({
              id: "acpAgents.acpAgentsOwner.thisAgentNoLongerExists",
              defaultMessage: "This Agent no longer exists.",
            }),
          },
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
    // An install that continues to Connect stays Installing while its receipt is pinned, so the
    // instance never reads as Not connected in between.
    const connectsNext =
      entry.kind === "install" &&
      entry.continuation === "connect" &&
      operation.phase === "succeeded";
    setActivity(entry.instanceId, {
      kind: entry.kind,
      operationId: entry.operationId,
      phase: connectsNext ? "running" : operation.phase,
      ...(operation.progress && !connectsNext ? { progress: operation.progress } : {}),
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
        const settled = snapshot.activities.get(entry.instanceId);
        if (settled?.operationId === entry.operationId && settled.phase === "running")
          setActivity(entry.instanceId, { ...settled, phase: "succeeded", cancelling: false });
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

  const account = (instanceId: string) => {
    const existing = accounts.get(instanceId);
    if (existing) return existing;
    const created = createAgentAccountOwner({
      backend: { driver: "acpRegistry", instanceId: instanceId },
      runtime: input.accountRuntime ?? agentAccountsRuntime,
      onSignedIn: () => {
        const activity = snapshot.activities.get(instanceId);
        if (activity?.phase === "failed" && activity.failure?.reason === "authentication_failed")
          setActivity(instanceId, undefined);
        void readInspection(instanceId);
        void readProviders().then(() => {
          const provider = snapshot.providers.get(instanceId);
          const current = snapshot.activities.get(instanceId);
          if (current && current.phase !== "succeeded") return;
          if (!provider || !acpProviderDiscovered(provider)) connect(instanceId);
        });
      },
      onSignedOut: () => {
        void readProviders();
        void readInspection(instanceId);
      },
    });
    accounts.set(instanceId, created);
    return created;
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
    account,
    acceptUrlAuth: async (instanceId, elicitationId) => {
      const result = await settle(() => runtime.acceptUrlAuth({ instanceId, elicitationId }));
      return result.ok ? { ok: true, value: result.value.accepted } : result;
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
