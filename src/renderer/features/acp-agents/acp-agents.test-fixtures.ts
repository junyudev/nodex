import { vi } from "vite-plus/test";
import type { AcpResult } from "../../../shared/acp-api";
import type {
  AcpAgentInstanceConfig,
  AcpAgentSettings,
  AcpAgentSettingsUpdateResult,
  UpdateAcpAgentSettingsInput,
} from "../../../shared/acp-agent-settings";
import type { AcpAgentsRuntime } from "../../lib/acp-agents-runtime";
import type {
  AcpAuthState,
  AcpInspection,
  AcpOperation,
  AcpProviderSnapshot,
  AcpRegistryAgent,
} from "./acp-agent-model";

type Input<Method extends keyof AcpAgentsRuntime> = Parameters<AcpAgentsRuntime[Method]>[0];

export const ok = <Value>(value: Value): AcpResult<Value> => ({ ok: true, value });

export const registryInstance = (
  patch: Partial<AcpAgentInstanceConfig> = {},
): AcpAgentInstanceConfig => ({
  id: "qoder-main",
  agentDefinitionId: "qoder-cli",
  displayName: "Qoder",
  enabled: true,
  source: { kind: "registry", agentId: "qoder-cli", distribution: "auto" },
  environment: [],
  credentials: { kind: "inherit-host-profile" },
  proxy: "inherit-host",
  customModels: [],
  ...patch,
});

export const localInstance = (
  patch: Partial<AcpAgentInstanceConfig> = {},
): AcpAgentInstanceConfig => ({
  id: "local-one",
  agentDefinitionId: "local-1",
  displayName: "Scripted",
  enabled: true,
  source: { kind: "local", executable: "/opt/agents/scripted", args: ["--acp"] },
  environment: [],
  credentials: { kind: "inherit-host-profile" },
  proxy: "inherit-host",
  customModels: [],
  ...patch,
});

export const readyInspection = (patch: Partial<AcpInspection> = {}): AcpInspection =>
  ({
    status: "ready",
    agentId: "qoder-cli",
    version: "0.2.14",
    distribution: "binary",
    latestVersion: "0.2.14",
    ...patch,
  }) as AcpInspection;

export const operation = (patch: Partial<AcpOperation> = {}): AcpOperation => ({
  operationId: "op",
  kind: "install",
  phase: "running",
  instanceId: null,
  agentId: "qoder-cli",
  result: null,
  error: null,
  ...patch,
});

export const authState = (patch: Partial<AcpAuthState> = {}): AcpAuthState => ({
  instanceId: "qoder-main",
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
  methods: [],
  interaction: null,
  ...patch,
});

/** The Runtime's record that a real connection reported the Agent's capabilities. */
export const discovered = (
  patch: { readonly supportsModelSelection?: boolean; readonly status?: "ready" | "failed" } = {},
) => ({
  discovery: {
    status: patch.status ?? ("ready" as const),
    checkedAt: "2026-10-25T00:00:00.000Z",
    ...(patch.supportsModelSelection === undefined
      ? {}
      : { supportsModelSelection: patch.supportsModelSelection }),
  },
});

export const providerSnapshot = (patch: Partial<AcpProviderSnapshot> = {}): AcpProviderSnapshot =>
  ({
    instanceId: "acp_x",
    driver: "acpRegistry",
    enabled: true,
    installed: true,
    version: "0.2.14",
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-10-24T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...patch,
  }) as AcpProviderSnapshot;

export const registryAgent = (patch: Partial<AcpRegistryAgent> = {}): AcpRegistryAgent => ({
  id: "qoder-cli",
  name: "Qoder CLI",
  version: "0.2.14",
  description: "Coding agent",
  authors: ["Qoder"],
  license: "MIT",
  website: "https://qoder.com",
  repository: null,
  icon: null,
  distribution: "binary",
  integrity: "sha256",
  distributions: [{ kind: "binary", available: true, runner: null, reason: null }],
  ...patch,
});

/** A Main/Runtime double that stores settings like Main does; operations are scripted. */
export function fakeAcpRuntime(initial: AcpAgentSettings = { instances: [] }) {
  let settings = initial;
  let deferred: readonly string[] = [];
  let failed = false;
  const status = () => ({
    deferredInstanceIds: deferred,
    configurationStatus: failed
      ? ("failed" as const)
      : deferred.length
        ? ("deferred" as const)
        : ("applied" as const),
  });
  const runtime = {
    readSettings: vi.fn(async () => settings),
    readConfigurationStatus: vi.fn(async () => status()),
    updateSettings: vi.fn(
      async (input: UpdateAcpAgentSettingsInput): Promise<AcpAgentSettingsUpdateResult> => {
        settings = {
          instances: input.instances.map((instance) => ({
            ...instance,
            environment: instance.environment.map((variable) =>
              variable.sensitive
                ? { name: variable.name, sensitive: true as const, value: null }
                : variable,
            ),
          })),
        };
        return {
          ...settings,
          ...status(),
        };
      },
    ),
    knownProviders: vi.fn(async () => [] as AcpProviderSnapshot[]),
    search: vi.fn(async (_input: Input<"search">) => ok({ agents: [registryAgent()] })),
    inspect: vi.fn(async (_input: Input<"inspect">) => ok(readyInspection())),
    previewInstall: vi.fn<AcpAgentsRuntime["previewInstall"]>(),
    install: vi.fn(async ({ operationId }: { operationId: string }) =>
      ok(operation({ operationId })),
    ),
    uninstall: vi.fn(async ({ agentId }: { agentId: string }) => ok({ agentId, removed: true })),
    connect: vi.fn(
      async ({ operationId, instanceId }: { operationId: string; instanceId: string }) =>
        ok(operation({ operationId, kind: "connect", instanceId, agentId: null })),
    ),
    readOperation: vi.fn(async ({ operationId }: { operationId: string }) =>
      ok(operation({ operationId })),
    ),
    cancelOperation: vi.fn(async ({ operationId }: { operationId: string }) =>
      ok(operation({ operationId, phase: "cancelled" })),
    ),
    readAuth: vi.fn(async (_input: Input<"readAuth">) => ok(authState())),
    startAuth: vi.fn(async (_input: Input<"startAuth">) => ok(authState())),
    respondAuth: vi.fn(async (_input: Input<"respondAuth">) => ok(authState())),
    cancelAuth: vi.fn(async (_input: Input<"cancelAuth">) => ok(authState({ phase: "cancelled" }))),
    logout: vi.fn(async (_input: Input<"logout">) => ok(authState())),
    acceptUrlAuth: vi.fn(async () => ok({ accepted: true })),
    listSessions: vi.fn<AcpAgentsRuntime["listSessions"]>(),
    prepareImport: vi.fn<AcpAgentsRuntime["prepareImport"]>(),
    importSession: vi.fn<AcpAgentsRuntime["importSession"]>(),
    deleteSession: vi.fn<AcpAgentsRuntime["deleteSession"]>(),
    listModelProviders: vi.fn<AcpAgentsRuntime["listModelProviders"]>(),
    setModelProvider: vi.fn<AcpAgentsRuntime["setModelProvider"]>(),
    disableModelProvider: vi.fn<AcpAgentsRuntime["disableModelProvider"]>(),
  };
  return {
    runtime: runtime as typeof runtime & AcpAgentsRuntime,
    settings: () => settings,
    /** Main's current reconcile result, returned by saves and status reads alike. */
    setFailed: (value: boolean) => {
      failed = value;
    },
    deferNext: (ids: readonly string[]) => {
      deferred = ids;
    },
  };
}

export const memoryJournal = (initial: string | null = null) => {
  let value = initial;
  return {
    read: () => value,
    write: (next: string | null) => {
      value = next;
    },
    current: () => value,
  };
};
