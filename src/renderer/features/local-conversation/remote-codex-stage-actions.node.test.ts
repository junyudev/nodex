import { expect, it, vi } from "vite-plus/test";
import { createRemoteCodexStageActions } from "./remote-codex-stage-actions";

type RemoteActionsInput = Parameters<typeof createRemoteCodexStageActions>[0];

function sideChatFixture() {
  const startTurn = vi.fn<RemoteActionsInput["control"]["startTurn"]>(async () => undefined);
  const sendQueuedFollowUpNow = vi.fn<RemoteActionsInput["control"]["sendQueuedFollowUpNow"]>(
    async () => null,
  );
  const readConversationTurnCount = vi.fn(() => 0);
  const onSideChatTitle = vi.fn();
  const actions = createRemoteCodexStageActions({
    hostId: "ssh:owned",
    threadId: "remote-thread",
    projectId: "project",
    control: { startTurn, sendQueuedFollowUpNow, readConversationTurnCount },
    host: { onQueueingEnabledChange: vi.fn(), onOpenThread: vi.fn() },
    onSideChatTitle,
  } as unknown as RemoteActionsInput);
  return { actions, startTurn, sendQueuedFollowUpNow, readConversationTurnCount, onSideChatTitle };
}

it("keeps remote submissions and queue edits on the attached native owner", async () => {
  const startTurn = vi.fn().mockResolvedValue(undefined);
  const removeQueuedFollowUp = vi.fn().mockResolvedValue(undefined);
  const input = {
    hostId: "ssh:owned",
    threadId: "remote-thread",
    projectId: "project",
    control: { startTurn, removeQueuedFollowUp },
    host: { onQueueingEnabledChange: vi.fn(), onOpenThread: vi.fn() },
  } as unknown as Parameters<typeof createRemoteCodexStageActions>[0];
  expect(() => createRemoteCodexStageActions({ ...input, hostId: "local" })).toThrow(
    "attached remote owner",
  );
  const actions = createRemoteCodexStageActions(input);
  await actions.onSendPrompt("Continue", { promptInput: { text: "Exact input" } });
  expect(startTurn).toHaveBeenCalledWith(
    "remote-thread",
    "Continue",
    { projectId: "project", promptInput: { text: "Exact input" } },
    undefined,
  );
  await actions.onRemoveQueuedFollowUp("remote-thread", "queued-message");
  await expect(actions.onRemoveQueuedFollowUp("foreign-thread", "queued-message")).rejects.toThrow(
    "identity changed",
  );
  expect(removeQueuedFollowUp).toHaveBeenCalledExactlyOnceWith("remote-thread", "queued-message");
});

it("names a remote side chat only after its first send succeeds, using the submitted request", async () => {
  const f = sideChatFixture();
  let accept!: () => void;
  f.startTurn.mockReturnValueOnce(new Promise<void>((resolve) => (accept = resolve)));
  const sent = f.actions.onSendPrompt("Display text", {
    promptInput: { text: "Context\n## My request:\n**Inspect** [this](https://example.com)" },
  });
  expect(f.onSideChatTitle).not.toHaveBeenCalled();
  accept();
  await sent;
  expect(f.onSideChatTitle).toHaveBeenCalledExactlyOnceWith("Inspect this");
  f.readConversationTurnCount.mockReturnValue(1);
  await f.actions.onSendPrompt("Later request");
  expect(f.onSideChatTitle).toHaveBeenCalledOnce();
});

it("keeps a remote side title on rejection or empty text and excludes Agent configuration", async () => {
  const f = sideChatFixture();
  f.startTurn.mockRejectedValueOnce(new Error("Send refused"));
  await expect(f.actions.onSendPrompt("Unsent title")).rejects.toThrow("Send refused");
  await f.actions.onSendPrompt("<!-- invisible -->");
  expect(f.onSideChatTitle).not.toHaveBeenCalled();
  await f.actions.onSendPrompt(':agent-config{mode="plan"}\n**Review** the request');
  expect(f.onSideChatTitle).toHaveBeenCalledExactlyOnceWith("Review the request");
});

it("names a queued first side message only when Send now confirms delivery", async () => {
  const f = sideChatFixture();
  await f.actions.onSendQueuedFollowUpNow("remote-thread", "queued");
  expect(f.onSideChatTitle).not.toHaveBeenCalled();
  f.sendQueuedFollowUpNow.mockResolvedValueOnce({
    prompt: "**First** queued request",
    startsConversation: true,
  });
  await f.actions.onSendQueuedFollowUpNow("remote-thread", "queued");
  expect(f.onSideChatTitle).toHaveBeenCalledExactlyOnceWith("First queued request");
  f.sendQueuedFollowUpNow.mockResolvedValueOnce({
    prompt: "A later queued message",
    startsConversation: false,
  });
  await f.actions.onSendQueuedFollowUpNow("remote-thread", "later");
  expect(f.onSideChatTitle).toHaveBeenCalledOnce();
  await expect(f.actions.onSendQueuedFollowUpNow("foreign-thread", "queued")).rejects.toThrow(
    "identity changed",
  );
  expect(f.sendQueuedFollowUpNow).toHaveBeenCalledTimes(3);
});

it("does not publish a queued title after failure or an empty accepted request", async () => {
  const f = sideChatFixture();
  f.sendQueuedFollowUpNow.mockRejectedValueOnce(new Error("Still pending"));
  await expect(f.actions.onSendQueuedFollowUpNow("remote-thread", "queued")).rejects.toThrow(
    "Still pending",
  );
  f.sendQueuedFollowUpNow.mockResolvedValueOnce({ prompt: " ", startsConversation: true });
  await f.actions.onSendQueuedFollowUpNow("remote-thread", "queued");
  expect(f.onSideChatTitle).not.toHaveBeenCalled();
});

it("stops the named remote background terminals, or cleans them all", async () => {
  const terminateBackgroundTerminal = vi.fn().mockResolvedValue(true);
  const cleanBackgroundTerminals = vi.fn().mockResolvedValue(true);
  const actions = createRemoteCodexStageActions({
    hostId: "ssh:owned",
    threadId: "remote-thread",
    projectId: null,
    control: { terminateBackgroundTerminal, cleanBackgroundTerminals },
    host: { onQueueingEnabledChange: vi.fn(), onOpenThread: vi.fn() },
  } as unknown as RemoteActionsInput);
  await actions.onStopBackgroundTerminals("remote-thread", ["41", "42"]);
  expect(terminateBackgroundTerminal.mock.calls).toEqual([
    [{ threadId: "remote-thread", processId: "41" }],
    [{ threadId: "remote-thread", processId: "42" }],
  ]);
  expect(cleanBackgroundTerminals).not.toHaveBeenCalled();
  await actions.onStopBackgroundTerminals("remote-thread");
  expect(cleanBackgroundTerminals).toHaveBeenCalledExactlyOnceWith("remote-thread");
  await expect(actions.onStopBackgroundTerminals("foreign-thread")).rejects.toThrow(
    "identity changed",
  );
});
