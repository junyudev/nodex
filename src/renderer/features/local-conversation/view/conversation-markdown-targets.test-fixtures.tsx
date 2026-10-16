import { StrictMode, useLayoutEffect, type ReactNode } from "react";
import { vi } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexComposerSkill } from "../../../../shared/types";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import { NodexTooltipProvider } from "../../../components/ui/tooltip";
import {
  FileReferenceRouterProvider,
  type FileReferenceRouterPort,
} from "../../../lib/file-reference-router";
import { dispatchCodexAppServerMessage } from "../app-server-message-bus";
import {
  useCodexAppServerRegistry,
  type CodexAppServerManagerRegistry,
} from "../local-conversation-store";
import {
  CodexTranscriptReadOwnerContext,
  CodexTranscriptTurnEntityContext,
} from "../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import { buildTurnRenderModel } from "../projection/build-turn-render-model";
import { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import { projectCodexTranscript } from "../../../../shared/codex-transcript-projection";
import { ThreadBlockRenderer } from "./blocks/local-conversation-block-renderer";
import { LocalConversationTimelinePromotion } from "./local-conversation-timeline-promotion";
import { LocalConversationRealtimeItem } from "./local-conversation-realtime-item";
import {
  isCodexTimelineTurnEntry,
  isCodexRealtimeTimelineEntry,
} from "../projection/normalized-timeline-entries";
import { ConversationMarkdownSourceProvider } from "./conversation-markdown-source";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import type { ThreadStageActions } from "../thread-stage-types";

const key = { threadId: "thread", entityKey: "turn:one", itemId: "answer" };
const skill: CodexComposerSkill = {
  name: "review",
  displayName: "Review code",
  description: "Review a change",
  iconUrl: null,
  brandColor: null,
  path: "/skills/review/SKILL.md",
  scope: "user",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function fixture(
  content: string,
  hostId = "local",
  family: "ordinary" | "inline" | "voice" = "ordinary",
  options?: {
    readonly threadId?: string;
    readonly onOpenThread?: ThreadStageActions["onOpenThread"];
    readonly projectId?: string | null;
    readonly onStartNewChatWithPrompt?: ThreadStageActions["onStartNewChatWithPrompt"];
    readonly streaming?: boolean;
  },
) {
  const threadId = options?.threadId ?? key.threadId;
  const item: Extract<ThreadItem, { type: "agentMessage" }> = {
    type: "agentMessage",
    id: key.itemId,
    text: family === "inline" ? `::codex-realtime-inline{}\n${content}` : content,
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  const native = timelineOwnerFixture(
    {
      data:
        family === "ordinary"
          ? []
          : [
              {
                type: "realtime",
                position: 1,
                item:
                  family === "inline"
                    ? {
                        type: "bemItemPromoted",
                        id: "promotion",
                        realtimeSessionId: "session",
                        turnId: "one",
                        itemId: "answer",
                        presentation: { type: "inlineMarkdown" },
                      }
                    : {
                        type: "transcriptSegment",
                        id: "voice",
                        realtimeSessionId: "session",
                        role: "assistant",
                        text: content,
                      },
              },
            ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
    },
    [item],
  );
  const owner =
    hostId === "local" && threadId === key.threadId
      ? native.owner
      : new CodexTranscriptReadOwner({ hostId, threadId });
  if (owner !== native.owner)
    owner.applyEvent({ type: "reset", value: projectCodexTranscript(native.state) });
  if (options?.streaming) {
    const details = owner.readTurnDetails(key.entityKey)!;
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key: { hostId, threadId, entityKey: key.entityKey },
          details: {
            ...details,
            status: "inProgress",
            lifecycleStatusByItemId: { [key.itemId]: "inProgress" },
          },
          hasSubagentActivity: false,
        },
      ],
    });
    const realtime = owner.readRealtimeItem("voice");
    if (realtime)
      owner.applyEvent({
        type: "changes",
        changes: [
          { type: "realtime-item", itemId: "voice", value: { ...realtime, completed: false } },
        ],
      });
  }
  const release = owner.subscribeStructure(() => {});
  const turn = owner.readTurn(key.entityKey)!;
  const model = buildTurnRenderModel({
    turn,
    requests: [],
    isLatestTurn: true,
    isStreamingTurn: options?.streaming ?? false,
  });
  const block = model.trailingBlocks.find((value) => value.type === "assistantMessage")!;
  const entry = native
    .project()
    .entries.find((candidate) =>
      family === "inline"
        ? isCodexTimelineTurnEntry(candidate) &&
          candidate.timelinePresentation?.type === "inlineMarkdown"
        : isCodexRealtimeTimelineEntry(candidate),
    );
  const nativeLeaf =
    family === "ordinary" ? (
      <ThreadBlockRenderer
        block={block}
        hostId={hostId}
        isLatestTurn
        isStreamingTurn={options?.streaming ?? false}
      />
    ) : entry && isCodexTimelineTurnEntry(entry) ? (
      <LocalConversationTimelinePromotion entry={entry} cwd="/source" />
    ) : entry && isCodexRealtimeTimelineEntry(entry) ? (
      <LocalConversationRealtimeItem entry={entry} conversationId="thread" cwd="/source" />
    ) : null;
  let registry: CodexAppServerManagerRegistry | null = null;
  const opened = vi.fn<FileReferenceRouterPort["openWorkspaceFileTab"]>(async () => true);
  const onOpenThread = vi.fn<ThreadStageActions["onOpenThread"]>(options?.onOpenThread);
  function Capture() {
    const value = useCodexAppServerRegistry();
    useLayoutEffect(() => {
      registry = value;
    }, [value]);
    return null;
  }
  const connect = (generation = 1, status: "connected" | "disconnected" = "connected") =>
    dispatchCodexAppServerMessage("shared-object-updated", {
      hostId,
      object: {
        objectType: "connection",
        objectId: "connection",
        value: {
          status,
          retries: 0,
          native: { sourceEpoch: "source", generation, transportKind: "stdio" },
        },
      },
    });
  const rows = (
    skills?: readonly CodexComposerSkill[],
    direct?: ReactNode,
    openThread: ThreadStageActions["onOpenThread"] = onOpenThread,
  ) => (
    <StrictMode>
      <Capture />
      <NodexTooltipProvider>
        <FileReferenceRouterProvider
          openWorkspaceFileTab={opened}
          workspaceRoot="/foreign-active-root"
        >
          <CodexTranscriptReadOwnerContext value={owner}>
            <ConversationMarkdownSourceProvider
              hostId={hostId}
              threadId={threadId}
              cwd="/source"
              workspaceRoot="/source-root"
              projectId={options?.projectId ?? null}
              onOpenThread={openThread}
              onStartNewChatWithPrompt={options?.onStartNewChatWithPrompt}
              skills={skills}
            >
              <CodexTranscriptTurnEntityContext value={key.entityKey}>
                {direct ?? nativeLeaf}
              </CodexTranscriptTurnEntityContext>
            </ConversationMarkdownSourceProvider>
          </CodexTranscriptReadOwnerContext>
        </FileReferenceRouterProvider>
      </NodexTooltipProvider>
    </StrictMode>
  );
  const mount = (skills?: readonly CodexComposerSkill[], direct?: ReactNode) =>
    render(rows(skills, direct), { wrapper: LocalConversationTestQueryProvider });
  return {
    owner,
    item,
    opened,
    onOpenThread,
    rows,
    mount,
    connect,
    project: native.project,
    dispose: () => {
      release();
      registry?.deleteManager(hostId);
    },
  };
}

export { fixture, key, skill, deferred };
