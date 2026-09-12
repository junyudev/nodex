import { describe, expect, test } from "vite-plus/test";
import type { CodexDynamicCreatePermissionContext } from "./codex-dynamic-create-permissions";
import {
  buildCodexDynamicCreatePermissionContextForMode,
  buildCodexDynamicPendingPermissionSelection,
  inferCodexDynamicCreatePermissionMode,
  isCodexDynamicCreatePermissionMode,
  resolveCodexDynamicCreatePermissionSelection,
} from "./codex-dynamic-create-permissions";

const TARGET_ROOTS = ["/target/repo", "/target/shared"];

function workspaceContext(
  overrides: Partial<CodexDynamicCreatePermissionContext> = {},
): CodexDynamicCreatePermissionContext {
  return {
    activePermissionProfile: null,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    runtimeWorkspaceRoots: ["/target/repo"],
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/target/repo"],
      excludeSlashTmp: false,
      excludeTmpdirEnvVar: false,
      networkAccess: false,
    },
    ...overrides,
  };
}

function autoContext(): CodexDynamicCreatePermissionContext {
  return {
    activePermissionProfile: { id: ":workspace", extends: null },
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [...TARGET_ROOTS],
      excludeSlashTmp: false,
      excludeTmpdirEnvVar: false,
      networkAccess: false,
    },
  };
}

function defaultDestination(
  defaultContext: CodexDynamicCreatePermissionContext = autoContext(),
  defaultMode: "auto" | "custom" = "auto",
) {
  return {
    hostId: "local",
    cwd: "/target/repo",
    defaultMode,
    defaultContext,
    workspaceRoots: TARGET_ROOTS,
  };
}

describe("resolveCodexDynamicCreatePermissionSelection", () => {
  test("uses destination defaults when source and destination hosts differ", () => {
    const defaultContext = workspaceContext({
      activePermissionProfile: null,
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
    });
    const selection = resolveCodexDynamicCreatePermissionSelection({
      source: {
        hostId: "remote-1",
        cwd: "/target/repo",
        mode: "full-access",
        context: {
          activePermissionProfile: { id: ":danger-full-access", extends: null },
          runtimeWorkspaceRoots: ["/remote/repo"],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      },
      destination: defaultDestination(defaultContext, "custom"),
    });

    expect(selection.mode).toBe("custom");
    expect(selection.sourcePermissionProfileId).toBe(undefined);
    expect(selection.context.approvalPolicy).toBe("never");
    expect(selection.context.approvalsReviewer).toBe("auto_review");
    expect(JSON.stringify(selection.launchParams)).toBe(
      JSON.stringify({
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
      }),
    );
    expect(JSON.stringify(selection.turnParams)).toBe(
      JSON.stringify({
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandboxPolicy: defaultContext.sandboxPolicy,
      }),
    );
  });

  test("inherits the complete same-cwd selection and merges both root collections", () => {
    const sourceContext = workspaceContext({
      activePermissionProfile: { id: "team-profile", extends: ":workspace" },
      runtimeWorkspaceRoots: ["/source/runtime", "/target/repo"],
      approvalPolicy: "never",
      approvalsReviewer: "guardian_subagent",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/source/write", "/target/repo"],
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
        networkAccess: true,
      },
    });
    const selection = resolveCodexDynamicCreatePermissionSelection({
      source: {
        hostId: "local",
        cwd: "/target/repo",
        mode: "custom",
        context: sourceContext,
      },
      destination: defaultDestination(),
    });

    expect(selection.mode).toBe("custom");
    expect(selection.sourcePermissionProfileId).toBe("team-profile");
    expect(selection.context.activePermissionProfile?.id ?? null).toBe("team-profile");
    expect(selection.context.activePermissionProfile?.extends ?? null).toBe(":workspace");
    expect(selection.context.approvalPolicy).toBe("never");
    expect(selection.context.approvalsReviewer).toBe("guardian_subagent");
    expect(JSON.stringify(selection.context.runtimeWorkspaceRoots)).toBe(
      JSON.stringify(["/source/runtime", "/target/repo", "/target/shared"]),
    );
    expect(
      JSON.stringify(
        selection.context.sandboxPolicy.type === "workspaceWrite"
          ? selection.context.sandboxPolicy.writableRoots
          : [],
      ),
    ).toBe(JSON.stringify(["/source/write", "/target/repo", "/target/shared"]));
    expect(JSON.stringify(selection.launchParams)).toBe(
      JSON.stringify({
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        permissions: "team-profile",
        runtimeWorkspaceRoots: ["/source/runtime", "/target/repo", "/target/shared"],
      }),
    );
    expect(JSON.stringify(selection.turnParams)).toBe(JSON.stringify(selection.launchParams));
  });

  for (const mode of ["custom", "guardian-approvals"] as const) {
    test(`drops ${mode} source permissions when the destination cwd changes`, () => {
      const selection = resolveCodexDynamicCreatePermissionSelection({
        source: {
          hostId: "local",
          cwd: "/source/repo",
          mode,
          context: workspaceContext({
            activePermissionProfile: { id: ":workspace", extends: null },
            runtimeWorkspaceRoots: ["/source/repo"],
          }),
        },
        destination: defaultDestination(),
      });

      expect(selection.mode).toBe("auto");
      expect(selection.sourcePermissionProfileId).toBe(undefined);
      expect(selection.context.activePermissionProfile?.id ?? null).toBe(":workspace");
      expect(selection.context.runtimeWorkspaceRoots).toBe(undefined);
    });
  }

  test("rebases a retained built-in profile onto destination roots and mode defaults", () => {
    const selection = resolveCodexDynamicCreatePermissionSelection({
      source: {
        hostId: "local",
        cwd: "/source/repo",
        mode: "granular",
        context: workspaceContext({
          activePermissionProfile: { id: ":team-built-in", extends: ":workspace" },
          runtimeWorkspaceRoots: ["/source/repo"],
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/source/repo"],
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
            networkAccess: true,
          },
        }),
      },
      destination: defaultDestination(),
    });

    expect(selection.mode).toBe("granular");
    expect(selection.sourcePermissionProfileId).toBe(":team-built-in");
    expect(selection.context.activePermissionProfile?.id ?? null).toBe(":team-built-in");
    expect(selection.context.activePermissionProfile?.extends).toBe(null);
    expect(JSON.stringify(selection.context.runtimeWorkspaceRoots)).toBe(
      JSON.stringify(TARGET_ROOTS),
    );
    expect(selection.context.approvalsReviewer).toBe("user");
    expect(typeof selection.context.approvalPolicy).toBe("object");
    expect(JSON.stringify(selection.context.sandboxPolicy)).toBe(
      JSON.stringify({
        type: "workspaceWrite",
        writableRoots: TARGET_ROOTS,
        excludeSlashTmp: false,
        excludeTmpdirEnvVar: false,
        networkAccess: false,
      }),
    );
    expect(JSON.stringify(selection.launchParams)).toBe(
      JSON.stringify({
        approvalPolicy: {
          granular: {
            sandbox_approval: false,
            rules: false,
            skill_approval: false,
            request_permissions: true,
            mcp_elicitations: false,
          },
        },
        approvalsReviewer: "user",
        permissions: ":team-built-in",
        runtimeWorkspaceRoots: TARGET_ROOTS,
      }),
    );
    expect(JSON.stringify(selection.turnParams)).toBe(JSON.stringify(selection.launchParams));
  });

  test("drops a non-built-in profile after a cwd change", () => {
    const selection = resolveCodexDynamicCreatePermissionSelection({
      source: {
        hostId: "local",
        cwd: "/source/repo",
        mode: "auto",
        context: workspaceContext({
          activePermissionProfile: { id: "team-profile", extends: ":workspace" },
          runtimeWorkspaceRoots: ["/source/repo"],
        }),
      },
      destination: defaultDestination(),
    });

    expect(selection.mode).toBe("auto");
    expect(selection.context.activePermissionProfile?.id ?? null).toBe(":workspace");
    expect(
      "permissions" in selection.launchParams ? selection.launchParams.permissions : null,
    ).toBe(":workspace");
    expect("permissions" in selection.turnParams ? selection.turnParams.permissions : null).toBe(
      ":workspace",
    );
  });

  test("falls back from a profile's missing runtime roots to workspace-write roots", () => {
    const selection = resolveCodexDynamicCreatePermissionSelection({
      source: null,
      destination: defaultDestination(
        workspaceContext({
          activePermissionProfile: { id: ":workspace", extends: null },
          runtimeWorkspaceRoots: undefined,
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/target/repo", "/target/profile-write"],
            excludeSlashTmp: false,
            excludeTmpdirEnvVar: false,
            networkAccess: false,
          },
        }),
      ),
    });

    expect(JSON.stringify(selection.launchParams)).toBe(
      JSON.stringify({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        permissions: ":workspace",
        runtimeWorkspaceRoots: ["/target/repo", "/target/profile-write"],
      }),
    );
    expect(JSON.stringify(selection.turnParams)).toBe(JSON.stringify(selection.launchParams));
  });
});

describe("buildCodexDynamicCreatePermissionContextForMode", () => {
  test("rebuilds custom workspace permissions from the frozen config at the new root", () => {
    const context = buildCodexDynamicCreatePermissionContextForMode({
      mode: "custom",
      workspaceRoots: ["/worktree/repo"],
      config: {
        sandbox_mode: "workspace-write",
        approval_policy: "never",
        approvals_reviewer: "auto_review",
        sandbox_workspace_write: {
          writable_roots: ["/shared/write"],
          network_access: true,
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: false,
        },
      },
    });

    expect(context.activePermissionProfile).toBe(null);
    expect(context.approvalPolicy).toBe("never");
    expect(context.approvalsReviewer).toBe("auto_review");
    expect(JSON.stringify(context.sandboxPolicy)).toBe(
      JSON.stringify({
        type: "workspaceWrite",
        writableRoots: ["/worktree/repo", "/shared/write"],
        excludeSlashTmp: false,
        excludeTmpdirEnvVar: true,
        networkAccess: true,
      }),
    );
  });

  test("uses guardian reviewer and drops the workspace profile for configured workspace-write", () => {
    const context = buildCodexDynamicCreatePermissionContextForMode({
      mode: "guardian-approvals",
      workspaceRoots: ["/worktree/repo"],
      config: {
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
        sandbox_workspace_write: null,
      },
    });

    expect(context.activePermissionProfile).toBe(null);
    expect(context.approvalsReviewer).toBe("guardian_subagent");
    expect(JSON.stringify(context.sandboxPolicy)).toBe(
      JSON.stringify({
        type: "workspaceWrite",
        writableRoots: ["/worktree/repo"],
        excludeSlashTmp: false,
        excludeTmpdirEnvVar: false,
        networkAccess: false,
      }),
    );
  });

  test("applies the frozen profile after rebuilding permissions without retaining source roots", () => {
    const selection = buildCodexDynamicPendingPermissionSelection({
      mode: "custom",
      workspaceRoot: "/worktree/repo",
      permissionProfileId: "team-profile",
      config: {
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
        sandbox_workspace_write: null,
      },
    });

    expect(selection.context.activePermissionProfile?.id ?? null).toBe("team-profile");
    expect(JSON.stringify(selection.context.runtimeWorkspaceRoots)).toBe(
      JSON.stringify(["/worktree/repo"]),
    );
    expect(
      JSON.stringify(
        selection.context.sandboxPolicy.type === "workspaceWrite"
          ? selection.context.sandboxPolicy.writableRoots
          : [],
      ),
    ).toBe(JSON.stringify(["/worktree/repo"]));
  });

  test("falls back from a disabled guardian reviewer in custom config", () => {
    const context = buildCodexDynamicCreatePermissionContextForMode({
      mode: "custom",
      workspaceRoots: ["/worktree/repo"],
      config: {
        approval_policy: "on-request",
        approvals_reviewer: "guardian_subagent",
        sandbox_mode: "workspace-write",
        "features.guardian_approval": false,
      },
    });

    expect(context.approvalsReviewer).toBe("user");
  });
});

describe("inferCodexDynamicCreatePermissionMode", () => {
  test("accepts only the exact host agent-mode union", () => {
    for (const mode of [
      "read-only",
      "auto",
      "granular",
      "guardian-approvals",
      "full-access",
      "custom",
    ]) {
      expect(isCodexDynamicCreatePermissionMode(mode)).toBe(true);
    }
    expect(isCodexDynamicCreatePermissionMode("workspace-write")).toBe(false);
    expect(isCodexDynamicCreatePermissionMode("AUTO")).toBe(false);
    expect(isCodexDynamicCreatePermissionMode(null)).toBe(false);
  });

  test("matches the exact policy, reviewer, and sandbox predicates", () => {
    expect(
      inferCodexDynamicCreatePermissionMode({
        activePermissionProfile: { id: "custom-profile", extends: null },
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace", "/extra"],
          excludeSlashTmp: false,
          excludeTmpdirEnvVar: false,
          networkAccess: false,
        },
      }),
    ).toBe("auto");
    expect(
      inferCodexDynamicCreatePermissionMode({
        activePermissionProfile: null,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace"],
          excludeSlashTmp: false,
          excludeTmpdirEnvVar: false,
          networkAccess: false,
        },
      }),
    ).toBe("guardian-approvals");
    expect(
      inferCodexDynamicCreatePermissionMode({
        activePermissionProfile: { id: ":workspace", extends: null },
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace"],
          excludeSlashTmp: false,
          excludeTmpdirEnvVar: false,
          networkAccess: true,
        },
      }),
    ).toBe("custom");
    expect(
      inferCodexDynamicCreatePermissionMode({
        activePermissionProfile: null,
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
    ).toBe("full-access");
  });
});
