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

const selectedPermissions = {
  activePermissionProfile: { id: "selected-profile", extends: null },
  runtimeWorkspaceRoots: ["/workspace", "/selected"],
  approvalPolicy: "never" as const,
  approvalsReviewer: "user" as const,
  sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
};

test.each(["local", "durable"])(
  "explicit resume permissions replace retained permissions on %s",
  (hostId) => {
    const initial = input();
    const request = buildConversationResumeRequest({
      ...initial,
      hostId,
      metadata: { ...initial.metadata, status: { type: "active", activeFlags: [] } },
      permissions: selectedPermissions,
      overrides: {
        cwd: "/workspace",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        config: { sandbox_workspace_write: { writable_roots: ["/retained"] } },
      },
    });
    expect(request).toMatchObject({
      permissions: "selected-profile",
      runtimeWorkspaceRoots: ["/workspace", "/selected"],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      config: initial.config,
    });
    expect(request).not.toHaveProperty("sandbox");
  },
);

test.each([false, true])(
  "server permission defaults suppress retained fields before idle reuse: %s",
  (useAppServerPermissionDefault) => {
    const initial = input();
    const request = buildConversationResumeRequest({
      ...initial,
      useAppServerPermissionDefault,
      overrides: {
        cwd: "/workspace",
        permissions: "retained-profile",
        runtimeWorkspaceRoots: ["/workspace"],
        approvalPolicy: "never",
        approvalsReviewer: "user",
      },
    });
    for (const key of [
      "permissions",
      "runtimeWorkspaceRoots",
      "approvalPolicy",
      "approvalsReviewer",
    ])
      expect(Object.hasOwn(request, key)).toBe(!useAppServerPermissionDefault);
    expect(request.config).toEqual(initial.config);
    expect(request.baseInstructions).toBe(initial.baseInstructions);
  },
);

test("server defaults suppress explicit permission fields but explicit selection still prevents idle reuse", () => {
  const initial = input();
  const request = buildConversationResumeRequest({
    ...initial,
    permissions: selectedPermissions,
    useAppServerPermissionDefault: true,
  });
  expect(request.config).toEqual(initial.config);
  expect(request.baseInstructions).toBe(initial.baseInstructions);
  expect(request).not.toHaveProperty("permissions");
  expect(request).not.toHaveProperty("approvalsReviewer");
});

test("preserving durable server configuration emits only thread and history selection", () => {
  expect(
    buildConversationResumeRequest({
      ...input(),
      hostId: "durable",
      preserveServerConfiguration: true,
      permissions: selectedPermissions,
      serviceTier: "priority",
    }),
  ).toEqual({ threadId: "thread", excludeTurns: false });
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

test.each([false, true])(
  "active durable resume preserves server permissions unless explicitly selected: %s",
  (explicitPermissions) => {
    const initial = input();
    const request = buildConversationResumeRequest({
      ...initial,
      hostId: "durable",
      metadata: { ...initial.metadata, status: { type: "active", activeFlags: [] } },
      permissions: explicitPermissions ? selectedPermissions : null,
      overrides: {
        ...initial.overrides,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissions: "saved-profile",
        runtimeWorkspaceRoots: ["/workspace"],
      },
    });
    for (const key of [
      "approvalPolicy",
      "approvalsReviewer",
      "permissions",
      "runtimeWorkspaceRoots",
    ] as const)
      expect(Object.hasOwn(request, key)).toBe(explicitPermissions);
    expect(request.cwd).toBe("/workspace");
    expect(request.config).toEqual(initial.config);
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

test.each([{ permissions: selectedPermissions }, { serviceTier: "priority" }])(
  "explicit caller selection disables idle reuse: %j",
  (selection) => {
    const result = buildConversationResumeRequest({ ...input(), ...selection });
    expect(result.config).toEqual(input().config);
    expect(result.developerInstructions).toBe("developer");
  },
);

test("a retained named permission profile and its roots survive preparation", () => {
  const result = buildConversationResumeRequest({
    ...input(),
    overrides: {
      permissions: "custom",
      runtimeWorkspaceRoots: ["/one", "/two"],
      approvalPolicy: "never",
      serviceTier: null,
      personality: "pragmatic",
    },
  });
  expect(result).toMatchObject({
    permissions: "custom",
    runtimeWorkspaceRoots: ["/one", "/two"],
    approvalPolicy: "never",
    serviceTier: null,
    personality: "pragmatic",
    config: input().config,
  });
  expect(result).not.toHaveProperty("sandbox");
});

test("permission configuration merges with required application capabilities", () => {
  const overrides = {
    sandbox: "workspace-write" as const,
    config: { sandbox_workspace_write: { writable_roots: ["/extra"] } },
  };
  expect(buildConversationResumeRequest({ ...input(), overrides }).config).toEqual({
    ...input().config,
    ...overrides.config,
  });
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
