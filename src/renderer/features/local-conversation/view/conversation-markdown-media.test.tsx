import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { fixture, key } from "./conversation-markdown-targets.test-fixtures";
import { installWindowApi } from "../../../test/browser-globals";
import { settleAsyncRender } from "../../../test/dom";

const read = vi.fn();
describe("native assistant media source admission", () => {
  beforeEach(() => {
    read.mockReset().mockResolvedValue({ contentsBase64: "aW1hZ2U=", mimeType: "image/png" });
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "read-file-binary") return read(...args);
        throw new Error(`Unsupported fixture operation ${channel}`);
      },
      on: () => () => {},
    });
  });
  afterEach(async () => {
    cleanup();
    await settleAsyncRender();
  });
  test.each(["ordinary", "inline", "voice"] as const)(
    "the %s leaf delegates to its real source host and native item",
    async (family) => {
      const hostId = "remote-ssh-discovered:media";
      const native = fixture("![Source image](/source/image.png)", hostId, family);
      const wholeTurn = vi.spyOn(native.owner, "readTurn");
      const view = native.mount();
      try {
        await act(async () => {
          native.connect();
          await Promise.resolve();
        });
        const image = await view.findByAltText("Source image");
        await waitFor(() =>
          expect(image.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U="),
        );
        expect(read).toHaveBeenCalledExactlyOnceWith({ hostId, path: "/source/image.png" });
        expect(wholeTurn).not.toHaveBeenCalled();
        await act(async () => {
          fireEvent.load(image);
          await Promise.resolve();
        });
        const button = view.getByRole("button", { name: "Source image" });
        await act(async () => {
          button.focus();
          await Promise.resolve();
        });
        const details = native.owner.readTurnDetails(key.entityKey);
        const voice = native.owner.readRealtimeItem("voice");
        await act(async () => {
          if (family === "voice" && voice)
            native.owner.applyEvent({
              type: "changes",
              changes: [
                { type: "realtime-item", itemId: "voice", value: { ...voice, completed: true } },
              ],
            });
          else if (details)
            native.owner.applyEvent({
              type: "changes",
              changes: [
                {
                  type: "turn",
                  key: { hostId, threadId: key.threadId, entityKey: key.entityKey },
                  details: {
                    ...details,
                    status: "completed",
                    lifecycleStatusByItemId: { answer: "completed" },
                  },
                  hasSubagentActivity: false,
                },
              ],
            });
          await Promise.resolve();
        });
        expect(view.getByAltText("Source image")).toBe(image);
        expect(document.activeElement).toBe(button);
        expect(read).toHaveBeenCalledTimes(1);
        await act(async () => {
          native.connect(2);
          await Promise.resolve();
        });
        await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      } finally {
        view.unmount();
        native.dispose();
      }
    },
  );
});
