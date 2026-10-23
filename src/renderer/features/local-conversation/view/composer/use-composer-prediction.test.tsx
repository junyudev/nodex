import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodexComposerPredictionResult } from "../../../../../shared/codex-composer-prediction";
import { resetComposerPredictionSettingsOwnersForTests } from "../../composer-prediction-settings";
import { installWindowApi } from "../../../../test/browser-globals";
import { predictionResult } from "./composer-prediction.test-fixtures";
import { useComposerPrediction } from "./use-composer-prediction";
import { ConversationRuntimeContext, type ConversationRuntime } from "../../conversation-runtime";

const mocks = vi.hoisted(() => ({
  operation: vi.fn(),
  telemetry: vi.fn(),
  available: false,
}));
vi.mock("../../local-conversation-operations", () => ({
  runConversationOperation: mocks.operation,
}));
vi.mock("../../../../lib/statsig-telemetry", () => ({ logTelemetryEvent: mocks.telemetry }));

const clients: QueryClient[] = [];
const preferenceListeners = new Set<(settings: { enabled: boolean }) => void>();
let preference = true;
const writeComposerPredictionsEnabled = (enabled: boolean) => {
  preference = enabled;
  for (const listener of preferenceListeners) listener({ enabled });
};
beforeEach(() => {
  preference = true;
  preferenceListeners.clear();
  resetComposerPredictionSettingsOwnersForTests();
  installWindowApi({
    invoke: async (channel: string) => {
      if (channel === "settings:composer-predictions:get") return { enabled: preference };
      throw new Error(`Unexpected setting: ${channel}`);
    },
    on: (channel: string, callback: (settings: { enabled: boolean }) => void) => {
      if (channel !== "composer-prediction-settings-changed") return () => {};
      preferenceListeners.add(callback);
      return () => preferenceListeners.delete(callback);
    },
  });
  mocks.available = false;
  mocks.telemetry.mockReset();
  mocks.operation.mockReset();
  mocks.operation.mockImplementation(async (channel: string, input: { latestTurnId?: string }) => {
    if (channel === "codex:composer-prediction:availability")
      return { enabled: mocks.available, source: null, scope: "local" };
    if (channel === "codex:composer-prediction:request")
      return predictionResult(input.latestTurnId);
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
});

function mount(
  props = {
    hostId: "local",
    threadId: "root",
    latestTurnId: "source-turn",
    eligible: true,
    connected: true,
  },
  runtime?: ConversationRuntime,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return renderHook((input) => useComposerPrediction(input), {
    initialProps: props,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ConversationRuntimeContext value={runtime ?? null}>{children}</ConversationRuntimeContext>
      </QueryClientProvider>
    ),
  });
}

const requests = () =>
  mocks.operation.mock.calls.filter(([channel]) => channel === "codex:composer-prediction:request");

it.each(["codex", "claude"] as const)(
  "routes %s Runtime prediction eligibility through its actual driver",
  async (kind) => {
    mocks.available = true;
    const hook = mount(undefined, { kind } as ConversationRuntime);
    if (kind === "codex") {
      await waitFor(() => expect(requests()).toHaveLength(1));
      expect(hook.result.current.prediction?.sourceTurnId).toBe("source-turn");
      return;
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.operation).not.toHaveBeenCalled();
  },
);

it("requires explicit enabled availability before any catch-up inference", async () => {
  const hook = mount();
  await waitFor(() =>
    expect(mocks.operation).toHaveBeenCalledWith("codex:composer-prediction:availability", "local"),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(requests()).toHaveLength(0);
  expect(hook.result.current.prediction).toBeNull();
});

it("excludes disconnected and ineligible composers and local preference disables consumption", async () => {
  mocks.available = true;
  const hook = mount({
    hostId: "local",
    threadId: "root",
    latestTurnId: "source-turn",
    eligible: true,
    connected: false,
  });
  await waitFor(() => expect(mocks.operation).toHaveBeenCalled());
  expect(requests()).toHaveLength(0);
  hook.rerender({
    hostId: "local",
    threadId: "root",
    latestTurnId: "source-turn",
    eligible: false,
    connected: true,
  });
  expect(requests()).toHaveLength(0);
  await act(async () => {
    writeComposerPredictionsEnabled(false);
    await Promise.resolve();
  });
  hook.rerender({
    hostId: "local",
    threadId: "root",
    latestTurnId: "source-turn",
    eligible: true,
    connected: true,
  });
  expect(requests()).toHaveLength(0);
  expect(hook.result.current.prediction).toBeNull();
});

it("suppresses a submitted source Turn and records accepted edits only after sent completion", async () => {
  mocks.available = true;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.prediction?.sourceTurnId).toBe("source-turn"));
  const prediction = hook.result.current.prediction!;
  await act(async () => {
    hook.result.current.onInteraction({ prediction, action: "shown" });
    hook.result.current.onInteraction({
      prediction,
      action: "accepted",
      acceptedText: prediction.text!,
    });
    await Promise.resolve();
  });
  const submittedEvents = () =>
    mocks.telemetry.mock.calls.filter(([name]) => name === "codex_composer_prediction_submitted");
  let submission: ReturnType<typeof hook.result.current.beforeSubmit> = null;
  await act(async () => {
    submission = hook.result.current.beforeSubmit();
    await Promise.resolve();
  });
  expect(hook.result.current.prediction).toBeNull();
  expect(submittedEvents()).toHaveLength(0);
  hook.rerender({
    hostId: "local",
    threadId: "root",
    latestTurnId: "source-turn",
    eligible: true,
    connected: true,
  });
  expect(requests()).toHaveLength(1);
  await act(async () => {
    hook.result.current.recordSubmitted(submission, "Edited accepted text");
    await Promise.resolve();
  });
  expect(submittedEvents()[0]?.[2]).toMatchObject({ acceptedPrediction: true, edited: true });
  hook.rerender({
    hostId: "local",
    threadId: "root",
    latestTurnId: "next-turn",
    eligible: true,
    connected: true,
  });
  await waitFor(() => expect(hook.result.current.prediction?.sourceTurnId).toBe("next-turn"));
  expect(requests()).toHaveLength(2);
});

it("rejects a late old-turn response after the composer target changes", async () => {
  mocks.available = true;
  let resolveOld!: (prediction: CodexComposerPredictionResult) => void;
  const pendingOld = new Promise<CodexComposerPredictionResult>((resolve) => {
    resolveOld = resolve;
  });
  mocks.operation.mockImplementation(async (channel: string, input: { latestTurnId?: string }) => {
    if (channel === "codex:composer-prediction:availability")
      return { enabled: true, source: "environment", scope: "local" };
    if (channel !== "codex:composer-prediction:request") return undefined;
    return input.latestTurnId === "source-turn" ? pendingOld : predictionResult(input.latestTurnId);
  });
  const hook = mount();
  await waitFor(() => expect(requests()).toHaveLength(1));
  hook.rerender({
    hostId: "local",
    threadId: "root",
    latestTurnId: "next-turn",
    eligible: true,
    connected: true,
  });
  await waitFor(() => expect(hook.result.current.prediction?.sourceTurnId).toBe("next-turn"));
  await act(async () => {
    resolveOld(predictionResult());
    await Promise.resolve();
  });
  expect(hook.result.current.prediction?.sourceTurnId).toBe("next-turn");
});

it("clears Renderer caches when the Profile preference is disabled", async () => {
  mocks.available = true;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.prediction?.sourceTurnId).toBe("source-turn"));
  expect(requests()).toHaveLength(1);
  await act(async () => {
    writeComposerPredictionsEnabled(false);
    await Promise.resolve();
  });
  expect(hook.result.current.prediction).toBeNull();
  expect(
    clients[0]?.getQueryData(["composer_prediction", "local", ["root", "source-turn"]]),
  ).toBeUndefined();
  await act(async () => {
    writeComposerPredictionsEnabled(true);
    await Promise.resolve();
  });
  await waitFor(() => expect(requests()).toHaveLength(2));
  await waitFor(() => expect(hook.result.current.prediction?.sourceTurnId).toBe("source-turn"));
});

it("clears cached previews when preference is disabled during an ineligible Turn", async () => {
  mocks.available = true;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.prediction?.sourceTurnId).toBe("source-turn"));
  hook.rerender({
    hostId: "local",
    threadId: "root",
    latestTurnId: "source-turn",
    eligible: false,
    connected: true,
  });
  expect(hook.result.current.prediction).toBeNull();
  await act(async () => {
    writeComposerPredictionsEnabled(false);
    await Promise.resolve();
  });
  expect(
    clients[0]?.getQueryData(["composer_prediction", "local", ["root", "source-turn"]]),
  ).toBeUndefined();
  expect(requests()).toHaveLength(1);
});

it("releases an old target during disconnect and requests its fresh Main entry after reconnect", async () => {
  mocks.available = true;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.prediction?.sourceTurnId).toBe("source-turn"));
  hook.rerender({
    hostId: "local",
    threadId: "root",
    latestTurnId: "source-turn",
    eligible: true,
    connected: false,
  });
  expect(hook.result.current.prediction).toBeNull();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
  hook.rerender({
    hostId: "local",
    threadId: "root",
    latestTurnId: "source-turn",
    eligible: true,
    connected: true,
  });
  await waitFor(() => expect(requests()).toHaveLength(2));
  await waitFor(() => expect(hook.result.current.prediction?.sourceTurnId).toBe("source-turn"));
});
