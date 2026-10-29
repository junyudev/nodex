import { inboxNewChatAction } from "../../../src/shared/inbox";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const INBOX_SUGGESTION_SPEND_SCENARIO_ID = "inbox/suggestion-spend" as const;
export const INBOX_SUGGESTION_SPEND_SCENARIO_REVISION = 1 as const;

export interface InboxSuggestionSpendScenarioFacts extends ScenarioFacts {
  readonly messageCount: number;
  readonly currentProposalCount: number;
  readonly outdatedProposalCount: number;
  readonly unrequestedCount: number;
  readonly groupedMemberCount: number;
}

export const requireInboxSuggestionSpendScenarioFacts = (
  value: unknown,
): InboxSuggestionSpendScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  const candidate = value as Record<string, unknown>;
  if (
    envelope.scenarioId !== INBOX_SUGGESTION_SPEND_SCENARIO_ID ||
    envelope.scenarioRevision !== INBOX_SUGGESTION_SPEND_SCENARIO_REVISION ||
    ![
      "messageCount",
      "currentProposalCount",
      "outdatedProposalCount",
      "unrequestedCount",
      "groupedMemberCount",
    ].every((key) => Number.isInteger(candidate[key]) && (candidate[key] as number) >= 0)
  ) {
    throw new Error("inbox/suggestion-spend facts are invalid");
  }
  return value as InboxSuggestionSpendScenarioFacts;
};

/** Advice remains reviewable after an edit; only sends await automatic preparation. */
const materialize = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: "Nodex", sources: [workspace] });
  if (!project.defaultDatabaseViewId) throw new Error("Suggestion scenario needs a Project View");

  const unrequested = await port.sendInboxMessage(
    "Could the weekly reading list include a short note on why each article matters?",
  );
  await port.prepareInboxSuggestions(false);

  const current = await port.sendInboxMessage(
    "Compare three onboarding flows and recommend a shorter path to the first useful result.",
  );
  await port.proposeInboxDispatch({
    pageIds: [current.pageId],
    action: inboxNewChatAction(project.id, "Compare onboarding flows and propose one improvement."),
    kind: "todo",
    summary: "Compare onboarding flows",
    rationale: "A focused comparison can identify the next improvement to Nodex's first run.",
  });

  const outdated = await port.sendInboxMessage(
    "Review the homepage copy and suggest a clearer opening paragraph.",
  );
  await port.proposeInboxDispatch({
    pageIds: [outdated.pageId],
    action: inboxNewChatAction(
      project.id,
      "Review the homepage copy and suggest a clearer opening.",
    ),
    kind: "todo",
    summary: "Review homepage copy",
    rationale: "The homepage should make the first useful action clear.",
  });
  await port.replaceOwnedDocument({
    projectId: project.id,
    pageId: outdated.pageId,
    operationId: createUuidV7(),
    mutationId: createUuidV7(),
    clientSessionId: "scenario-inbox-suggestion-spend",
    markdown:
      "Review the homepage copy for new team members. Include the pricing section and keep the tone direct.",
  });

  const navigation = await port.sendInboxMessage(
    "The sidebar loses my place when I switch between a Page and its linked chat.",
  );
  const keyboard = await port.sendInboxMessage(
    "Keyboard focus should return to the same sidebar item after I close a linked chat.",
  );
  await port.proposeInboxDispatch({
    pageIds: [navigation.pageId, keyboard.pageId],
    action: inboxNewChatAction(
      project.id,
      "Investigate sidebar selection and keyboard focus across linked chats.",
    ),
    kind: "todo",
    summary: "Keep your place across linked chats",
    rationale:
      "These messages describe the same navigation workflow and should be investigated together.",
  });

  return {
    version: 1,
    scenarioId: INBOX_SUGGESTION_SPEND_SCENARIO_ID,
    scenarioRevision: INBOX_SUGGESTION_SPEND_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {
      current: current.pageId,
      outdated: outdated.pageId,
      unrequested: unrequested.pageId,
      navigation: navigation.pageId,
      keyboard: keyboard.pageId,
    },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
};

const inspect = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<InboxSuggestionSpendScenarioFacts> => {
  const { items } = await port.readInbox("inbox");
  const proposals = [
    ...new Map(
      items.flatMap((item) =>
        item.proposal ? [[item.proposal.proposalId, item.proposal] as const] : [],
      ),
    ).values(),
  ];
  const facts = {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    messageCount: items.length,
    currentProposalCount: proposals.filter((proposal) => !proposal.outdated).length,
    outdatedProposalCount: proposals.filter((proposal) => proposal.outdated).length,
    unrequestedCount: items.filter((item) => item.suggestionState === "none" && !item.proposal)
      .length,
    groupedMemberCount: items.filter((item) => (item.proposal?.pageIds.length ?? 0) > 1).length,
  };
  if (
    facts.messageCount !== 5 ||
    facts.currentProposalCount !== 2 ||
    facts.outdatedProposalCount !== 1 ||
    facts.unrequestedCount !== 1 ||
    facts.groupedMemberCount !== 2
  ) {
    throw new Error(
      `inbox/suggestion-spend materialized facts do not match: ${JSON.stringify(facts)}`,
    );
  }
  return facts;
};

export const inboxSuggestionSpendScenario: ScenarioDomainRecipe = {
  id: INBOX_SUGGESTION_SPEND_SCENARIO_ID,
  revision: INBOX_SUGGESTION_SPEND_SCENARIO_REVISION,
  materialize,
  inspect,
  parseFacts: requireInboxSuggestionSpendScenarioFacts,
};
