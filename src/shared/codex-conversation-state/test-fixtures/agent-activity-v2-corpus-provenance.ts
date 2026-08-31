import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2/ThreadItem";
import type {
  CodexConversationReplayFixture,
  CodexConversationReplayProvenance,
  CodexConversationReplaySanitization,
  CodexConversationReplayTarget,
} from "../codex-conversation-replay";

export const AGENT_ACTIVITY_V2_CORPUS_THREAD_ID = "thread-activity-v2-corpus";
export const AGENT_ACTIVITY_V2_CORPUS_TURN_ID = "turn-activity-v2-corpus";

export const AGENT_ACTIVITY_V2_CORPUS_TARGET = {
  version: "26.707.30751",
  build: 5018,
  asarSha256: "bf6a8d30300c95cd12eb51fc39ea462a3b1bd4719a4ab260b22194340d0b2959",
} satisfies CodexConversationReplayTarget;

export const AGENT_ACTIVITY_V2_CORPUS_RUNTIME_EVIDENCE =
  "30751 runtime unavailable; bundle-only";

export const AGENT_ACTIVITY_V2_CORPUS_SANITIZATION = {
  status: "sanitized",
  substitutions: [
    "thread, turn, item, request, operation, connector, and plugin identifiers",
    "working directories, commands, file paths, diffs, and command output",
    "tool arguments, results, permission roots, questions, and web queries",
  ],
} satisfies CodexConversationReplaySanitization;

export function buildAgentActivityV2BundleProvenance(
  evidence: readonly string[],
): CodexConversationReplayProvenance {
  return {
    kind: "bundle-synthesized",
    target: AGENT_ACTIVITY_V2_CORPUS_TARGET,
    evidence,
    runtimeEvidence: AGENT_ACTIVITY_V2_CORPUS_RUNTIME_EVIDENCE,
  };
}

export function buildAgentActivityV2CorpusThread(
  items: readonly ThreadItem[] = [],
): Thread {
  return {
    id: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    extra: null,
    sessionId: "session-activity-v2-corpus",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Agent activity v2 protocol payload corpus",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: {
      type: "active",
      activeFlags: [],
    },
    path: null,
    cwd: "/workspace/project",
    cliVersion: "fixture",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Agent activity v2 protocol payload corpus",
    turns: [{
      id: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
      items: [...items],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    }],
  };
}

export function validateAgentActivityV2CorpusFixtureMetadata(
  fixture: CodexConversationReplayFixture,
): readonly string[] {
  const errors: string[] = [];
  const { provenance } = fixture;

  if (fixture.threadId !== AGENT_ACTIVITY_V2_CORPUS_THREAD_ID) {
    errors.push(`${fixture.id} targets an unexpected thread`);
  }
  if (provenance.kind !== "bundle-synthesized") {
    errors.push(`${fixture.id} has unexpected provenance ${provenance.kind}`);
  }
  if (
    provenance.target.version !== AGENT_ACTIVITY_V2_CORPUS_TARGET.version
    || provenance.target.build !== AGENT_ACTIVITY_V2_CORPUS_TARGET.build
    || provenance.target.asarSha256 !== AGENT_ACTIVITY_V2_CORPUS_TARGET.asarSha256
  ) {
    errors.push(`${fixture.id} has target version drift`);
  }
  if (provenance.runtimeEvidence !== AGENT_ACTIVITY_V2_CORPUS_RUNTIME_EVIDENCE) {
    errors.push(`${fixture.id} overstates its runtime evidence`);
  }
  if (provenance.evidence.length === 0) {
    errors.push(`${fixture.id} has no exact bundle evidence`);
  }
  if (JSON.stringify(fixture.sanitization) !== JSON.stringify(AGENT_ACTIVITY_V2_CORPUS_SANITIZATION)) {
    errors.push(`${fixture.id} has unexpected sanitization metadata`);
  }
  if (fixture.initialThread?.id !== AGENT_ACTIVITY_V2_CORPUS_THREAD_ID) {
    errors.push(`${fixture.id} has no corpus thread snapshot`);
  }
  if (
    fixture.initialThread?.turns.some((turn) => turn.id === AGENT_ACTIVITY_V2_CORPUS_TURN_ID)
    !== true
  ) {
    errors.push(`${fixture.id} has no corpus turn snapshot`);
  }

  return errors;
}
