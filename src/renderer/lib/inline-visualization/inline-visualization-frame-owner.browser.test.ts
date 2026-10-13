import { expect, test } from "vite-plus/test";
import {
  createInlineVisualizationFrameOwner,
  type InlineVisualizationFrameInput,
} from "./inline-visualization-frame-owner";

test("the browser platform retains a parked occurrence and retires it after its window lease ends", async () => {
  const owner = createInlineVisualizationFrameOwner();
  const parking = document.createElement("div");
  const firstAnchor = document.createElement("div");
  const secondAnchor = document.createElement("div");
  document.body.append(parking, firstAnchor, secondAnchor);
  const input: InlineVisualizationFrameInput = {
    identity: {
      surfaceId: "main",
      hostId: "local",
      readHostId: "local",
      threadId: "a",
      sourceThreadId: "a",
      file: "retained.html",
      occurrence: "native-answer",
    },
    fragment: { contents: "<button>Counter</button>", path: "/retained.html" },
    stateIdentity: null,
    attempt: 0,
    canExpand: true,
    retry: () => {},
    followUp: null,
    submitAnnotations: null,
  };
  try {
    const releaseWindow = owner.acquireWindow();
    owner.setParking(parking);
    owner.reportResumeState("local", "a", "resumed");
    owner.setSurface("main", "local", "a");
    const first = owner.bind(input, firstAnchor);
    const container = owner.readFrame(first.frameId)!.container;
    owner.setSurface("main", "local", "b");
    owner.unbind(first);
    firstAnchor.remove();
    await Promise.resolve();
    expect(owner.readIds()).toEqual([first.frameId]);
    expect(container.parentElement).toBe(parking);
    owner.setSurface("main", "local", "a");
    await Promise.resolve();
    owner.reportResumeState("local", "a", "resumed");
    expect(owner.readIds()).toEqual([first.frameId]);
    const returned = owner.bind(input, secondAnchor);
    expect(returned.frameId).toBe(first.frameId);
    expect(container.parentElement).toBe(secondAnchor);
    releaseWindow();
    await Promise.resolve();
    expect(owner.readIds()).toEqual([]);
    expect(container.isConnected).toBe(false);
  } finally {
    owner.dispose();
    parking.remove();
    firstAnchor.remove();
    secondAnchor.remove();
  }
});
