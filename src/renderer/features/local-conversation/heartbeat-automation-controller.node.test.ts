import { describe, expect, test } from "vite-plus/test";
import type { CodexScheduledAutomation } from "../../../shared/types";
import { listHeartbeatAutomationTargetSessionIds } from "./heartbeat-automation-controller";

describe("heartbeat Session targets", () => {
  test("retains each active Session once across backends and excludes paused or unbound definitions", () => {
    const definition = (id: string, targetSessionId: string | null, extra = {}) =>
      ({
        id,
        kind: "heartbeat",
        status: "ACTIVE",
        targetSessionId,
        ...extra,
      }) as CodexScheduledAutomation;
    expect(
      listHeartbeatAutomationTargetSessionIds([
        definition("codex", "session:one", { backendBinding: { kind: "codex" } }),
        definition("claude", "session:one", {
          backendBinding: { kind: "claude", instanceConfigId: "team" },
        }),
        definition("two", "session:two"),
        definition("paused", "session:paused", { status: "PAUSED" }),
        definition("cron", "session:cron", { kind: "cron" }),
        definition("unbound", null),
        definition("blank", " "),
      ]),
    ).toEqual(["session:one", "session:two"]);
  });
});
