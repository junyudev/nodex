import { readFile } from "node:fs/promises";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import type { DiscussionAnchor } from "../../../src/shared/discussions";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const PAGE_ASKS_AND_COMMENTS_ID = "page-asks-and-comments";
export const LAUNCH_REVIEW_PROJECT = "Launch review";
export const LAUNCH_REVIEW_TITLE = "Ask for change launch review";
export const LAUNCH_REVIEW_PAGE_KEY = "launchReview";
export const LAUNCH_REVIEW_CLAIM = "doubled every week";
export const LAUNCH_REVIEW_SUMMARY = `Usage ${LAUNCH_REVIEW_CLAIM} after the launch of in-place Ask.`;
export const LAUNCH_REVIEW_INTERPRETATION =
  "Every entry point doubled after launch. In-place Ask accounts for about a third of usage in week 8.";
export const LAUNCH_REVIEW_METHOD =
  "We excluded internal accounts and counted Pages by entry point.";
const revision = 1;

function textAnchor(blockId: string, text: string, quote: string) {
  const from = text.indexOf(quote);
  if (from < 0) throw new Error(`Missing fixture quote: ${quote}`);
  return {
    anchor: { kind: "text", blockId } as const,
    quote,
    textRange: { from, to: from + quote.length, expectedText: quote },
  };
}

async function materialize(port: ScenarioSeedPort, workspace: string): Promise<ScenarioManifest> {
  const discussions = port.discussionSeed;
  if (!discussions) throw new Error("Seed page-asks-and-comments through Core");
  const project = await port.createProject({ name: LAUNCH_REVIEW_PROJECT, sources: [workspace] });
  if (!project.defaultDatabaseViewId) throw new Error("Launch review has no default Database View");

  const adoption = await readFile(
    "scripts/scenarios/fixtures/page-asks-and-comments/adoption.jsx",
    "utf8",
  );
  const pageId = createUuidV7();
  await port.createPage({
    key: LAUNCH_REVIEW_PAGE_KEY,
    pageId,
    operationId: createUuidV7(),
    projectId: project.id,
    status: "doing",
    title: LAUNCH_REVIEW_TITLE,
    markdown: [
      LAUNCH_REVIEW_SUMMARY,
      "## Adoption",
      ["```visual", adoption.trimEnd(), "```"].join("\n"),
      LAUNCH_REVIEW_INTERPRETATION,
      "## Method",
      LAUNCH_REVIEW_METHOD,
      "## Next steps",
      "Compare four more weeks of usage and review how people move between entry points.",
    ].join("\n\n"),
  });
  const [summary, , visual, , , method] = await port.readPageBlockTree(project.id, pageId);
  if (summary?.type !== "paragraph" || visual?.type !== "codeBlock" || method?.type !== "paragraph")
    throw new Error("Launch review Page did not materialize the expected Blocks");

  const [ownerId, adamId, mayaId] = await discussions.enrollDiscussionMembers("Jun", [
    "Adam",
    "Maya",
  ]);
  if (!ownerId || !adamId || !mayaId) throw new Error("Launch review Members are missing");

  const factCheck = createUuidV7();
  const checkRequest = createUuidV7();
  await discussions.createDiscussion({
    kind: "create",
    pageId,
    discussionId: factCheck,
    firstCommentId: checkRequest,
    ...textAnchor(summary.id, LAUNCH_REVIEW_SUMMARY, LAUNCH_REVIEW_CLAIM),
    firstComment: { body: "Is this true?", toNodex: true, askKind: "check" },
  });
  await discussions.seedAgentDiscussionReply({
    projectId: project.id,
    discussionId: factCheck,
    requestId: checkRequest,
    reply: {
      body: "Usage grew after launch. The weekly totals do not support repeated doubling.",
      verdict: {
        result: "partly_true",
        evidence: [
          {
            title: "Pre-launch baseline",
            url: `nodex://pages/${pageId}`,
            excerpt: "88 Pages in week 4.",
          },
          {
            title: "Four weeks after launch",
            url: `nodex://pages/${pageId}`,
            excerpt: "212 Pages in week 8.",
          },
        ],
      },
      suggestedEdit: {
        blockIds: [summary.id],
        newMarkdown: LAUNCH_REVIEW_SUMMARY.replace(
          "doubled every week after the launch of in-place Ask",
          "grew 2.4x in four weeks after in-place Ask launched",
        ),
        expectedOldMarkdown: LAUNCH_REVIEW_SUMMARY,
      },
    },
  });

  const methodQuestion = createUuidV7();
  const methodRequest = createUuidV7();
  await discussions.createDiscussion({
    kind: "create",
    pageId,
    discussionId: methodQuestion,
    firstCommentId: methodRequest,
    ...textAnchor(method.id, LAUNCH_REVIEW_METHOD, "excluded internal accounts"),
    firstComment: { body: "Check how we identified internal accounts.", toNodex: true },
  });
  await discussions.seedAgentDiscussionReply({
    projectId: project.id,
    discussionId: methodQuestion,
    requestId: methodRequest,
    reply: {
      body: "Which account flag did you use to exclude internal accounts?",
      questionFor: ownerId,
    },
  });

  const weekSix = createUuidV7();
  const datumRequest = createUuidV7();
  const anchor: DiscussionAnchor = {
    kind: "datum",
    blockId: visual.id,
    source: "adoption",
    key: "Week 6",
    field: "In-place Ask",
  };
  await discussions.createDiscussion(
    {
      kind: "create",
      pageId,
      discussionId: weekSix,
      firstCommentId: datumRequest,
      anchor,
      quote: "Week 6 · In-place Ask",
      firstComment: { body: "What share of week 6 came from in-place Ask?", toNodex: true },
    },
    adamId,
  );
  await discussions.replyToDiscussion(
    weekSix,
    "I counted 178 Pages across all entry points that week.",
    mayaId,
  );
  await discussions.seedAgentDiscussionReply({
    projectId: project.id,
    discussionId: weekSix,
    requestId: datumRequest,
    reply: { body: "In-place Ask accounted for 52 of 178 Pages, or 29%." },
  });

  return {
    version: 1,
    scenarioId: PAGE_ASKS_AND_COMMENTS_ID,
    scenarioRevision: revision,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: { [LAUNCH_REVIEW_PAGE_KEY]: pageId },
    entityIdsByKey: { adoptionVisual: visual.id, factCheck, methodQuestion, weekSix },
    minimumCommitSeq: 0,
    materializedAt: new Date().toISOString(),
  };
}

async function inspect(port: ScenarioSeedPort, manifest: ScenarioManifest) {
  const pageId = manifest.pageIdsByKey[LAUNCH_REVIEW_PAGE_KEY];
  const { adoptionVisual, factCheck, methodQuestion, weekSix } = manifest.entityIdsByKey ?? {};
  if (
    !pageId ||
    !adoptionVisual ||
    !factCheck ||
    !methodQuestion ||
    !weekSix ||
    !port.readDiscussion
  )
    throw new Error("Launch review scenario inspection is unavailable");
  const [page, check, method, datum] = await Promise.all([
    port.readPage(manifest.projectId, pageId),
    port.readDiscussion(manifest.projectId, factCheck),
    port.readDiscussion(manifest.projectId, methodQuestion),
    port.readDiscussion(manifest.projectId, weekSix),
  ]);
  const [datumRequest, memberReply, agentReply] = datum.comments;
  if (
    page.title !== LAUNCH_REVIEW_TITLE ||
    page.documentReadiness !== "ready" ||
    check.anchorState !== "live" ||
    check.comments[0]?.ask?.state !== "answered" ||
    check.comments[1]?.verdict?.result !== "partly_true" ||
    check.comments[1]?.verdict.evidence.length !== 2 ||
    check.comments[1]?.suggestedEdit?.state !== "open" ||
    method.anchorState !== "live" ||
    method.comments[0]?.ask?.state !== "needs_you" ||
    !method.comments[1]?.questionFor ||
    datum.anchor.kind !== "datum" ||
    datum.anchorState !== "live" ||
    datum.anchor.blockId !== adoptionVisual ||
    datumRequest?.author.type !== "member" ||
    datumRequest.ask?.state !== "answered" ||
    memberReply?.author.type !== "member" ||
    memberReply.author.member_id === datumRequest.author.member_id ||
    agentReply?.author.type !== "agent" ||
    agentReply.author.on_behalf_of !== datumRequest.author.member_id
  ) {
    throw new Error("Seeded launch review does not match its Discussion and attribution contract");
  }
  return { scenarioId: manifest.scenarioId, scenarioRevision: manifest.scenarioRevision };
}

export const pageAsksAndCommentsScenario: ScenarioDomainRecipe = {
  id: PAGE_ASKS_AND_COMMENTS_ID,
  revision,
  materialize,
  inspect,
  parseFacts: parseScenarioFacts,
};
