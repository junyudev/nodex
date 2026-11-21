import { expect, test } from "vite-plus/test";
import { getIntl } from "@/lib/i18n";
import type { AppComponentInstallation, AppComponentState } from "../../../shared/app-components";
import { agentReadinessProblem } from "../local-conversation/agent-readiness-notice";
import { providerComponentSetup } from "./provider-component-setup";

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
  expect(providerComponentSetup({ ...provider, installed: true }, undefined, getIntl())).toBeNull();
  expect(
    providerComponentSetup({ ...provider, requiredComponent: undefined }, undefined, getIntl()),
  ).toBeNull();
});

test("projects live progress, terminal retry, and the Components link", () => {
  const intl = getIntl();
  const setup = (installation: AppComponentInstallation, enabled?: boolean) =>
    providerComponentSetup(provider, component(installation, enabled), intl);
  for (const status of ["on-demand", "queued", "installing"] as const) {
    expect(setup({ status })).toMatchObject({ title: "Installing Claude Code…", action: null });
  }
  expect(setup({ status: "downloading", receivedBytes: 42, totalBytes: 100 })).toMatchObject({
    title: "Installing Claude Code… 42%",
    action: null,
    tone: "progress",
    modelHint: "Installing",
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
    tone: "warning",
    modelHint: "Turned off",
  });
});

test("Codex offers first use before showing the same progress and actions as Claude Code", () => {
  const intl = getIntl();
  const codex = { ...provider, requiredComponent: "codex" } as const;
  const setup = (installation: AppComponentInstallation, enabled?: boolean) =>
    providerComponentSetup(codex, { ...component(installation, enabled), id: "codex" }, intl);
  expect(setup({ status: "on-demand" })).toBeNull();
  expect(setup({ status: "downloading", receivedBytes: 42, totalBytes: 100 })).toMatchObject({
    id: "codex",
    title: "Installing Codex… 42%",
    action: null,
    tone: "progress",
    modelHint: "Installing",
  });
  expect(
    setup({ status: "failed", reason: "integrity", message: "Invalid archive.", retryAt: null }),
  ).toMatchObject({ title: "Couldn’t install Codex", action: "retry", tone: "danger" });
  expect(setup({ status: "installed", installedBytes: 100 }, false)).toMatchObject({
    title: "Codex is turned off",
    action: "settings",
    tone: "warning",
    modelHint: "Turned off",
  });
});
