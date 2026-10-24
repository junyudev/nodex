import { describe, expect, it, vi } from "vite-plus/test";
import type {
  NativeConversationImportInput,
  NativeConversationImportOutcome,
} from "../../shared/native-session-catalog";
import {
  createNativeConversationImportLedger,
  nativeConversationImportedCopy,
} from "./native-conversation-import-ledger";
import {
  nativeConversationCandidate,
  nativeConversationImportSelection,
  type NativeConversationCandidate,
} from "./native-conversation-import-model";

const source = (observedAt: number, imported?: { thread: string; session: string }) =>
  nativeConversationCandidate(
    { backendKind: "codex" },
    "/codex",
    {
      nativeSessionId: "0199a7c4-5b7e-7d10-9a3e-2f4b6c8d0e12",
      title: "Migrate billing",
      cwd: "/repo",
      updatedAt: 1,
      ...(imported
        ? { importedThreadId: imported.thread, importedSessionId: imported.session }
        : {}),
    },
    observedAt,
  );
const selection = (candidate: NativeConversationCandidate, projectId: string | null = null) =>
  nativeConversationImportSelection(candidate, projectId, "/repo");
const imported = (input: NativeConversationImportInput): NativeConversationImportOutcome => ({
  kind: "imported",
  sessionId: input.requestId,
  threadId: `thread-${input.requestId}`,
  projectId: input.projectId,
});
const deferred = () => {
  let resolve!: (outcome: NativeConversationImportOutcome) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<NativeConversationImportOutcome>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe("NativeConversationImportLedger", () => {
  it("lets only one submission per source be in flight, whoever asks", async () => {
    const ledger = createNativeConversationImportLedger();
    const reply = deferred();
    const send = vi.fn(() => reply.promise);
    const candidate = source(ledger.now());
    const first = ledger.submit(candidate, selection(candidate), send);
    // A second page, mounted later with other controls, joins the same submission.
    const second = ledger.submit(source(ledger.now()), selection(candidate, "project"), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot().get(candidate.key)?.status).toBe("sending");

    reply.resolve({
      kind: "not_admitted",
      message: "This folder is no longer available. Refresh and choose another one.",
    });
    expect(await first).toEqual({
      kind: "not_admitted",
      message: "This folder is no longer available. Refresh and choose another one.",
    });
    expect(await second).toBe(await first);
    expect(ledger.snapshot().has(candidate.key)).toBe(false);
  });

  it("finishes an unknown outcome only with its own request and keeps its conversation", async () => {
    const ledger = createNativeConversationImportLedger();
    const send = vi
      .fn<(input: NativeConversationImportInput) => Promise<NativeConversationImportOutcome>>()
      .mockRejectedValueOnce(new Error("Agent Runtime is restarting."))
      .mockImplementation(async (input) => imported(input));
    const candidate = source(ledger.now());
    expect(await ledger.submit(candidate, selection(candidate), send)).toEqual({
      kind: "unsettled",
      message: "Agent Runtime is restarting.",
    });
    const unsettled = ledger.snapshot().get(candidate.key);
    expect(unsettled).toMatchObject({ status: "unsettled", candidate });

    const changed = { ...source(ledger.now()), title: "Renamed elsewhere" };
    const settlement = await ledger.submit(changed, selection(changed, "project"), send);
    const [first, retry] = send.mock.calls.map(([input]) => input);
    expect(retry).toBe(first);
    expect(settlement).toEqual({
      kind: "imported",
      copy: { threadId: `thread-${first!.requestId}`, sessionId: first!.requestId },
    });
    expect(ledger.snapshot().get(candidate.key)).toMatchObject({ status: "imported", candidate });
  });

  it("starts a new request only after the previous one was not admitted", async () => {
    const ledger = createNativeConversationImportLedger();
    const send = vi
      .fn<(input: NativeConversationImportInput) => Promise<NativeConversationImportOutcome>>()
      .mockResolvedValueOnce({
        kind: "not_admitted",
        message:
          "This Claude Code profile is no longer available. Turn it on in Agent settings, then refresh.",
      })
      .mockImplementation(async (input) => imported(input));
    const candidate = source(ledger.now());
    await ledger.submit(candidate, selection(candidate), send);
    await ledger.submit(candidate, selection(candidate, "project"), send);
    const [rejected, fresh] = send.mock.calls.map(([input]) => input);
    expect(fresh!.requestId).not.toBe(rejected!.requestId);
    expect(fresh!.projectId).toBe("project");
  });

  it("protects a copy from reads sent before it settled, but not from later reads", async () => {
    const ledger = createNativeConversationImportLedger();
    const send = vi.fn(async (input: NativeConversationImportInput) => imported(input));
    const staleRead = source(ledger.now());
    const settlement = await ledger.submit(staleRead, selection(staleRead), send);
    expect(settlement.kind).toBe("imported");
    const entry = ledger.snapshot().get(staleRead.key);

    // A read sent before the copy existed cannot have reported it: the copy is offered, not redone.
    expect(nativeConversationImportedCopy(staleRead, entry)).toEqual(
      settlement.kind === "imported" ? settlement.copy : null,
    );
    expect(await ledger.submit(staleRead, selection(staleRead), send)).toEqual(settlement);
    expect(send).toHaveBeenCalledTimes(1);

    // A later read without the copy means it was deleted; importing again is a deliberate new copy.
    const laterRead = source(ledger.now());
    expect(nativeConversationImportedCopy(laterRead, entry)).toBeNull();
    await ledger.submit(laterRead, selection(laterRead), send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].requestId).not.toBe(send.mock.calls[0]![0].requestId);

    // The read's own report always wins.
    const reported = source(ledger.now(), { thread: "t", session: "s" });
    expect(nativeConversationImportedCopy(reported, undefined)).toEqual({
      threadId: "t",
      sessionId: "s",
    });
  });
});
