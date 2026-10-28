import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import { render, settleAsyncRender, textContent } from "../../../test/dom";
import type { ThreadTranscriptBlockModel } from "../thread-stage-types";
import {
  LocalConversationAboveComposerPortal,
  LocalConversationAboveComposerPortalHost,
} from "./local-conversation-above-composer-portal";
import {
  buildAboveComposerTodoListBlock as buildTodoListBlock,
  buildAboveComposerTurnDiffBlock as buildTurnDiffBlock,
} from "./local-conversation-above-composer-portal.test-fixtures";

const buildTurnDiffModelCall = vi.hoisted(() => vi.fn());

vi.mock("./shared/turn-diff-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared/turn-diff-model")>();
  return {
    ...actual,
    buildTurnDiffModel: (...args: Parameters<typeof actual.buildTurnDiffModel>) => {
      buildTurnDiffModelCall();
      return actual.buildTurnDiffModel(...args);
    },
  };
});

describe("LocalConversationAboveComposerPortal", () => {
  beforeEach(() => {
    buildTurnDiffModelCall.mockClear();
  });

  test("renders streaming turn diffs through the fixed-content portal shell", async () => {
    let openedTurnId = "";
    const { container } = render(
      <TooltipProvider>
        <LocalConversationAboveComposerPortalHost conversationId="thread-portal" />
        <LocalConversationAboveComposerPortal
          blocks={[buildTurnDiffBlock()]}
          isLatestTurn={true}
          isStreamingTurn={true}
          threadCwd="/tmp/project"
          onOpenTurnDiffReview={(target) => {
            openedTurnId =
              target.source.kind === "selected-turn"
                ? target.source.turnId
                : target.source.kind === "last-turn"
                  ? target.source.threadId
                  : target.source.kind;
          }}
        />
      </TooltipProvider>,
    );

    await settleAsyncRender();

    const host = container.querySelector("[data-above-composer-portal]");
    expect(host?.textContent?.includes("1 file changed") ?? false).toBe(true);
    expect(host?.querySelector('[codex\\.turn_diff\\.state="in_progress"]') !== null).toBe(true);
    expect(host?.querySelector("[data-above-composer-fixed-spacer]") !== null).toBe(true);
    expect(host?.querySelector("[data-above-composer-fixed-content]") !== null).toBe(true);
    expect(host?.querySelector("[data-above-composer-fixed-fade]") !== null).toBe(true);
    expect(host?.querySelector("[data-above-composer-fixed-pill]") !== null).toBe(true);
    expect(textContent(container).includes("1 file changed")).toBe(true);

    const reviewButton = host?.querySelector<HTMLButtonElement>(
      'button[aria-label="Review changed files"]',
    );
    expect(reviewButton !== null).toBe(true);
    fireEvent.click(reviewButton as HTMLButtonElement);
    expect(openedTurnId).toBe("thread-portal");
    expect(buildTurnDiffModelCall).toHaveBeenCalledTimes(1);
  });

  test("does not render fixed-content chrome for an empty portal", async () => {
    const { container } = render(
      <TooltipProvider>
        <LocalConversationAboveComposerPortalHost conversationId="thread-portal" />
        <LocalConversationAboveComposerPortal
          blocks={[]}
          isLatestTurn={true}
          isStreamingTurn={true}
          threadCwd="/tmp/project"
        />
      </TooltipProvider>,
    );

    await settleAsyncRender();

    expect(container.querySelector("[data-above-composer-fixed-content]") === null).toBe(true);
  });

  test("renders no spacer or chrome for empty todo state", async () => {
    const todo = buildTodoListBlock();
    const emptyTodo: ThreadTranscriptBlockModel = {
      ...todo,
      entry: {
        ...todo.entry,
        markdownText: "",
        rawItem: { plan: [] },
      },
    };
    const { container } = render(
      <TooltipProvider>
        <LocalConversationAboveComposerPortalHost conversationId="thread-portal" />
        <LocalConversationAboveComposerPortal
          blocks={[emptyTodo]}
          isLatestTurn={true}
          isStreamingTurn={true}
          threadCwd="/tmp/project"
        />
      </TooltipProvider>,
    );

    await settleAsyncRender();

    expect(container.querySelector("[data-above-composer-fixed-spacer]") === null).toBe(true);
    expect(container.querySelector("[data-above-composer-fixed-content]") === null).toBe(true);
    expect(container.querySelector("[data-above-composer-fixed-pill]") === null).toBe(true);
  });

  test("does not let a non-latest turn mount fixed content", async () => {
    const { container } = render(
      <TooltipProvider>
        <LocalConversationAboveComposerPortalHost conversationId="thread-portal" />
        <LocalConversationAboveComposerPortal
          blocks={[buildTodoListBlock(), buildTurnDiffBlock()]}
          isLatestTurn={false}
          isStreamingTurn={true}
          threadCwd="/tmp/project"
        />
      </TooltipProvider>,
    );

    await settleAsyncRender();

    expect(container.querySelector("[data-above-composer-fixed-spacer]") === null).toBe(true);
    expect(container.querySelector("[data-above-composer-fixed-content]") === null).toBe(true);
  });

  test("renders todo progress and turn diff in one fixed-content pill", async () => {
    const { container } = render(
      <TooltipProvider>
        <LocalConversationAboveComposerPortalHost conversationId="thread-portal" />
        <LocalConversationAboveComposerPortal
          blocks={[buildTodoListBlock(), buildTurnDiffBlock()]}
          isLatestTurn={true}
          isStreamingTurn={true}
          threadCwd="/tmp/project"
        />
      </TooltipProvider>,
    );

    await settleAsyncRender();

    const host = container.querySelector("[data-above-composer-portal]");
    const content = host?.textContent ?? "";
    const todoIndex = content.indexOf("Step 2 / 3");
    const diffIndex = content.indexOf("1 file changed");

    expect(host?.querySelectorAll("[data-above-composer-fixed-pill]").length ?? 0).toBe(1);
    expect(todoIndex >= 0).toBe(true);
    expect(diffIndex >= 0).toBe(true);
    expect(todoIndex < diffIndex).toBe(true);
    expect(content.includes("·")).toBe(true);
  });
});
