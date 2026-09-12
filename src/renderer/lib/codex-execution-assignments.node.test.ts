import { describe, expect, test, vi } from "vitest";
import {
  CODEX_EXECUTION_ASSIGNMENT_CONFIGS,
  CODEX_EXECUTION_ASSIGNMENT_EXPERIMENTS,
  CODEX_EXECUTION_ASSIGNMENT_GATES,
  CODEX_EXECUTION_ASSIGNMENT_LAYERS,
  CODEX_EXECUTION_TOOL_CATALOG_CONFIGS,
  CODEX_EXECUTION_TOOL_CATALOG_GATES,
  CODEX_PERMISSION_REFRESH_GATE_HASH,
} from "../../shared/codex-execution-assignments";
import { CODEX_ATTACH_AUTH_HEADER } from "../../shared/codex-http-fetch";
import { CodexHttpFetchError, fetchCodexHttp } from "./codex-http-fetch";
import {
  executionAssignmentsPublicationFromClient,
  executionStatsigOptions,
  fetchExecutionStatsigNetwork,
  isExecutionStatsigLogEventUrl,
  normalizeExecutionStatsigBody,
} from "./codex-execution-assignments";

const user = {
  userID: "user-1",
  customIDs: { account_id: "account-1", stableID: "stable-1" },
  custom: { auth_method: "chatgpt" },
};

const client = (input: {
  loadingStatus: string;
  values: unknown;
  permissionRefresh?: boolean;
  gates?: Readonly<Record<string, boolean>>;
  configs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  layers?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  experiments?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}) => {
  const getFeatureGate = vi.fn((name: string) => ({
    value:
      input.gates?.[name] ??
      (name === CODEX_PERMISSION_REFRESH_GATE_HASH ? input.permissionRefresh : undefined) ??
      false,
  }));
  const getDynamicConfig = vi.fn((name: string) => {
    const value = input.configs?.[name] ?? {};
    return { value, get: (key: string, fallback: unknown) => value[key] ?? fallback };
  });
  const getLayer = vi.fn((name: string) => {
    const value = input.layers?.[name] ?? {};
    return { __value: value, get: (key: string, fallback: unknown) => value[key] ?? fallback };
  });
  const getExperiment = vi.fn((name: string) => ({ value: input.experiments?.[name] ?? {} }));
  return {
    loadingStatus: input.loadingStatus,
    dataAdapter: { setData: vi.fn() },
    getContext: () => ({ sdkKey: "client-test", user, values: input.values }),
    getFeatureGate,
    getDynamicConfig,
    getLayer,
    getExperiment,
    initializeAsync: vi.fn(),
    initializeSync: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    shutdown: vi.fn(),
    getFeatureGateSpy: getFeatureGate,
    getDynamicConfigSpy: getDynamicConfig,
    getLayerSpy: getLayer,
    getExperimentSpy: getExperiment,
  };
};

describe("executionAssignmentsPublicationFromClient", () => {
  test("publishes identity without a payload while evaluations are loading", () => {
    const fake = client({ loadingStatus: "Loading", values: null });
    expect(executionAssignmentsPublicationFromClient(fake)).toEqual({
      userId: "user-1",
      accountId: "account-1",
      authMethod: "chatgpt",
      stableId: "stable-1",
    });
  });

  test("publishes a ready null payload when evaluations are unavailable", () => {
    expect(
      executionAssignmentsPublicationFromClient(client({ loadingStatus: "Ready", values: null })),
    ).toEqual({
      userId: "user-1",
      accountId: "account-1",
      authMethod: "chatgpt",
      stableId: "stable-1",
      payload: null,
    });
  });

  test("publishes the hashed permission gate with exposure logging disabled", () => {
    const fake = client({
      loadingStatus: "Ready",
      values: { feature_gates: {}, user },
      permissionRefresh: true,
    });
    const publication = executionAssignmentsPublicationFromClient(fake);
    expect(publication.executionValues?.permissionRefresh).toBe(true);
    expect(fake.getFeatureGateSpy).toHaveBeenCalledWith(CODEX_PERMISSION_REFRESH_GATE_HASH, {
      disableExposureLog: true,
    });
  });

  test("publishes the exact execution feature, catalog, experiment, and layer assignments", () => {
    const fake = client({
      loadingStatus: "Ready",
      values: { feature_gates: {}, user },
      gates: {
        [CODEX_EXECUTION_ASSIGNMENT_GATES.artifactSession]: true,
        [CODEX_EXECUTION_ASSIGNMENT_GATES.artifactTemplatePicker]: true,
        "1786883712": true,
        "2395575782": true,
        "2380644311": true,
        [CODEX_EXECUTION_ASSIGNMENT_GATES.localThreadStoreCompression]: true,
        [CODEX_EXECUTION_ASSIGNMENT_GATES.automaticTitles]: true,
        [CODEX_EXECUTION_ASSIGNMENT_GATES.presentationOutlinesTargeting]: true,
        [CODEX_EXECUTION_ASSIGNMENT_GATES.permissionRefresh]: true,
        [CODEX_EXECUTION_TOOL_CATALOG_GATES.projectTools]: true,
      },
      configs: {
        [CODEX_EXECUTION_ASSIGNMENT_CONFIGS.artifactTemplatePicker]: {
          template_elicitation_enabled: true,
        },
        [CODEX_EXECUTION_ASSIGNMENT_CONFIGS.featureOverrides]: {
          feature_overrides: {
            "features.shell_snapshot": false,
            compaction_image_budget: true,
            ignored_feature: true,
          },
        },
        [CODEX_EXECUTION_ASSIGNMENT_CONFIGS.guardianV2Defaults]: {
          mode: true,
        },
        [CODEX_EXECUTION_ASSIGNMENT_CONFIGS.guardianV2Experiment]: {
          min_app_server_version: "0.150.0",
          config: { nested: { enabled: true } },
        },
        [CODEX_EXECUTION_TOOL_CATALOG_CONFIGS.modelAvailability]: { luna: true },
      },
      layers: {
        "2138468235": { enable_mcp_apps: true },
        "223073164": { enable_plugins: true, enable_tool_suggest: false },
        [CODEX_EXECUTION_ASSIGNMENT_LAYERS.presentationOutlines]: { enabled: true },
        [CODEX_EXECUTION_ASSIGNMENT_LAYERS.instructions]: { luna: "custom" },
      },
      experiments: {
        [CODEX_EXECUTION_ASSIGNMENT_EXPERIMENTS.personality]: { personality: "pragmatic" },
      },
    });

    const publication = executionAssignmentsPublicationFromClient(fake);
    expect(publication.defaultEnableFeatures).toEqual({
      unified_exec: true,
      thread_tools: true,
      shell_snapshot: false,
      compaction_image_budget: true,
      enable_mcp_apps: true,
      apps: true,
      plugins: true,
      recommended_plugins: true,
      tool_suggest: false,
      guardianv2: { mode: true },
      realtime_conversation: true,
    });
    expect(publication.executionValues).toMatchObject({
      artifactSession: true,
      artifactTemplatePicker: true,
      guardianV2Experiment: {
        min_app_server_version: "0.150.0",
        config: { nested: { enabled: true } },
      },
      automaticTitles: true,
      experimentalFeatureGates: { localThreadStoreCompression: true },
      presentationOutlinesTargeting: true,
      presentationOutlines: { enabled: true },
      permissionRefresh: true,
      personality: { personality: "pragmatic" },
      instructions: { luna: "custom" },
      toolCatalog: {
        restrictedGates: {},
        gates: { projectTools: true },
        configs: { modelAvailability: { luna: true } },
      },
    });
    expect(fake.getFeatureGateSpy).toHaveBeenCalledWith(
      CODEX_EXECUTION_ASSIGNMENT_GATES.localThreadStoreCompression,
      { disableExposureLog: false },
    );
    expect(fake.getFeatureGateSpy).toHaveBeenCalledWith(
      CODEX_EXECUTION_TOOL_CATALOG_GATES.projectTools,
      { disableExposureLog: true },
    );
    expect(fake.getLayerSpy).toHaveBeenCalledWith(CODEX_EXECUTION_ASSIGNMENT_LAYERS.instructions, {
      disableExposureLog: true,
    });
    expect(fake.getExperimentSpy).toHaveBeenCalledWith(
      CODEX_EXECUTION_ASSIGNMENT_EXPERIMENTS.personality,
      { disableExposureLog: true },
    );
  });

  test("rejects values embedded for a different user", () => {
    const fake = client({
      loadingStatus: "Ready",
      values: {
        user: {
          userID: "user-2",
          customIDs: { account_id: "account-2", stableID: "stable-1" },
          custom: { auth_method: "chatgpt" },
        },
      },
      permissionRefresh: true,
    });
    expect(executionAssignmentsPublicationFromClient(fake).payload).toBeNull();
    expect(fake.getFeatureGateSpy).not.toHaveBeenCalled();
  });

  test("rejects embedded evaluation users with a different custom id set", () => {
    const fake = client({
      loadingStatus: "Ready",
      values: {
        user: {
          ...user,
          customIDs: { ...user.customIDs, extra: "different" },
        },
      },
    });
    expect(executionAssignmentsPublicationFromClient(fake).payload).toBeNull();
  });
});

describe("execution Statsig network transport", () => {
  test("uses the source endpoints and native network override", () => {
    const options = executionStatsigOptions() as {
      readonly loggingEnabled: string;
      readonly networkConfig: Readonly<Record<string, unknown>>;
    };
    expect(options.loggingEnabled).toBe("disabled");
    expect(options.networkConfig.api).toBe("https://ab.chatgpt.com/v1");
    expect(options.networkConfig.sdkExceptionUrl).toBe("https://ab.chatgpt.com/v1/sdk_exception");
    expect(options.networkConfig.logEventUrl).toBe("https://chatgpt.com/ces/v1/rgstr");
    expect(options.networkConfig.preventAllNetworkTraffic).toBe(false);
    expect(options.networkConfig.networkOverrideFunc).toBeTypeOf("function");
  });

  test("normalizes Statsig bodies before crossing the native boundary", async () => {
    await expect(normalizeExecutionStatsigBody("raw")).resolves.toBe("raw");
    await expect(
      normalizeExecutionStatsigBody(new URLSearchParams({ a: "1", b: "two" })),
    ).resolves.toBe("a=1&b=two");
    const bytes = await normalizeExecutionStatsigBody(new Blob(["bytes"]));
    expect(bytes).toEqual(new TextEncoder().encode("bytes"));
  });

  test("suppresses sdk_exception traffic when Statsig logging is disabled", async () => {
    const nativeFetch = vi.fn(
      async (_url: string, _init: Parameters<typeof fetchCodexHttp>[1]) =>
        new Response("unexpected", { status: 200 }),
    );
    const response = await fetchExecutionStatsigNetwork(
      "https://ab.chatgpt.com/v1/sdk_exception",
      { method: "POST", body: "{}" },
      false,
      nativeFetch,
    );
    expect(response.status).toBe(204);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  test("marks only the CES registration path for Main-side authentication", async () => {
    expect(isExecutionStatsigLogEventUrl("https://chatgpt.com/ces/v1/rgstr")).toBe(true);
    expect(isExecutionStatsigLogEventUrl("https://chatgpt.com/ces/v1/rgstr/?batch=1")).toBe(true);
    expect(isExecutionStatsigLogEventUrl("https://ab.chatgpt.com/ces/v1/rgstr")).toBe(false);

    const nativeFetch = vi.fn(
      async (_url: string, _init: Parameters<typeof fetchCodexHttp>[1]) =>
        new Response("ok", { status: 200 }),
    );
    await fetchExecutionStatsigNetwork(
      "https://chatgpt.com/ces/v1/rgstr?batch=1",
      {
        method: "POST",
        headers: { "X-Custom": "yes" },
        body: new URLSearchParams({ value: "1" }),
      },
      true,
      nativeFetch,
    );
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    const [, init] = nativeFetch.mock.calls[0] ?? [];
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      "x-custom": "yes",
      [CODEX_ATTACH_AUTH_HEADER]: "1",
    });
    expect(init?.body).toBe("value=1");
  });

  test("turns native HTTP service errors back into ordinary responses", async () => {
    const nativeFetch = vi.fn(async (_url: string, _init: Parameters<typeof fetchCodexHttp>[1]) => {
      throw new CodexHttpFetchError({
        responseType: "error",
        requestId: "request-1",
        status: 429,
        error: "rate limited",
        responseStatus: 429,
      });
    });
    const response = await fetchExecutionStatsigNetwork(
      "https://ab.chatgpt.com/v1/initialize",
      { method: "POST", body: "{}" },
      true,
      nativeFetch,
    );
    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toBe("rate limited");
  });
});
