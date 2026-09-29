import { expect, test } from "vite-plus/test";
import type { AgentConversationOwnerSnapshot } from "./agent-conversation-owner";
import { buildNativeHeartbeatAutomationThreadState } from "./native-heartbeat-automation";

const ready = {
  connection: "ready",
  promptPending: false,
  controlPending: null,
  error: null,
  presentation: {
    snapshot: {
      backend: "claude",
      status: "idle",
      requests: [],
      tasks: [],
      liveBackgroundTaskIds: [],
    },
  },
} as unknown as AgentConversationOwnerSnapshot;

test("native Heartbeat readiness follows its current owner and native requests or background tasks", () => {
  const state = buildNativeHeartbeatAutomationThreadState("native", ready);
  expect(state).toMatchObject({
    threadId: "native",
    isEligible: true,
    streamRole: "owner",
    collaborationMode: null,
    permissions: null,
  });
  expect(
    buildNativeHeartbeatAutomationThreadState("native", { ...ready, promptPending: true })
      .isEligible,
  ).toBe(false);
  expect(
    buildNativeHeartbeatAutomationThreadState("native", { ...ready, connection: "failed" })
      .isEligible,
  ).toBe(false);
  expect(
    buildNativeHeartbeatAutomationThreadState("native", {
      ...ready,
      presentation: {
        ...ready.presentation!,
        snapshot: { ...ready.presentation!.snapshot, liveBackgroundTaskIds: ["task"] },
      },
    }).reason,
  ).toBe("native_background_task");
  expect(
    buildNativeHeartbeatAutomationThreadState("native", {
      ...ready,
      presentation: {
        ...ready.presentation!,
        snapshot: { ...ready.presentation!.snapshot, requests: [{ id: "request" } as never] },
      },
    }).reason,
  ).toBe("waiting_on_user_input");
});
