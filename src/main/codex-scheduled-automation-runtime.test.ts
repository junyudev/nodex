import { describe, expect, test } from "vite-plus/test";
import {
  buildCodexScheduledAutomationHeartbeatPrompt,
  buildCodexProjectlessThreadInstructions,
  buildCodexScheduledAutomationRunPrompt,
  parseCodexAutomationInboxItemDirective,
  resolveCodexScheduledAutomationModelSettings,
} from "./codex-scheduled-automation-runtime";
import type { CodexModelOption, CodexScheduledAutomation } from "../shared/types";

function makeAutomation(
  overrides: Partial<CodexScheduledAutomation> = {},
): CodexScheduledAutomation {
  return {
    id: "daily-report",
    definitionRevision: 1,
    projectId: null,
    targetSessionId: null,
    notificationPolicy: null,
    launch: "automatic",
    runbookPageId: null,
    runbookTitle: null,
    heldFiring: null,
    kind: "cron",
    status: "ACTIVE",
    name: "Daily report",
    prompt: "Summarize the repo.",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: ["/repo/project"],
    executionEnvironment: "worktree",
    localEnvironmentConfigPath: null,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeModel(overrides: Partial<CodexModelOption> = {}): CodexModelOption {
  return {
    id: "gpt-5",
    model: "gpt-5",
    displayName: "GPT-5",
    description: "",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "" },
      { reasoningEffort: "high", description: "" },
    ],
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
    ...overrides,
  };
}

describe("codex scheduled automation runtime helpers", () => {
  test("builds the first turn prompt from the automation identity, previous run, and instructions", () => {
    const prompt = buildCodexScheduledAutomationRunPrompt(
      makeAutomation({
        lastRunAt: Date.UTC(2026, 6, 8, 1, 2, 3),
      }),
    );

    expect(prompt).toBe(
      [
        "Automation: Daily report",
        "Automation ID: daily-report",
        "Last run: 2026-07-08T01:02:03.000Z",
        "",
        "Summarize the repo.",
      ].join("\n"),
    );
  });

  test("uses never for automations without a previous run", () => {
    const prompt = buildCodexScheduledAutomationRunPrompt(makeAutomation());
    expect(prompt.includes("Last run: never")).toBe(true);
  });

  test("builds the heartbeat follow-up prompt with automation identity and current time", () => {
    const prompt = buildCodexScheduledAutomationHeartbeatPrompt(
      makeAutomation({
        id: "follow-up",
        prompt: "Check whether the user needs another pass.",
      }),
      Date.UTC(2026, 6, 8, 13, 45, 0),
    );

    expect(prompt).toBe(
      [
        "<heartbeat>",
        "  <automation_id>follow-up</automation_id>",
        "  <current_time_iso>2026-07-08T13:45:00.000Z</current_time_iso>",
        "  <instructions>",
        "Check whether the user needs another pass.",
        "  </instructions>",
        "</heartbeat>",
      ].join("\n"),
    );
  });

  test("parses the final inbox item remark directive", () => {
    const directive = parseCodexAutomationInboxItemDirective(
      ["Done.", '::inbox-item{title="PR comments addressed" summary="Ready for re-review"}'].join(
        "\n",
      ),
    );

    expect(directive?.title).toBe("PR comments addressed");
    expect(directive?.summary).toBe("Ready for re-review");
  });

  test("rejects comma-separated inbox item directive arguments", () => {
    const directive = parseCodexAutomationInboxItemDirective(
      '::inbox-item{title="PR comments addressed", summary="Ready for re-review"}',
    );

    expect(directive).toBe(null);
  });

  test("requires inbox item directives to be on their own line", () => {
    const directive = parseCodexAutomationInboxItemDirective(
      'Done. ::inbox-item{title="Inline" summary="Ignored"}',
    );

    expect(directive).toBe(null);
  });

  test("builds split projectless output instructions", () => {
    const instructions = buildCodexProjectlessThreadInstructions({
      cwd: "/Users/test/Documents/Nodex/2026-07-08/daily/work",
      outputDirectory: "/Users/test/Documents/Nodex/2026-07-08/daily/outputs",
      workspaceBrowserRoot: "/Users/test/Documents/Nodex",
    });

    expect(instructions.includes("### Projectless Chat")).toBe(true);
    expect(instructions.includes("Use work/ for intermediate files")).toBe(true);
    expect(instructions.includes("Documents/Nodex")).toBe(true);
    expect(instructions.includes("/Users/test/Documents/Nodex/2026-07-08/daily/outputs")).toBe(
      true,
    );
    expect(instructions.includes("Do not write directly in the home directory")).toBe(true);
  });

  test("uses the requested available model and reasoning effort", () => {
    const settings = resolveCodexScheduledAutomationModelSettings({
      automation: makeAutomation({
        model: "gpt-5.1",
        reasoningEffort: "medium",
      }),
      models: [
        makeModel({ id: "gpt-5", model: "gpt-5", isDefault: true }),
        makeModel({ id: "gpt-5.1-id", model: "gpt-5.1", isDefault: false }),
      ],
    });

    expect(settings.model).toBe("gpt-5.1");
    expect(settings.reasoningEffort).toBe("medium");
  });

  test("falls back to the default model and default effort when the requested model is unavailable", () => {
    const settings = resolveCodexScheduledAutomationModelSettings({
      automation: makeAutomation({
        model: "retired-model",
        reasoningEffort: "max",
      }),
      models: [
        makeModel({
          id: "gpt-5",
          model: "gpt-5",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
          defaultReasoningEffort: "high",
        }),
      ],
    });

    expect(settings.model).toBe("gpt-5");
    expect(settings.reasoningEffort).toBe("high");
  });
});
