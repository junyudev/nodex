import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { createPromptTurnStore, usePromptTurn } from "./prompt-turn";
import type { PromptTurnEntry } from "../../shared/prompt-turn";

it("updates one anchored Prompt without turning an earlier completed Prompt back into working", async () => {
  let entries: readonly PromptTurnEntry[] = [
    { messageId: "first", phase: "done", runId: "old", reply: "Reply" },
  ];
  const subscribe = vi.fn(async () => () => {});
  const store = createPromptTurnStore({ read: async () => entries, subscribe });
  const view = renderHook(
    ({ messageId }) => usePromptTurn({ sessionId: "chat", messageId }, store),
    { initialProps: { messageId: "first" } },
  );
  await waitFor(() => expect(view.result.current).toMatchObject({ phase: "done", reply: "Reply" }));
  expect(subscribe).toHaveBeenCalledTimes(1);
  entries = [{ messageId: "second", phase: "working", runId: "new", reply: null }];
  await act(async () => {
    view.rerender({ messageId: "second" });
    await Promise.resolve();
  });
  await waitFor(() => expect(view.result.current.phase).toBe("working"));
  view.unmount();
});
