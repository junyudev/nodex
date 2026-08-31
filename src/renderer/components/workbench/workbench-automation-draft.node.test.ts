import { describe, expect, test } from "vite-plus/test";
import type { CodexModelOption, CodexScheduledAutomation } from "@/lib/types";
import {
  buildCodexScheduledAutomationCreateInput,
  buildCodexScheduledAutomationUpdateInput,
  createCodexScheduledAutomationId,
  createWorkbenchAutomationDraft,
  formatWorkbenchAutomationDraftSaveTooltip,
  hasWorkbenchAutomationCreateDraftChanges,
  isWorkbenchAutomationDraftDirty,
  parseWorkbenchAutomationCwds,
  resolveWorkbenchAutomationDraftModelSettings,
  validateWorkbenchAutomationDraft,
} from "./workbench-automation-draft";

const MODELS: CodexModelOption[] = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Default coding model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true,
  },
  {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "Previous coding model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "high", description: "Deep" },
      { reasoningEffort: "xhigh", description: "Extra deep" },
    ],
    defaultReasoningEffort: "high",
    inputModalities: ["text", "image"],
    multiAgentVersion: null,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
];

function makeAutomation(
  overrides: Partial<CodexScheduledAutomation> = {},
): CodexScheduledAutomation {
  return {
    id: "automation-1",
    definitionRevision: 1,
    kind: "heartbeat",
    status: "ACTIVE",
    targetThreadId: "thread-1",
    name: "Daily standup",
    prompt: "Check the daily standup thread.",
    rrule: "FREQ=DAILY",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: [],
    executionEnvironment: "worktree",
    localEnvironmentConfigPath: null,
    nextRunAt: new Date(2026, 6, 9, 9, 30).getTime(),
    lastRunAt: null,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

describe("workbench automation draft", () => {
  test("builds create payloads with normalized fields", () => {
    const draft = createWorkbenchAutomationDraft({ id: "automation-new" });
    draft.name = "  Weekly triage  ";
    draft.prompt = "  Triage the project queue.  ";
    draft.targetThreadId = " thread-alpha ";
    draft.rrule = " FREQ=WEEKLY ";
    draft.cwds = ["/tmp/project"];
    draft.model = "gpt-5.5";
    draft.reasoningEffort = "high";

    const payload = buildCodexScheduledAutomationCreateInput({ draft });

    expect(payload?.name).toBe("Weekly triage");
    expect(payload?.prompt).toBe("Triage the project queue.");
    expect(payload?.targetThreadId).toBe(null);
    expect(payload?.rrule).toBe("FREQ=WEEKLY");
    expect(JSON.stringify(payload?.cwds)).toBe(JSON.stringify(["/tmp/project"]));
    expect(payload?.model).toBe("gpt-5.5");
    expect(payload?.reasoningEffort).toBe("high");
  });

  test("starts cron drafts without a concrete model fallback", () => {
    const draft = createWorkbenchAutomationDraft({ id: "automation-new" });

    expect(draft.model).toBe("");
    expect(draft.reasoningEffort).toBe("medium");
    expect(hasWorkbenchAutomationCreateDraftChanges(draft)).toBe(false);
  });

  test("resolves cron draft model settings from visible runtime models", () => {
    const draft = createWorkbenchAutomationDraft({ id: "automation-new" });

    const resolved = resolveWorkbenchAutomationDraftModelSettings({
      draft,
      models: MODELS,
    });

    expect(resolved.model).toBe("gpt-5.5");
    expect(resolved.reasoningEffort).toBe("medium");
  });

  test("does not count runtime-resolved default model settings as create draft changes", () => {
    const draft = resolveWorkbenchAutomationDraftModelSettings({
      draft: createWorkbenchAutomationDraft({ id: "automation-new" }),
      models: MODELS,
    });
    const baseline = resolveWorkbenchAutomationDraftModelSettings({
      draft: createWorkbenchAutomationDraft({ id: "automation-baseline" }),
      models: MODELS,
    });

    expect(hasWorkbenchAutomationCreateDraftChanges(draft, baseline)).toBe(false);
  });

  test("falls back from unavailable cron draft models to the visible default", () => {
    const draft = createWorkbenchAutomationDraft({
      automation: makeAutomation({
        kind: "cron",
        targetThreadId: null,
        model: "unavailable-model",
        reasoningEffort: "max",
        cwds: ["/tmp/project"],
      }),
    });

    const resolved = resolveWorkbenchAutomationDraftModelSettings({
      draft,
      models: MODELS,
    });

    expect(resolved.model).toBe("gpt-5.5");
    expect(resolved.reasoningEffort).toBe("medium");
  });

  test("builds update payloads and detects dirty edits", () => {
    const automation = makeAutomation();
    const draft = createWorkbenchAutomationDraft({ automation });
    expect(isWorkbenchAutomationDraftDirty({ draft, existing: automation })).toBe(false);

    draft.status = "PAUSED";
    expect(isWorkbenchAutomationDraftDirty({ draft, existing: automation })).toBe(true);

    const payload = buildCodexScheduledAutomationUpdateInput({
      draft,
      id: automation.id,
    });
    expect(payload?.id).toBe("automation-1");
    expect(payload?.status).toBe("PAUSED");
  });

  test("accepts calendar RRULE text when building cron model updates", () => {
    const calendarRrule = "DTSTART;TZID=Asia/Shanghai:20260710T090000\nRRULE:FREQ=DAILY";
    const automation = makeAutomation({
      kind: "cron",
      targetThreadId: null,
      rrule: calendarRrule,
      model: "gpt-5.5",
      reasoningEffort: "medium",
      cwds: ["/tmp/project"],
      executionEnvironment: "local",
    });
    const draft = createWorkbenchAutomationDraft({ automation });
    draft.model = "gpt-5.4";
    draft.reasoningEffort = "high";

    const validation = validateWorkbenchAutomationDraft(draft);
    const payload = buildCodexScheduledAutomationUpdateInput({
      draft,
      id: automation.id,
    });

    expect(validation.canSave).toBe(true);
    expect(payload?.rrule).toBe(calendarRrule);
    expect(payload?.model).toBe("gpt-5.4");
    expect(payload?.reasoningEffort).toBe("high");
  });

  test("validates required name, prompt, schedule, project, chat, and model", () => {
    const draft = createWorkbenchAutomationDraft({ id: "automation-new" });
    draft.name = " ";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.name = "Valid name";
    draft.prompt = " ";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.prompt = "Run the report.";
    draft.rrule = "INTERVAL=2";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.rrule = "FREQ=DAILY";
    draft.cwds = [];
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.cwds = ["/tmp/project"];
    draft.model = "";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.model = "gpt-5.5";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(true);

    draft.kind = "heartbeat";
    draft.targetThreadId = "";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.targetThreadId = "thread-1";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(true);
  });

  test("formats reference-style disabled save tooltips from missing requirements", () => {
    const draft = createWorkbenchAutomationDraft({ id: "automation-new" });
    draft.rrule = "INTERVAL=2";

    expect(
      formatWorkbenchAutomationDraftSaveTooltip({
        draft,
        action: "create",
      }),
    ).toBe(
      "Create title, add prompt, select project, choose a model, and fix the schedule to create",
    );

    draft.name = "Weekly triage";
    draft.prompt = "Run the report.";
    draft.rrule = "FREQ=DAILY";
    draft.cwds = ["/tmp/project"];
    draft.model = "";

    expect(
      formatWorkbenchAutomationDraftSaveTooltip({
        draft,
        action: "save",
      }),
    ).toBe("Choose a model to save");

    draft.kind = "heartbeat";
    draft.model = "";
    draft.cwds = [];
    draft.targetThreadId = "";

    expect(
      formatWorkbenchAutomationDraftSaveTooltip({
        draft,
        action: "create",
      }),
    ).toBe("Select chat to create");

    draft.targetThreadId = "thread-1";
    expect(
      formatWorkbenchAutomationDraftSaveTooltip({
        draft,
        action: "create",
      }),
    ).toBe(null);
  });

  test("parses project inputs and prefixes generated ids", () => {
    expect(JSON.stringify(parseWorkbenchAutomationCwds(" /a, /b\n/c "))).toBe(
      JSON.stringify(["/a", "/b", "/c"]),
    );
    expect(createCodexScheduledAutomationId(() => "abc").startsWith("automation-")).toBe(true);
  });

  test("detects meaningful create draft changes without counting generated ids", () => {
    const draft = createWorkbenchAutomationDraft({ id: "automation-new" });
    expect(hasWorkbenchAutomationCreateDraftChanges(draft)).toBe(false);

    draft.name = "Draft only";
    expect(hasWorkbenchAutomationCreateDraftChanges(draft)).toBe(true);

    draft.name = "";
    draft.cwds = ["/tmp/project"];
    expect(hasWorkbenchAutomationCreateDraftChanges(draft)).toBe(true);

    draft.cwds = [];
    draft.kind = "heartbeat";
    expect(hasWorkbenchAutomationCreateDraftChanges(draft)).toBe(true);
  });

  test("compares create drafts against their initial seed", () => {
    const initialDraft = createWorkbenchAutomationDraft({ id: "initial-id" });
    initialDraft.name = "Daily bug scan";
    initialDraft.prompt = "Scan recent commits.";
    initialDraft.rrule = "FREQ=DAILY";

    const draft = {
      ...initialDraft,
      id: "next-generated-id",
      cwds: [...initialDraft.cwds],
    };
    expect(hasWorkbenchAutomationCreateDraftChanges(draft, initialDraft)).toBe(false);

    draft.prompt = "Scan recent commits and CI failures.";
    expect(hasWorkbenchAutomationCreateDraftChanges(draft, initialDraft)).toBe(true);
  });
});
