import { describe, expect, test } from "bun:test";
import {
  ThreadSectionRuntimeProvider,
  useThreadSectionRuntime,
  type ThreadSectionLinkedThreadState,
} from "./thread-section-runtime";
import { render } from "../../../test/dom";

function buildRuntime(threadName: string) {
  const thread: ThreadSectionLinkedThreadState = {
    threadId: "thr-1",
    threadName,
    threadPreview: "",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    updatedAt: 1,
  };

  return {
    threads: { [thread.threadId]: thread },
    pendingBlockIds: new Set<string>(),
  };
}

function RuntimeThreadNameConsumer() {
  const runtime = useThreadSectionRuntime();
  return <div>{runtime.threads["thr-1"]?.threadName ?? "missing"}</div>;
}

describe("thread section runtime provider", () => {
  test("passes updated thread titles through the provider", () => {
    const firstRender = render(
      <ThreadSectionRuntimeProvider value={buildRuntime("Old title")}>
        <RuntimeThreadNameConsumer />
      </ThreadSectionRuntimeProvider>
    );
    expect(firstRender.getByText("Old title").textContent).toBe("Old title");

    firstRender.unmount();

    const secondRender = render(
      <ThreadSectionRuntimeProvider value={buildRuntime("New title")}>
        <RuntimeThreadNameConsumer />
      </ThreadSectionRuntimeProvider>
    );

    expect(secondRender.getByText("New title").textContent).toBe("New title");
  });
});
