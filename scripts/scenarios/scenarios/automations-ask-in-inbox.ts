import { projectInbox } from "../../../src/shared/inbox";
import type { AutomationCreateInput } from "../../../src/shared/types";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const AUTOMATIONS_ASK_IN_INBOX_SCENARIO_ID = "automations/ask-in-inbox" as const;
export const AUTOMATIONS_ASK_IN_INBOX_SCENARIO_REVISION = 1 as const;

export interface AutomationsAskInInboxScenarioFacts extends ScenarioFacts {
  readonly taskCount: number;
  readonly heldDecisionCount: number;
  readonly bumpMissedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly projectInboxCount: number;
  readonly allInboxCount: number;
}

export const requireAutomationsAskInInboxScenarioFacts = (
  value: unknown,
): AutomationsAskInInboxScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== AUTOMATIONS_ASK_IN_INBOX_SCENARIO_ID ||
    envelope.scenarioRevision !== AUTOMATIONS_ASK_IN_INBOX_SCENARIO_REVISION ||
    ![
      "taskCount",
      "heldDecisionCount",
      "bumpMissedCount",
      "skippedCount",
      "failedCount",
      "projectInboxCount",
      "allInboxCount",
    ].every((key) => Number.isInteger(candidate[key]) && (candidate[key] as number) >= 0)
  ) {
    throw new Error("automations/ask-in-inbox facts are invalid");
  }
  return value as AutomationsAskInInboxScenarioFacts;
};

/** Automation decisions and their Activity, seeded through the scheduler without Agent execution. */
const materializeAutomationsAskInInbox = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: "Nodex", sources: [workspace] });
  if (!project.defaultDatabaseViewId) {
    throw new Error("automations/ask-in-inbox Project has no default View");
  }
  const runbookPageId = createUuidV7();
  await port.createPage({
    key: "dependencyPolicy",
    pageId: runbookPageId,
    operationId: createUuidV7(),
    projectId: project.id,
    status: "plan",
    title: "Dependency policy",
    markdown: [
      "Pin the Node runtime, package manager, Electron, and native addons to exact versions.",
      "Keep other packages within their current compatible ranges and update the lockfile.",
      "Run the project's typecheck, lint, and relevant tests before opening a draft PR.",
    ].join("\n\n"),
  });

  const defaults = {
    kind: "cron",
    mode: "ask_first",
    projectId: project.id,
    cwds: [workspace],
    executionEnvironment: "worktree",
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
  } satisfies Omit<AutomationCreateInput, "name">;
  const bump = await port.createAutomation({
    ...defaults,
    name: "Bump dependency versions",
    runbookPageId,
    prompt:
      "Bump outdated dependencies to their latest compatible versions, run the project's checks, and open one draft PR per ecosystem.",
  });
  const bumpMessage = await port.holdAutomationNow(bump.id);
  await port.holdAutomationNow(bump.id);
  await port.holdAutomationNow(bump.id);

  const reading = await port.createAutomation({
    ...defaults,
    projectId: null,
    cwds: [],
    executionEnvironment: "local",
    name: "Weekly reading list",
    prompt: "Collect this week's useful engineering articles and prepare a short reading list.",
  });
  const readingMessage = await port.holdAutomationNow(reading.id);

  const changelog = await port.createAutomation({
    ...defaults,
    name: "Update changelog",
    prompt: "Review the week's changes and update the changelog with user-visible improvements.",
  });
  const changelogMessage = await port.holdAutomationNow(changelog.id);
  await port.skipAutomationDecision(changelogMessage.pageId);

  const release = await port.createAutomation({
    ...defaults,
    name: "Release notes draft",
    prompt: "Draft concise release notes from the changelog and recent merged pull requests.",
  });
  const releaseMessage = await port.holdAutomationNow(release.id);
  await port.failAutomationRunNow(release.id);

  const security = await port.createAutomation({
    ...defaults,
    mode: "run",
    name: "Security check",
    prompt: "Check dependencies for security advisories and report anything that needs attention.",
  });

  const note = await port.sendInboxMessage(
    "The dependency policy is ready for the next maintenance pass.",
    projectInbox(project.id),
  );
  await port.proposeInboxDispatch({
    pageIds: [note.pageId],
    action: { type: "keep" },
    kind: "note",
    summary: "Keep the dependency policy handy.",
    rationale: null,
  });

  return {
    version: 1,
    scenarioId: AUTOMATIONS_ASK_IN_INBOX_SCENARIO_ID,
    scenarioRevision: AUTOMATIONS_ASK_IN_INBOX_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {
      dependencyPolicy: runbookPageId,
      bumpDependencies: bumpMessage.pageId,
      weeklyReadingList: readingMessage.pageId,
      updateChangelog: changelogMessage.pageId,
      releaseNotesDraft: releaseMessage.pageId,
      ordinaryMessage: note.pageId,
    },
    entityIdsByKey: {
      bumpDependencies: bump.id,
      weeklyReadingList: reading.id,
      updateChangelog: changelog.id,
      releaseNotesDraft: release.id,
      securityCheck: security.id,
    },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspectAutomationsAskInInbox = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<AutomationsAskInInboxScenarioFacts> => {
  const tasks = await port.readAutomations();
  const projectScope = projectInbox(manifest.projectId);
  const project = (await port.readInbox(projectScope)).items;
  const all = (await port.readInbox()).items;
  const history = await port.readHandledMessages(projectScope);
  const bump = project.find((item) => item.pageId === manifest.pageIdsByKey.bumpDependencies);
  const facts: AutomationsAskInInboxScenarioFacts = {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    taskCount: tasks.length,
    heldDecisionCount: tasks.filter((task) => task.heldDecision !== null).length,
    bumpMissedCount: bump?.automationDecision?.missedCount ?? -1,
    skippedCount: history.filter((item) => item.automationDecision?.status === "skipped").length,
    failedCount: project.filter((item) => item.automationDecision?.status === "failed").length,
    projectInboxCount: project.length,
    allInboxCount: all.length,
  };
  if (
    facts.taskCount !== 5 ||
    // The failed run awaiting Retry is its task's waiting run too.
    facts.heldDecisionCount !== 3 ||
    facts.bumpMissedCount !== 2 ||
    facts.skippedCount !== 1 ||
    facts.failedCount !== 1 ||
    facts.projectInboxCount !== 3 ||
    facts.allInboxCount !== 4
  ) {
    throw new Error(
      `automations/ask-in-inbox materialized facts do not match revision ${AUTOMATIONS_ASK_IN_INBOX_SCENARIO_REVISION}: ${JSON.stringify(facts)}`,
    );
  }
  return facts;
};

export const automationsAskInInboxScenario: ScenarioDomainRecipe = {
  id: AUTOMATIONS_ASK_IN_INBOX_SCENARIO_ID,
  revision: AUTOMATIONS_ASK_IN_INBOX_SCENARIO_REVISION,
  materialize: materializeAutomationsAskInInbox,
  inspect: inspectAutomationsAskInInbox,
  parseFacts: requireAutomationsAskInInboxScenarioFacts,
};
