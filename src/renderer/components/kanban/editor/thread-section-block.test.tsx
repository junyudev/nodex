import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ThreadSectionRuntimeProvider,
  useThreadSectionRuntime,
  type ThreadSectionLinkedThreadState,
} from "./thread-section-runtime";

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
    const firstMarkup = renderToStaticMarkup(
      <ThreadSectionRuntimeProvider value={buildRuntime("Old title")}>
        <RuntimeThreadNameConsumer />
      </ThreadSectionRuntimeProvider>
    );
    const secondMarkup = renderToStaticMarkup(
      <ThreadSectionRuntimeProvider value={buildRuntime("New title")}>
        <RuntimeThreadNameConsumer />
      </ThreadSectionRuntimeProvider>
    );

    expect(firstMarkup.includes("Old title")).toBeTrue();
    expect(secondMarkup.includes("New title")).toBeTrue();
  });
});
