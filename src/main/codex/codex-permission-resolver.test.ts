import { describe, expect, test } from "vite-plus/test";
import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import type { ConfigRequirements } from "@nodex/codex-app-server-protocol/v2/ConfigRequirements";
import {
  buildThreadPermissionOverrides,
  buildPermissionModeConfigEdits,
  resolveCodexPermissionState,
} from "./codex-permission-resolver";

function buildConfig(
  overrides?: Partial<ConfigReadResponse["config"]>,
): ConfigReadResponse["config"] {
  return {
    model: null,
    review_model: null,
    model_context_window: null,
    model_auto_compact_token_limit: null,
    model_provider: null,
    approval_policy: "on-request",
    approvals_reviewer: "user",
    sandbox_mode: "workspace-write",
    sandbox_workspace_write: null,
    forced_chatgpt_workspace_id: null,
    forced_login_method: null,
    web_search: null,
    tools: null,
    profile: null,
    profiles: {},
    instructions: null,
    developer_instructions: null,
    compact_prompt: null,
    model_reasoning_effort: null,
    model_reasoning_summary: null,
    model_verbosity: null,
    service_tier: null,
    analytics: null,
    apps: null,
    features: {},
    ...overrides,
  } as ConfigReadResponse["config"];
}

function buildRequirements(overrides?: Partial<ConfigRequirements>): ConfigRequirements {
  return {
    cliAuthCredentialsStore: null,
    chatgptBaseUrl: null,
    additionalDeveloperInstructions: null,
    autoReview: null,
    allowedApprovalPolicies: null,
    allowedApprovalsReviewers: null,
    allowedSandboxModes: null,
    allowedWindowsSandboxImplementations: null,
    allowedPermissionProfiles: null,
    defaultPermissions: null,
    allowRemoteControl: null,
    allowedWebSearchModes: null,
    allowManagedHooksOnly: null,
    allowBrowserAndComputerUse: null,
    allowAppshots: null,
    browserUse: null,
    inAppBrowser: null,
    checkForUpdateOnStartup: null,
    computerUse: null,
    feedback: null,
    featureRequirements: null,
    hooks: null,
    enforceResidency: null,
    network: null,
    models: null,
    sqliteHome: null,
    logDir: null,
    modelCatalogJson: null,
    allowLoginShell: null,
    windowsSandboxPrivateDesktop: null,
    ...overrides,
  };
}

function resolveState(input: {
  config?: Partial<ConfigReadResponse["config"]>;
  requirements?: ConfigRequirements | null;
}) {
  return resolveCodexPermissionState({
    config: buildConfig(input.config),
    origins: {},
    requirements: input.requirements ?? null,
    defaultUserConfigPath: "/Users/test/.codex/config.toml",
    workspaceRoots: ["/Users/test/project"],
  });
}

function buildPermissionOrigins(): ConfigReadResponse["origins"] {
  return {
    approval_policy: {
      name: {
        type: "user",
        file: "/Users/test/.codex/config.toml",
        profile: null,
      },
      version: "test",
    },
    sandbox_mode: {
      name: {
        type: "user",
        file: "/Users/test/.codex/config.toml",
        profile: null,
      },
      version: "test",
    },
  } as ConfigReadResponse["origins"];
}

function buildReviewerOrigin(): ConfigReadResponse["origins"] {
  return {
    approvals_reviewer: {
      name: {
        type: "user",
        file: "/Users/test/.codex/config.toml",
        profile: null,
      },
      version: "test",
    },
  } as ConfigReadResponse["origins"];
}

describe("codex-permission-resolver", () => {
  test("defaults an implicit workspace permission config to Auto-review", () => {
    const state = resolveState({});

    expect(state.mode).toBe("guardian-approvals");
    expect(state.effectivePreset).toBe("guardian-approvals");
    expect(state.approvalsReviewer).toBe("auto_review");
  });

  test("writes the canonical auto_review reviewer for Auto-review", () => {
    const edits = buildPermissionModeConfigEdits("guardian-approvals");
    const reviewerEdit = edits.find((edit) => edit.keyPath === "approvals_reviewer");

    expect(reviewerEdit?.value).toBe("auto_review");
  });

  test("keeps Auto-review available when the feature key is absent", () => {
    const state = resolveState({
      config: {
        approvals_reviewer: "auto_review",
      },
      requirements: null,
    });

    expect(state.autoReviewAvailable).toBe(true);
    expect(state.availableModes.includes("guardian-approvals")).toBe(true);
    expect(state.mode).toBe("guardian-approvals");
    expect(state.effectivePreset).toBe("guardian-approvals");
    expect(state.approvalsReviewer).toBe("auto_review");
  });

  test("honors flat, nested, and requirement explicit feature disables", () => {
    const flatState = resolveState({
      config: {
        approvals_reviewer: "auto_review",
        "features.guardian_approval": false,
      } as Partial<ConfigReadResponse["config"]>,
      requirements: null,
    });
    const nestedState = resolveState({
      config: {
        approvals_reviewer: "auto_review",
        features: {
          guardian_approval: false,
        },
      },
      requirements: null,
    });
    const requirementsState = resolveState({
      config: {
        approvals_reviewer: "auto_review",
      },
      requirements: buildRequirements({
        featureRequirements: {
          guardian_approval: false,
        },
      }),
    });

    expect(flatState.autoReviewAvailable).toBe(false);
    expect(flatState.availableModes.includes("guardian-approvals")).toBe(false);
    expect(flatState.mode).toBe("auto");
    expect(flatState.approvalsReviewer).toBe("user");
    expect(nestedState.autoReviewAvailable).toBe(false);
    expect(nestedState.availableModes.includes("guardian-approvals")).toBe(false);
    expect(nestedState.mode).toBe("auto");
    expect(nestedState.approvalsReviewer).toBe("user");
    expect(requirementsState.autoReviewAvailable).toBe(false);
    expect(requirementsState.availableModes.includes("guardian-approvals")).toBe(false);
    expect(requirementsState.mode).toBe("auto");
    expect(requirementsState.approvalsReviewer).toBe("user");
  });

  test("treats guardian_subagent as the legacy automatic reviewer alias", () => {
    const state = resolveState({
      config: {
        approvals_reviewer: "guardian_subagent",
      },
      requirements: null,
    });
    const overrides = buildThreadPermissionOverrides({ permissionState: state });

    expect(state.autoReviewAvailable).toBe(true);
    expect(state.mode).toBe("guardian-approvals");
    expect(state.effectivePreset).toBe("guardian-approvals");
    expect(state.approvalsReviewer).toBe("auto_review");
    expect(overrides.approvalsReviewer).toBe("auto_review");
  });

  test("filters Auto-review when requirements disallow its reviewer", () => {
    const state = resolveState({
      config: {
        approvals_reviewer: "auto_review",
      },
      requirements: buildRequirements({
        allowedApprovalsReviewers: ["user"],
      }),
    });

    expect(state.availableModes.includes("guardian-approvals")).toBe(false);
    expect(state.autoReviewAvailable).toBe(false);
    expect(state.mode).toBe("auto");
    expect(state.effectivePreset).toBe("auto");
    expect(state.approvalsReviewer).toBe("user");
  });

  test("allows Auto-review when requirements allow automatic review", () => {
    const state = resolveState({
      config: {
        approvals_reviewer: "auto_review",
      },
      requirements: buildRequirements({
        allowedApprovalsReviewers: ["auto_review"],
      }),
    });

    expect(state.availableModes.includes("guardian-approvals")).toBe(true);
    expect(state.availableModes.includes("auto")).toBe(false);
    expect(state.mode).toBe("guardian-approvals");
    expect(state.effectivePreset).toBe("guardian-approvals");
    expect(state.approvalsReviewer).toBe("auto_review");
  });

  test("allows Auto-review when requirements allow the legacy reviewer alias", () => {
    const state = resolveState({
      config: {
        approvals_reviewer: "guardian_subagent",
      },
      requirements: buildRequirements({
        allowedApprovalsReviewers: ["guardian_subagent"],
      }),
    });

    expect(state.autoReviewAvailable).toBe(true);
    expect(state.availableModes.includes("guardian-approvals")).toBe(true);
    expect(state.availableModes.includes("auto")).toBe(false);
    expect(state.mode).toBe("guardian-approvals");
    expect(state.effectivePreset).toBe("guardian-approvals");
    expect(state.approvalsReviewer).toBe("auto_review");
  });

  test("filters workspace presets when the workspace permission profile is disallowed", () => {
    const state = resolveState({
      config: {
        approvals_reviewer: "auto_review",
      },
      requirements: buildRequirements({
        allowedPermissionProfiles: {
          ":workspace": false,
          ":danger-full-access": true,
        },
      }),
    });

    expect(state.autoReviewAvailable).toBe(false);
    expect(state.availableModes.includes("auto")).toBe(false);
    expect(state.availableModes.includes("guardian-approvals")).toBe(false);
    expect(state.availableModes.includes("full-access")).toBe(true);
    expect(state.mode).toBe("full-access");
    expect(state.effectivePreset).toBe("full-access");
    expect(state.approvalsReviewer).toBe("user");
  });

  test("keeps explicit config Custom even when it is equivalent to a fixed preset", () => {
    const state = resolveCodexPermissionState({
      config: buildConfig({
        approval_policy: "never",
        approvals_reviewer: "user",
        sandbox_mode: "danger-full-access",
      }),
      origins: buildPermissionOrigins(),
      requirements: null,
      defaultUserConfigPath: "/Users/test/.codex/config.toml",
      workspaceRoots: ["/Users/test/project"],
    });

    expect(state.mode).toBe("custom");
    expect(state.effectivePreset).toBe("custom");
    expect(state.availableModes.includes("custom")).toBe(true);
  });

  test("treats an explicit reviewer-only config as Custom", () => {
    const state = resolveCodexPermissionState({
      config: buildConfig(),
      origins: buildReviewerOrigin(),
      requirements: null,
      defaultUserConfigPath: "/Users/test/.codex/config.toml",
      workspaceRoots: ["/Users/test/project"],
    });

    expect(state.mode).toBe("custom");
    expect(state.effectivePreset).toBe("custom");
    expect(state.approvalsReviewer).toBe("user");
  });

  test("does not expose Custom when permission profiles constrain the mode space", () => {
    const state = resolveCodexPermissionState({
      config: buildConfig(),
      origins: buildPermissionOrigins(),
      requirements: buildRequirements({
        allowedPermissionProfiles: {
          ":workspace": true,
          ":danger-full-access": true,
        },
      }),
      defaultUserConfigPath: "/Users/test/.codex/config.toml",
      workspaceRoots: ["/Users/test/project"],
    });

    expect(state.mode).toBe("auto");
    expect(state.availableModes.includes("custom")).toBe(false);
  });

  test("does not expose Custom when explicit config is denied by requirements", () => {
    const state = resolveCodexPermissionState({
      config: buildConfig({
        approval_policy: "never",
        sandbox_mode: "workspace-write",
      }),
      origins: buildPermissionOrigins(),
      requirements: buildRequirements({
        allowedApprovalPolicies: ["on-request"],
      }),
      defaultUserConfigPath: "/Users/test/.codex/config.toml",
      workspaceRoots: ["/Users/test/project"],
    });

    expect(state.mode).toBe("auto");
    expect(state.availableModes.includes("custom")).toBe(false);
  });
});
