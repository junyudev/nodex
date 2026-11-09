import { expect, test } from "vite-plus/test";
import { memberEditCapabilities, REPLIED_SINCE_REASON } from "./agent-runtime-conversation-owner";

test("a chat on this computer edits every message its Provider can rewind to", () => {
  expect(memberEditCapabilities(["r1", "r2"], undefined)).toEqual({
    editableUserTurnIds: ["r1", "r2"],
  });
});

test("a hosted chat edits only the reader's own messages no one else has replied after", () => {
  const edits = new Map([
    ["r1", "replied_since"],
    ["r2", "unavailable"],
    ["r3", "available"],
  ] as const);
  expect(memberEditCapabilities(["r1", "r2", "r3", "r4"], edits)).toEqual({
    editableUserTurnIds: ["r3"],
    userTurnEditRefusals: { r1: REPLIED_SINCE_REASON },
  });
});
