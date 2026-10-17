import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { Thread } from "../../packages/codex-app-server-protocol/src/v2/Thread";
import type { CodexHostMessage } from "../../src/shared/types";
import type { IpcApi } from "../../src/shared/ipc-api";
import { invokeIpc } from "./support/agent-smoke-harness";
import {
  ElectronScenarioHarness,
  openNodexWindow,
} from "../../scripts/scenarios/harness/electron-e2e-harness";
import { prepareScenarioCodexAppServerRuntimeSync } from "../../scripts/scenarios/runtime/agent-runtime-fixture";

const nativeThreadReadRequest = (
  requestId: string,
): IpcApi["codex:app-server:request"]["args"][0] => ({
  hostId: "local",
  caller: { requestId, timeoutMs: 0, expiresAtMs: null },
  request: {
    method: "thread/read",
    id: requestId,
    params: { threadId: "coalesced-read-thread", includeTurns: true },
  },
});

test("delivers large native responses and raw notifications through one preload ACK receiver", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "native-response-delivery",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_LARGE_HISTORY: "1",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  try {
    const page = await harness.launch();
    await harness.application.evaluate(({ ipcMain }) => {
      const state = { count: 0, duplicates: 0, transfers: new Map<string, Set<number>>() };
      Object.assign(globalThis, { nativeResponseDeliveryEvidence: state });
      ipcMain.on(
        "codex_desktop:chunked-message-ack",
        (_event, transferId: string, sequence: number) => {
          const sequences = state.transfers.get(transferId) ?? new Set<number>();
          if (sequences.has(sequence)) state.duplicates += 1;
          sequences.add(sequence);
          state.transfers.set(transferId, sequences);
          state.count += 1;
        },
      );
    });
    const result = await page.evaluate(async () => {
      const api = window.api;
      if (!api) throw new Error("Missing preload API");
      const invokeNative = (input: IpcApi["codex:app-server:request"]["args"][0]) =>
        api.invoke("codex:app-server:request", input) as Promise<
          IpcApi["codex:app-server:request"]["result"]
        >;
      const observed = [0, 0];
      const responseObserved = [0, 0];
      let receivedThread: Thread | undefined;
      let resolveNotification: (() => void) | undefined;
      const notification = new Promise<void>((resolve) => {
        resolveNotification = resolve;
      });
      const unsubscribes = observed.map((_, index) =>
        api.on("codex:host-message", (payload) => {
          const message = payload as CodexHostMessage;
          if (message.type === "mcp-response" && message.message.id === "e2e-large-history")
            responseObserved[index]! += 1;
          if (
            message.type !== "nativeNotification" ||
            message.notification.method !== "thread/started"
          )
            return;
          if (message.notification.params.thread.id !== "large-response-thread") return;
          observed[index]! += 1;
          receivedThread = message.notification.params.thread;
          if (observed.every((count) => count === 1)) resolveNotification?.();
        }),
      );
      const caller = (requestId: string) => ({ requestId, timeoutMs: 0, expiresAtMs: null });
      try {
        const large = invokeNative({
          hostId: "local",
          caller: caller("e2e-large-history"),
          request: {
            method: "thread/read",
            id: "e2e-large-history",
            params: { threadId: "large-response-thread", includeTurns: true },
          },
        });
        const small = invokeNative({
          hostId: "local",
          caller: caller("e2e-models"),
          request: { method: "model/list", id: "e2e-models", params: {} },
          scheduling: { priority: "critical" },
        });
        const [largeOutcome, smallOutcome] = await Promise.all([large, small]);
        if (largeOutcome.type !== "result") throw new Error(largeOutcome.error.message);
        if (smallOutcome.type !== "result") throw new Error(smallOutcome.error.message);
        const thread = (largeOutcome.result as { thread: Thread }).thread;
        await notification;
        const failure = await invokeNative({
          hostId: "local",
          caller: caller("e2e-unsupported"),
          request: {
            method: "thread/backgroundTerminals/list",
            id: "e2e-unsupported",
            params: { threadId: "large-response-thread" },
          },
        });
        const describeThread = (value: Thread | undefined) => ({
          length: value?.turns.length,
          first: value?.turns[0]?.id,
          last: value?.turns.at(-1)?.id,
          lastText:
            value?.turns.at(-1)?.items.at(-1)?.type === "agentMessage"
              ? (value.turns.at(-1)!.items.at(-1) as { text: string }).text
              : undefined,
        });
        return {
          response: describeThread(thread),
          notification: describeThread(receivedThread),
          observed,
          responseObserved,
          hostId: largeOutcome.hostId,
          hostMetrics: largeOutcome.hostMetrics,
          modelCount: (smallOutcome.result as { data: unknown[] }).data.length,
          error: failure.type === "error" ? failure.error : null,
        };
      } finally {
        for (const unsubscribe of unsubscribes) unsubscribe();
      }
    });
    const expectedThread = {
      length: 4096,
      first: "large-turn-0",
      last: "large-turn-4095",
      lastText: `4095:${"多窗口😀".repeat(256)}`,
    };
    expect(result.response).toEqual(expectedThread);
    expect(result.notification).toEqual(expectedThread);
    expect(result.observed).toEqual([1, 1]);
    expect(result.responseObserved).toEqual([1, 1]);
    expect(result.hostId).toBe("local");
    expect(result.modelCount).toBeGreaterThan(0);
    expect(result.error?.code).toBe(-32601);
    expect(result.error?.message).toContain("thread/backgroundTerminals/list");
    const logged = fs
      .readFileSync(path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: { responseBytes?: number } });
    const responseBytes = logged.find((entry) => entry.method === "large-history-response")?.params
      .responseBytes;
    expect(responseBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(result.hostMetrics?.responseBytes).toBe(responseBytes);
    const acks = await harness.application.evaluate(() => {
      const state = (
        globalThis as unknown as {
          nativeResponseDeliveryEvidence: {
            count: number;
            duplicates: number;
            transfers: Map<string, Set<number>>;
          };
        }
      ).nativeResponseDeliveryEvidence;
      return { count: state.count, duplicates: state.duplicates, transfers: state.transfers.size };
    });
    expect(acks.count).toBeGreaterThan(6);
    expect(acks.duplicates).toBe(0);
    expect(acks.transfers).toBeGreaterThanOrEqual(2);
  } finally {
    await harness.close();
  }
});

test("does not broadcast a destroyed coalesced leader when a live waiter receives the shared response", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "native-coalesced-destroyed-leader",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_THREAD_READ_RELEASE_PATH: ".fake-codex/release-thread-read",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  const logPath = path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl");
  const releasePath = path.join(harness.profile.runRoot, ".fake-codex/release-thread-read");
  const readLog = () =>
    fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: { requestId?: string } });
  try {
    const first = await harness.launch();
    const second = await openNodexWindow(harness.application, async () => {
      expect(await invokeIpc(first, "window:new", {})).toBe(true);
    });
    fs.rmSync(releasePath, { force: true });

    await second.evaluate(() => {
      const api = window.api;
      if (!api) throw new Error("Missing preload API");
      const messages: CodexHostMessage[] = [];
      const unsubscribe = api.on("codex:host-message", (payload) => {
        const message = payload as CodexHostMessage;
        if (message.type !== "mcp-response") return;
        if (!String(message.message.id).startsWith("coalesced:")) return;
        messages.push(message);
      });
      Object.assign(window, { coalescedDeliveryEvidence: { messages, unsubscribe } });
    });

    await first.evaluate<void, unknown>((input) => {
      const api = window.api;
      if (!api) throw new Error("Missing preload API");
      void api.invoke("codex:app-server:request", input).catch(() => undefined);
    }, nativeThreadReadRequest("coalesced:leader"));
    await expect
      .poll(() => readLog().filter((entry) => entry.method === "thread/read-held").length)
      .toBe(1);

    await second.evaluate<void, unknown>((input) => {
      const api = window.api;
      if (!api) throw new Error("Missing preload API");
      void api.invoke("codex:app-server:request", input).catch(() => undefined);
    }, nativeThreadReadRequest("coalesced:follower"));
    await second.waitForTimeout(100);
    expect(readLog().filter((entry) => entry.method === "thread/read-held")).toHaveLength(1);

    await first.close();
    fs.writeFileSync(releasePath, "release\n");
    await expect
      .poll(() =>
        second.evaluate(() => {
          const evidence = (
            window as unknown as {
              coalescedDeliveryEvidence: { messages: CodexHostMessage[]; unsubscribe: () => void };
            }
          ).coalescedDeliveryEvidence;
          return evidence.messages.map((message) =>
            message.type === "mcp-response" ? message.message.id : null,
          );
        }),
      )
      .toEqual(["coalesced:follower"]);
    expect(readLog().filter((entry) => entry.method === "thread/read-held")).toHaveLength(1);
    expect(readLog().filter((entry) => entry.method === "thread/read-released")).toHaveLength(1);
    await second.evaluate(() =>
      (
        window as unknown as {
          coalescedDeliveryEvidence: { messages: CodexHostMessage[]; unsubscribe: () => void };
        }
      ).coalescedDeliveryEvidence.unsubscribe(),
    );
  } finally {
    await harness.close();
  }
});

test("uses the exact request-id prefixes when routing destroyed read responses", async () => {
  test.setTimeout(120_000);
  const harness = await ElectronScenarioHarness.create({
    label: "native-destroyed-read-prefix-routing",
    prepareAgentRuntime: false,
    environment: {
      NODEX_FAKE_CODEX_STATE_PATH: ".fake-codex/state.json",
      NODEX_FAKE_CODEX_LOG_PATH: ".fake-codex/requests.jsonl",
      NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT: ".",
      NODEX_FAKE_CODEX_THREAD_READ_RELEASE_PATH: ".fake-codex/release-thread-read",
    },
  });
  prepareScenarioCodexAppServerRuntimeSync(
    harness.profile.runRoot,
    path.resolve("tests/e2e/fixtures/codex-queue-app-server.mjs"),
  );
  const logPath = path.join(harness.profile.runRoot, ".fake-codex/requests.jsonl");
  const releasePath = path.join(harness.profile.runRoot, ".fake-codex/release-thread-read");
  const readLog = () =>
    fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method: string; params: { requestId?: string } });
  const installEvidence = (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      const api = window.api;
      if (!api) throw new Error("Missing preload API");
      const messages: CodexHostMessage[] = [];
      const unsubscribe = api.on("codex:host-message", (payload) => {
        const message = payload as CodexHostMessage;
        if (message.type !== "mcp-response") return;
        if (!String(message.message.id).includes("destroyed-read")) return;
        messages.push(message);
      });
      Object.assign(window, { destroyedReadEvidence: { messages, unsubscribe } });
    });
  try {
    const first = await harness.launch();
    const second = await openNodexWindow(harness.application, async () => {
      expect(await invokeIpc(first, "window:new", {})).toBe(true);
    });
    await installEvidence(second);

    fs.rmSync(releasePath, { force: true });
    await first.evaluate<void, unknown>((input) => {
      const api = window.api;
      if (!api) throw new Error("Missing preload API");
      void api.invoke("codex:app-server:request", input).catch(() => undefined);
    }, nativeThreadReadRequest("destroyed-read-random-uuid"));
    await expect
      .poll(() => readLog().filter((entry) => entry.method === "thread/read-held").length)
      .toBe(1);
    await first.close();
    fs.writeFileSync(releasePath, "release\n");
    await expect
      .poll(() =>
        second.evaluate(() =>
          (
            window as unknown as {
              destroyedReadEvidence: { messages: CodexHostMessage[]; unsubscribe: () => void };
            }
          ).destroyedReadEvidence.messages.map((message) =>
            message.type === "mcp-response" ? message.message.id : null,
          ),
        ),
      )
      .toEqual(["destroyed-read-random-uuid"]);

    fs.rmSync(releasePath, { force: true });
    const third = await openNodexWindow(harness.application, async () => {
      expect(await invokeIpc(second, "window:new", {})).toBe(true);
    });
    await installEvidence(third);
    await second.evaluate<void, unknown>((input) => {
      const api = window.api;
      if (!api) throw new Error("Missing preload API");
      void api.invoke("codex:app-server:request", input).catch(() => undefined);
    }, nativeThreadReadRequest("thread/read:destroyed-read-prefixed"));
    await expect
      .poll(() => readLog().filter((entry) => entry.method === "thread/read-held").length)
      .toBe(2);
    await second.close();
    fs.writeFileSync(releasePath, "release\n");
    await expect
      .poll(() => readLog().filter((entry) => entry.method === "thread/read-released").length)
      .toBe(2);
    await third.waitForTimeout(100);
    expect(
      await third.evaluate(
        () =>
          (
            window as unknown as {
              destroyedReadEvidence: { messages: CodexHostMessage[]; unsubscribe: () => void };
            }
          ).destroyedReadEvidence.messages,
      ),
    ).toEqual([]);
    await third.evaluate(() =>
      (
        window as unknown as {
          destroyedReadEvidence: { messages: CodexHostMessage[]; unsubscribe: () => void };
        }
      ).destroyedReadEvidence.unsubscribe(),
    );
  } finally {
    await harness.close();
  }
});
