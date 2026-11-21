import { expect, test } from "vite-plus/test";
import { getIntl } from "@/lib/i18n";
import type { AppComponentInstallation, AppComponentState } from "../../../shared/app-components";
import { agentReadinessProblem } from "../local-conversation/agent-readiness-notice";
import { claudeCodeSetup } from "./claude-code-setup";

const provider = {
  instanceId: "managed",
  enabled: true,
  installed: false,
  requiredComponent: "claude-code",
  status: "warning",
  auth: { status: "authenticated" },
} as const;

const component = (installation: AppComponentInstallation, enabled = true): AppComponentState => ({
  id: "claude-code",
  downloadBytes: 100,
  enabled,
  installation,
  removalPending: false,
});

test("uses component readiness to block only managed Claude and keeps unchecked providers unchanged", () => {
  expect(agentReadinessProblem(provider)).toBe("not-installed");
  expect(agentReadinessProblem({ ...provider, installed: true })).toBeNull();
  expect(agentReadinessProblem({ ...provider, requiredComponent: undefined })).toBeNull();
  expect(claudeCodeSetup({ ...provider, installed: true }, undefined, getIntl())).toBeNull();
  expect(
    claudeCodeSetup({ ...provider, requiredComponent: undefined }, undefined, getIntl()),
  ).toBeNull();
});

test("projects live progress, terminal retry, and the Components link", () => {
  const intl = getIntl();
  const setup = (installation: AppComponentInstallation, enabled?: boolean) =>
    claudeCodeSetup(provider, component(installation, enabled), intl);
  for (const status of ["on-demand", "queued", "installing"] as const) {
    expect(setup({ status })).toMatchObject({ title: "Installing Claude Code…", action: null });
  }
  expect(setup({ status: "downloading", receivedBytes: 42, totalBytes: 100 })).toMatchObject({
    title: "Installing Claude Code… 42%",
    action: null,
  });
  expect(
    setup({ status: "failed", reason: "network", message: "Interrupted.", retryAt: 10 })?.action,
  ).toBeNull();
  expect(
    setup({ status: "failed", reason: "integrity", message: "Invalid archive.", retryAt: null })
      ?.action,
  ).toBe("retry");
  expect(setup({ status: "installed", installedBytes: 100 }, false)).toMatchObject({
    title: "Claude Code is turned off",
    action: "settings",
  });
});
