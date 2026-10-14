import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "@/test/browser-globals";
import type { ThreadStageActions } from "../thread-stage-types";
import { fixture, key } from "./conversation-markdown-targets.test-fixtures";

const prompt = "\nReview **raw** work\n\nKeep @src/a%20b.ts and `code`";
const authored = `:::task-stub{title="Review work"}${prompt}\n:::`;

describe("native task suggestion drafts", () => {
  test.each(
    (["ordinary", "inline", "voice"] as const).flatMap((family) =>
      [false, true].map((streaming) => ({ family, streaming })),
    ),
  )(
    "$family uses the captured project and exact raw prompt without submitting: streaming=$streaming",
    async ({ family, streaming }) => {
      const invoke = vi.fn(async (_channel: string) => {
        throw new Error("Unsupported fixture request");
      });
      installWindowApi({ invoke, on: () => () => {} });
      const prefill = vi.fn<NonNullable<ThreadStageActions["onStartNewChatWithPrompt"]>>(
        async () => {},
      );
      const source = fixture(authored, "remote", family, {
        projectId: "source-project",
        onStartNewChatWithPrompt: prefill,
        streaming,
      });
      const readTurn = vi.spyOn(source.owner, "readTurn");
      const view = source.mount([]);
      try {
        await act(async () => {
          source.connect();
          await Promise.resolve();
        });
        const use = await view.findByRole("button", { name: "Use suggestion" });
        readTurn.mockClear();
        await act(async () => {
          fireEvent.click(use);
          await Promise.resolve();
        });
        expect(prefill).toHaveBeenCalledOnce();
        const input = prefill.mock.calls[0]![0];
        expect(input.projectId).toBe("source-project");
        expect(input.prompt).toBe(prompt);
        expect(input.isSourceCurrent?.()).toBe(true);
        expect(readTurn).not.toHaveBeenCalled();
        expect(
          invoke.mock.calls.filter(([channel]) => /start|enqueue|steer/.test(String(channel))),
        ).toEqual([]);
        await act(async () => {
          source.owner.applyEvent({ type: "reset", value: null });
          await Promise.resolve();
        });
        expect(input.isSourceCurrent?.()).toBe(false);
        await act(async () => {
          fireEvent.click(use);
          await Promise.resolve();
        });
        expect(prefill).toHaveBeenCalledOnce();
      } finally {
        view.unmount();
        source.dispose();
      }
    },
  );

  test("projectless and empty prompt retain their authored meaning", async () => {
    installWindowApi({
      invoke: async () => {
        throw new Error("Unsupported fixture request");
      },
      on: () => () => {},
    });
    const prefill = vi.fn<NonNullable<ThreadStageActions["onStartNewChatWithPrompt"]>>(
      async () => {},
    );
    const source = fixture("::task-stub{}", "local", "ordinary", {
      projectId: null,
      onStartNewChatWithPrompt: prefill,
    });
    const view = source.mount([]);
    try {
      await act(async () => {
        source.connect();
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(await view.findByRole("button", { name: "Use suggestion" }));
        await Promise.resolve();
      });
      expect(prefill.mock.calls[0]?.[0]).toMatchObject({ projectId: null, prompt: "" });
    } finally {
      view.unmount();
      source.dispose();
    }
  });

  test("a replaced native connection retires an already mounted suggestion", async () => {
    installWindowApi({
      invoke: async () => {
        throw new Error("Unsupported fixture request");
      },
      on: () => () => {},
    });
    const prefill = vi.fn<NonNullable<ThreadStageActions["onStartNewChatWithPrompt"]>>(
      async () => {},
    );
    const source = fixture(authored, "remote", "inline", {
      projectId: "alpha",
      onStartNewChatWithPrompt: prefill,
    });
    const view = source.mount([]);
    try {
      await act(async () => {
        source.connect();
        await Promise.resolve();
      });
      const use = await view.findByRole("button", { name: "Use suggestion" });
      await act(async () => {
        fireEvent.click(use);
        await Promise.resolve();
      });
      const captured = prefill.mock.calls[0]![0];
      await act(async () => {
        source.connect(2);
        await Promise.resolve();
      });
      expect(captured.isSourceCurrent?.()).toBe(false);
      await act(async () => {
        fireEvent.click(use);
        await Promise.resolve();
      });
      expect(prefill).toHaveBeenCalledTimes(2);
      expect(prefill.mock.calls[1]![0].isSourceCurrent?.()).toBe(true);
      expect(source.owner.readItem(key.entityKey, key.itemId)).not.toBeNull();
      await waitFor(() => expect(use.isConnected).toBe(true));
    } finally {
      view.unmount();
      source.dispose();
    }
  });

  test("removing only the suggestion retires its captured action while the native item remains", async () => {
    installWindowApi({
      invoke: async () => {
        throw new Error("Unsupported fixture request");
      },
      on: () => () => {},
    });
    const prefill = vi.fn<NonNullable<ThreadStageActions["onStartNewChatWithPrompt"]>>(
      async () => {},
    );
    const source = fixture(authored, "local", "inline", {
      projectId: "alpha",
      onStartNewChatWithPrompt: prefill,
    });
    const view = source.mount([]);
    try {
      await act(async () => {
        source.connect();
        await Promise.resolve();
      });
      const use = await view.findByRole("button", { name: "Use suggestion" });
      await act(async () => {
        fireEvent.click(use);
        await Promise.resolve();
      });
      const captured = prefill.mock.calls[0]![0];
      view.rerender(source.rows([], <span>Replacement</span>));
      expect(source.owner.readItem(key.entityKey, key.itemId)).not.toBeNull();
      expect(captured.isSourceCurrent?.()).toBe(false);
      await act(async () => {
        fireEvent.click(use);
        await Promise.resolve();
      });
      expect(prefill).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      source.dispose();
    }
  });
});
