import { projectInbox } from "../../../src/shared/inbox";
import type { CodexScheduledAutomationCreateInput } from "../../../src/shared/types";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const SCHEDULED_ASK_IN_INBOX_SCENARIO_ID = "scheduled/ask-in-inbox" as const;
export const SCHEDULED_ASK_IN_INBOX_SCENARIO_REVISION = 1 as const;

export interface ScheduledAskInInboxScenarioFacts extends ScenarioFacts {
  readonly taskCount: number;
  readonly heldFiringCount: number;
  readonly bumpMissedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly projectInboxCount: number;
  readonly libraryInboxCount: number;
}

export const requireScheduledAskInInboxScenarioFacts = (
  value: unknown,
): ScheduledAskInInboxScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== SCHEDULED_ASK_IN_INBOX_SCENARIO_ID ||
    envelope.scenarioRevision !== SCHEDULED_ASK_IN_INBOX_SCENARIO_REVISION ||
    ![
      "taskCount",
      "heldFiringCount",
      "bumpMissedCount",
      "skippedCount",
      "failedCount",
      "projectInboxCount",
      "libraryInboxCount",
    ].every((key) => Number.isInteger(candidate[key]) && (candidate[key] as number) >= 0)
  ) {
    throw new Error("scheduled/ask-in-inbox facts are invalid");
  }
  return value as ScheduledAskInInboxScenarioFacts;
};

/** Scheduled decisions and their History, seeded through the scheduler without Agent execution. */
const materializeScheduledAskInInbox = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: "Nodex", sources: [workspace] });
  if (!project.defaultDatabaseViewId) {
    throw new Error("scheduled/ask-in-inbox Project has no default View");
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
    launch: "ask",
    projectId: project.id,
    cwds: [workspace],
    executionEnvironment: "worktree",
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
  } satisfies Omit<CodexScheduledAutomationCreateInput, "name">;
  const bump = await port.createScheduledTask({
    ...defaults,
    name: "Bump dependency versions",
    runbookPageId,
    prompt:
      "Bump outdated dependencies to their latest compatible versions, run the project's checks, and open one draft PR per ecosystem.",
  });
  const bumpMessage = await port.holdScheduledTaskNow(bump.id);
  await port.holdScheduledTaskNow(bump.id);
  await port.holdScheduledTaskNow(bump.id);

  const reading = await port.createScheduledTask({
    ...defaults,
    projectId: null,
    cwds: [],
    executionEnvironment: "local",
    name: "Weekly reading list",
    prompt: "Collect this week's useful engineering articles and prepare a short reading list.",
  });
  const readingMessage = await port.holdScheduledTaskNow(reading.id);

  const changelog = await port.createScheduledTask({
    ...defaults,
    name: "Update changelog",
    prompt: "Review the week's changes and update the changelog with user-visible improvements.",
  });
  const changelogMessage = await port.holdScheduledTaskNow(changelog.id);
  await port.skipScheduledFiring(changelogMessage.pageId);

  const release = await port.createScheduledTask({
    ...defaults,
    name: "Release notes draft",
    prompt: "Draft concise release notes from the changelog and recent merged pull requests.",
  });
  const releaseMessage = await port.holdScheduledTaskNow(release.id);
  await port.failScheduledRunNow(release.id);

  const security = await port.createScheduledTask({
    ...defaults,
    launch: "automatic",
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
    scenarioId: SCHEDULED_ASK_IN_INBOX_SCENARIO_ID,
    scenarioRevision: SCHEDULED_ASK_IN_INBOX_SCENARIO_REVISION,
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

const inspectScheduledAskInInbox = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<ScheduledAskInInboxScenarioFacts> => {
  const tasks = await port.readScheduledTasks();
  const projectScope = projectInbox(manifest.projectId);
  const project = (await port.readInbox("inbox", projectScope)).items;
  const library = (await port.readInbox("inbox")).items;
  const history = (await port.readInbox("processed", projectScope)).items;
  const bump = project.find((item) => item.pageId === manifest.pageIdsByKey.bumpDependencies);
  const facts: ScheduledAskInInboxScenarioFacts = {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    taskCount: tasks.length,
    heldFiringCount: tasks.filter((task) => task.heldFiring !== null).length,
    bumpMissedCount: bump?.firing?.missedCount ?? -1,
    skippedCount: history.filter((item) => item.firing?.status === "skipped").length,
    failedCount: project.filter((item) => item.firing?.status === "failed").length,
    projectInboxCount: project.length,
    libraryInboxCount: library.length,
  };
  if (
    facts.taskCount !== 5 ||
    // The failed run awaiting Retry is its task's waiting run too.
    facts.heldFiringCount !== 3 ||
    facts.bumpMissedCount !== 2 ||
    facts.skippedCount !== 1 ||
    facts.failedCount !== 1 ||
    facts.projectInboxCount !== 3 ||
    facts.libraryInboxCount !== 1
  ) {
    throw new Error(
      `scheduled/ask-in-inbox materialized facts do not match revision ${SCHEDULED_ASK_IN_INBOX_SCENARIO_REVISION}: ${JSON.stringify(facts)}`,
    );
  }
  return facts;
};

export const scheduledAskInInboxScenario: ScenarioDomainRecipe = {
  id: SCHEDULED_ASK_IN_INBOX_SCENARIO_ID,
  revision: SCHEDULED_ASK_IN_INBOX_SCENARIO_REVISION,
  materialize: materializeScheduledAskInInbox,
  inspect: inspectScheduledAskInInbox,
  parseFacts: requireScheduledAskInInboxScenarioFacts,
};
