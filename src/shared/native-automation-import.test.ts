import { describe, expect, it } from "vite-plus/test";
import { nativeAutomationCreateDraft } from "./native-automation-draft";
import type { NativeAutomationCandidate } from "./native-automation-import";
import { claudeCronToRrule, normalizeCodexAutomationRrule } from "./native-automation-schedule";

describe("native Automation schedules", () => {
  it("expands cron lists, ranges, steps, named months and Sunday aliases", () => {
    expect(claudeCronToRrule("5,30-40/5 8-10 * JAN,MAR SUN,7")).toEqual({
      kind: "rrule",
      rrule: "FREQ=DAILY;BYHOUR=8,9,10;BYMINUTE=5,30,35,40;BYSECOND=0;BYMONTH=1,3;BYDAY=SU",
    });
    expect(claudeCronToRrule("0 9 1,15 * *")).toEqual({
      kind: "rrule",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;BYMONTHDAY=1,15",
    });
    expect(claudeCronToRrule("0 9 */10 * 1")).toEqual({
      kind: "rrule",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;BYMONTHDAY=1,11,21,31;BYDAY=MO",
    });
  });

  it("rejects a day-of-month/day-of-week union and malformed expressions", () => {
    expect(claudeCronToRrule("0 9 1 * MON")).toEqual({
      kind: "unsupported",
      reason: "cron-day-or",
    });
    for (const expression of [
      "@daily",
      "0 30 * * *",
      "*/0 10 * * *",
      "0 9 * * FRI-MON",
      "0 9 * * * *",
    ]) {
      expect(claudeCronToRrule(expression)).toEqual({ kind: "unsupported", reason: "invalid" });
    }
  });

  it("normalizes a Codex rule body and classifies bad or one-shot rules", () => {
    expect(
      normalizeCodexAutomationRrule("  rrule: freq=weekly;byday=mo,fr;byhour=9;byminute=15 "),
    ).toEqual({
      kind: "rrule",
      rrule: "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=15",
    });
    expect(normalizeCodexAutomationRrule("FREQ=DAILY;COUNT=1")).toEqual({
      kind: "unsupported",
      reason: "one-shot",
    });
    for (const rule of [
      "",
      "BYDAY=MO",
      "FREQ=DAILY;INTERVAL=0",
      "FREQ=DAILY;BYHOUR=24",
      "FREQ=DAILY;FREQ=WEEKLY",
      "FREQ=DAILY\nEXDATE:20261129",
    ]) {
      expect(normalizeCodexAutomationRrule(rule)).toEqual({
        kind: "unsupported",
        reason: "invalid",
      });
    }
  });
});

const codexCron = {
  agent: "codex",
  sourceHome: "/source/codex",
  sourceAutomationId: "native-task",
  conversationSource: { backendKind: "codex", nativeHome: "/source/codex" },
  kind: "cron",
  schedule: { kind: "rrule", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" },
  sourceStatus: "active",
  name: " Review builds ",
  prompt: " Read recent build logs. ",
  executionEnvironment: "worktree",
  localEnvironmentConfigPath: "/workspace/environment.toml",
  folders: ["/workspace/project", "/workspace/project"],
  model: "model-id",
  reasoningEffort: "high",
  notificationPolicy: "failed_runs_only",
  memory: "A prior checkpoint.",
  runs: [],
} as const satisfies NativeAutomationCandidate;

describe("native Automation drafts", () => {
  it("maps a Codex worktree task to a paused Run draft with explicit origin", () => {
    expect(
      nativeAutomationCreateDraft(codexCron, { timezone: "Asia/Singapore", projectId: "project" }),
    ).toEqual({
      draft: {
        import_origin: {
          agent: "codex",
          sourceHome: "/source/codex",
          sourceAutomationId: "native-task",
        },
        initial_status: "paused",
        import_runbook_markdown: "A prior checkpoint.",
        scope: { kind: "project", project_id: "project" },
        kind: "cron",
        mode: "run",
        name: "Review builds",
        prompt: "Read recent build logs.",
        trigger: {
          kind: "clock",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
          timezone: "Asia/Singapore",
        },
        backend_binding: { driver: "codex", instanceId: "codex" },
        execution_environment: "worktree",
        local_environment_config_path: "/workspace/environment.toml",
        cwds: ["/workspace/project"],
        project_id: "project",
        model: "model-id",
        reasoning_effort: "high",
        notification_policy: { kind: "set", value: "failed_runs_only" },
      },
      issues: [],
    });
  });

  it("needs the destination Session for a heartbeat and leaves execution scope to it", () => {
    const candidate = {
      ...codexCron,
      kind: "heartbeat",
      memory: undefined,
      heartbeatTarget: { nativeSessionId: "native-session" },
    } as const;
    const options = { timezone: "UTC", projectId: "project" };
    expect(nativeAutomationCreateDraft(candidate, options)).toEqual({
      draft: null,
      issues: [{ field: "heartbeatTarget", reason: "needs-nodex-session" }],
    });
    const { draft } = nativeAutomationCreateDraft(candidate, {
      ...options,
      targetSessionId: "nodex-session",
    });
    expect(draft).toMatchObject({ kind: "heartbeat", target_session_id: "nodex-session" });
    expect(draft).not.toHaveProperty("cwds");
    expect(draft).not.toHaveProperty("project_id");
    expect(draft).not.toHaveProperty("execution_environment");
  });

  it("keeps the Claude backend and reports folder grants without turning them into run targets", () => {
    const candidate = {
      ...codexCron,
      agent: "claude",
      conversationSource: {
        backendKind: "claude",
        nativeHome: "/source/claude",
        instanceConfigId: "profile",
      },
      additionalFolders: ["/reference"],
      notificationPolicy: "unknown-policy",
    } as const;
    const options = { timezone: "UTC", projectId: "project" };
    const { draft, issues } = nativeAutomationCreateDraft(candidate, options);
    expect(draft).toMatchObject({
      backend_binding: { driver: "claudeAgent", instanceId: "profile" },
      cwds: ["/workspace/project"],
    });
    expect(draft).not.toHaveProperty("notification_policy");
    expect(issues).toEqual([
      { field: "additionalFolders", reason: "no-equivalent" },
      { field: "notificationPolicy", reason: "no-equivalent" },
    ]);
    expect(
      nativeAutomationCreateDraft(
        {
          ...candidate,
          schedule: { kind: "unsupported", reason: "manual" },
        },
        { ...options, projectId: null },
      ),
    ).toMatchObject({
      draft: null,
      issues: expect.arrayContaining([
        { field: "schedule", reason: "manual" },
        { field: "projectId", reason: "needs-project" },
      ]),
    });
  });
});
