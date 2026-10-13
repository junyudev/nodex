import { describe, expect, test } from "vite-plus/test";
import type { CodexQueuedMessage } from "../../../shared/codex-queued-message";
import {
  hasPendingOrdinaryLocalQueuedMessage,
  readMixedCodexQueuedMessages,
} from "./codex-mixed-queued-messages";

const message = (id: string, app = false): CodexQueuedMessage => ({
  id,
  cwd: "/workspace",
  context: {
    prompt: id,
    fileAttachments: [],
    addedFiles: [],
    commentAttachments: [],
    imageAttachments: [],
    ...(app
      ? { untrustedAppMessage: { source: "visualization", sourceId: "widget", text: id } }
      : {}),
  },
});
describe("mixed queued message delivery", () => {
  test("keeps native order, local confirmation and deduplicated client identity independent", () => {
    const server = [message("native-1"), message("native-copy")];
    const local = [message("local-client", true)];
    const read = (local: readonly CodexQueuedMessage[]) =>
      readMixedCodexQueuedMessages({
        local,
        server,
        serverEnabled: true,
        findServerByClientId: (id) => (id === "local-client" ? "native-copy" : undefined),
        readServerClientId: (id) => (id === "native-copy" ? "local-client" : "native-client"),
      });
    expect(read(local)).toEqual([
      { owner: "server", message: server[0], clientUserMessageId: "native-client" },
      { owner: "local", message: local[0], clientUserMessageId: "local-client" },
    ]);
    expect(read([])?.map((row) => row.message.id)).toEqual(["native-1", "native-copy"]);
    expect(hasPendingOrdinaryLocalQueuedMessage(local)).toBe(false);
    expect(hasPendingOrdinaryLocalQueuedMessage([message("captured-text")])).toBe(true);
  });
  test("unloaded native state does not hide a captured app input or invent an empty queue", () => {
    const read = (local: readonly CodexQueuedMessage[] | undefined, enabled = true) =>
      readMixedCodexQueuedMessages({
        local,
        server: undefined,
        serverEnabled: enabled,
        findServerByClientId: () => undefined,
        readServerClientId: () => undefined,
      });
    expect(read([])).toBeUndefined();
    expect(read([message("app", true)])).toMatchObject([
      { owner: "local", message: { id: "app" } },
    ]);
    expect(read([], false)).toEqual([]);
  });
});
