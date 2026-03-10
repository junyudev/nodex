import { describe, expect, test } from "bun:test";
import { fileLinkOpenerTestHelpers } from "./use-file-link-opener";

const EXAMPLE_FILE_LINK = "/workspace/nodex/src/renderer/lib/nfm/parser.ts#L71";

describe("use-file-link-opener helpers", () => {
  test("deduplicates click opens that immediately follow a handled mouseup", () => {
    expect(fileLinkOpenerTestHelpers.shouldSkipDuplicateClickOpen(
      { at: 100, href: EXAMPLE_FILE_LINK },
      EXAMPLE_FILE_LINK,
      200,
    )).toBeTrue();

    expect(fileLinkOpenerTestHelpers.shouldSkipDuplicateClickOpen(
      { at: 100, href: EXAMPLE_FILE_LINK },
      "/workspace/nodex/src/renderer/lib/nfm/parser.ts#L72",
      200,
    )).toBeFalse();

    expect(fileLinkOpenerTestHelpers.shouldSkipDuplicateClickOpen(
      { at: 100, href: EXAMPLE_FILE_LINK },
      EXAMPLE_FILE_LINK,
      400,
    )).toBeFalse();
  });

  test("resolves text-node click targets to their parent element", () => {
    class FakeElement {
      parentElement: FakeElement | null = null;
    }
    class FakeNode {
      constructor(readonly parentElement: FakeElement | null) {}
    }

    const globals = globalThis as {
      Element?: typeof FakeElement;
      Node?: typeof FakeNode;
    };
    const previousElement = globals.Element;
    const previousNode = globals.Node;
    globals.Element = FakeElement;
    globals.Node = FakeNode;

    try {
      const anchor = new FakeElement();
      const text = new FakeNode(anchor);
      expect(fileLinkOpenerTestHelpers.resolveElementFromEventTarget(text as unknown as EventTarget)).toBe(anchor);
    } finally {
      if (previousElement) {
        globals.Element = previousElement;
      } else {
        delete globals.Element;
      }
      if (previousNode) {
        globals.Node = previousNode;
      } else {
        delete globals.Node;
      }
    }
  });

  test("consumes handled file link clicks so editors cannot also open the href", () => {
    let preventDefaultCalls = 0;
    let stopPropagationCalls = 0;
    let stopImmediatePropagationCalls = 0;

    fileLinkOpenerTestHelpers.consumeHandledFileLinkEvent({
      preventDefault: () => {
        preventDefaultCalls += 1;
      },
      stopPropagation: () => {
        stopPropagationCalls += 1;
      },
      stopImmediatePropagation: () => {
        stopImmediatePropagationCalls += 1;
      },
    });

    expect(preventDefaultCalls).toBe(1);
    expect(stopPropagationCalls).toBe(1);
    expect(stopImmediatePropagationCalls).toBe(1);
  });
});
