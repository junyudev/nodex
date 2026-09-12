import { expect, test } from "vite-plus/test";
import { materializeCodexPermissionSelection } from "./codex-permission-selection";

test("agent permission selections use the canonical profile catalog", () => {
  expect(
    materializeCodexPermissionSelection(
      { kind: "agent-mode", agentMode: "granular" },
      ["/repo"],
      null,
    ),
  ).toEqual({
    permissions: ":workspace",
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
  });
});

test("profile permission selections only select the named profile", () => {
  expect(
    materializeCodexPermissionSelection(
      { kind: "profile", profileId: "team-profile" },
      ["/repo"],
      null,
    ),
  ).toEqual({ permissions: "team-profile" });
});

test("custom permission selections materialize the captured cwd configuration", () => {
  expect(
    materializeCodexPermissionSelection({ kind: "custom" }, ["/repo"], {
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: ["/configured"],
        network_access: true,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: true,
      },
      approval_policy: "on-request",
      approvals_reviewer: "user",
    }),
  ).toEqual({
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/repo", "/configured"],
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: false,
      networkAccess: true,
    },
  });
});

test("server-default permission selections emit no native override fields", () => {
  expect(
    materializeCodexPermissionSelection({ kind: "server-default" }, ["/repo"], null),
  ).toBeNull();
});
