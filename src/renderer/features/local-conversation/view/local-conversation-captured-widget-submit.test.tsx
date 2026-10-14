import { act, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { renderWithMaitai } from "@/test/thread-maitai";
import { buildComposerActions } from "@/test/composer-actions-fixture";
import { buildComposerShellFixture } from "@/test/composer-shell-fixture";
import type { ThreadBodySurfaceModel } from "../thread-stage-types";
import {
  useInlineVisualizationAnnotationSubmitHandler,
  useInlineVisualizationFollowUpHandler,
} from "@/lib/inline-visualization/inline-visualization-follow-up-context";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import { LocalConversationThreadBody } from "./local-conversation-thread-body";

function WidgetControls() {
  const annotations = useInlineVisualizationAnnotationSubmitHandler();
  const followup = useInlineVisualizationFollowUpHandler();
  return (
    <>
      <button
        onClick={() => {
          void annotations?.({
            sourceId: "widget",
            title: "Chart",
            prompt: "Change it",
            context: { edits: [], selectedVariants: [{ carousel: 0, variant: "one" }] },
          });
        }}
      >
        Send changes
      </button>
      <button
        onClick={() => {
          void followup?.({ sourceId: "widget", prompt: "Continue", context: { key: "value" } });
        }}
      >
        Widget follow-up
      </button>
    </>
  );
}
vi.mock("./local-conversation-thread-body-owner", () => ({
  LocalConversationThreadBodyOwner: WidgetControls,
}));

function model(running: boolean): ThreadBodySurfaceModel {
  const base = buildComposerShellFixture();
  return {
    projectId: "source-project",
    hostId: "remote",
    threadId: "source-thread",
    isSideChat: false,
    cwd: "/source",
    turns: [],
    requests: [],
    resumeState: "resumed",
    statusType: running ? "active" : "idle",
    capabilityFlags: {
      canEditLastUserTurn: false,
      canForkFromTurn: false,
      canSearch: false,
      canCollapseTurns: false,
    },
    body: { ...base.body, threadId: "source-thread", isThreadRunning: running },
    parentTurns: [],
    childMemberships: [],
    threadStartProgress: null,
    searchOpenTick: 0,
  };
}

describe("transcript widget submission owners", () => {
  test.each([false, true])(
    "routes host-captured adjustments separately from guest follow-ups: running=%s",
    async (running) => {
      const captured = vi.fn(async () => {});
      const queued = vi.fn(async () => {});
      const send = vi.fn(async () => {});
      const actions = buildComposerActions({
        onSendCapturedFollowUp: captured,
        onEnqueueQueuedFollowUp: queued,
        onSendPrompt: send,
      });
      const view = renderWithMaitai(
        <LocalConversationThreadBody
          model={model(running)}
          actions={actions}
          onErrorMessage={() => {}}
        />,
        { wrapper: LocalConversationTestQueryProvider },
      );
      try {
        await act(async () => {
          fireEvent.click(view.getByRole("button", { name: "Send changes" }));
          await Promise.resolve();
        });
        expect(captured).toHaveBeenCalledExactlyOnceWith("source-thread", "Change it", {
          promptInput: {
            text: "Change it",
            mcpAppModelContextAttachments: [
              {
                id: "widget",
                kind: "context",
                sourceName: "Chart",
                text: null,
                structuredContent: {
                  edits: [],
                  selectedVariants: [{ carousel: 0, variant: "one" }],
                },
                imageAttachments: [],
                untrusted: true,
              },
            ],
          },
        });
        expect(queued).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        await act(async () => {
          fireEvent.click(view.getByRole("button", { name: "Widget follow-up" }));
          await Promise.resolve();
        });
        const options = {
          untrustedAppMessage: {
            source: "visualization",
            sourceId: "widget",
            text: "Continue",
            structuredContent: { key: "value" },
          },
        };
        if (running)
          expect(queued).toHaveBeenCalledExactlyOnceWith("source-thread", "Continue", options);
        else expect(send).toHaveBeenCalledExactlyOnceWith("Continue", options);
        expect(captured).toHaveBeenCalledOnce();
      } finally {
        view.unmount();
      }
    },
  );
});
