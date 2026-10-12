import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { waitFor } from "@testing-library/react";
import { CodexTranscriptReadService } from "../../../../shared/codex-transcript-read-service";
import {
  createCodexTranscriptSubscription,
  type CodexTranscriptSubscription,
} from "../../../../shared/codex-transcript-subscription";
import type {
  CodexTranscriptEvent,
  CodexTranscriptUpdate,
} from "../../../../shared/codex-transcript-projection";
import { connectLocalTranscript } from "./local-transcript-connection";

afterEach(() => vi.unstubAllGlobals());

it("awaits each RPC callback and retires its source when the read capability closes", async () => {
  vi.stubGlobal("MessageChannel", MessageChannel);
  const events: CodexTranscriptEvent[] = [];
  let receive!: (update: CodexTranscriptUpdate) => void;
  let subscription!: CodexTranscriptSubscription;
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const released = vi.fn();
  const service = new CodexTranscriptReadService((threadId, listener) => {
    expect(threadId).toBe("thread");
    subscription = createCodexTranscriptSubscription({
      getSnapshot: () => null,
      subscribe: (next) => {
        receive = next;
        receive({ type: "reset", value: null });
        return released;
      },
      listener,
    });
    return subscription;
  });
  const disconnect = connectLocalTranscript(service, "thread", async (event) => {
    events.push(event);
    if (events.length === 1) await blocked;
  });
  try {
    await waitFor(() => expect(events).toHaveLength(1));
    receive({ type: "changes", changes: [] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toHaveLength(1);
    unblock();
    await waitFor(() => expect(events).toHaveLength(2));
    disconnect();
    await waitFor(() => expect(released).toHaveBeenCalledOnce());
    await subscription.completion;
  } finally {
    unblock();
    subscription?.dispose();
    disconnect();
  }
});
