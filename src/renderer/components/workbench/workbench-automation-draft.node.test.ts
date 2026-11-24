import { describe, expect, test } from "vite-plus/test";
import type { CodexModelOption, Automation } from "@/lib/types";
import {
  buildAutomationCreateInput,
  buildAutomationUpdateInput,
  createAutomationId,
  createWorkbenchAutomationDraft,
  createWorkbenchAutomationDraftFromCreateInput,
  createWorkbenchAutomationDraftFromUpdateInput,
  formatWorkbenchAutomationDraftSaveTooltip,
  hasWorkbenchAutomationCreateDraftChanges,
  isWorkbenchAutomationDraftDirty,
  parseWorkbenchAutomationCwds,
  resolveWorkbenchAutomationDraftModelSettings,
  validateWorkbenchAutomationDraft,
  workbenchAutomationClockTrigger,
  type WorkbenchAutomationDraft,
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

const clockTrigger = {
  ...workbenchAutomationClockTrigger("FREQ=DAILY"),
  nextRunAt: new Date(2026, 6, 9, 9, 30).getTime(),
} satisfies Automation["trigger"];

const eventTrigger = {
  kind: "event",
  filter: {
    sourceId: "source:github",
    repositories: ["team/repo"],
    events: ["check_failed"],
    labels: ["ci"],
    actorClass: "any",
  },
} satisfies Automation["trigger"];

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    automationRevision: 1,
    scope: { kind: "space" },
    ownerMemberId: "member-owner",
    conditionText: "Every day",
    trigger: clockTrigger,
    projectId: null,
    notificationPolicy: null,
    mode: "run",
    runbookPageId: null,
    runbookTitle: null,
    heldDecision: null,
    kind: "heartbeat",
    status: "ACTIVE",
    targetSessionId: "thread-1",
    name: "Daily standup",
    prompt: "Check the daily standup thread.",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { driver: "codex", instanceId: "codex" },
    cwds: [],
    executionEnvironment: "worktree",
    localEnvironmentConfigPath: null,
    lastRunAt: null,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function makeEventAutomation(): Automation {
  return makeAutomation({
    kind: "cron",
    targetSessionId: null,
    projectId: "project",
    cwds: ["/tmp/project"],
    model: "gpt-5.5",
    trigger: eventTrigger,
    conditionText: "A check fails on main",
  });
}

describe("workbench automation draft", () => {
  test("builds event create and update inputs without clock fields", () => {
    const draft = createWorkbenchAutomationDraft({ automation: makeEventAutomation() });

    expect(draft.trigger).toEqual(eventTrigger);
    for (const payload of [
      buildAutomationCreateInput({ draft }),
      buildAutomationUpdateInput({ draft }),
    ]) {
      expect(payload?.trigger).toEqual(eventTrigger);
      const keys = new Set<string>();
      JSON.stringify(payload, (key, value: unknown) => {
        keys.add(key);
        return value;
      });
      expect(
        ["rrule", "timezone", "nextRunAt", "sourceCondition"].filter((key) => keys.has(key)),
      ).toEqual([]);
    }
  });

  test("a Heartbeat create input always starts with a clock draft", () => {
    const draft = createWorkbenchAutomationDraftFromCreateInput({
      kind: "heartbeat",
      name: "Follow up",
      prompt: "Check progress",
      targetSessionId: "session:resolved",
      trigger: eventTrigger,
    });

    expect(draft.trigger).toEqual(workbenchAutomationClockTrigger());
  });

  test("editing a target retains the Automation's scope and observed revision", () => {
    const automation = makeAutomation({
      scope: { kind: "project", projectId: "scope-project" },
      automationRevision: 7,
    });
    const draft = createWorkbenchAutomationDraft({ automation: automation });
    expect(
      buildAutomationUpdateInput({ draft: { ...draft, prompt: "Check the latest progress" } }),
    ).toMatchObject({ scope: automation.scope, expectedRevision: 7 });
  });

  test("a reviewed proposal cannot inherit Run from an omitted mode", () => {
    const automation = makeAutomation({
      mode: "ask_first",
      automationRevision: 7,
      trigger: { ...clockTrigger, timezone: "Asia/Tokyo" },
    });
    const draft = createWorkbenchAutomationDraftFromUpdateInput({
      automation: automation,
      update: {
        id: automation.id,
        expectedRevision: 7,
        kind: "heartbeat",
        status: "ACTIVE",
        name: automation.name,
        prompt: "Check the latest progress",
        trigger: { kind: "clock", rrule: "FREQ=WEEKLY" },
        targetSessionId: automation.targetSessionId,
      },
    });
    expect(draft.trigger).toEqual({ kind: "clock", rrule: "FREQ=WEEKLY", timezone: "Asia/Tokyo" });
    expect(buildAutomationUpdateInput({ draft })).toMatchObject({
      mode: "ask_first",
      ownerMemberId: automation.ownerMemberId,
      trigger: { kind: "clock", rrule: "FREQ=WEEKLY", timezone: "Asia/Tokyo" },
      scope: automation.scope,
    });
  });
  test("an unregistered Agent's Automation keeps its identity and omits model defaults", () => {
    const binding = { driver: "futureAgent", instanceId: "future-work" };
    const draft = createWorkbenchAutomationDraft({
      automation: makeAutomation({
        kind: "cron",
        targetSessionId: null,
        backendBinding: binding,
      }),
    });
    const resolved = resolveWorkbenchAutomationDraftModelSettings({ draft, models: MODELS });

    expect(resolved).toMatchObject({ backendBinding: binding, model: "", reasoningEffort: "" });
  });

  test("preserves a reviewed Claude profile and its Default intent when Codex models reload", () => {
    const draft = createWorkbenchAutomationDraftFromCreateInput({
      kind: "cron",
      backendBinding: { driver: "claudeAgent", instanceId: "gateway" },
      name: "Review",
      prompt: "Check progress",
      trigger: { kind: "clock", rrule: "FREQ=DAILY" },
      projectId: "project",
      cwds: ["/workspace"],
      executionEnvironment: "local",
    });
    const resolved = resolveWorkbenchAutomationDraftModelSettings({ draft, models: MODELS });
    expect(resolved).toBe(draft);
    expect(buildAutomationCreateInput({ draft: resolved })).toMatchObject({
      backendBinding: { driver: "claudeAgent", instanceId: "gateway" },
      model: "default",
      reasoningEffort: "default",
      serviceTier: null,
    });
    const definition = makeAutomation({
      kind: "cron",
      targetSessionId: null,
      projectId: "project",
      cwds: ["/workspace"],
      backendBinding: { driver: "claudeAgent", instanceId: "gateway" },
      model: "vendor-sonnet",
      reasoningEffort: "max",
    });
    const edit = createWorkbenchAutomationDraft({ automation: definition });
    expect(isWorkbenchAutomationDraftDirty({ draft: edit, existing: definition })).toBe(false);
    const inherited = { ...definition, model: null, reasoningEffort: null };
    expect(
      isWorkbenchAutomationDraftDirty({
        draft: createWorkbenchAutomationDraft({ automation: inherited }),
        existing: inherited,
      }),
    ).toBe(false);
    expect(
      resolveWorkbenchAutomationDraftModelSettings({ draft: edit, models: MODELS }).model,
    ).toBe("vendor-sonnet");
    edit.backendBinding = { driver: "claudeAgent", instanceId: "other" };
    expect(isWorkbenchAutomationDraftDirty({ draft: edit, existing: definition })).toBe(true);
  });

  test("retains a Claude heartbeat's exact profile and omits per-run model overrides", () => {
    const draft = createWorkbenchAutomationDraftFromCreateInput({
      kind: "heartbeat",
      backendBinding: { driver: "claudeAgent", instanceId: "gateway" },
      targetSessionId: "session",
      name: "Follow up",
      prompt: "Check progress",
      trigger: { kind: "clock", rrule: "FREQ=HOURLY" },
      model: "unused",
    });
    expect(buildAutomationCreateInput({ draft })).toMatchObject({
      backendBinding: { driver: "claudeAgent", instanceId: "gateway" },
      targetSessionId: "session",
      model: null,
      reasoningEffort: null,
      serviceTier: null,
    });
  });

  test("uses a revisioned replacement's omitted execution fields instead of inheriting a newer definition", () => {
    const draft = createWorkbenchAutomationDraftFromUpdateInput({
      update: {
        id: "automation-1",
        expectedRevision: 3,
        kind: "cron",
        status: "ACTIVE",
        projectId: null,
        executionEnvironment: "local",
        name: "Independent check",
        prompt: "Check progress",
        trigger: { kind: "clock", rrule: "FREQ=DAILY" },
      },
      automation: makeAutomation({
        kind: "cron",
        automationRevision: 4,
        scope: { kind: "space" },
        ownerMemberId: "member-owner",
        conditionText: "Every day",
        projectId: "project:newer",
        cwds: ["/newer"],
        model: "newer-model",
        serviceTier: "priority",
        localEnvironmentConfigPath: "/newer/environment.toml",
      }),
    });
    expect(draft).toMatchObject({
      projectId: null,
      expectedRevision: 3,
      cwds: [],
      model: "",
      serviceTier: "",
      localEnvironmentConfigPath: "",
    });
  });

  test.each([undefined, null, "failed_runs_only"] as const)(
    "keeps a reviewed Session target and notification policy %s",
    (notificationPolicy) => {
      const draft = createWorkbenchAutomationDraftFromCreateInput({
        kind: "heartbeat",
        name: "Follow up",
        prompt: "Check progress",
        trigger: { kind: "clock", rrule: "FREQ=DAILY" },
        targetSessionId: "session:original",
        ...(notificationPolicy !== undefined ? { notificationPolicy } : {}),
      });
      const payload = buildAutomationCreateInput({ draft });
      expect(payload).toMatchObject({ targetSessionId: "session:original" });
      expect(payload?.notificationPolicy).toBe(notificationPolicy);
      expect(Object.hasOwn(payload ?? {}, "notificationPolicy")).toBe(
        notificationPolicy !== undefined,
      );
    },
  );

  test("retains the proposal revision and target when a newer definition loads during review", () => {
    const draft = createWorkbenchAutomationDraftFromUpdateInput({
      update: {
        id: "automation-1",
        kind: "heartbeat",
        status: "PAUSED",
        expectedRevision: 3,
        name: "Follow up",
        prompt: "Check progress",
        trigger: { kind: "clock", rrule: "FREQ=DAILY" },
        targetSessionId: "session:original",
      },
      automation: makeAutomation({
        automationRevision: 4,
        scope: { kind: "space" },
        ownerMemberId: "member-owner",
        conditionText: "Every day",
        targetSessionId: "session:newer",
        notificationPolicy: "failed_runs_only",
      }),
    });
    const payload = buildAutomationUpdateInput({ draft });
    expect(payload).toMatchObject({
      expectedRevision: 3,
      targetSessionId: "session:original",
      status: "PAUSED",
    });
    expect(Object.hasOwn(payload ?? {}, "notificationPolicy")).toBe(false);
  });

  test("builds create payloads with normalized fields", () => {
    const draft = createWorkbenchAutomationDraft({ id: "automation-new" });
    draft.name = "  Weekly triage  ";
    draft.prompt = "  Triage the project queue.  ";
    draft.targetSessionId = " thread-alpha ";
    draft.trigger = workbenchAutomationClockTrigger(" FREQ=WEEKLY ");
    draft.projectId = "project";
    draft.cwds = ["/tmp/project"];
    draft.model = "gpt-5.5";
    draft.reasoningEffort = "high";

    const payload = buildAutomationCreateInput({ draft });

    expect(payload?.name).toBe("Weekly triage");
    expect(payload?.prompt).toBe("Triage the project queue.");
    expect(payload?.targetSessionId).toBe(null);
    expect(payload?.trigger).toEqual(workbenchAutomationClockTrigger("FREQ=WEEKLY"));
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
        targetSessionId: null,
        model: "unavailable-model",
        reasoningEffort: "max",
        projectId: "project",
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

    const payload = buildAutomationUpdateInput({
      draft,
      id: automation.id,
    });
    expect(payload?.id).toBe("automation-1");
    expect(payload?.status).toBe("PAUSED");
  });

  test("counts only editable clock trigger fields as draft changes", () => {
    const clock = { ...workbenchAutomationClockTrigger("FREQ=DAILY"), timezone: "Asia/Tokyo" };
    const trigger = { ...clock, nextRunAt: clockTrigger.nextRunAt };
    const automation = makeAutomation({ trigger });
    const draft = createWorkbenchAutomationDraft({ automation });

    expect(isWorkbenchAutomationDraftDirty({ draft, existing: automation })).toBe(false);
    expect(
      isWorkbenchAutomationDraftDirty({
        draft,
        existing: { ...automation, trigger: { ...trigger, nextRunAt: null } },
      }),
    ).toBe(false);
    expect(
      isWorkbenchAutomationDraftDirty({
        draft: { ...draft, trigger: { ...clock, rrule: "FREQ=WEEKLY" } },
        existing: automation,
      }),
    ).toBe(true);
    expect(
      isWorkbenchAutomationDraftDirty({
        draft: { ...draft, trigger: { ...clock, timezone: "UTC" } },
        existing: automation,
      }),
    ).toBe(true);
  });

  test("detects changes to a saved event filter", () => {
    const automation = makeEventAutomation();
    const draft = createWorkbenchAutomationDraft({ automation });

    expect(isWorkbenchAutomationDraftDirty({ draft, existing: automation })).toBe(false);
    const editedTrigger = {
      ...eventTrigger,
      filter: { ...eventTrigger.filter, labels: ["urgent"] },
    };
    expect(
      isWorkbenchAutomationDraftDirty({
        draft: { ...draft, trigger: editedTrigger },
        existing: automation,
      }),
    ).toBe(true);
  });

  test("accepts calendar RRULE text when building cron model updates", () => {
    const calendarRrule = "DTSTART;TZID=Asia/Shanghai:20260710T090000\nRRULE:FREQ=DAILY";
    const automation = makeAutomation({
      kind: "cron",
      targetSessionId: null,
      trigger: { ...clockTrigger, rrule: calendarRrule },
      model: "gpt-5.5",
      reasoningEffort: "medium",
      projectId: "project",
      cwds: ["/tmp/project"],
      executionEnvironment: "local",
    });
    const draft = createWorkbenchAutomationDraft({ automation });
    draft.model = "gpt-5.4";
    draft.reasoningEffort = "high";

    const validation = validateWorkbenchAutomationDraft(draft);
    const payload = buildAutomationUpdateInput({
      draft,
      id: automation.id,
    });

    expect(validation.canSave).toBe(true);
    expect(payload?.trigger).toMatchObject({ kind: "clock", rrule: calendarRrule });
    expect(payload?.model).toBe("gpt-5.4");
    expect(payload?.reasoningEffort).toBe("high");
  });

  test.each(["", "INTERVAL=2"])("rejects a clock schedule without a frequency (%j)", (rrule) => {
    const draft = createWorkbenchAutomationDraft({ automation: makeAutomation() });
    draft.trigger = workbenchAutomationClockTrigger(rrule);

    expect(validateWorkbenchAutomationDraft(draft)).toMatchObject({
      canSave: false,
      missingRequirements: ["schedule"],
    });
    expect(buildAutomationUpdateInput({ draft })).toBeNull();
  });

  test.each([
    ["condition", { conditionText: " " }],
    ["events", { trigger: { ...eventTrigger, filter: { ...eventTrigger.filter, events: [] } } }],
    ["cwd", { projectId: null, cwds: [], executionEnvironment: "local" }],
    ["cwd", { cwds: [] }],
    ["workspace", { cwds: ["/tmp/first", "/tmp/second"] }],
  ] satisfies Array<[string, Partial<WorkbenchAutomationDraft>]>)(
    "requires %s for an event Automation (%j)",
    (requirement, overrides) => {
      const draft = createWorkbenchAutomationDraft({ automation: makeEventAutomation() });
      const invalid = { ...draft, ...overrides };

      expect(validateWorkbenchAutomationDraft(invalid)).toMatchObject({
        canSave: false,
        missingRequirements: [requirement],
      });
      expect(buildAutomationCreateInput({ draft: invalid })).toBeNull();
    },
  );

  test("validates required name, prompt, project, chat, and model", () => {
    const draft = createWorkbenchAutomationDraft({ id: "automation-new" });
    draft.name = " ";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.name = "Valid name";
    draft.prompt = " ";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.prompt = "Run the report.";
    draft.cwds = [];
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.projectId = "project";
    draft.cwds = ["/tmp/project"];
    draft.model = "";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.model = "gpt-5.5";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(true);

    draft.kind = "heartbeat";
    draft.targetSessionId = "";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);

    draft.targetSessionId = "thread-1";
    expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(true);
  });

  test("formats reference-style disabled save tooltips from missing requirements", () => {
    const draft = createWorkbenchAutomationDraft({ id: "automation-new" });
    draft.trigger = workbenchAutomationClockTrigger("INTERVAL=2");

    expect(
      formatWorkbenchAutomationDraftSaveTooltip({
        draft,
        action: "create",
      }),
    ).toBe("Create title, add prompt, choose a model, and fix the schedule to create");

    draft.name = "Weekly triage";
    draft.prompt = "Run the report.";
    draft.trigger = workbenchAutomationClockTrigger("FREQ=DAILY");
    draft.projectId = "project";
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
    draft.targetSessionId = "";

    expect(
      formatWorkbenchAutomationDraftSaveTooltip({
        draft,
        action: "create",
      }),
    ).toBe("Select chat to create");

    draft.targetSessionId = "thread-1";
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
    expect(createAutomationId(() => "abc").startsWith("automation-")).toBe(true);
  });

  test("detects meaningful create draft changes without counting generated ids", () => {
    const draft = createWorkbenchAutomationDraft({ id: "automation-new" });
    expect(hasWorkbenchAutomationCreateDraftChanges(draft)).toBe(false);

    draft.name = "Draft only";
    expect(hasWorkbenchAutomationCreateDraftChanges(draft)).toBe(true);

    draft.name = "";
    draft.projectId = "project";
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
    initialDraft.trigger = workbenchAutomationClockTrigger("FREQ=DAILY");

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

test("builds a projectless local task without borrowing a directory or Project", () => {
  const draft = createWorkbenchAutomationDraft();
  draft.name = "Daily review";
  draft.prompt = "Review updates";
  draft.model = "gpt-5.5";
  expect(buildAutomationCreateInput({ draft })).toMatchObject({
    projectId: null,
    cwds: [],
    executionEnvironment: "local",
  });
  draft.executionEnvironment = "worktree";
  expect(validateWorkbenchAutomationDraft(draft).canSave).toBe(false);
});

test("an ACP task keeps its exact instance and sends only options its model advertises", () => {
  const draft = createWorkbenchAutomationDraftFromCreateInput({
    kind: "cron",
    backendBinding: { driver: "acpRegistry", instanceId: "qoder-work" },
    name: "Nightly triage",
    prompt: "Triage new issues",
    trigger: { kind: "clock", rrule: "FREQ=DAILY" },
  });
  // No model is chosen for an ACP Agent; Codex's effort default never applies to it.
  expect(draft).toMatchObject({ model: "", reasoningEffort: "" });
  expect(validateWorkbenchAutomationDraft(draft).missingRequirements).toContain("model");
  draft.model = "dfmodel";
  expect(buildAutomationCreateInput({ draft })).toMatchObject({
    backendBinding: { driver: "acpRegistry", instanceId: "qoder-work" },
    model: "dfmodel",
    reasoningEffort: null,
    serviceTier: null,
  });
});
