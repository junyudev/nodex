import { describe, expect, test } from "vitest";
import { ReceiptFencedOptimisticJournal } from "./receipt-fenced-optimistic-journal";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
};
const cursor = { storeEpoch: "epoch-1", commitSeq: 2 };
const createJournal = () => new ReceiptFencedOptimisticJournal<number>({ onChange: () => {} });

describe("receipt-fenced optimistic journal", () => {
  test("receipt-normalized materialization hands off canonical content without replaying the preview", async () => {
    const journal = createJournal();
    await journal.run({
      conflictKeys: ["a"],
      apply: (model) => model + 1,
      runRemote: async () => ({ cursor, normalized: 4 }),
      getCommitCursor: (result) => result.cursor,
      isCommitMaterialized: (model, result) => model === result.normalized,
    });
    const candidate = journal.project(4, cursor);
    expect(candidate.model).toBe(4);
    expect(candidate.renderToken).not.toBeNull();
    expect(journal.getActivity().acknowledged).toBe(1);
    journal.markRendered(candidate.renderToken!);
    expect(journal.project(4, cursor).model).toBe(4);
    expect(journal.getActivity().acknowledged).toBe(0);
  });

  test("raw canonical proof cannot settle while another visible overlay hides the result", async () => {
    const journal = createJournal();
    await journal.run({
      conflictKeys: ["a"],
      apply: () => 1,
      runRemote: async () => cursor,
      getCommitCursor: (result) => result,
      isCommitMaterialized: (model) => model === 1,
    });
    expect(journal.project(0, cursor, true, 1)).toEqual({ model: 1, renderToken: null });
    const matching = journal.project(1, cursor, true, 1);
    expect(matching.renderToken).not.toBeNull();
    journal.markRendered(matching.renderToken!);
    expect(journal.getActivity().acknowledged).toBe(0);
  });
  test("acknowledges without awaiting repair but fences the next placement", async () => {
    const journal = createJournal();
    const repair = deferred<boolean>();
    let submitted = false;
    const first = journal.run({
      operationIdentity: "first",
      conflictKeys: ["a"],
      apply: () => 1,
      runRemote: async () => cursor,
      getCommitCursor: (result) => result,
      remoteLane: "placement",
      refresh: () => repair.promise,
    });
    expect((await first).ok).toBe(true);
    expect(journal.getActivity()).toEqual({ pending: 0, unknown: 0, acknowledged: 1 });
    const second = journal.run({
      conflictKeys: ["b"],
      apply: () => 2,
      remoteLane: "placement",
      runRemote: async () => {
        submitted = true;
        return 2;
      },
    });
    await Promise.resolve();
    expect(submitted).toBe(false);
    repair.resolve(true);
    expect((await second).ok).toBe(true);
    expect(submitted).toBe(true);
  });

  test("repair failure preserves the committed result and blocks dependent placement", async () => {
    const journal = createJournal();
    const repair = deferred<boolean>();
    const first = await journal.run({
      conflictKeys: ["a"],
      apply: () => 1,
      runRemote: async () => cursor,
      getCommitCursor: (result) => result,
      remoteLane: "placement",
      refresh: () => repair.promise,
    });
    let submitted = false;
    const second = journal.run({
      conflictKeys: ["b"],
      apply: () => 2,
      remoteLane: "placement",
      runRemote: async () => {
        submitted = true;
        return 2;
      },
    });
    repair.reject(new Error("Read unavailable"));
    expect((await second).outcome).toBe("rejected");
    expect(first.ok).toBe(true);
    expect(submitted).toBe(false);
    expect(journal.project(0, { ...cursor, commitSeq: 1 }).model).toBe(1);
    expect(journal.getActivity().acknowledged).toBe(1);
  });

  test("canonical observation before receipt settles without a post-ack read, but needs render proof", async () => {
    const journal = createJournal();
    const remote = deferred<typeof cursor>();
    const command = journal.run({
      conflictKeys: ["a"],
      apply: () => 1,
      runRemote: () => remote.promise,
      getCommitCursor: (result) => result,
      isCommitMaterialized: (model) => model === 1,
    });
    expect(journal.project(1, cursor).renderToken).toBeNull();
    remote.resolve(cursor);
    await command;
    const rendered = journal.project(1, cursor);
    expect(rendered.renderToken).not.toBeNull();
    journal.markRendered(rendered.renderToken! + 1);
    expect(journal.getActivity().acknowledged).toBe(1);
    journal.markRendered(rendered.renderToken!);
    expect(journal.getActivity().acknowledged).toBe(0);
    expect(journal.project(3, { ...cursor, commitSeq: 3 }).model).toBe(3);
  });

  test("a covered cursor alone cannot prove bounded materialization", async () => {
    const journal = createJournal();
    await journal.run({
      conflictKeys: ["a"],
      apply: () => 1,
      runRemote: async () => cursor,
      getCommitCursor: (result) => result,
      isCommitMaterialized: (model) => model === 1,
    });
    expect(journal.project(0, cursor)).toEqual({ model: 1, renderToken: null });
    expect(journal.project(1, { ...cursor, storeEpoch: "another" }).renderToken).toBeNull();
    expect(journal.project(1, cursor, false).renderToken).toBeNull();
    expect(journal.project(1, cursor).renderToken).not.toBeNull();
  });

  test("unknown result retains exact intent and retries the same operation without self-supersession", async () => {
    const journal = createJournal();
    const first = await journal.run({
      operationIdentity: "exact",
      conflictKeys: ["a"],
      apply: () => 1,
      remoteLane: "placement",
      runRemote: async () => {
        throw new Error("Disconnected");
      },
      classifyFailure: () => "unknown",
      isCommitMaterialized: (model) => model === 1,
    });
    expect(first.outcome).toBe("unknown");
    expect(journal.getActivity().unknown).toBe(1);
    expect(journal.project(0, cursor).model).toBe(1);
    const retry = await journal.run({
      operationIdentity: "exact",
      conflictKeys: ["a"],
      apply: () => 999,
      remoteLane: "placement",
      runRemote: async () => cursor,
      getCommitCursor: (result) => result,
      isCommitMaterialized: () => true,
    });
    expect(retry.opId).toBe(first.opId);
    expect(retry.superseded).toBe(false);
    expect(journal.project(0, cursor)).toEqual({ model: 1, renderToken: null });
    expect(journal.getActivity()).toEqual({ pending: 0, unknown: 0, acknowledged: 1 });
    const rendered = journal.project(1, cursor);
    journal.markRendered(rendered.renderToken!);
    expect(journal.getActivity().acknowledged).toBe(0);
  });

  test("older receipt and render token cannot retire newer conflicting intent", async () => {
    const journal = createJournal();
    await journal.run({ conflictKeys: ["a"], apply: () => 1, runRemote: async () => 1 });
    const firstToken = journal.project(1, null).renderToken!;
    const remote = deferred<number>();
    const second = journal.run({
      conflictKeys: ["a"],
      apply: () => 2,
      runRemote: () => remote.promise,
    });
    journal.project(1, null);
    journal.markRendered(firstToken);
    expect(journal.project(1, null).model).toBe(2);
    expect(journal.getActivity().pending).toBe(1);
    remote.resolve(2);
    await second;
  });

  test("discard removes only the exact unknown presentation and does not cancel another command", async () => {
    const journal = createJournal();
    await journal.run({
      operationIdentity: "unknown",
      conflictKeys: ["a"],
      apply: () => 1,
      runRemote: async () => {
        throw new Error("Disconnected");
      },
      classifyFailure: () => "unknown",
    });
    const remote = deferred<number>();
    const pending = journal.run({
      operationIdentity: "other",
      conflictKeys: ["b"],
      apply: (model) => model + 2,
      runRemote: () => remote.promise,
    });
    expect(journal.discard("missing")).toBe(false);
    expect(journal.discard("unknown")).toBe(true);
    expect(journal.project(0, cursor).model).toBe(2);
    expect(journal.getActivity()).toEqual({ pending: 1, unknown: 0, acknowledged: 0 });
    remote.resolve(2);
    expect((await pending).ok).toBe(true);
  });

  test("authority replacement revokes overlays and prevents queued transport", async () => {
    const journal = createJournal();
    const remote = deferred<number>();
    const first = journal.run({
      conflictKeys: ["a"],
      apply: () => 1,
      remoteLane: "lane",
      runRemote: () => remote.promise,
    });
    let submitted = false;
    const second = journal.run({
      conflictKeys: ["b"],
      apply: () => 2,
      remoteLane: "lane",
      runRemote: async () => {
        submitted = true;
        return 2;
      },
    });
    journal.revoke("store_reset");
    remote.resolve(1);
    expect((await first).superseded).toBe(true);
    expect((await second).superseded).toBe(true);
    expect(submitted).toBe(false);
    expect(journal.project(3, cursor).model).toBe(3);
  });
});
