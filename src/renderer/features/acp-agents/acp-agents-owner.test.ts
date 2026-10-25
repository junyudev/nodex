import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { acpInstanceStatus, acpProviderId } from "./acp-agent-model";
import { createAcpAgentsOwner } from "./acp-agents-owner";
import {
  authState,
  deferred,
  fakeAcpRuntime,
  memoryJournal,
  ok,
  discovered,
  operation,
  providerSnapshot,
  registryInstance,
} from "./acp-agents.test-fixtures";

const INSTALLATION = "a".repeat(64);

const setup = (instances = [registryInstance()], journal = memoryJournal()) => {
  const main = fakeAcpRuntime({ instances });
  let ids = 0;
  const owner = createAcpAgentsOwner({
    runtime: main.runtime,
    subscribeChanges: () => () => {},
    journal,
    createId: () => `op-${++ids}`,
  });
  const stop = owner.subscribe(() => {});
  return { main, owner, journal, stop };
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

describe("ACP Agents owner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("installing pins the exact receipt to the instance, then connects", async () => {
    const { main, owner, journal } = setup();
    await settleAll();
    main.runtime.readOperation.mockResolvedValueOnce(
      ok(
        operation({
          operationId: "op-1",
          phase: "succeeded",
          result: {
            agentId: "qoder-cli",
            version: "0.2.14",
            distribution: "binary",
            prepared: true,
            installationId: INSTALLATION,
          },
        }),
      ),
    );

    owner.install(
      "qoder-main",
      { agentId: "qoder-cli", distribution: "auto", expectedInstallationId: INSTALLATION },
      "connect",
    );
    await settleAll();
    expect(main.runtime.install).toHaveBeenCalledWith({
      operationId: "op-1",
      agentId: "qoder-cli",
      distribution: "auto",
      expectedInstallationId: INSTALLATION,
    });
    expect(owner.getSnapshot().activities.get("qoder-main")?.kind).toBe("install");
    expect(journal.current()).toContain("op-1");

    await vi.advanceTimersByTimeAsync(500);
    await settleAll();
    expect(main.settings().instances[0]?.source).toEqual({
      kind: "registry",
      agentId: "qoder-cli",
      distribution: "auto",
      installationId: INSTALLATION,
    });
    expect(main.runtime.connect).toHaveBeenCalledWith({
      instanceId: "qoder-main",
      operationId: "op-2",
    });
    expect(owner.getSnapshot().activities.get("qoder-main")?.kind).toBe("connect");
  });

  test("an installed Agent reads Installing until its Connect starts", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.runtime.readOperation.mockResolvedValueOnce(
      ok(
        operation({
          operationId: "op-1",
          phase: "succeeded",
          result: {
            agentId: "qoder-cli",
            version: "0.2.14",
            distribution: "binary",
            prepared: true,
            installationId: INSTALLATION,
          },
        }),
      ),
    );
    const pin = deferred<void>();
    const save = main.runtime.updateSettings.getMockImplementation()!;
    main.runtime.updateSettings.mockImplementationOnce(async (input) => {
      await pin.promise;
      return save(input);
    });
    const status = () =>
      acpInstanceStatus({
        instance: owner.getSnapshot().settings!.instances[0]!,
        inspection: undefined,
        provider: undefined,
        activity: owner.getSnapshot().activities.get("qoder-main"),
      }).label;

    owner.install(
      "qoder-main",
      { agentId: "qoder-cli", distribution: "auto", expectedInstallationId: INSTALLATION },
      "connect",
    );
    await vi.advanceTimersByTimeAsync(500);
    await settleAll();
    expect(main.runtime.updateSettings).toHaveBeenCalledOnce();
    expect(status()).toBe("Installing");

    pin.resolve();
    await settleAll();
    expect(main.runtime.connect).toHaveBeenCalledOnce();
    expect(status()).toBe("Connecting");
  });

  test("a reloaded window resumes polling the operation it started", async () => {
    const journal = memoryJournal(
      JSON.stringify([{ instanceId: "qoder-main", kind: "connect", operationId: "op-9" }]),
    );
    const { main, owner } = setup([registryInstance()], journal);
    await settleAll();
    expect(main.runtime.readOperation).toHaveBeenCalledWith({ operationId: "op-9" });
    expect(owner.getSnapshot().activities.get("qoder-main")).toMatchObject({
      operationId: "op-9",
      phase: "running",
    });
  });

  test("a stale operation answer cannot replace a newer operation for the instance", async () => {
    const { main, owner } = setup();
    await settleAll();
    let answer!: () => void;
    main.runtime.connect.mockImplementationOnce(
      ({ operationId }) =>
        new Promise((resolve) => {
          answer = () =>
            resolve(
              ok(
                operation({
                  operationId,
                  kind: "connect",
                  phase: "failed",
                  error: { reason: "probe_failed", message: "late" },
                }),
              ),
            );
        }),
    );
    owner.connect("qoder-main");
    await settleAll();
    owner.dismiss("qoder-main");
    // Still starting: dismiss keeps a live operation.
    expect(owner.getSnapshot().activities.get("qoder-main")?.operationId).toBe("op-1");
    answer();
    await settleAll();
    expect(owner.getSnapshot().activities.get("qoder-main")).toMatchObject({
      phase: "failed",
      failure: { reason: "probe_failed" },
    });
  });

  test("a typed failure keeps the Agent's recovery data for the status", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.runtime.connect.mockResolvedValueOnce({
      ok: false,
      error: {
        reason: "authentication_failed",
        message: "Sign in first",
        authMethods: [
          {
            id: "token",
            name: "Personal token",
            description: null,
            type: "env_var",
            envVarNames: ["QODER_PERSONAL_ACCESS_TOKEN"],
          },
        ],
      },
    });
    owner.connect("qoder-main");
    await settleAll();
    expect(
      owner.getSnapshot().activities.get("qoder-main")?.failure?.authMethods?.[0],
    ).toMatchObject({ envVarNames: ["QODER_PERSONAL_ACCESS_TOKEN"] });
  });

  test("a save reports Runtime deferral instead of claiming it applied", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.deferNext(["qoder-main"]);
    const outcome = await owner.setEnabled("qoder-main", false);
    expect(outcome).toEqual({ ok: true, deferred: true, configurationFailed: false });
    expect(owner.getSnapshot().deferred.has("qoder-main")).toBe(true);
    main.deferNext([]);
    await owner.setEnabled("qoder-main", true);
    expect(owner.getSnapshot().deferred.has("qoder-main")).toBe(false);
  });

  test("a rejected save keeps the previous settings and returns its reason", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.runtime.updateSettings.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'settings:acp-agents:update': Error: An existing Agent instance cannot change its identity.",
      ),
    );
    const outcome = await owner.updateInstance("qoder-main", (saved) => ({
      ...saved,
      agentDefinitionId: "other",
    }));
    expect(outcome).toEqual({
      ok: false,
      message: "An existing Agent instance cannot change its identity.",
    });
    expect(owner.getSnapshot().settings?.instances[0]?.agentDefinitionId).toBe("qoder-cli");
  });

  test("a sign-in flow polls while active and the last closed view cancels it", async () => {
    const { main, owner } = setup();
    await settleAll();
    const waiting = authState({
      phase: "waiting",
      flowId: "flow-1",
      interaction: { type: "terminal", id: "terminal", output: "Login: ", outputOffset: 7 },
    });
    main.runtime.startAuth.mockResolvedValueOnce(ok(waiting));
    main.runtime.readAuth.mockResolvedValue(ok(waiting));
    main.runtime.respondAuth.mockResolvedValue(ok(waiting));
    const release = owner.retainAuth("qoder-main");
    owner.signIn("qoder-main", "login");
    await settleAll();
    expect(main.runtime.startAuth).toHaveBeenCalledWith({
      instanceId: "qoder-main",
      methodId: "login",
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(main.runtime.readAuth).toHaveBeenCalled();

    owner.terminalInput("qoder-main", "x".repeat(5_000));
    await settleAll();
    // Input is sent in order, in chunks the Runtime accepts.
    expect(
      main.runtime.respondAuth.mock.calls.map(([input]) =>
        input.response.type === "terminal" ? input.response.data.length : null,
      ),
    ).toEqual([4_096, 904]);

    release();
    await settleAll();
    expect(main.runtime.cancelAuth).toHaveBeenCalledWith({
      instanceId: "qoder-main",
      flowId: "flow-1",
    });
  });

  test("another client's sign-in is never cancelled from this window", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.runtime.readAuth.mockResolvedValue(
      ok(authState({ phase: "waiting", message: "Sign-in is in progress in another client." })),
    );
    const release = owner.retainAuth("qoder-main");
    owner.readAuth("qoder-main");
    await settleAll();
    expect(owner.getSnapshot().auth.get("qoder-main")?.state).toMatchObject({
      phase: "waiting",
      cancellable: false,
    });
    owner.cancelSignIn("qoder-main");
    release();
    await settleAll();
    expect(main.runtime.cancelAuth).not.toHaveBeenCalled();
  });

  test("a failed read settles this window's flow as no longer cancellable and still ends it", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.runtime.startAuth.mockResolvedValueOnce(ok(waiting("flow-1")));
    main.runtime.readAuth.mockResolvedValue({
      ok: false,
      error: { reason: "probe_failed", message: "lost" },
    });
    owner.retainAuth("qoder-main");
    owner.signIn("qoder-main", "login");
    await settleAll();
    expect(owner.getSnapshot().auth.get("qoder-main")?.state?.cancellable).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    await settleAll();
    expect(owner.getSnapshot().auth.get("qoder-main")?.state).toMatchObject({
      phase: "failed",
      flowId: null,
      cancellable: false,
    });
    expect(main.runtime.cancelAuth).toHaveBeenCalledExactlyOnceWith({
      instanceId: "qoder-main",
      flowId: "flow-1",
    });
  });

  test("busy sign-out keeps the affected chats for its explanation", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.runtime.logout.mockResolvedValueOnce({
      ok: false,
      error: {
        reason: "busy",
        message: "busy",
        affectedSessions: [{ sessionId: "s1", threadId: "t1" }],
      },
    });
    owner.signOut("qoder-main");
    await settleAll();
    expect(owner.getSnapshot().auth.get("qoder-main")?.failure).toMatchObject({
      context: "sign-out",
      failure: { reason: "busy", affectedSessions: [{ sessionId: "s1" }] },
    });
  });

  test("overlapping saves each apply to the settings the previous one saved", async () => {
    const other = registryInstance({
      id: "vibe-main",
      agentDefinitionId: "vibe",
      displayName: "Vibe",
      source: { kind: "registry", agentId: "vibe", distribution: "auto" },
    });
    const { main, owner } = setup([registryInstance(), other]);
    await settleAll();
    const first = deferred<void>();
    const original = main.runtime.updateSettings.getMockImplementation()!;
    main.runtime.updateSettings.mockImplementationOnce(async (input) => {
      await first.promise;
      return original(input);
    });
    const pin = (instanceId: string, installationId: string) =>
      owner.updateInstance(instanceId, (saved) =>
        saved.source.kind === "registry"
          ? { ...saved, source: { ...saved.source, installationId } }
          : saved,
      );
    const pinned = [pin("qoder-main", "a".repeat(64)), pin("vibe-main", "b".repeat(64))];
    const toggled = owner.setEnabled("qoder-main", false);
    first.resolve();
    await Promise.all([...pinned, toggled]);
    expect(main.runtime.updateSettings).toHaveBeenCalledTimes(3);
    expect(main.settings().instances.map(({ enabled, source }) => [enabled, source])).toEqual([
      [
        false,
        {
          kind: "registry",
          agentId: "qoder-cli",
          distribution: "auto",
          installationId: "a".repeat(64),
        },
      ],
      [
        true,
        { kind: "registry", agentId: "vibe", distribution: "auto", installationId: "b".repeat(64) },
      ],
    ]);
  });

  test("two installs finishing together keep both pinned receipts", async () => {
    const other = registryInstance({
      id: "vibe-main",
      agentDefinitionId: "vibe",
      displayName: "Vibe",
      source: { kind: "registry", agentId: "vibe", distribution: "auto" },
    });
    const { main, owner } = setup([registryInstance(), other]);
    await settleAll();
    main.runtime.readOperation.mockImplementation(async ({ operationId }) =>
      ok(
        operation({
          operationId,
          phase: "succeeded",
          result: {
            agentId: operationId === "op-1" ? "qoder-cli" : "vibe",
            version: "1.0.0",
            distribution: "binary",
            prepared: true,
            installationId: (operationId === "op-1" ? "a" : "b").repeat(64),
          },
        }),
      ),
    );
    owner.install("qoder-main", { agentId: "qoder-cli", distribution: "auto" }, "none");
    owner.install("vibe-main", { agentId: "vibe", distribution: "auto" }, "none");
    await settleAll();
    await vi.advanceTimersByTimeAsync(500);
    await settleAll();
    expect(
      main
        .settings()
        .instances.map(({ source }) => (source.kind === "registry" ? source.installationId : null)),
    ).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  test("pending configuration clears once Main reports it applied, then stops checking", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.deferNext(["qoder-main"]);
    await owner.setEnabled("qoder-main", false);
    expect(owner.getSnapshot().deferred).toEqual(new Set(["qoder-main"]));
    const reads = main.runtime.readConfigurationStatus.mock.calls.length;

    await vi.advanceTimersByTimeAsync(2_000);
    expect(main.runtime.readConfigurationStatus.mock.calls.length).toBe(reads + 1);
    expect(owner.getSnapshot().deferred.size).toBe(1);

    // The Agent finished its work; Runtime applied the saved settings.
    main.deferNext([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(owner.getSnapshot().deferred.size).toBe(0);
    const settled = main.runtime.readConfigurationStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(main.runtime.readConfigurationStatus.mock.calls.length).toBe(settled);
  });

  test("a failed reconcile stays visible and retries only while observed", async () => {
    const { main, owner, stop } = setup();
    await settleAll();
    main.setFailed(true);
    const outcome = await owner.setEnabled("qoder-main", false);
    expect(outcome).toMatchObject({ ok: true, configurationFailed: true });
    expect(owner.getSnapshot().configurationFailed).toBe(true);
    main.setFailed(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(owner.getSnapshot().configurationFailed).toBe(false);

    main.setFailed(true);
    owner.checkConfiguration();
    await settleAll();
    stop();
    const reads = main.runtime.readConfigurationStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(main.runtime.readConfigurationStatus.mock.calls.length).toBe(reads);
  });

  test("closing the last sign-in surface while sign-in starts cancels the flow it returns", async () => {
    const { main, owner } = setup();
    await settleAll();
    const start = deferred<ReturnType<typeof ok<ReturnType<typeof waiting>>>>();
    main.runtime.startAuth.mockReturnValueOnce(start.promise);
    const release = owner.retainAuth("qoder-main");
    owner.signIn("qoder-main", "login");
    await settleAll();
    release();
    expect(owner.getSnapshot().auth.has("qoder-main")).toBe(false);

    start.resolve(ok(waiting("flow-late")));
    await settleAll();
    expect(main.runtime.cancelAuth).toHaveBeenCalledWith({
      instanceId: "qoder-main",
      flowId: "flow-late",
    });
    expect(owner.getSnapshot().auth.has("qoder-main")).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(main.runtime.readAuth).not.toHaveBeenCalled();
  });

  test("a late answer for an abandoned flow cannot replace the newer flow", async () => {
    const { main, owner } = setup();
    await settleAll();
    const first = deferred<ReturnType<typeof ok<ReturnType<typeof waiting>>>>();
    main.runtime.startAuth
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(ok(waiting("flow-b")));
    main.runtime.readAuth.mockResolvedValue(ok(waiting("flow-b")));
    owner.retainAuth("qoder-main");
    owner.signIn("qoder-main", "login");
    await settleAll();
    owner.cancelSignIn("qoder-main");
    owner.signIn("qoder-main", "login");
    await settleAll();
    expect(owner.getSnapshot().auth.get("qoder-main")?.state?.flowId).toBe("flow-b");

    first.resolve(ok(waiting("flow-a")));
    await settleAll();
    expect(owner.getSnapshot().auth.get("qoder-main")?.state?.flowId).toBe("flow-b");
    expect(main.runtime.cancelAuth).toHaveBeenCalledExactlyOnceWith({
      instanceId: "qoder-main",
      flowId: "flow-a",
    });
  });

  test("typed input stays with the terminal that received it", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.runtime.startAuth
      .mockResolvedValueOnce(ok(waiting("flow-a")))
      .mockResolvedValueOnce(ok(waiting("flow-b")));
    main.runtime.readAuth.mockImplementation(async () =>
      ok(waiting(owner.getSnapshot().auth.get("qoder-main")?.state?.flowId ?? "flow-a")),
    );
    main.runtime.cancelAuth.mockResolvedValue(
      ok(authState({ phase: "cancelled", flowId: "flow-a" })),
    );
    const firstChunk = deferred<ReturnType<typeof ok<ReturnType<typeof waiting>>>>();
    main.runtime.respondAuth.mockReturnValueOnce(firstChunk.promise);
    owner.retainAuth("qoder-main");
    owner.signIn("qoder-main", "login");
    await settleAll();
    owner.terminalInput("qoder-main", "p".repeat(4_096) + "secret-tail");
    await settleAll();

    owner.cancelSignIn("qoder-main");
    await settleAll();
    owner.signIn("qoder-main", "login");
    await settleAll();
    firstChunk.resolve(ok(waiting("flow-a")));
    await settleAll();
    expect(owner.getSnapshot().auth.get("qoder-main")?.state?.flowId).toBe("flow-b");
    expect(main.runtime.respondAuth.mock.calls.map(([input]) => input.flowId)).toEqual(["flow-a"]);
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
      main.runtime.startAuth
        .mockResolvedValueOnce(ok(path === "browser" ? browser : waiting("flow-a")))
        .mockResolvedValueOnce(ok(waiting("flow-b")));
      main.runtime.readAuth.mockResolvedValue(path === "poll" ? expired : ok(waiting("flow-a")));
      main.runtime.respondAuth.mockResolvedValue(expired);
      owner.retainAuth("qoder-main");
      owner.signIn("qoder-main", "login");
      await settleAll();
      if (path === "poll") await vi.advanceTimersByTimeAsync(300);
      else if (path === "browser") await owner.respondBrowser("qoder-main", true);
      else owner.terminalInput("qoder-main", "user@example.test\r");
      await settleAll();

      const view = owner.getSnapshot().auth.get("qoder-main");
      expect(view?.state?.phase).toBe("failed");
      expect(view?.failure?.failure.reason).toBe("operation_expired");
      // An expired flow is already gone; nothing is cancelled on its behalf.
      expect(main.runtime.cancelAuth).not.toHaveBeenCalled();
      const reads = main.runtime.readAuth.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3_000);
      expect(main.runtime.readAuth.mock.calls.length).toBe(reads);

      owner.signIn("qoder-main", "login");
      await settleAll();
      expect(main.runtime.startAuth).toHaveBeenCalledTimes(2);
      expect(owner.getSnapshot().auth.get("qoder-main")?.state?.flowId).toBe("flow-b");
    },
  );

  test("an expired answer for an earlier flow leaves the newer flow running", async () => {
    const { main, owner } = setup();
    await settleAll();
    const answer = deferred<Awaited<ReturnType<typeof main.runtime.respondAuth>>>();
    main.runtime.startAuth
      .mockResolvedValueOnce(ok(waiting("flow-a")))
      .mockResolvedValueOnce(ok(waiting("flow-b")));
    main.runtime.readAuth.mockImplementation(async () =>
      ok(waiting(owner.getSnapshot().auth.get("qoder-main")?.state?.flowId ?? "flow-a")),
    );
    main.runtime.respondAuth.mockReturnValueOnce(answer.promise);
    owner.retainAuth("qoder-main");
    owner.signIn("qoder-main", "login");
    await settleAll();
    owner.terminalInput("qoder-main", "a");
    await settleAll();
    owner.cancelSignIn("qoder-main");
    await settleAll();
    owner.signIn("qoder-main", "login");
    await settleAll();
    answer.resolve({ ok: false, error: { reason: "operation_expired", message: "expired" } });
    await settleAll();
    const view = owner.getSnapshot().auth.get("qoder-main");
    expect(view?.state).toMatchObject({ phase: "waiting", flowId: "flow-b" });
    expect(view?.failure).toBeNull();
  });

  test("verified sign-in answers the Connect that asked for it", async () => {
    const qoder = registryInstance();
    const { main, owner } = setup([qoder]);
    await settleAll();
    main.runtime.connect.mockResolvedValueOnce({
      ok: false,
      error: { reason: "authentication_failed", message: "Sign in first" },
    });
    owner.connect("qoder-main");
    await settleAll();
    const status = () =>
      acpInstanceStatus({
        instance: qoder,
        inspection: owner.getSnapshot().inspections.get("qoder-main"),
        provider: owner.getSnapshot().providers.get("qoder-main"),
        activity: owner.getSnapshot().activities.get("qoder-main"),
      });
    expect(status().kind).toBe("sign-in");

    main.runtime.knownProviders.mockResolvedValue([
      providerSnapshot({
        instanceId: acpProviderId(qoder)!,
        auth: { status: "unknown" },
        models: [{ slug: "dfmodel", name: "DeepSeek", isCustom: false, capabilities: null }],
        ...discovered(),
      }),
    ]);
    main.runtime.startAuth.mockResolvedValueOnce(
      ok(authState({ phase: "succeeded", flowId: "f" })),
    );
    owner.signIn("qoder-main", "login");
    await settleAll();
    expect(owner.getSnapshot().activities.has("qoder-main")).toBe(false);
    expect(status()).toMatchObject({ kind: "ready", detail: "1 model" });
    // Its models were already known, so nothing else starts.
    expect(main.runtime.connect).toHaveBeenCalledOnce();
  });

  test("signing in to an Agent whose models aren't known yet connects to read them", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.runtime.startAuth.mockResolvedValueOnce(
      ok(authState({ phase: "succeeded", flowId: "f" })),
    );
    owner.signIn("qoder-main", "login");
    await settleAll();
    expect(main.runtime.connect).toHaveBeenCalledWith({
      instanceId: "qoder-main",
      operationId: "op-1",
    });
    expect(owner.getSnapshot().activities.get("qoder-main")?.kind).toBe("connect");
  });

  test("a failed install stays current through an unrelated sign-in", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.runtime.install.mockResolvedValueOnce({
      ok: false,
      error: { reason: "checksum_mismatch", message: "bad bytes" },
    });
    owner.install("qoder-main", { agentId: "qoder-cli", distribution: "auto" }, "none");
    await settleAll();
    main.runtime.startAuth.mockResolvedValueOnce(
      ok(authState({ phase: "succeeded", flowId: "f" })),
    );
    owner.signIn("qoder-main");
    await settleAll();
    expect(owner.getSnapshot().activities.get("qoder-main")?.failure?.reason).toBe(
      "checksum_mismatch",
    );
  });

  test("an earlier flow's success read passively is not a new sign-in", async () => {
    const { main, owner } = setup();
    await settleAll();
    main.runtime.connect.mockResolvedValueOnce({
      ok: false,
      error: { reason: "authentication_failed", message: "Sign in first" },
    });
    owner.connect("qoder-main");
    await settleAll();
    main.runtime.readAuth.mockResolvedValueOnce(
      ok(authState({ phase: "succeeded", flowId: "old" })),
    );
    owner.readAuth("qoder-main");
    await settleAll();
    expect(owner.getSnapshot().activities.get("qoder-main")?.failure?.reason).toBe(
      "authentication_failed",
    );
    expect(main.runtime.connect).toHaveBeenCalledOnce();
  });

  test("uninstalling waits out the post-install reservation but not chats using the Agent", async () => {
    const { main, owner } = setup();
    await settleAll();
    const reserved = { ok: false as const, error: { reason: "busy" as const, message: "busy" } };
    main.runtime.uninstall
      .mockResolvedValueOnce(reserved)
      .mockResolvedValueOnce(ok({ agentId: "qoder-cli", removed: true }));
    const done = owner.uninstall("qoder-cli");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toMatchObject({ ok: true });
    expect(main.runtime.uninstall).toHaveBeenCalledTimes(2);

    main.runtime.uninstall.mockClear().mockResolvedValue({
      ok: false,
      error: {
        reason: "busy",
        message: "busy",
        affectedSessions: [{ sessionId: "s", threadId: "t" }],
      },
    });
    expect(await owner.uninstall("qoder-cli")).toMatchObject({ ok: false });
    expect(main.runtime.uninstall).toHaveBeenCalledOnce();
  });
});
