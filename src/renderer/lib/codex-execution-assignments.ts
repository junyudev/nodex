import {
  CODEX_EXECUTION_ASSIGNMENT_CONFIGS,
  CODEX_EXECUTION_ASSIGNMENT_EXPERIMENTS,
  CODEX_EXECUTION_ASSIGNMENT_GATES,
  CODEX_EXECUTION_ASSIGNMENT_LAYERS,
  CODEX_EXECUTION_DYNAMIC_FEATURE_ALLOWLIST,
  CODEX_EXECUTION_FEATURE_GATE_MAPPINGS,
  CODEX_EXECUTION_FEATURE_LAYERS,
  CODEX_EXECUTION_TOOL_CATALOG_CONFIGS,
  CODEX_EXECUTION_TOOL_CATALOG_GATES,
  type CodexExecutionAssignmentIdentity,
  type CodexExecutionAssignmentValues,
  type CodexExecutionAssignmentsPublication,
  type CodexExecutionToolCatalog,
  type CodexExecutionStatsigBootstrap,
  type CodexExecutionStatsigUser,
  type CodexGuardianV2Experiment,
  isCodexSemanticVersion,
} from "../../shared/codex-execution-assignments";
import { _getFullUserHash, type StatsigUser } from "@statsig/js-client";
import { CODEX_ATTACH_AUTH_HEADER } from "../../shared/codex-http-fetch";
import { registerAppCloseFlushHandler } from "./app-close-flush";
import { subscribeCodexEvents } from "./api";
import { CodexHttpFetchError, fetchCodexHttp } from "./codex-http-fetch";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

interface StatsigContextLike {
  readonly sdkKey: string;
  readonly user: CodexExecutionStatsigUser;
  readonly values: unknown;
}

interface ExecutionStatsigClient {
  readonly loadingStatus: string;
  readonly dataAdapter: {
    setData: (data: string) => void;
    getDataSync?: (user: CodexExecutionStatsigUser) => {
      readonly data: string;
      readonly fullUserHash?: string | null;
    } | null;
  };
  readonly getContext: () => StatsigContextLike;
  readonly getFeatureGate: (
    name: string,
    options?: { readonly disableExposureLog?: boolean },
  ) => { readonly value: boolean };
  readonly getDynamicConfig: (
    name: string,
    options?: { readonly disableExposureLog?: boolean },
  ) => {
    readonly value: Readonly<Record<string, unknown>>;
    readonly get: (name: string, fallback: unknown) => unknown;
  };
  readonly getExperiment: (
    name: string,
    options?: { readonly disableExposureLog?: boolean },
  ) => { readonly value: Readonly<Record<string, unknown>> };
  readonly getLayer: (
    name: string,
    options?: { readonly disableExposureLog?: boolean },
  ) => {
    readonly __value: Readonly<Record<string, unknown>>;
    readonly get: (name: string, fallback: unknown) => unknown;
  };
  readonly initializeAsync: (options?: { readonly timeoutMs?: number }) => Promise<unknown>;
  readonly initializeSync: () => unknown;
  readonly on: (name: "values_updated", listener: () => void) => void;
  readonly off: (name: "values_updated", listener: () => void) => void;
  readonly shutdown: () => Promise<void>;
}

interface ExecutionStatsigAdapter {
  readonly createClient: (
    bootstrap: CodexExecutionStatsigBootstrap,
    options: Readonly<Record<string, unknown>>,
  ) => ExecutionStatsigClient;
}

interface InitializeInput {
  readonly adapter?: ExecutionStatsigAdapter;
  readonly readBootstrap?: () => Promise<CodexExecutionStatsigBootstrap>;
  readonly publish?: (publication: CodexExecutionAssignmentsPublication) => Promise<void>;
  readonly subscribeEvents?: typeof subscribeCodexEvents;
}

const publishExecutionAssignmentsCommand = defineRendererCommand({
  key: "codex_execution_assignments.publish",
  channel: "codex:execution-assignments:publish",
  authority: "main",
  owner: "CodexExecutionAssignments",
  protocol: { kind: "returned_value" },
});

const EXECUTION_STATSIG_API = "https://ab.chatgpt.com/v1";
const EXECUTION_STATSIG_SDK_EXCEPTION = "https://ab.chatgpt.com/v1/sdk_exception";
const EXECUTION_STATSIG_LOG_EVENT = "https://chatgpt.com/ces/v1/rgstr";

let activeClient: ExecutionStatsigClient | null = null;
let activeClientValuesListener: (() => void) | null = null;
let initializationPromise: Promise<boolean> | null = null;
let disposeEventSubscription: (() => void) | null = null;
let disposeCloseHandler: (() => void) | null = null;
let generation = 0;
let reloadInFlight = false;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const recordsEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => recordsEqual(entry, right[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      recordsEqual(leftRecord[key], rightRecord[key]),
  );
};

const identityFromUser = (user: CodexExecutionStatsigUser): CodexExecutionAssignmentIdentity => ({
  userId: user.userID ?? null,
  accountId: user.customIDs?.account_id ?? null,
  authMethod: nullableString(user.custom?.auth_method),
  stableId: user.customIDs?.stableID ?? null,
});

const evaluationUserMatches = (
  client: ExecutionStatsigClient,
  values: Readonly<Record<string, unknown>>,
  user: CodexExecutionStatsigUser,
): boolean => {
  const evaluationUser = asRecord(values.user);
  if (evaluationUser) {
    const custom = asRecord(evaluationUser.custom);
    return (
      nullableString(evaluationUser.userID) === (user.userID ?? null) &&
      nullableString(custom?.auth_method) === nullableString(user.custom?.auth_method) &&
      recordsEqual(evaluationUser.customIDs, user.customIDs)
    );
  }
  const cached = client.dataAdapter.getDataSync?.(user);
  if (!cached || cached.fullUserHash !== _getFullUserHash(user as StatsigUser)) return false;
  try {
    return recordsEqual(JSON.parse(cached.data), values);
  } catch {
    return false;
  }
};

const normalizeFeatureKey = (key: string): string =>
  key.startsWith("features.") ? key.slice("features.".length) : key;

const booleanRecord = (
  value: unknown,
  normalizeKeys: boolean,
): Readonly<Record<string, boolean>> => {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, entry]) =>
      typeof entry === "boolean" ? [[normalizeKeys ? normalizeFeatureKey(key) : key, entry]] : [],
    ),
  );
};

const readGuardianV2Experiment = (
  client: ExecutionStatsigClient,
): CodexGuardianV2Experiment | undefined => {
  const config = client.getDynamicConfig(CODEX_EXECUTION_ASSIGNMENT_CONFIGS.guardianV2Experiment);
  const minimum = config.get("min_app_server_version", "");
  const value = config.get("config", {});
  const record = asRecord(value);
  if (typeof minimum !== "string" || !isCodexSemanticVersion(minimum) || !record) return undefined;
  return { min_app_server_version: minimum, config: record };
};

const readDefaultEnableFeatures = (
  client: ExecutionStatsigClient,
): Readonly<Record<string, unknown>> => {
  const direct = Object.fromEntries(
    CODEX_EXECUTION_FEATURE_GATE_MAPPINGS.flatMap(([gateName, featureKey]) =>
      client.getFeatureGate(gateName).value ? [[featureKey, true]] : [],
    ),
  );
  const dynamicConfig = client.getDynamicConfig(
    CODEX_EXECUTION_ASSIGNMENT_CONFIGS.featureOverrides,
  );
  const dynamic = booleanRecord(dynamicConfig.get("feature_overrides", {}), true);
  const allowlisted = Object.fromEntries(
    Object.entries(dynamic).filter(([key]) => CODEX_EXECUTION_DYNAMIC_FEATURE_ALLOWLIST.has(key)),
  );
  const layers: Record<string, boolean> = {};
  for (const mapping of CODEX_EXECUTION_FEATURE_LAYERS) {
    const value = client.getLayer(mapping.layerName).get(mapping.param, null);
    if (typeof value !== "boolean") continue;
    for (const featureKey of mapping.featureKeys) layers[featureKey] = value;
  }
  const guardianDefaults = booleanRecord(
    client.getDynamicConfig(CODEX_EXECUTION_ASSIGNMENT_CONFIGS.guardianV2Defaults).value,
    false,
  );
  return {
    ...direct,
    ...allowlisted,
    ...layers,
    ...(Object.keys(guardianDefaults).length === 0 ? {} : { guardianv2: guardianDefaults }),
    realtime_conversation: client.getFeatureGate("2380644311").value,
  };
};

const readToolCatalog = (client: ExecutionStatsigClient): CodexExecutionToolCatalog => ({
  restrictedGates: {},
  gates: Object.fromEntries(
    Object.entries(CODEX_EXECUTION_TOOL_CATALOG_GATES).map(([key, gate]) => [
      key,
      client.getFeatureGate(gate, { disableExposureLog: true }).value,
    ]),
  ) as unknown as CodexExecutionToolCatalog["gates"],
  configs: Object.fromEntries(
    Object.entries(CODEX_EXECUTION_TOOL_CATALOG_CONFIGS).map(([key, config]) => [
      key,
      client.getDynamicConfig(config, { disableExposureLog: true }).value,
    ]),
  ) as unknown as CodexExecutionToolCatalog["configs"],
});

const readExecutionValues = (client: ExecutionStatsigClient): CodexExecutionAssignmentValues => {
  const guardianV2Experiment = readGuardianV2Experiment(client);
  const artifactTemplatePickerConfig = client.getDynamicConfig(
    CODEX_EXECUTION_ASSIGNMENT_CONFIGS.artifactTemplatePicker,
    { disableExposureLog: true },
  );
  return {
    ...(guardianV2Experiment === undefined ? {} : { guardianV2Experiment }),
    artifactSession: client.getFeatureGate(CODEX_EXECUTION_ASSIGNMENT_GATES.artifactSession, {
      disableExposureLog: false,
    }).value,
    artifactTemplatePicker:
      client.getFeatureGate(CODEX_EXECUTION_ASSIGNMENT_GATES.artifactTemplatePicker, {
        disableExposureLog: false,
      }).value && artifactTemplatePickerConfig.get("template_elicitation_enabled", true) === true,
    experimentalFeatureGates: {
      localThreadStoreCompression: client.getFeatureGate(
        CODEX_EXECUTION_ASSIGNMENT_GATES.localThreadStoreCompression,
        { disableExposureLog: false },
      ).value,
      mcp20260728: client.getFeatureGate(CODEX_EXECUTION_ASSIGNMENT_GATES.mcp20260728, {
        disableExposureLog: false,
      }).value,
      curatedRemoteMarketplace: client.getFeatureGate(
        CODEX_EXECUTION_ASSIGNMENT_GATES.curatedRemoteMarketplace,
        { disableExposureLog: false },
      ).value,
      backgroundPaginatedRolloutMigration: client.getFeatureGate(
        CODEX_EXECUTION_ASSIGNMENT_GATES.backgroundPaginatedRolloutMigration,
        { disableExposureLog: false },
      ).value,
    },
    toolCatalog: readToolCatalog(client),
    automaticTitles: client.getFeatureGate(CODEX_EXECUTION_ASSIGNMENT_GATES.automaticTitles, {
      disableExposureLog: true,
    }).value,
    presentationOutlinesTargeting: client.getFeatureGate(
      CODEX_EXECUTION_ASSIGNMENT_GATES.presentationOutlinesTargeting,
      { disableExposureLog: true },
    ).value,
    presentationOutlines: client.getLayer(CODEX_EXECUTION_ASSIGNMENT_LAYERS.presentationOutlines, {
      disableExposureLog: true,
    }).__value,
    permissionRefresh: client.getFeatureGate(CODEX_EXECUTION_ASSIGNMENT_GATES.permissionRefresh, {
      disableExposureLog: true,
    }).value,
    threadQueue: client.getFeatureGate(CODEX_EXECUTION_ASSIGNMENT_GATES.threadQueue, {
      disableExposureLog: false,
    }).value,
    personality: client.getExperiment(CODEX_EXECUTION_ASSIGNMENT_EXPERIMENTS.personality, {
      disableExposureLog: true,
    }).value,
    instructions: client.getLayer(CODEX_EXECUTION_ASSIGNMENT_LAYERS.instructions, {
      disableExposureLog: true,
    }).__value,
  };
};

export function executionAssignmentsPublicationFromClient(
  client: ExecutionStatsigClient,
): CodexExecutionAssignmentsPublication {
  const context = client.getContext();
  const identity = identityFromUser(context.user);
  if (client.loadingStatus !== "Ready") return identity;
  const values = asRecord(context.values);
  if (!values || !evaluationUserMatches(client, values, context.user))
    return { ...identity, payload: null };
  return {
    sdkKey: context.sdkKey,
    ...identity,
    payload: JSON.stringify({ ...values, user: values.user ?? context.user }),
    defaultEnableFeatures: readDefaultEnableFeatures(client),
    executionValues: readExecutionValues(client),
  };
}

export async function normalizeExecutionStatsigBody(
  body: BodyInit | null | undefined,
): Promise<string | Uint8Array | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export function isExecutionStatsigLogEventUrl(value: string): boolean {
  try {
    const target = new URL(value);
    const expected = new URL(EXECUTION_STATSIG_LOG_EVENT);
    const expectedPath = expected.pathname.replace(/\/+$/u, "") || "/";
    return (
      target.origin === expected.origin &&
      (target.pathname.replace(/\/+$/u, "") || "/") === expectedPath
    );
  } catch {
    return false;
  }
}

export async function fetchExecutionStatsigNetwork(
  url: string,
  init: RequestInit,
  loggingEnabled = true,
  nativeFetch: typeof fetchCodexHttp = fetchCodexHttp,
): Promise<Response> {
  if (!loggingEnabled && url === EXECUTION_STATSIG_SDK_EXCEPTION) {
    return new Response(null, { status: 204 });
  }
  const body = await normalizeExecutionStatsigBody(init.body);
  const headers = {
    "content-type": "application/json",
    ...Object.fromEntries(new Headers(init.headers).entries()),
    ...(isExecutionStatsigLogEventUrl(url) ? { [CODEX_ATTACH_AUTH_HEADER]: "1" } : {}),
  };
  try {
    return await nativeFetch(url, {
      method: init.method ?? "GET",
      ...(body === undefined ? {} : { body }),
      headers,
      ...(init.keepalive === undefined ? {} : { keepalive: init.keepalive }),
      signal: init.signal,
    });
  } catch (error) {
    if (error instanceof CodexHttpFetchError) {
      return new Response(error.message, { status: error.status });
    }
    throw error;
  }
}

export const executionStatsigOptions = (): Readonly<Record<string, unknown>> => ({
  disableStorage: true,
  enableLiveValuesAutoRefresh: true,
  loggingEnabled: "disabled",
  networkConfig: {
    api: EXECUTION_STATSIG_API,
    logEventUrl: EXECUTION_STATSIG_LOG_EVENT,
    sdkExceptionUrl: EXECUTION_STATSIG_SDK_EXCEPTION,
    preventAllNetworkTraffic: false,
    networkOverrideFunc: (url: string, init: RequestInit) =>
      fetchExecutionStatsigNetwork(url, init, false),
  },
});

const defaultReadBootstrap = () => invokeRendererQuery("codex:execution-assignments:bootstrap");
const defaultPublish = (publication: CodexExecutionAssignmentsPublication) =>
  invokePlainCommand(publishExecutionAssignmentsCommand, publication);

async function loadDefaultAdapter(): Promise<ExecutionStatsigAdapter> {
  const statsig = await import("@statsig/js-client");
  return {
    createClient: (bootstrap, options) =>
      new statsig.StatsigClient(
        bootstrap.sdkKey,
        bootstrap.user as ConstructorParameters<typeof statsig.StatsigClient>[1],
        options as ConstructorParameters<typeof statsig.StatsigClient>[2],
      ) as unknown as ExecutionStatsigClient,
  };
}

async function retireActiveClient(): Promise<void> {
  const client = activeClient;
  const listener = activeClientValuesListener;
  activeClient = null;
  activeClientValuesListener = null;
  if (!client) return;
  if (listener) client.off("values_updated", listener);
  await client.shutdown().catch(() => {});
}

async function installClient(
  input: Required<Pick<InitializeInput, "readBootstrap" | "publish">> & {
    readonly adapter: ExecutionStatsigAdapter;
  },
): Promise<void> {
  const localGeneration = ++generation;
  const bootstrap = await input.readBootstrap();
  if (localGeneration !== generation) return;
  await retireActiveClient();
  if (localGeneration !== generation) return;

  await input.publish({ ...identityFromUser(bootstrap.user), payload: undefined });
  if (localGeneration !== generation) return;

  const client = input.adapter.createClient(bootstrap, executionStatsigOptions());
  activeClient = client;
  const publishCurrent = () => {
    if (localGeneration !== generation || activeClient !== client) return;
    void input.publish(executionAssignmentsPublicationFromClient(client)).catch(() => {});
  };
  activeClientValuesListener = publishCurrent;
  client.on("values_updated", publishCurrent);

  if (bootstrap.statsigPayload) {
    client.dataAdapter.setData(bootstrap.statsigPayload);
    client.initializeSync();
    publishCurrent();
    return;
  }
  await client.initializeAsync({ timeoutMs: 5_000 }).catch(() => {});
  publishCurrent();
}

export async function initializeCodexExecutionAssignments(
  input: InitializeInput = {},
): Promise<boolean> {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    try {
      const adapter = input.adapter ?? (await loadDefaultAdapter());
      const readBootstrap = input.readBootstrap ?? defaultReadBootstrap;
      const publish = input.publish ?? defaultPublish;
      const subscribeEvents = input.subscribeEvents ?? subscribeCodexEvents;
      const install = async () => {
        if (reloadInFlight) return;
        reloadInFlight = true;
        try {
          await installClient({ adapter, readBootstrap, publish });
        } finally {
          reloadInFlight = false;
        }
      };
      await install();
      disposeEventSubscription = subscribeEvents((event) => {
        if (event.type === "account") {
          void install();
          return;
        }
        if (event.type !== "executionAssignmentsChanged" || reloadInFlight) return;
        void invokeRendererQuery("codex:execution-assignments:read")
          .then((snapshot) => {
            if (snapshot.permissionRefresh === null) void install();
          })
          .catch(() => {});
      });
      disposeCloseHandler = registerAppCloseFlushHandler(async () => {
        generation += 1;
        disposeEventSubscription?.();
        disposeEventSubscription = null;
        disposeCloseHandler?.();
        disposeCloseHandler = null;
        await retireActiveClient();
      });
      return true;
    } catch {
      return false;
    }
  })();
  return initializationPromise;
}

export async function resetCodexExecutionAssignmentsForTests(): Promise<void> {
  generation += 1;
  disposeEventSubscription?.();
  disposeEventSubscription = null;
  disposeCloseHandler?.();
  disposeCloseHandler = null;
  initializationPromise = null;
  reloadInFlight = false;
  await retireActiveClient();
}
