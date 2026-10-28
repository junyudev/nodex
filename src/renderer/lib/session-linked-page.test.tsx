import { act, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { render } from "../test/dom";
import {
  useSessionLinkedPage,
  type SessionLinkedPage,
  type SessionLinkedPageStore,
} from "./session-linked-page";

test("works without a Query provider, skips null IDs, and observes an injected keyed store", async () => {
  let value: SessionLinkedPage | null = null;
  const listeners = new Set<() => void>();
  const subscribeSession = vi.fn((_sessionId: string, listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const read = vi.fn(() => value);
  const store: SessionLinkedPageStore = { read, subscribeSession };
  function Row({ sessionId }: { sessionId: string | null }) {
    const page = useSessionLinkedPage(sessionId, store);
    return <span>{page?.status?.label ?? "No Page"}</span>;
  }
  const view = render(<Row sessionId={null} />);
  expect(subscribeSession).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  view.rerender(<Row sessionId="session:a" />);
  expect(subscribeSession).toHaveBeenCalledWith("session:a", expect.any(Function));
  await act(async () => {
    value = {
      pageId: "page:a",
      pageKey: null,
      title: "A",
      status: { optionId: "build", label: "In progress" },
    };
    for (const listener of listeners) listener();
    await Promise.resolve();
  });
  await waitFor(() => expect(view.getByText("In progress")).toBeTruthy());
  view.rerender(<Row sessionId={null} />);
  expect(listeners.size).toBe(0);
});
