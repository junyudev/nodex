import { parseDatabaseViewId } from "../../../src/shared/database-identities";
import type { InboxItem, InboxPlanStep } from "../../../src/shared/inbox";
import { projectInbox } from "../../../src/shared/inbox";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import type { WorkflowStatus } from "../../../src/shared/workflow-status";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const NODEX_COORDINATOR_SCENARIO_ID = "nodex-coordinator";
export const NODEX_COORDINATOR_SCENARIO_REVISION = 11;
export const COORDINATOR_AGENT = {
  selection: { instanceId: "codex", model: "gpt-5.5", effort: "medium" },
  launch: "ask",
} as const;

const CARDS = {
  ready: {
    title: "Fix README install typo",
    status: "plan",
    outcome: "ready",
    summary: "Fixed the README install typo; checked all docs — no other occurrences.",
  },
  blocked: {
    title: "Add team invitations",
    status: "doing",
    outcome: "blocked",
    summary: "Invitation flow is ready; waiting for the email sender domain to be verified.",
    branch: "nodex-2-add-team-invitations",
    pullRequest: 2,
  },
  failed: {
    title: "Restore search indexing",
    status: "doing",
    outcome: "failed",
    summary:
      "The index rebuild failed: the search service rejected its credentials. No documents changed.",
  },
  dropped: {
    title: "Remove duplicate welcome email",
    status: "triage",
    outcome: "dropped",
    summary: "The welcome email already sends once. No change is needed.",
  },
  ask: { title: "Polish empty search results", status: "plan", blockedBy: "done" },
  dependent: { title: "Test invitation delivery", status: "plan", blockedBy: "blocked" },
  chainStart: { title: "Build keyboard navigation", status: "doing", live: "working" },
  // Its chat waits second in line for Agent capacity, on a checkout with no pull request yet.
  queued: {
    title: "Speed up Board loading",
    status: "doing",
    live: "queued",
    branch: "nodex-12-speed-up-board-loading",
  },
  paused: { title: "Tidy settings copy", status: "plan", paused: true },
  chainEnd: {
    title: "Document keyboard shortcuts",
    status: "plan",
    blockedBy: "chainStart",
    launch: "automatic",
  },
  needsYou: { title: "Choose session retention", status: "review", live: "input" },
  done: {
    title: "Add copy link action",
    status: "done",
    outcome: "ready",
    summary: "Copy link works from the Page menu; keyboard and clipboard checks passed.",
  },
type CardKey = keyof typeof CARDS;
  readonly title: string;
  readonly status: WorkflowStatus;
  readonly outcome?: "ready" | "blocked" | "failed" | "dropped";
  readonly summary?: string;
  readonly live?: "working" | "input" | "queued";
  readonly launch?: "automatic";
  /** A person paused this Page's work. */
  readonly paused?: true;
  /** The Page's checkout, and the pull request GitHub reports for it. */
  readonly branch?: string;
  readonly pullRequest?: number;
};

export interface NodexCoordinatorScenarioFacts extends ScenarioFacts {
  readonly cardCount: number;
  readonly managedChatCount: number;
  readonly reportCounts: Readonly<Record<"ready" | "blocked" | "failed" | "dropped", number>>;
  readonly turnCounts: Readonly<Record<string, number>>;
  readonly planSteps: readonly { readonly key: string; readonly blockedBy: readonly string[] }[];
  readonly nodexStartedCount: number;
  /** The Project filters the same mixed Inbox projection. */
  readonly projectTurnCount: number;
  readonly automaticBlockedCount: number;
}

export const requireNodexCoordinatorFacts = (value: unknown): NodexCoordinatorScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Partial<NodexCoordinatorScenarioFacts>;
  if (
    envelope.scenarioId !== NODEX_COORDINATOR_SCENARIO_ID ||
    envelope.scenarioRevision !== NODEX_COORDINATOR_SCENARIO_REVISION ||
    ![
      candidate.cardCount,
      candidate.managedChatCount,
      candidate.nodexStartedCount,
      candidate.projectTurnCount,
      candidate.automaticBlockedCount,
    ].every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0) ||
    !candidate.reportCounts ||
    !candidate.turnCounts ||
    !candidate.inboxRowCounts ||
    !Array.isArray(candidate.planSteps)
  ) {
    throw new Error("nodex-coordinator facts are invalid");
  }
  return value as NodexCoordinatorScenarioFacts;
};

const valueOf = <T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
): T => {
  if (result.ok) return result.value;
  throw new Error(result.error.message);
};
const identity = (values: Readonly<Record<string, string>> | undefined, key: string): string => {
  const id = values?.[key];
  if (id) return id;
  throw new Error("nodex-coordinator identity missing: " + key);
};

const materialize: ScenarioDomainRecipe["materialize"] = async (port, workspace) => {
  const project = await port.createProject({ name: "Nodex", sources: [workspace] });
  if (!project.defaultDatabaseViewId) throw new Error("Nodex has no Board");
  const coordinator = await port.createCoordinatorSession();
  const pages: Record<string, string> = {};
  const entities: Record<string, string> = { coordinator };
  for (const [key, recipe] of Object.entries<CardRecipe>(CARDS)) {
    // Filing retains the Library Inbox as this result's home even though its card lives on the Board.
    const pageId =
      key === "ready" ? (await port.sendInboxMessage(recipe.title)).pageId : createUuidV7();
    pages[key] = pageId;
    if (key === "ready")
      await port.dispatchInboxEntries({
        pageIds: [pageId],
        action: { type: "move_to_project", projectId: project.id },
      });
    else
      await port.createPage({
        key,
        pageId,
        operationId: createUuidV7(),
        projectId: project.id,
        status: recipe.status,
        title: recipe.title,
        markdown:
          key === "ask"
            ? "Make the empty search state useful. Keep the query visible, offer Clear filters, and check keyboard focus."
            : (recipe.summary ?? "Ship a focused improvement and check the main user path."),
      });
    await port.setPageWork(project.id, pageId, {
      assignee: {
        kind: "agent",
        instance_id: COORDINATOR_AGENT.selection.instanceId,
        model: COORDINATOR_AGENT.selection.model,
        effort: COORDINATOR_AGENT.selection.effort,
      },
      auto_start: recipe.launch === "automatic",
    });
    if (recipe.paused) await port.pauseWork({ kind: "page", page_id: pageId });
    if (!recipe.outcome && !recipe.live) continue;
    // Work with a checkout runs in an Agent chat, as starting it would create; the rest use
    // native chats with their own status.
    const chat = recipe.branch
      ? await port.createWorkChat({ projectId: project.id, pageId, title: recipe.title })
      : await port.createRelatedChat({
          handOff: true,
          projectId: key === "ready" || key === "failed" || key === "needsYou" ? null : project.id,
          relatedPageIds: [pageId],
          noThreadFallbackTitle: recipe.title,
          thread: {
            threadId: createUuidV7(),
            threadName: recipe.title,
            threadPreview: recipe.summary ?? "Working through the keyboard interaction.",
            statusType: recipe.live ? "active" : "idle",
            statusActiveFlags: recipe.live === "input" ? ["waitingOnUserInput"] : [],
            unread: false,
          },
        });
    entities[key + "Session"] = chat.sessionId;
    if (chat.threadId) entities[key + "Thread"] = chat.threadId;
    if (recipe.branch)
      await port.recordPageWorkspace({
        projectId: project.id,
        pageId,
        sessionId: chat.sessionId,
        repositoryRoot: workspace,
        branchName: recipe.branch,
        ...(recipe.pullRequest
          ? { pullRequest: { number: recipe.pullRequest, state: "OPEN" as const } }
          : {}),
      });
    // A report also hands these linked chats to Nodex. Live states need the same managed membership.
    if (recipe.outcome)
      await port.reportPageWork({
        sessionId: chat.sessionId,
        pageId,
        outcome: recipe.outcome,
        summary: recipe.summary!,
      });
    else await port.setSessionManaged(chat.sessionId, true);
    if (recipe.live)
      await port.recordSessionExecution(chat.sessionId, {
        state: recipe.live === "input" ? "waiting" : recipe.live,
        runId: `scenario:${key}`,
        runStartedAt: 0,
        pendingRequestIds: recipe.live === "input" ? ["scenario:question"] : [],
        pendingRequests:
          recipe.live === "input"
            ? [
                {
                  id: "scenario:question",
                  kind: "question",
                  question: "How long should completed sessions stay?",
                  options: ["Keep 30 days", "Keep 90 days", "Keep until I delete them"],
                },
              ]
            : [],
        queue:
          recipe.live === "queued"
            ? {
                runId: `scenario:${key}`,
                class: "person",
                position: 2,
                waitingSince: new Date().toISOString(),
              }
            : null,
        terminalStatus: null,
        personStopped: false,
        stalled: false,
        progressFingerprint: `scenario:${key}`,
        progressSince: 0,
      });
  }
  const view = valueOf(
    await port.readDatabase({
      projectId: project.id,
      read: {
        target: { kind: "view", viewId: parseDatabaseViewId(project.defaultDatabaseViewId) },
        mode: "view",
      },
    }),
  );
  if (view.value.kind !== "view") throw new Error("Expected Nodex Board View");
  const sourceId = view.value.value.dataSourceId;
  const source = valueOf(
    await port.readDatabase({
      projectId: project.id,
      read: { target: { kind: "data_source", dataSourceId: sourceId }, mode: "data_source" },
    }),
  );
  if (source.value.kind !== "data_source") throw new Error("Expected Nodex Source");
  const blockedBy = source.value.value.properties.find(
    (property) => property.propertyId === "blocked_by",
  );
  if (!blockedBy) throw new Error("Nodex Source has no Waits for");
  valueOf(
    await port.applyDatabase({
      projectId: project.id,
      storeEpoch: source.storeEpoch,
      operationId: createUuidV7(),
      actor: { kind: "scenario_seed" },
      operations: [
        {
          kind: "edit_property_values",
          edits: Object.entries<CardRecipe>(CARDS).flatMap(([key, recipe]) =>
            recipe.blockedBy
              ? [
                  {
                    pageId: identity(pages, key),
                    dataSourceId: sourceId,
                    propertyId: blockedBy.propertyId,
                    edit: {
                      kind: "patch_set" as const,
                      delta: {
                        kind: "relation" as const,
                        addPageIds: [identity(pages, recipe.blockedBy)],
                        removeEdgeIds: [],
                      },
                    },
                  },
                ]
              : [],
          ),
        },
      ],
    }),
  );

  const started = await port.sendInboxMessage("Audit README links.");
  pages.startedRequest = started.pageId;
  const startedProposal = await port.settleCoordinatorSuggestion({
    coordinatorSessionId: coordinator,
    pageIds: [started.pageId],
    action: {
      type: "new_chat",
      projectId: project.id,
      agent: {
        instanceId: COORDINATOR_AGENT.selection.instanceId,
        model: COORDINATOR_AGENT.selection.model,
        reasoningEffort: COORDINATOR_AGENT.selection.effort,
        serviceTier: null,
      },
      prompt: "Audit README links.",
      additions: [],
    },
    kind: "todo",
    summary: "Continue the README check.",
    rationale: null,
    explicitRequest: true,
    automaticDispatch: true,
  });
  await port.confirmInboxRequestByNodex(startedProposal, COORDINATOR_AGENT.selection);
  await port.completeInboxDispatch(startedProposal, createUuidV7());

  const question = await port.sendInboxMessage("What is still waiting on me?");
  pages.question = question.pageId;
  pages.answer = (
    await port.answerInboxQuestion({
      coordinatorSessionId: coordinator,
      questionPageId: question.pageId,
      body: "Session retention needs your decision. Search indexing needs fresh credentials.",
    })
  ).pageId;
  await port.writeTurnNote({
    coordinatorSessionId: coordinator,
    pageId: identity(pages, "ready"),
    sessionId: identity(entities, "readySession"),
    body: "README install typo fixed; checked all docs. Ready for review.",
    notify: false,
  });
  await port.writeTurnNote({
    coordinatorSessionId: coordinator,
    pageId: identity(pages, "failed"),
    sessionId: identity(entities, "failedSession"),
    body: "Update the search service key to continue indexing.",
    notify: true,
  });
  const returned = await port.handBackChatMessage({
    body: "Update the keyboard shortcut guide.",
    reason: "The keyboard navigation chat owns this change.",
  });
  pages.handedBack = returned.pageId;
  entities.handedBackSession = returned.sessionId;
  await port.settleCoordinatorSuggestion({
    coordinatorSessionId: coordinator,
    pageIds: [returned.pageId],
    action: {
      type: "send_to_chat",
      sessionId: identity(entities, "chainStartSession"),
      prompt: "Continue the existing keyboard navigation work.",
      additions: [],
    },
    kind: "todo",
    summary: "Continue with keyboard navigation",
    rationale: null,
    explicitRequest: false,
    automaticDispatch: false,
  });

  const plan = await port.sendInboxMessage(
    "Improve onboarding: audit the first run, simplify setup, then verify the new flow.",
  );
  pages.planRequest = plan.pageId;
  const steps: readonly InboxPlanStep[] = [
    {
      key: "audit",
      title: "Audit the first run",
      body: "Walk through a clean first run and list the friction points.",
      blockedBy: [],
    },
    {
      key: "simplify",
      title: "Simplify project setup",
      body: "Remove unnecessary setup steps based on the audit.",
      blockedBy: ["audit"],
    },
    {
      key: "verify",
      title: "Verify the onboarding flow",
      body: "Check a fresh Profile and keyboard navigation through setup.",
      blockedBy: ["simplify"],
    },
  ].map((step) => ({ ...step, projectId: project.id, agent: COORDINATOR_AGENT.selection }));
  entities.planProposal = await port.settleCoordinatorSuggestion({
    coordinatorSessionId: coordinator,
    pageIds: [plan.pageId],
    action: { type: "plan", summary: "A smoother first run", steps },
    kind: "todo",
    summary: "A smoother first run",
    rationale: null,
  });
  return {
    version: 1,
    scenarioId: NODEX_COORDINATOR_SCENARIO_ID,
    scenarioRevision: NODEX_COORDINATOR_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: pages,
    entityIdsByKey: entities,
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const rowCounts = (items: readonly InboxItem[]) => {
  for (const item of items) counts[item.rowKind]++;
  return counts;
};
const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<NodexCoordinatorScenarioFacts> => {
  const plan = library.find((item) => item.pageId === manifest.pageIdsByKey.planRequest)?.proposal;
  const dispatched = await port.readPage(
    manifest.projectId,
    identity(manifest.pageIdsByKey, "startedRequest"),
  );
  if (
    dispatched.pageWork?.assignee?.kind !== "agent" ||
    dispatched.pageWork.assignee.instance_id !== COORDINATOR_AGENT.selection.instanceId ||
    dispatched.pageWork.auto_start
  )
    throw new Error("Dispatched work must retain its receiving Agent without automatic starts");
  if (plan?.action.type !== "plan" || plan.state !== "open")
    throw new Error("Expected an open Coordinator plan");
  const counts = { ready: 0, blocked: 0, failed: 0, dropped: 0 };
  const states: Record<string, number> = {};
  let managedChatCount = 0;
  let automaticBlockedCount = 0;
  for (const [key, recipe] of Object.entries<CardRecipe>(CARDS)) {
    const pageId = identity(manifest.pageIdsByKey, key);
    const activity = (await port.readPageChatActivity([pageId])).summaries[0];
    if (!activity) throw new Error("Missing Page activity");
    const detail = await port.readPage(manifest.projectId, pageId);
    if (
      detail.title !== recipe.title ||
      detail.pageWork?.assignee?.kind !== "agent" ||
      detail.pageWork.assignee.model !== COORDINATOR_AGENT.selection.model
    )
      throw new Error("Card did not retain its Agent Assignee: " + key);
    managedChatCount += activity.work.managedSessionCount;
    const report = activity.work.latestReport;
    if (report) counts[report.outcome]++;
    const prerequisites = valueOf(
      await port.readDatabase({
        projectId: manifest.projectId,
        read: { target: { kind: "page", pageId }, mode: "prerequisites" },
      }),
    );
    if (prerequisites.value.kind !== "prerequisites") throw new Error("Expected prerequisites");
    const waiting = prerequisites.value.value.unsatisfiedCount;
    if (
      recipe.blockedBy &&
      CARDS[recipe.blockedBy].status !== "done" &&
      prerequisites.value.value.blockers[0]?.pageId !==
        identity(manifest.pageIdsByKey, recipe.blockedBy)
    )
      throw new Error("Missing work graph edge: " + key);
    if (recipe.blockedBy && CARDS[recipe.blockedBy].status === "done" && waiting !== 0)
      throw new Error("Done prerequisites still block work: " + key);
    if (detail.pageWork.auto_start && waiting > 0) automaticBlockedCount++;
    const state = (await port.readPageTurn(pageId)).reason ?? "none";
    states[state] = (states[state] ?? 0) + 1;
  }
  return requireNodexCoordinatorFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    cardCount: (await port.readBoard(manifest.projectId, manifest.databaseViewId)).totalRows,
    managedChatCount,
    reportCounts: counts,
    turnCounts: states,
    inboxRowCounts: rowCounts(library),
    planSteps: plan.action.steps.map(({ key, blockedBy }) => ({ key, blockedBy })),
    nodexStartedCount: history.filter(
      (item) => item.proposal?.confirmedBy === "nodex" && item.proposal.state === "completed",
    ).length,
    projectTurnCount: project.filter((item) => item.rowKind === "turn").length,
    automaticBlockedCount,
  });
};

export const nodexCoordinatorScenario: ScenarioDomainRecipe = {
  id: NODEX_COORDINATOR_SCENARIO_ID,
  revision: NODEX_COORDINATOR_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireNodexCoordinatorFacts,
};
