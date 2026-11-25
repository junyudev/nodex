import { expect, it } from "vite-plus/test";
import { makeLocalConversationAttachmentFailure } from "./conversation-attachment-state";

it("shows the reason a conversation could not be restored, without the IPC channel", () => {
  expect(
    makeLocalConversationAttachmentFailure(
      new Error(
        "Error invoking remote method 'agent-runtime:session:read': Error: Agent execution could not start. Nodex will try again with your next Agent action.",
      ),
    ),
  ).toEqual({
    status: "failed",
    message: "Agent execution could not start. Nodex will try again with your next Agent action.",
  });
  expect(
    makeLocalConversationAttachmentFailure(
      new Error("Error invoking remote method 'agent-runtime:session:read': Error: "),
    ),
  ).toEqual({ status: "failed", message: "The thread could not be restored." });
});
