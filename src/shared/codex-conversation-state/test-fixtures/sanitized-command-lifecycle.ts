import type { CodexConversationReplayFixture } from "../codex-conversation-replay";

const THREAD_ID = "thread_fixture";
const TURN_ID = "turn_fixture";
const ITEM_ID = "item_fixture_command";
const REQUEST_ID = 73;

export const sanitizedCommandLifecycleFixture = {
  id: "codex-electron-26.707.30751-command-lifecycle-smoke",
  threadId: THREAD_ID,
  targetState: "ordered command lifecycle with a resolved approval request",
  provenance: {
    kind: "bundle-synthesized",
    target: {
      version: "26.707.30751",
      build: 5018,
      asarSha256: "bf6a8d30300c95cd12eb51fc39ea462a3b1bd4719a4ab260b22194340d0b2959",
    },
    evidence: [
      "h59fr3q5.pretty.js:86369-86447 (ordered hydration-aware replay)",
      "h59fr3q5.pretty.js:86458-86509 (notification/request buffer union)",
      "h59fr3q5.pretty.js:91374-91427 (item started)",
      "h59fr3q5.pretty.js:91430-91522 (item completed)",
      "h59fr3q5.pretty.js:91613-91624 (command output delta)",
      "h59fr3q5.pretty.js:91671-91681 (request resolution)",
    ],
    runtimeEvidence: "30751 runtime unavailable; bundle-only",
  },
  sanitization: {
    status: "sanitized",
    substitutions: [
      "thread, turn, item, and request identifiers",
      "working directory and command text",
      "command output and approval reason",
    ],
  },
  initialThread: {
    model: null,
    reasoningEffort: null,
    id: THREAD_ID,
    extra: null,
    sessionId: "session_fixture",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Sanitized replay fixture",
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
    source: "unknown",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Sanitized replay fixture",
    turns: [{
      id: TURN_ID,
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    }],
  },
  events: [
    {
      type: "notification",
      notification: {
        method: "item/started",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          startedAtMs: 1_000,
          item: {
            type: "commandExecution",
            id: ITEM_ID,
            command: "printf fixture",
            cwd: "/workspace/project",
            processId: null,
            pluginId: null,
            scriptPath: null,
            source: "agent",
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          },
        },
      },
    },
    {
      type: "notification",
      notification: {
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: ITEM_ID,
          delta: "fixture output\n",
        },
      },
    },
    {
      type: "request",
      request: {
        id: REQUEST_ID,
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: ITEM_ID,
          startedAtMs: 1_010,
          environmentId: null,
          reason: "Sanitized fixture approval",
          command: "printf fixture",
          cwd: "/workspace/project",
          commandActions: [],
        },
      },
    },
    {
      type: "notification",
      notification: {
        method: "serverRequest/resolved",
        params: {
          threadId: THREAD_ID,
          requestId: REQUEST_ID,
        },
      },
    },
    {
      type: "notification",
      notification: {
        method: "item/completed",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          completedAtMs: 1_050,
          item: {
            type: "commandExecution",
            id: ITEM_ID,
            command: "printf fixture",
            cwd: "/workspace/project",
            processId: null,
            pluginId: null,
            scriptPath: null,
            source: "agent",
            status: "completed",
            commandActions: [],
            aggregatedOutput: "fixture output\n",
            exitCode: 0,
            durationMs: 50,
          },
        },
      },
    },
  ],
} satisfies CodexConversationReplayFixture;
