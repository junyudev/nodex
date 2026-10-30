import { inboxNewChatAction } from "../../../src/shared/inbox";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

/** A small app screenshot, so a message that opens with an image reads as one. */
const INBOX_SCREENSHOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAPAAAACWCAIAAABvmpKCAAACxklEQVR42u3dP0scQRjA4XfP1QvBIhYKClZpAoLg97FJKWlT5QNYpRVLG7+PIATSWAkRIqigCGKC6Y6wOxFPNvtn9nmq8zgSb+fHMjs3txZXN7cBuZg4BAgaBA2CBkEjaBA09E35khc9ffk0e1zsHyRfMz3ZnT1+2DlOvubzt4+zx1+3jhx9OjhD/11z/cd6zfUf6zXXf4Q2gk7mW3kymW/lyWS+msYcGgSNoCHDoJNrGpUnk2salSeTaxoWOujgDF3JN5l4Jd9k4pV81cz/UNgPjTk0CBoEDYJG0JCFcrFcGMrv+vjrtwGjge2jPbH89o0Bw5QDQYOgQdAgaBA0ggZBg6BB0BBzfPR9/uNnm7/K5sZag//a97Nzo5uHD+83GzhDt1xzs/+jmnMy12hORv7+yWxMzaFxUQiChi6DbnbNIVpf5SAs2ykMUw4QNAgaxhj0XJ+UktmYTnz6T06jWdze3Q/ljU2XFo0uMc7ddphD57PbDkGDoEHQIGiw247xsQ6NKQcIGsKfpHidi8trQ9tn66srztBqNkamHJhDg912YR0au+3CbjtMOTq7gqb/Y1Q6XjhDg6DBbjsIu+0I69Dhk1WGf+VtLwdZHWcXhVjlAEGDoCEaW7br2267ly/buS6Msa5y/DPoTva+Pd+0dWhMORA0CBoEDVY5wipHWD8Z0W47NY+5aVMOzKFB0CBocF8O9zCwyhG+U4gzNAgaBA2CJtyXI3zDPqwhOEOr2fERNAgaBI2gQdCu4h2fcH/osJcDZ2gQNIIGQYOgQdAgaAQNggZBQ/jGSsL23s3Q38Lp4TuNhr0cGaQsa1MOyDHozE7PWb4jQYOgETQIGgQNggZBI2gQNAgaBB3j2spjc5IzNGH7aGR2KzD7oQXt3naYcoCgQdAgaAQNggZBg6BB0AgaBA2CBkGDoBE0CBoEDYIGQSNo6L8/xwzAtxQwALEAAAAASUVORK5CYII=";

export const INBOX_SUGGESTION_SPEND_SCENARIO_ID = "inbox/suggestion-spend" as const;
export const INBOX_SUGGESTION_SPEND_SCENARIO_REVISION = 3 as const;

export interface InboxSuggestionSpendScenarioFacts extends ScenarioFacts {
  readonly messageCount: number;
  readonly currentProposalCount: number;
  readonly outdatedProposalCount: number;
  readonly unrequestedCount: number;
  readonly groupedMemberCount: number;
  readonly failedCount: number;
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
      "failedCount",
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

  const failed = await port.sendInboxMessage(
    "Summarize this week's support tickets by theme and flag anything urgent.",
  );
  await port.recordInboxSuggestionFailure(
    [failed.pageId],
    "The suggestion Agent is rate limited. Try again in a few minutes.",
  );

  const screenshotFileId = createUuidV7();
  await port.createLibraryFile({
    projectId: project.id,
    operationId: createUuidV7(),
    fileId: screenshotFileId,
    defaultName: "inbox-screenshot.png",
    mimeType: "image/png",
    bytes: new Uint8Array(Buffer.from(INBOX_SCREENSHOT_PNG, "base64")),
  });
  const pictured = await port.sendInboxMessage(
    `![](nodex://files/${screenshotFileId})\n\nCan you look at this?`,
  );
  await port.prepareInboxSuggestions(false);

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
      failed: failed.pageId,
      pictured: pictured.pageId,
    },
    entityIdsByKey: { screenshotFile: screenshotFileId },
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
    failedCount: items.filter((item) => item.suggestionState === "failed").length,
  };
  if (
    facts.messageCount !== 7 ||
    facts.currentProposalCount !== 2 ||
    facts.outdatedProposalCount !== 1 ||
    facts.unrequestedCount !== 2 ||
    facts.groupedMemberCount !== 2 ||
    facts.failedCount !== 1
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
