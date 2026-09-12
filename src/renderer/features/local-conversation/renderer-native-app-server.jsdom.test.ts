import { afterEach, expect, test, vi } from "vite-plus/test";
import type { CodexHostMessage } from "../../../shared/types";
import type { CodexNativeRequestOutcome } from "../../../shared/codex-native-request-outcome";
import { RendererNativeAppServer } from "./renderer-native-app-server";
import { __resetCodexAppServerMessageBusForTests } from "./app-server-message-bus";
import {
  __resetLocalConversationHostBridgeForTests,
  startLocalConversationHostBridge,
} from "./local-conversation-host-bridge";

const fixture = vi.hoisted(() => ({
  listener: null as ((message: CodexHostMessage) => void) | null,
  dispatch: vi.fn<(...args: unknown[]) => Promise<CodexNativeRequestOutcome<unknown>>>(),
}));

vi.mock("./local-conversation-deps", () => ({
  runConversationOperation: (...args: unknown[]) => fixture.dispatch(...args),
  subscribeCodexHostMessages: (listener: (message: CodexHostMessage) => void) => {
    fixture.listener = listener;
    return () => {
      fixture.listener = null;
    };
  },
}));

afterEach(() => {
  __resetLocalConversationHostBridgeForTests();
  __resetCodexAppServerMessageBusForTests();
  fixture.dispatch.mockReset();
});

test("routes host delivery into native requests while preserving host isolation and late completion", async () => {
  startLocalConversationHostBridge();
  using local = new RendererNativeAppServer("local");
  using remote = new RendererNativeAppServer("remote");
  const localUnknown = vi.fn();
  const remoteUnknown = vi.fn();
  let finishLocal!: (value: CodexNativeRequestOutcome<unknown>) => void;
  let finishRemote!: (value: CodexNativeRequestOutcome<unknown>) => void;
  fixture.dispatch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLocal = resolve;
      }),
  );
  fixture.dispatch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRemote = resolve;
      }),
  );
  const params = { threadId: "thread", items: [] };
  const localResult = local.request("thread/inject_items", params, {
    requestId: "same-id",
    onOutcomeUnknown: localUnknown,
  });
  const remoteResult = remote.request("thread/inject_items", params, {
    requestId: "same-id",
    onOutcomeUnknown: remoteUnknown,
  });
  const delivery = {
    requestId: "same-id",
    method: "thread/inject_items",
    stage: "outcome-unknown",
  } as const;
  fixture.listener?.({
    type: "mcp-request-delivery",
    hostId: "local",
    update: { type: "outcome-unknown", delivery },
  });
  fixture.listener?.({
    type: "mcp-request-delivery",
    hostId: "local",
    update: { type: "outcome-unknown", delivery },
  });
  expect(localUnknown).toHaveBeenCalledExactlyOnceWith(delivery);
  expect(remoteUnknown).not.toHaveBeenCalled();
  finishLocal({ type: "result", result: {} });
  await expect(localResult).resolves.toEqual({});
  const rejected = expect(remoteResult).rejects.toMatchObject({
    message: "Host disconnected",
    delivery,
  });
  fixture.listener?.({
    type: "mcp-request-delivery",
    hostId: "remote",
    update: { type: "failed", delivery, message: "Host disconnected" },
  });
  await rejected;
  finishRemote({ type: "result", result: {} });
  await expect(remoteResult).rejects.toThrow("Host disconnected");
});

test("disposes pending requests and delivery subscriptions before replacement", async () => {
  startLocalConversationHostBridge();
  const old = new RendererNativeAppServer("local");
  const oldUnknown = vi.fn();
  fixture.dispatch.mockImplementation(async () => new Promise(() => {}));
  const result = old.request(
    "thread/inject_items",
    { threadId: "thread", items: [] },
    { requestId: "reused", onOutcomeUnknown: oldUnknown },
  );
  const rejected = expect(result).rejects.toThrow("disposed");
  old[Symbol.dispose]();
  await rejected;
  using replacement = new RendererNativeAppServer("local");
  let finish!: (value: CodexNativeRequestOutcome<unknown>) => void;
  fixture.dispatch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const replacementUnknown = vi.fn();
  const next = replacement.request(
    "thread/inject_items",
    { threadId: "thread", items: [] },
    { requestId: "reused", onOutcomeUnknown: replacementUnknown },
  );
  fixture.listener?.({
    type: "mcp-request-delivery",
    hostId: "local",
    update: {
      type: "outcome-unknown",
      delivery: { requestId: "reused", method: "thread/inject_items", stage: "outcome-unknown" },
    },
  });
  expect(oldUnknown).not.toHaveBeenCalled();
  expect(replacementUnknown).toHaveBeenCalledOnce();
  finish({ type: "result", result: {} });
  await expect(next).resolves.toEqual({});
});
