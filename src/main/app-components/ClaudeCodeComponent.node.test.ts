import { isolatedClaudeProbe } from "@nodex/agent-runtime/contracts";
import { expect, test } from "vite-plus/test";
import type { AppComponentInstallation, AppComponentState } from "../../shared/app-components";
import { claudeCodeReadiness } from "./ClaudeCodeComponent";

const cases = [
  [{ status: "on-demand" }, true, "warning", "still installing"],
  [{ status: "queued" }, true, "warning", "still installing"],
  [
    { status: "downloading", receivedBytes: 10, totalBytes: 50 },
    true,
    "warning",
    "still installing",
  ],
  [{ status: "installing" }, true, "warning", "still installing"],
  [
    { status: "failed", reason: "network", message: "Retry", retryAt: 1 },
    true,
    "warning",
    "still installing",
  ],
  [
    { status: "failed", reason: "integrity", message: "Check failed", retryAt: null },
    true,
    "error",
    "could not be installed",
  ],
  [{ status: "not-installed" }, false, "warning", "turned off"],
  [{ status: "installed", installedBytes: 100 }, false, "warning", "turned off"],
  [{ status: "installed", installedBytes: 100 }, true, "ready", null],
] satisfies readonly [AppComponentInstallation, boolean, string, string | null][];

test.each(cases)(
  "projects managed Claude readiness for %j (enabled %s)",
  (installation, enabled, status, message) => {
    const component: AppComponentState = {
      id: "claude-code",
      enabled,
      installation,
      downloadBytes: 50,
      removalPending: false,
    };
    const probe = isolatedClaudeProbe(claudeCodeReadiness(component));
    expect(probe).toMatchObject({ status, installed: status === "ready" });
    if (message) expect(probe.message).toContain(message);
    else expect(probe.message).toBeUndefined();
  },
);
