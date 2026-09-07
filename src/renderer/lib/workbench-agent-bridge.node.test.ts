import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  WORKBENCH_AGENT_MAX_REPLY_BYTES,
  type WorkbenchAgentRequest,
  type WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import {
  createWorkbenchSceneSurface,
  materializeInitialWorkbenchScene,
} from "../../shared/workbench-scene";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "./maitai/maitai-store";
import { getWorkbenchWindowOwner } from "./workbench-window-owner";
import {
  createWorkbenchSceneCommands,
  type WorkbenchSceneCommandExecutor,
} from "./workbench-scene-commands";
import {
  captureWorkbenchSubmitPresentation,
  createWorkbenchAgentBridge,
  type WorkbenchAgentBridgePort,
} from "./workbench-agent-bridge";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness() {
  const store = createMaitaiStore();
  disposers.push(() => disposeMaitaiStore(store));
  const sceneOwner = { kind: "session" as const, sessionId: "session-a" };
  const scene = materializeInitialWorkbenchScene(sceneOwner);
  const owner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
    ...createDefaultWorkbenchLayoutSnapshot(),
    location: { kind: "session", sessionId: "session-a", projectContextId: null },
    scenesByOwnerKey: { "session:session-a": scene },
  });
  owner.initialize();
  const requests = new Set<(message: unknown) => void>();
  const cancellations = new Set<(message: unknown) => void>();
  const opening = deferred<WorkbenchWindowReference>();
  const events: string[] = [];
  const port = {
    subscribeRequests(listener) {
      events.push("requests attached");
      requests.add(listener);
      return () => {
        requests.delete(listener);
      };
    },
    subscribeCancellations(listener) {
      events.push("cancellations attached");
      cancellations.add(listener);
      return () => {
        cancellations.delete(listener);
      };
    },
    register: vi.fn<WorkbenchAgentBridgePort["register"]>(() => {
      events.push("register");
      return opening.promise;
    }),
    release: vi.fn<WorkbenchAgentBridgePort["release"]>(async () => {}),
    reply: vi.fn<WorkbenchAgentBridgePort["reply"]>(async () => true),
  } satisfies WorkbenchAgentBridgePort;
  const reference = { windowSessionId: "window-a", rendererGeneration: "generation-a" };
  const request = (requestId: string, target = reference): WorkbenchAgentRequest => ({
    ...target,
    requestId,
    body: { kind: "observe", sceneOwner },
  });
  const start = (commands?: WorkbenchSceneCommandExecutor) => {
    const capability = createWorkbenchAgentBridge(owner, port, { commands });
    disposers.push(capability.dispose);
    return capability;
  };
  return {
    owner,
    sceneOwner,
    scene,
    reference,
    opening,
    port,
    events,
    requests,
    cancellations,
    start,
    request,
    emitRequest: (message: unknown) => {
      for (const listener of requests) listener(message);
    },
    emitCancel: (message: unknown) => {
      for (const listener of cancellations) listener(message);
    },
  };
}

describe("Workbench renderer Agent bridge", () => {
  test("cancels a pending content close before apply and shares the command receipt for duplicate operations", async () => {
    const subject = harness();
    subject.owner.setScene(
      subject.sceneOwner,
      createWorkbenchSceneSurface(subject.scene, {
        panelId: "right",
        surface: {
          id: "page-tab",
          kind: "page_stage",
          titleSnapshot: "Page",
          config: { accessContext: { kind: "project", projectId: "project-a" }, pageId: "page-a" },
          state: null,
          stateKey: 0,
        },
      }),
    );
    const save = deferred<boolean>();
    const prepareClose = vi.fn(async () => true).mockImplementationOnce(() => save.promise);
    const close = vi.fn(async () => {});
    const commit = vi.fn(
      async (snapshot: ReturnType<typeof subject.owner.capturePersistenceSnapshot>) => ({
        ...snapshot,
        sessionId: "window-a",
        layoutRevision: 8,
      }),
    );
    subject.owner.registerPersistenceCommit(commit);
    const bridge = subject.start(
      createWorkbenchSceneCommands(subject.owner, { prepareClose, close }),
    );
    subject.opening.resolve(subject.reference);
    await bridge.ready;
    const expectedPresentationRevision = subject.owner.read().presentationRevision;
    const commandRequest = (requestId: string, operationId: string): WorkbenchAgentRequest => ({
      ...subject.reference,
      requestId,
      body: {
        kind: "command",
        envelope: {
          operationId,
          sceneOwner: subject.sceneOwner,
          expectedPresentationRevision,
          command: { kind: "close_tab", tabId: "page-tab" },
        },
      },
    });
    subject.emitRequest(commandRequest("request-cancelled", "operation-cancelled"));
    await vi.waitFor(() => {
      expect(subject.port.reply.mock.calls).toEqual([]);
      expect(prepareClose).toHaveBeenCalledTimes(1);
    });
    subject.emitCancel({ ...subject.reference, requestId: "request-cancelled" });
    save.resolve(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(subject.owner.read().presentationRevision).toBe(expectedPresentationRevision);
    expect(commit).not.toHaveBeenCalled();
    expect(subject.port.reply).not.toHaveBeenCalled();
    subject.emitRequest(commandRequest("request-first", "operation-retry"));
    subject.emitRequest(commandRequest("request-duplicate", "operation-retry"));
    await vi.waitFor(() => expect(subject.port.reply).toHaveBeenCalledTimes(2));
    expect(prepareClose).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    const replies = subject.port.reply.mock.calls.map(([reply]) => reply.outcome);
    expect(replies[0]).toEqual(replies[1]);
    expect(replies[0]).toMatchObject({
      ok: true,
      result: {
        kind: "command",
        receipt: { applied: true, persisted: true, layoutRevision: 8, error: null },
      },
    });
  });

  test("attaches listeners before registration and captures only its exact ready generation", async () => {
    const subject = harness();
    const bridge = subject.start();
    expect(subject.events).toEqual(["requests attached", "cancellations attached", "register"]);
    expect(captureWorkbenchSubmitPresentation(subject.owner)).toBeNull();
    subject.emitRequest(subject.request("early-request"));
    subject.opening.resolve(subject.reference);
    await bridge.ready;
    await vi.waitFor(() => expect(subject.port.reply).toHaveBeenCalledTimes(1));
    expect(subject.port.reply.mock.calls[0]?.[0]).toMatchObject({
      ...subject.reference,
      requestId: "early-request",
      outcome: {
        ok: true,
        result: {
          kind: "observe",
          observation: { sceneOwner: subject.sceneOwner, presentationRevision: 0 },
        },
      },
    });
    subject.owner.selectProject("project-b");
    expect(captureWorkbenchSubmitPresentation(subject.owner)).toEqual({
      rendererGeneration: subject.reference.rendererGeneration,
      sceneOwner: { kind: "project", projectId: "project-b" },
      presentationRevision: 1,
      focusedTarget: null,
      selectedTabs: [],
    });
    bridge.dispose();
    expect(captureWorkbenchSubmitPresentation(subject.owner)).toBeNull();
    expect(subject.requests.size).toBe(0);
    expect(subject.cancellations.size).toBe(0);
    await vi.waitFor(() => expect(subject.port.release).toHaveBeenCalledWith(subject.reference));
  });

  test("ignores stale requests, cancels exact pending requests, and does not cancel another generation", async () => {
    const subject = harness();
    const bridge = subject.start();
    subject.opening.resolve(subject.reference);
    await bridge.ready;
    const stale = { ...subject.reference, rendererGeneration: "old-generation" };
    subject.emitRequest(subject.request("stale", stale));
    subject.emitRequest(subject.request("cancelled"));
    subject.emitCancel({ ...subject.reference, requestId: "cancelled" });
    subject.emitRequest(subject.request("keep"));
    subject.emitRequest(subject.request("keep"));
    subject.emitCancel({ ...stale, requestId: "keep" });
    subject.emitRequest(subject.request("valid"));
    await vi.waitFor(() => expect(subject.port.reply).toHaveBeenCalledTimes(2));
    expect(subject.port.reply.mock.calls.map(([reply]) => reply.requestId)).toEqual([
      "keep",
      "valid",
    ]);
  });

  test("late registration cleanup releases only its old reference and preserves its replacement", async () => {
    const subject = harness();
    const replacementOpening = deferred<WorkbenchWindowReference>();
    subject.port.register
      .mockImplementationOnce(() => subject.opening.promise)
      .mockImplementationOnce(() => replacementOpening.promise);
    const first = subject.start();
    first.dispose();
    const replacement = subject.start();
    const replacementReference = { ...subject.reference, rendererGeneration: "generation-b" };
    replacementOpening.resolve(replacementReference);
    await replacement.ready;
    subject.opening.resolve(subject.reference);
    await expect(first.ready).resolves.toBeNull();
    expect(subject.port.release).toHaveBeenCalledExactlyOnceWith(subject.reference);
    first.dispose();
    expect(captureWorkbenchSubmitPresentation(subject.owner)?.rendererGeneration).toBe(
      "generation-b",
    );
    expect(new Set(subject.port.register.mock.calls.map(([input]) => input.ownerId)).size).toBe(2);
    replacement.dispose();
    await vi.waitFor(() => expect(subject.port.release).toHaveBeenCalledTimes(2));
    expect(subject.port.release.mock.calls[1]?.[0]).toEqual(replacementReference);
  });

  test("returns a bounded explicit failure for oversized observation evidence", async () => {
    const subject = harness();
    subject.owner.setScene(subject.sceneOwner, (scene) =>
      createWorkbenchSceneSurface(scene!, {
        panelId: "right",
        surface: {
          id: "large-browser",
          kind: "browser",
          titleSnapshot: "Browser",
          stateKey: 0,
          state: null,
          config: { browserTabId: "browser-a", url: "x".repeat(WORKBENCH_AGENT_MAX_REPLY_BYTES) },
        },
      }),
    );
    const bridge = subject.start();
    subject.opening.resolve(subject.reference);
    await bridge.ready;
    subject.emitRequest(subject.request("large"));
    await vi.waitFor(() => expect(subject.port.reply).toHaveBeenCalledTimes(1));
    expect(subject.port.reply.mock.calls[0]?.[0]).toEqual({
      ...subject.reference,
      requestId: "large",
      outcome: { ok: false, error: "result_too_large" },
    });
    expect(
      subject.owner.read().windowState.scenesByOwnerKey["session:session-a"]?.panelSurfacesById[
        "large-browser"
      ],
    ).toBeDefined();
  });

  test("failed registration releases listeners and does not leave a submission capability", async () => {
    const subject = harness();
    const bridge = subject.start();
    const error = new Error("Renderer is unavailable");
    subject.opening.reject(error);
    await expect(bridge.ready).rejects.toBe(error);
    expect(subject.requests.size).toBe(0);
    expect(subject.cancellations.size).toBe(0);
    expect(captureWorkbenchSubmitPresentation(subject.owner)).toBeNull();
  });
});
