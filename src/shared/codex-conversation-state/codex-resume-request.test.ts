import { expect, test } from "vite-plus/test";
import { buildConversationResumeRequest } from "./codex-resume-request";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";

const input = () => ({
  hostId: "local",
  threadId: "thread",
  metadata: {
    ...buildAgentActivityV2CorpusThread([]),
    id: "thread",
    status: { type: "idle" as const },
    historyMode: "paginated" as const,
  },
  supportsPaginatedHistory: true,
  overrides: { cwd: "/workspace" },
  config: { "features.thread_tools": true },
  baseInstructions: "base",
  developerInstructions: "developer",
});

test("preserving durable server configuration still uses fixed full native execution", () => {
  expect(
    buildConversationResumeRequest({
      ...input(),
      hostId: "durable",
      preserveServerConfiguration: true,
      serviceTier: "priority",
    }),
  ).toEqual({
    threadId: "thread",
    excludeTurns: false,
    permissions: ":danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user",
  });
  expect(
    buildConversationResumeRequest({
      ...input(),
      preserveServerConfiguration: true,
    }).cwd,
  ).toBe("/workspace");
});

test.each([false, true])(
  "durable resume retains inline history with paging capability %s",
  (supportsPaginatedHistory) => {
    for (const historyMode of ["legacy", "paginated"] as const) {
      const initial = input();
      const request = buildConversationResumeRequest({
        ...initial,
        hostId: "durable",
        supportsPaginatedHistory,
        metadata: { ...initial.metadata, historyMode },
      });
      expect(request.excludeTurns).toBe(false);
      expect(request).not.toHaveProperty("initialTurnsPage");
    }
  },
);

test("idle resume reapplies product-owned static feature configuration and instructions", () => {
  const result = buildConversationResumeRequest(input());
  expect(result).toMatchObject({
    threadId: "thread",
    history: null,
    model: null,
    cwd: "/workspace",
    config: { "features.thread_tools": true },
    baseInstructions: "base",
    developerInstructions: "developer",
    excludeTurns: true,
  });
  expect(result).not.toHaveProperty("initialTurnsPage");
});

test.each([undefined, null, "priority"])(
  "caller service tier controls idle configuration reuse: %s",
  (serviceTier) => {
    const result = buildConversationResumeRequest({ ...input(), serviceTier });
    expect(result.serviceTier).toBe(serviceTier);
    expect(Object.hasOwn(result, "serviceTier")).toBe(serviceTier !== undefined);
    expect(result.config).toEqual(input().config);
    expect(result.developerInstructions).toBe("developer");
  },
);

test.each([null, "flex"])(
  "resident tier %s wins while an explicit caller tier still prevents idle reuse",
  (serviceTier) => {
    const result = buildConversationResumeRequest({
      ...input(),
      serviceTier: "priority",
      overrides: { ...input().overrides, serviceTier },
    });
    expect(result.serviceTier).toBe(serviceTier);
    expect(result.config).toEqual(input().config);
    expect(result.developerInstructions).toBe("developer");
  },
);

test.each([
  { "features.thread_tools": false },
  { "features.unknown": true },
  { "mcp_servers.app.enabled_tools": ["read"] },
  { profiles: { custom: { model: "model" } } },
])("configuration changes require a full idle resume: %j", (config) => {
  const result = buildConversationResumeRequest({ ...input(), config });
  expect(result.config).toEqual(config);
  expect(result.baseInstructions).toBe("base");
  expect(result.developerInstructions).toBe("developer");
});

test.each([{}, { profiles: {} }, { unused: null }, { unused: undefined }])(
  "empty configuration does not force an idle reload: %j",
  (config) => {
    expect(buildConversationResumeRequest({ ...input(), config })).not.toHaveProperty("config");
  },
);

test("native resume ignores historical policy overrides while preserving physical and model preferences", () => {
  const overrides = {
    cwd: "/workspace",
    permissions: "custom",
    approvalPolicy: "on-request" as const,
    approvalsReviewer: "guardian_subagent" as const,
    sandbox: "read-only" as const,
    config: { sandbox_workspace_write: { writable_roots: ["/restricted"] } },
    runtimeWorkspaceRoots: ["/one", "/two"],
    serviceTier: null,
    personality: "pragmatic" as const,
  };
  const result = buildConversationResumeRequest({ ...input(), overrides });
  expect(result).toMatchObject({
    permissions: ":danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    runtimeWorkspaceRoots: ["/one", "/two"],
    serviceTier: null,
    personality: "pragmatic",
    config: input().config,
  });
  expect(result).not.toHaveProperty("sandbox");
  expect(overrides.permissions).toBe("custom");
});

test("an unloaded thread receives configuration even when all features match defaults", () => {
  const result = buildConversationResumeRequest({
    ...input(),
    metadata: null,
    rolloutPath: "/rollout",
    historyMode: "paginated",
  });
  expect(result).toMatchObject({
    path: "/rollout",
    config: input().config,
    developerInstructions: "developer",
  });
  expect(result).not.toHaveProperty("initialTurnsPage");
});

test.each([false, true])(
  "legacy metadata requests a five-turn full page regardless of capability: %s",
  (supportsPaginatedHistory) => {
    const initial = input();
    const result = buildConversationResumeRequest({
      ...initial,
      supportsPaginatedHistory,
      metadata: { ...initial.metadata, historyMode: "legacy" },
      historyMode: "paginated",
    });
    expect(result.initialTurnsPage).toEqual({ limit: 5, itemsView: "full", sortDirection: "desc" });
  },
);

test("explicit static feature config is sent instead of being treated as a remote default", () => {
  const result = buildConversationResumeRequest({
    ...input(),
    config: { "features.custom": { one: true, two: [1, 2] } },
  });
  expect(result.config).toEqual({ "features.custom": { one: true, two: [1, 2] } });
});
