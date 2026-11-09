import { parseDatabaseViewId } from "../../../src/shared/database-identities";
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
export const COORDINATOR_AGENT = {
  selection: { instanceId: "codex", model: "gpt-5.5", effort: "medium" },
  launch: "ask",

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
  dependent: { title: "Test invitation delivery", status: "plan", blockedBy: "blocked" },
  chainStart: { title: "Build keyboard navigation", status: "doing", live: "working" },
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
  readonly launch?: "automatic";
};

export interface NodexCoordinatorScenarioFacts extends ScenarioFacts {
  readonly cardCount: number;
  readonly managedChatCount: number;
  readonly reportCounts: Readonly<Record<"ready" | "blocked" | "failed" | "dropped", number>>;
  readonly planSteps: readonly { readonly key: string; readonly blockedBy: readonly string[] }[];
  readonly nodexStartedCount: number;
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
      candidate.automaticBlockedCount,
    ].every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0) ||
    !candidate.reportCounts ||
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
    });
    if (!recipe.outcome && !recipe.live) continue;
    entities[key + "Session"] = chat.sessionId;
    // A report also hands these linked chats to Nodex. Live states need the same managed membership.
    if (recipe.outcome)
      await port.reportPageWork({
        sessionId: chat.sessionId,
        pageId,
        outcome: recipe.outcome,
        summary: recipe.summary!,
      });
    else await port.setSessionManaged(chat.sessionId, true);
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

  return counts;
};
const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<NodexCoordinatorScenarioFacts> => {
  const plan = library.find((item) => item.pageId === manifest.pageIdsByKey.planRequest)?.proposal;
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
    )
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
      prerequisites.value.value.blockers[0]?.pageId !==
        identity(manifest.pageIdsByKey, recipe.blockedBy)
    )
      throw new Error("Missing work graph edge: " + key);
    states[state] = (states[state] ?? 0) + 1;
  }
  return requireNodexCoordinatorFacts({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    managedChatCount,
    reportCounts: counts,
    planSteps: plan.action.steps.map(({ key, blockedBy }) => ({ key, blockedBy })),
    nodexStartedCount: history.filter(
      (item) => item.proposal?.confirmedBy === "nodex" && item.proposal.state === "completed",
    ).length,
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
