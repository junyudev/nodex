import { act, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { ConversationMath } from "./conversation-token-leaves";

const download = vi.hoisted(() => {
  let release: (() => void) | null = null;
  return {
    pending: new Promise<void>((resolve) => {
      release = resolve;
    }),
    fail: () => release?.(),
  };
});
vi.mock("katex", async () => {
  await download.pending;
  throw new Error("math module unavailable");
});
const token = { type: "math", raw: "\\(source\\)", text: "source", display: false } as const;

test("a failed math download falls back to TeX and cannot update a retired consumer", async () => {
  const retired = render(<ConversationMath token={token} streaming />);
  expect(retired.container.textContent).toBe("");
  retired.unmount();
  const current = render(<ConversationMath token={token} streaming={false} />);
  try {
    expect(current.container.textContent).toBe(token.raw);
    await act(async () => {
      download.fail();
      await Promise.resolve();
    });
    await waitFor(() => expect(current.container.textContent).toBe(token.text));
    current.rerender(<ConversationMath token={token} streaming />);
    expect(current.container.textContent).toBe(token.text);
    expect(
      current.container.querySelector("[data-math-source]")?.getAttribute("data-math-source"),
    ).toBe(token.text);
  } finally {
    current.unmount();
  }
});
