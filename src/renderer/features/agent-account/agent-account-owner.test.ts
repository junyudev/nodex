import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createAgentAccountOwner } from "./agent-account-owner";
import { authState, deferred, fakeAccountRuntime, ok } from "./agent-account.test-fixtures";

const setup = () => {
  const accounts = fakeAccountRuntime();
  return {
    main: { accounts },
    owner: createAgentAccountOwner({
      runtime: accounts,
      backend: { kind: "acp", instanceConfigId: "qoder-main" },
    }),
  };
};

const waiting = (flowId: string, output = "") =>
  authState({
    phase: "waiting",
    flowId,
    interaction: { type: "terminal", id: "terminal", output, outputOffset: output.length },
  });

const settleAll = async () => {
  for (let index = 0; index < 8; index += 1) await vi.advanceTimersByTimeAsync(0);
};

describe("Agent account owner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a sign-in flow polls while active and the last closed view cancels it", async () => {
    const { main, owner } = setup();
    await settleAll();
    const waiting = authState({
      phase: "waiting",
      flowId: "flow-1",
      interaction: { type: "terminal", id: "terminal", output: "Login: ", outputOffset: 7 },
    });
    main.accounts.start.mockResolvedValueOnce(ok(waiting));
    main.accounts.read.mockResolvedValue(ok(waiting));
    main.accounts.respond.mockResolvedValue(ok(waiting));
    const release = owner.retain();
    owner.signIn("login");
    await settleAll();
    expect(main.accounts.start).toHaveBeenCalledWith({
      backend: { kind: "acp", instanceConfigId: "qoder-main" },
      methodId: "login",
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(main.accounts.read).toHaveBeenCalled();

    owner.terminalInput("x".repeat(5_000));
    await settleAll();
    // Input is sent in order, in chunks the Runtime accepts.
    expect(
      main.accounts.respond.mock.calls.map(([input]) =>
        input.response.type === "terminal" ? input.response.data.length : null,
      ),
    ).toEqual([4_096, 904]);

    release();
    await settleAll();
    expect(main.accounts.cancel).toHaveBeenCalledWith({
      backend: { kind: "acp", instanceConfigId: "qoder-main" },
      flowId: "flow-1",
    });
  });

  test("another client's sign-in is never cancelled from this window", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.accounts.read.mockResolvedValue(
      ok(authState({ phase: "waiting", message: "Sign-in is in progress in another window." })),
    );
    const release = owner.retain();
    owner.read();
    await settleAll();
    expect(owner.getSnapshot()?.state).toMatchObject({
      phase: "waiting",
      cancellable: false,
    });
    owner.cancelSignIn();
    release();
    await settleAll();
    expect(main.accounts.cancel).not.toHaveBeenCalled();
  });

  test("a failed read settles this window's flow as no longer cancellable and still ends it", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.accounts.start.mockResolvedValueOnce(ok(waiting("flow-1")));
    main.accounts.read.mockResolvedValue({
      ok: false,
      error: { reason: "probe_failed", message: "lost" },
    });
    owner.retain();
    owner.signIn("login");
    await settleAll();
    expect(owner.getSnapshot()?.state?.cancellable).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    await settleAll();
    expect(owner.getSnapshot()?.state).toMatchObject({
      phase: "failed",
      flowId: null,
      cancellable: false,
    });
    expect(main.accounts.cancel).toHaveBeenCalledExactlyOnceWith({
      backend: { kind: "acp", instanceConfigId: "qoder-main" },
      flowId: "flow-1",
    });
  });

  test("busy sign-out keeps the affected chats for its explanation", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.accounts.logout.mockResolvedValueOnce({
      ok: false,
      error: {
        reason: "busy",
        message: "busy",
        affectedSessions: [{ sessionId: "s1", threadId: "t1" }],
      },
    });
    owner.signOut();
    await settleAll();
    expect(owner.getSnapshot()?.failure).toMatchObject({
      context: "sign-out",
      failure: { reason: "busy", affectedSessions: [{ sessionId: "s1" }] },
    });
  });

  test("closing the last sign-in surface while sign-in starts cancels the flow it returns", async () => {
    const { main, owner } = setup();
    await settleAll();
    const start = deferred<ReturnType<typeof ok<ReturnType<typeof waiting>>>>();
    main.accounts.start.mockReturnValueOnce(start.promise);
    const release = owner.retain();
    owner.signIn("login");
    await settleAll();
    release();
    expect(owner.getSnapshot()).toBeNull();

    start.resolve(ok(waiting("flow-late")));
    await settleAll();
    expect(main.accounts.cancel).toHaveBeenCalledWith({
      backend: { kind: "acp", instanceConfigId: "qoder-main" },
      flowId: "flow-late",
    });
    expect(owner.getSnapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(main.accounts.read).not.toHaveBeenCalled();
  });

  test("a late answer for an abandoned flow cannot replace the newer flow", async () => {
    const { main, owner } = setup();
    await settleAll();
    const first = deferred<ReturnType<typeof ok<ReturnType<typeof waiting>>>>();
    main.accounts.start
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ok(waiting("flow-b")));
    main.accounts.read.mockResolvedValue(ok(waiting("flow-b")));
    owner.retain();
    owner.signIn("login");
    await settleAll();
    owner.cancelSignIn();
    owner.signIn("login");
    await settleAll();
    expect(owner.getSnapshot()?.state?.flowId).toBe("flow-b");

    first.resolve(ok(waiting("flow-a")));
    await settleAll();
    expect(owner.getSnapshot()?.state?.flowId).toBe("flow-b");
    expect(main.accounts.cancel).toHaveBeenCalledExactlyOnceWith({
      backend: { kind: "acp", instanceConfigId: "qoder-main" },
      flowId: "flow-a",
    });
  });

  test("typed input stays with the terminal that received it", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.accounts.start
      .mockResolvedValueOnce(ok(waiting("flow-a")))
      .mockResolvedValueOnce(ok(waiting("flow-b")));
    main.accounts.read.mockImplementation(async () =>
      ok(waiting(owner.getSnapshot()?.state?.flowId ?? "flow-a")),
    );
    main.accounts.cancel.mockResolvedValue(ok(authState({ phase: "cancelled", flowId: "flow-a" })));
    const firstChunk = deferred<ReturnType<typeof ok<ReturnType<typeof waiting>>>>();
    main.accounts.respond.mockReturnValueOnce(firstChunk.promise);
    owner.retain();
    owner.signIn("login");
    await settleAll();
    owner.terminalInput("p".repeat(4_096) + "secret-tail");
    await settleAll();

    owner.cancelSignIn();
    await settleAll();
    owner.signIn("login");
    await settleAll();
    firstChunk.resolve(ok(waiting("flow-a")));
    await settleAll();
    expect(owner.getSnapshot()?.state?.flowId).toBe("flow-b");
    expect(main.accounts.respond.mock.calls.map(([input]) => input.flowId)).toEqual(["flow-a"]);
  });

  test.each(["poll", "browser", "terminal"] as const)(
    "an expired flow (%s) settles its view so sign-in can start again",
    async (path) => {
      const { main, owner } = setup();
      await settleAll();
      const expired = {
        ok: false as const,
        error: { reason: "operation_expired" as const, message: "expired" },
      };
      const browser = authState({
        phase: "waiting",
        flowId: "flow-a",
        interaction: {
          type: "browser",
          id: "page",
          url: "https://example.test",
          requiresConsent: true,
        },
      });
      main.accounts.start
        .mockResolvedValueOnce(ok(path === "browser" ? browser : waiting("flow-a")))
        .mockResolvedValueOnce(ok(waiting("flow-b")));
      main.accounts.read.mockResolvedValue(path === "poll" ? expired : ok(waiting("flow-a")));
      main.accounts.respond.mockResolvedValue(expired);
      owner.retain();
      owner.signIn("login");
      await settleAll();
      if (path === "poll") await vi.advanceTimersByTimeAsync(300);
      else if (path === "browser") await owner.respondBrowser(true);
      else owner.terminalInput("user@example.test\r");
      await settleAll();

      const view = owner.getSnapshot();
      expect(view?.state?.phase).toBe("failed");
      expect(view?.failure?.failure.reason).toBe("operation_expired");
      // An expired flow is already gone; nothing is cancelled on its behalf.
      expect(main.accounts.cancel).not.toHaveBeenCalled();
      const reads = main.accounts.read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(main.accounts.read.mock.calls.length).toBe(reads);

      owner.signIn("login");
      await settleAll();
      expect(main.accounts.start).toHaveBeenCalledTimes(2);
      expect(owner.getSnapshot()?.state?.flowId).toBe("flow-b");
    },
  );

  test("an expired answer for an earlier flow leaves the newer flow running", async () => {
    const { main, owner } = setup();
    await settleAll();
    const answer = deferred<Awaited<ReturnType<typeof main.accounts.respond>>>();
    main.accounts.start
      .mockResolvedValueOnce(ok(waiting("flow-a")))
      .mockResolvedValueOnce(ok(waiting("flow-b")));
    main.accounts.read.mockImplementation(async () =>
      ok(waiting(owner.getSnapshot()?.state?.flowId ?? "flow-a")),
    );
    main.accounts.respond.mockReturnValueOnce(answer.promise);
    owner.retain();
    owner.signIn("login");
    await settleAll();
    owner.terminalInput("a");
    await settleAll();
    owner.cancelSignIn();
    await settleAll();
    owner.signIn("login");
    await settleAll();
    answer.resolve({ ok: false, error: { reason: "operation_expired", message: "expired" } });
    await settleAll();
    const view = owner.getSnapshot();
    expect(view?.state).toMatchObject({ phase: "waiting", flowId: "flow-b" });
    expect(view?.failure).toBeNull();
  });
});
