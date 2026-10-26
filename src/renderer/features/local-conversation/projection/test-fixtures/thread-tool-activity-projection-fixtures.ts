import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2/ThreadItem";
import type { TurnStatus } from "@nodex/codex-app-server-protocol/v2/TurnStatus";
import type {
  CodexConversationItem,
  CodexConversationTurn,
} from "@/lib/types";
import { projectCodexCanonicalTurnItemViews } from "../../../../../shared/codex-canonical-item-projector";
import {
  materializeCodexCanonicalProtocolItem,
} from "../../../../../shared/codex-conversation-state/codex-conversation-state";
import {
  agentActivityV2DynamicHandoffItem,
  agentActivityV2DynamicGenericFailedItem,
  agentActivityV2FallbackCommandItem,
  agentActivityV2McpAppContextPrecedenceItem,
  agentActivityV2MixedPatchItem,
  agentActivityV2WebSearchItem,
} from "../../../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-item-family-corpus";
import { projectCodexItemViewToTranscriptEntry } from "../../../../../shared/codex-transcript-entry-projection";
import type {
  ThreadAgentActivityGroupBlockModel,
  ThreadAgentActivityGroupEntryModel,
  ThreadAgentRenderUnit,
  ThreadTurnModel,
} from "../../thread-stage-types";
import { buildTurnRenderModel } from "../build-turn-render-model";

const THREAD_ID = "thread-tool-activity-projection-fixture";
const TURN_ID = "turn-tool-activity-projection-fixture";

type LifecycleStatus = "inProgress" | "completed" | "failed" | "declined" | "interrupted";

export type ThreadToolActivityProjectionScenarioId =
  | "reasoning-only"
  | "pre-patch"
  | "materialized-patch"
  | "mixed-tools"
  | "settled-mixed-tools"
  | "completed-patch-singleton"
  | "completed-web-singleton"
  | "thinking-owner"
  | "active-standalone-dynamic";

export interface ThreadToolActivityProjectionFixtureInput {
  readonly id: string;
  readonly rawItems: readonly ThreadItem[];
  readonly turnStatus: TurnStatus;
  readonly lifecycleStatusByItemId?: Readonly<Record<string, LifecycleStatus>>;
  readonly isLatestTurn?: boolean;
}

export interface ThreadToolActivityProjectionFixtureResult {
  readonly canonicalItems: ReturnType<typeof materializeCodexCanonicalProtocolItem>[];
  readonly transcriptItems: CodexConversationItem[];
  readonly turn: CodexConversationTurn;
  readonly model: ThreadTurnModel;
}

/** A Codex reasoning summary section, headed by what the Agent is doing. */
function reasoning(id: string, heading: string): ThreadItem {
  return {
    type: "reasoning",
    id,
    summary: [`**${heading}**`],
    content: [],
  };
}

function command(
  id: string,
  status: "inProgress" | "completed" = "completed",
): ThreadItem {
  return {
    ...agentActivityV2FallbackCommandItem,
    id,
    command: "pnpm test",
    status,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 90 : null,
  };
}

function patch(
  id: string,
  status: "inProgress" | "completed" = "inProgress",
): ThreadItem {
  return {
    ...agentActivityV2MixedPatchItem,
    id,
    status,
    changes: [{
      path: "src/activity-fixture.ts",
      kind: { type: "update", move_path: null },
      diff: "@@ -1 +1 @@\n-export const state = 'before';\n+export const state = 'after';\n",
    }],
  };
}

function emptyPatch(id: string): ThreadItem {
  return {
    type: "fileChange",
    id,
    status: "inProgress",
    changes: [],
  };
}

function webSearch(id: string): ThreadItem {
  return {
    ...agentActivityV2WebSearchItem,
    id,
    query: "Codex app-server activity projection",
    action: {
      type: "search",
      query: "Codex app-server activity projection",
      queries: ["Codex app-server activity projection"],
    },
  };
}

const SCENARIOS: Record<
  ThreadToolActivityProjectionScenarioId,
  ThreadToolActivityProjectionFixtureInput
> = {
  "reasoning-only": {
    id: "reasoning-only",
    rawItems: [reasoning("reasoning-only", "Preparing the implementation.")],
    turnStatus: "inProgress",
  },
  "pre-patch": {
    id: "pre-patch",
    rawItems: [
      reasoning("reasoning-pre-patch", "Preparing the larger patch."),
      emptyPatch("patch-pre-materialization"),
    ],
    turnStatus: "inProgress",
    lifecycleStatusByItemId: {
      "patch-pre-materialization": "inProgress",
    },
  },
  "materialized-patch": {
    id: "materialized-patch",
    rawItems: [
      reasoning("reasoning-materialized-patch", "Applying the larger patch."),
      patch("patch-materialized"),
    ],
    turnStatus: "inProgress",
    lifecycleStatusByItemId: {
      "patch-materialized": "inProgress",
    },
  },
  "mixed-tools": {
    id: "mixed-tools",
    rawItems: [
      command("command-mixed"),
      reasoning("reasoning-between-command-and-patch", "Checking the command result."),
      patch("patch-mixed-tools", "completed"),
      reasoning("reasoning-between-patch-and-web", "Checking current documentation."),
      webSearch("web-mixed-tools"),
    ],
    turnStatus: "inProgress",
    lifecycleStatusByItemId: {
      "command-mixed": "completed",
      "patch-mixed-tools": "completed",
      "web-mixed-tools": "inProgress",
    },
  },
  "settled-mixed-tools": {
    id: "settled-mixed-tools",
    rawItems: [
      command("command-settled"),
      patch("patch-settled", "completed"),
      webSearch("web-settled"),
      {
        ...agentActivityV2McpAppContextPrecedenceItem,
        id: "mcp-settled",
      },
      {
        ...agentActivityV2DynamicGenericFailedItem,
        id: "dynamic-settled",
      },
    ],
    turnStatus: "completed",
    lifecycleStatusByItemId: {
      "command-settled": "completed",
      "patch-settled": "completed",
      "web-settled": "completed",
      "mcp-settled": "completed",
      "dynamic-settled": "failed",
    },
    isLatestTurn: false,
  },
  "completed-patch-singleton": {
    id: "completed-patch-singleton",
    rawItems: [patch("patch-singleton", "completed")],
    turnStatus: "completed",
    lifecycleStatusByItemId: {
      "patch-singleton": "completed",
    },
    isLatestTurn: false,
  },
  "completed-web-singleton": {
    id: "completed-web-singleton",
    rawItems: [webSearch("web-singleton")],
    turnStatus: "completed",
    lifecycleStatusByItemId: {
      "web-singleton": "completed",
    },
    isLatestTurn: false,
  },
  "thinking-owner": {
    id: "thinking-owner",
    rawItems: [
      command("command-thinking-owner"),
      patch("patch-thinking-owner", "completed"),
      reasoning("reasoning-thinking-owner", "Verifying the completed edits."),
    ],
    turnStatus: "inProgress",
    lifecycleStatusByItemId: {
      "command-thinking-owner": "completed",
      "patch-thinking-owner": "completed",
    },
  },
  "active-standalone-dynamic": {
    id: "active-standalone-dynamic",
    rawItems: [{
      ...agentActivityV2DynamicHandoffItem,
      id: "dynamic-handoff-thread-active",
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null,
    }],
    turnStatus: "inProgress",
    lifecycleStatusByItemId: {
      "dynamic-handoff-thread-active": "inProgress",
    },
  },
};

export const THREAD_TOOL_ACTIVITY_PROJECTION_SCENARIOS = SCENARIOS;

export function buildThreadToolActivityProjectionFixture(
  input: ThreadToolActivityProjectionFixtureInput,
): ThreadToolActivityProjectionFixtureResult {
  const canonicalItems = input.rawItems.map((item) =>
    materializeCodexCanonicalProtocolItem(item)
  );
  const transcriptItems = projectCodexCanonicalTurnItemViews({
    threadId: THREAD_ID,
    turnId: TURN_ID,
    items: canonicalItems,
    observedAtMs: 1_000,
    turnStatus: input.turnStatus,
    lifecycleStatusByItemId: input.lifecycleStatusByItemId,
    commandExecutionStartedAtMsById: {},
    interruptedCommandExecutionItemIds: [],
    isBackgroundSubagentsEnabled: true,
  }).map((view, index) =>
    projectCodexItemViewToTranscriptEntry(view, "live", index) as CodexConversationItem
  );
  const turn: CodexConversationTurn = {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    status: input.turnStatus,
    itemIds: transcriptItems.map((item) => item.itemId),
    items: transcriptItems,
  };
  const isLatestTurn = input.isLatestTurn ?? true;
  const model = buildTurnRenderModel({
    turn,
    requests: [],
    isLatestTurn,
    isStreamingTurn: input.turnStatus === "inProgress",
    cwd: "/workspace/project",
  });

  return {
    canonicalItems,
    transcriptItems,
    turn,
    model,
  };
}

export function buildThreadToolActivityProjectionScenario(
  id: ThreadToolActivityProjectionScenarioId,
): ThreadToolActivityProjectionFixtureResult {
  return buildThreadToolActivityProjectionFixture(SCENARIOS[id]);
}

export function findProjectedActivityGroup(
  units: readonly ThreadAgentRenderUnit[],
): ThreadAgentActivityGroupBlockModel | null {
  const group = units.find((unit) => unit.block.type === "agentActivityGroup")?.block;
  return group?.type === "agentActivityGroup" ? group : null;
}

export function readProjectedActivityEntryTypes(
  entries: readonly ThreadAgentActivityGroupEntryModel[],
): string[] {
  return entries.map((entry) => entry.type);
}
