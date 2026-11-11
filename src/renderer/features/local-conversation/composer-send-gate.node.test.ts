import { describe, expect, test, vi } from "vite-plus/test";
import { chatConnectionSendGate } from "./composer-send-gate";

const gate = (input: Partial<Parameters<typeof chatConnectionSendGate>[0]>) =>
  chatConnectionSendGate({
    resumeState: "resumed",
    attachmentState: { status: "attached" },
    reconnectingLong: false,
    failureShownInTranscript: false,
    retry: async () => {},
    ...input,
  });

describe("chatConnectionSendGate", () => {
  test("lets a connected chat send", () => {
    expect(gate({})).toBeNull();
    expect(gate({ resumeState: null, attachmentState: { status: "idle" } })).toBeNull();
  });

  test("holds sending quietly while a chat reconnects, then says so", () => {
    for (const reconnecting of [
      { resumeState: "needs_resume" as const, attachmentState: { status: "idle" as const } },
      { resumeState: "resuming" as const, attachmentState: { status: "attaching" as const } },
      { resumeState: "resumed" as const, attachmentState: { status: "attaching" as const } },
    ]) {
      expect(gate(reconnecting)).toMatchObject({ notice: null });
      expect(gate({ ...reconnecting, reconnectingLong: true })?.notice).toMatchObject({
        tone: "warning",
        title: "Reconnecting to this chat…",
      });
    }
  });

  test("explains a failed connection and retries it", async () => {
    const retry = vi.fn(async () => {});
    const failed = gate({
      resumeState: "needs_resume",
      attachmentState: { status: "failed", message: "socket closed" },
      retry,
    });
    expect(failed?.notice).toMatchObject({
      tone: "danger",
      title: "Couldn’t connect to this chat",
      detail: "socket closed",
    });
    await failed?.notice?.actions?.[0]?.run();
    expect(retry).toHaveBeenCalledOnce();
  });

  test("leaves the failure to an empty transcript that already shows it", () => {
    const failed = gate({
      attachmentState: { status: "failed", message: "socket closed" },
      failureShownInTranscript: true,
    });
    expect(failed).toMatchObject({ notice: null });
  });

  test("names a chat that another app is writing to", () => {
    const conflict = gate({
      attachmentState: { status: "failed", message: "Thread already has an active writer" },
      failureShownInTranscript: true,
    });
    expect(conflict?.notice).toMatchObject({
      tone: "warning",
      title: "This chat is open in another app",
    });
    expect(conflict?.notice?.actions?.map((action) => action.label)).toEqual(["Retry"]);
  });
});
