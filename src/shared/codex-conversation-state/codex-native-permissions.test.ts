import { expect, test } from "vite-plus/test";
import {
  canonicalPermissionsForMode,
  nativePermissionRequestFields,
} from "./codex-native-permissions";

test("guardian custom workspace config retains concrete sandbox rather than named profile", () => {
  const result = canonicalPermissionsForMode("guardian-approvals", ["/new"], {
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    sandbox_workspace_write: {
      writable_roots: ["/configured"],
      network_access: true,
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: true,
    },
  });
  expect(result?.activePermissionProfile).toBeNull();
  expect(result?.sandboxPolicy).toEqual({
    type: "workspaceWrite",
    writableRoots: ["/new", "/configured"],
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: false,
    networkAccess: true,
  });
  expect(result?.approvalsReviewer).toBe("guardian_subagent");
});
test("named presets carry runtime roots and omit concrete sandbox", () => {
  const permissions = canonicalPermissionsForMode("auto", ["/actual"], {})!;
  expect(nativePermissionRequestFields(permissions)).toEqual({
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    permissions: ":workspace",
    runtimeWorkspaceRoots: ["/actual"],
  });
});
test("granular permission mode uses the exact request-permissions-only approval policy", () => {
  const permissions = canonicalPermissionsForMode("granular", ["/actual"], {})!;
  expect(permissions.approvalPolicy).toEqual({
    granular: {
      sandbox_approval: false,
      rules: false,
      skill_approval: false,
      request_permissions: true,
      mcp_elicitations: false,
    },
  });
});
test("custom permission reviewer obeys the explicit guardian disable flag", () => {
  expect(
    canonicalPermissionsForMode("custom", [], {
      approvals_reviewer: "guardian_subagent",
      features: { guardian_approval: false },
    })?.approvalsReviewer,
  ).toBe("user");
  expect(
    canonicalPermissionsForMode("custom", [], {
      approvals_reviewer: "guardian_subagent",
      features: { guardian_approval: false },
      "features.guardian_approval": true,
    })?.approvalsReviewer,
  ).toBe("guardian_subagent");
  expect(canonicalPermissionsForMode(undefined, [], {})).toBeNull();
});
