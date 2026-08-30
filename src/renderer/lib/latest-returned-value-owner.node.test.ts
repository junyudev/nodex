import { describe, expect, it } from "vite-plus/test";
import { createLatestReturnedValueOwner } from "./latest-returned-value-owner";
import { createRendererCausalTrace, recordRendererOwnerTrace } from "./renderer-causal-trace";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

interface Setting {
  readonly mode: string;
}

const setting = (mode: string): Setting => ({ mode });

function operationIds() {
  let sequence = 0;
  return () => `operation-${++sequence}`;
}

describe("LatestReturnedValueOwner", () => {
  it("presents complete intent before transport and settles only its matching render", async () => {
    const request = deferred<Setting>();
    const trace = createRendererCausalTrace({ enabled: true });
    let presentedAtSend = "";
    const owner = createLatestReturnedValueOwner({
      initialValue: setting("initial"),
      equals: (left, right) => left.mode === right.mode,
      operationId: operationIds(),
      project: (_current, desired) => desired,
      port: {
        read: async () => setting("initial"),
        update: async (_, context) => {
          recordRendererOwnerTrace(
            context,
            { kind: "submitted", reason: "transport_submit" },
            trace,
          );
          presentedAtSend = owner.getSnapshot().value.mode;
          return await request.promise;
        },
      },
      semanticKey: "settings.update",
      owner: "settings",
      scopeKind: "application",
      trace,
    });

    const update = owner.update(setting("desired"));
    expect(presentedAtSend).toBe("desired");
    const renderToken = owner.getSnapshot().renderToken;
    expect(renderToken).not.toBeNull();
    owner.markRendered((renderToken ?? 0) + 1);
    expect(owner.getSnapshot()).toMatchObject({ pending: true, renderToken });
    owner.markRendered(renderToken ?? 0);
    expect(owner.getSnapshot()).toMatchObject({ pending: true, renderToken: null });

    request.resolve(setting("desired"));
    await expect(update).resolves.toEqual(setting("desired"));
    expect(owner.getSnapshot()).toMatchObject({
      value: setting("desired"),
      pending: false,
      renderToken: null,
    });
    expect(trace.reduce()).toMatchObject({ legal: true });
  });

  it("keeps B over late A success and reads that started before B", async () => {
    const readBeforeB = deferred<Setting>();
    const requestA = deferred<Setting>();
    const requestB = deferred<Setting>();
    const requests = [requestA, requestB];
    const trace = createRendererCausalTrace({ enabled: true });
    let updateIndex = 0;
    const owner = createLatestReturnedValueOwner({
      initialValue: setting("canonical"),
      equals: (left, right) => left.mode === right.mode,
      operationId: operationIds(),
      project: (_current, desired) => desired,
      port: {
        read: async () => await readBeforeB.promise,
        update: async (_, context) => {
          const request = requests[updateIndex++]!;
          recordRendererOwnerTrace(
            context,
            { kind: "submitted", reason: "transport_submit" },
            trace,
          );
          const result = await request.promise;
          recordRendererOwnerTrace(context, { kind: "result", reason: "terminal_result" }, trace);
          return result;
        },
      },
      semanticKey: "settings.update",
      owner: "settings",
      scopeKind: "application",
      trace,
    });

    const staleRead = owner.readCanonical();
    const updateA = owner.update(setting("A"));
    const tokenA = owner.getSnapshot().renderToken;
    const updateB = owner.update(setting("B"));
    const tokenB = owner.getSnapshot().renderToken;
    expect(owner.getSnapshot().value).toEqual(setting("B"));

    readBeforeB.resolve(setting("canonical"));
    await staleRead;
    expect(owner.getSnapshot().value).toEqual(setting("B"));

    requestB.resolve(setting("B"));
    await expect(updateB).resolves.toEqual(setting("B"));
    requestA.resolve(setting("A"));
    await expect(updateA).resolves.toEqual(setting("B"));
    expect(owner.getSnapshot().value).toEqual(setting("B"));

    owner.markRendered(tokenA ?? 0);
    expect(owner.getSnapshot()).toMatchObject({ pending: true, renderToken: tokenB });
    owner.markRendered(tokenB ?? 0);
    expect(owner.getSnapshot()).toMatchObject({ value: setting("B"), pending: false });
    expect(trace.reduce()).toMatchObject({
      legal: true,
      operations: [{ outcome: "superseded" }, { outcome: "settled" }],
    });
  });

  it("ignores a superseded failure and fences canonical reads while B is pending", async () => {
    const reads: Array<ReturnType<typeof deferred<Setting>>> = [];
    const requestA = deferred<Setting>();
    const requestB = deferred<Setting>();
    const requests = [requestA, requestB];
    let updateIndex = 0;
    const owner = createLatestReturnedValueOwner({
      initialValue: setting("canonical"),
      equals: (left, right) => left.mode === right.mode,
      operationId: operationIds(),
      project: (_current, desired) => desired,
      port: {
        read: async () => {
          const request = deferred<Setting>();
          reads.push(request);
          return await request.promise;
        },
        update: async () => await requests[updateIndex++]!.promise,
      },
      semanticKey: "settings.update",
      owner: "settings",
      scopeKind: "application",
    });

    const updateA = owner.update(setting("A"));
    const updateB = owner.update(setting("B"));
    const tokenB = owner.getSnapshot().renderToken;
    requestB.resolve(setting("B"));
    await expect(updateB).resolves.toEqual(setting("B"));

    const staleAfterResult = owner.readCanonical();
    reads[0]!.resolve(setting("A"));
    await staleAfterResult;
    expect(owner.getSnapshot().value).toEqual(setting("B"));

    owner.markRendered(tokenB ?? 0);
    requestA.reject(new Error("late A failure"));
    await expect(updateA).resolves.toEqual(setting("B"));
    expect(owner.getSnapshot().value).toEqual(setting("B"));

    const laterCanonicalRead = owner.readCanonical();
    reads[1]!.resolve(setting("external"));
    await laterCanonicalRead;
    expect(owner.getSnapshot().value).toEqual(setting("external"));
  });

  it("does not install a read started during an intent after that intent settles", async () => {
    const staleRead = deferred<Setting>();
    const request = deferred<Setting>();
    const owner = createLatestReturnedValueOwner({
      initialValue: setting("canonical"),
      equals: (left, right) => left.mode === right.mode,
      operationId: operationIds(),
      project: (_current, desired) => desired,
      port: {
        read: async () => await staleRead.promise,
        update: async () => await request.promise,
      },
      semanticKey: "settings.update",
      owner: "settings",
      scopeKind: "application",
    });

    const update = owner.update(setting("B"));
    const renderToken = owner.getSnapshot().renderToken;
    const read = owner.readCanonical();
    request.resolve(setting("B"));
    await update;
    owner.markRendered(renderToken ?? 0);
    expect(owner.getSnapshot()).toMatchObject({ value: setting("B"), pending: false });

    staleRead.resolve(setting("A"));
    await read;
    expect(owner.getSnapshot()).toMatchObject({ value: setting("B"), pending: false });
  });

  it("rolls a failed latest intent back to an older command's canonical result", async () => {
    const requestA = deferred<Setting>();
    const requestB = deferred<Setting>();
    const requests = [requestA, requestB];
    let requestIndex = 0;
    const owner = createLatestReturnedValueOwner({
      initialValue: setting("canonical"),
      equals: (left, right) => left.mode === right.mode,
      operationId: operationIds(),
      project: (_current, desired) => desired,
      port: {
        read: async () => setting("canonical"),
        update: async () => await requests[requestIndex++]!.promise,
      },
      semanticKey: "settings.update",
      owner: "settings",
      scopeKind: "application",
    });

    const updateA = owner.update(setting("A"));
    const updateB = owner.update(setting("B"));
    requestA.resolve(setting("A"));
    await updateA;
    expect(owner.getSnapshot().value).toEqual(setting("B"));

    requestB.reject(new Error("B failed"));
    await expect(updateB).rejects.toThrow("B failed");
    expect(owner.getSnapshot()).toMatchObject({ value: setting("A"), pending: false });
  });
});
