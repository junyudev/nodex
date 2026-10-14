import { expect, test } from "vite-plus/test";
import { readCodexFollowUpDeliveryPolicy } from "./codex-follow-up-delivery-policy";

test.each([
  { threadStartKind: "aeon", threadSource: null },
  { threadStartKind: null, threadSource: "aeon" },
])("uses the Thread's exact execution provenance: %j", (source) => {
  expect(readCodexFollowUpDeliveryPolicy(source)).toBe("send-now");
});

test.each([
  { threadStartKind: null, threadSource: null, mode: "aeon" },
  { threadStartKind: "AEON", threadSource: " aeon " },
  { threadStartKind: "ordinary", threadSource: "voice", active: true },
])("does not grant immediate delivery from adjacent metadata: %j", (source) => {
  expect(readCodexFollowUpDeliveryPolicy(source)).toBe("queue");
});
