import { act, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender } from "@/test/dom";
import type { ProjectSessionStart } from "../../../shared/types";
import { SessionStartNotice } from "./session-start-notice";

const mocks = vi.hoisted(() => ({ retry: vi.fn() }));
vi.mock("@/lib/inbox-runtime", () => ({ retryInboxDispatch: mocks.retry }));

const failed: ProjectSessionStart = {
  proposalId: "proposal",
  pageId: "message",
  state: "failed",
  failureMessage: "The host has no Agent for this chat.",
  retryable: true,
};
const show = (start: ProjectSessionStart) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionStartNotice sessionId="chat" start={start} />
    </QueryClientProvider>,
  );

describe("a chat its Inbox decision could not start", () => {
  beforeEach(() => mocks.retry.mockReset());

  test("says why, and sends the decision again from the chat", async () => {
    mocks.retry.mockResolvedValue({ ok: true });
    show(failed);
    expect(screen.getByText("This chat couldn’t start")).toBeTruthy();
    expect(screen.getByText("The host has no Agent for this chat.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await settleAsyncRender();
    });
    expect(mocks.retry).toHaveBeenCalledWith({ proposalId: "proposal" });
  });

  test("leaves a decision Core would not send again to the Inbox", async () => {
    show({ ...failed, failureMessage: "The Agent refused this chat.", retryable: false });
    await act(settleAsyncRender);
    expect(
      screen.getByText(
        "The Agent refused this chat. Review its message in the Inbox to decide again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
