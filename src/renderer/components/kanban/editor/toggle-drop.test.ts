import { describe, expect, test } from "bun:test";
import {
  finalizeToggleDropDragSession,
  findToggleOuterFromPoint,
  findToggleOuterFromTarget,
  isToggleDropTargetBlock,
  isSyntheticDnDEvent,
} from "./toggle-drop";

type Closable = {
  closest: (selector: string) => unknown;
};

type ToggleOuterMock = Closable & {
  contains: (node: unknown) => boolean;
  querySelector: (selector: string) => { getAttribute: (name: string) => string | null } | null;
};

/** Default bounding rect for the toggle header — center zone spans y=100..140. */
const DEFAULT_HEADER_RECT = { top: 100, bottom: 140, left: 50, right: 400 };

function createTarget({
  collapsed,
  headerRect = DEFAULT_HEADER_RECT,
}: {
  collapsed: boolean;
  headerRect?: { top: number; bottom: number; left: number; right: number };
}): { target: Closable; outer: ToggleOuterMock } {
  const wrapper = {
    getAttribute: (name: string) => (name === "data-show-children"
      ? (collapsed ? "false" : "true")
      : null),
    closest: (selector: string) => (selector === ".bn-block-content" ? blockContent : null),
  };

  const outer: ToggleOuterMock = {
    closest: () => null,
    contains: () => false,
    querySelector: (selector: string) => (selector === ".bn-toggle-wrapper" ? wrapper : null),
  };

  const blockContent: Closable & { getBoundingClientRect: () => typeof headerRect } = {
    closest: (selector: string) => (selector === ".bn-block-outer" ? outer : null),
    getBoundingClientRect: () => headerRect,
  };

  const target: Closable = {
    closest: (selector: string) => {
      if (selector === ".bn-toggle-wrapper") {
        return wrapper;
      }
      if (selector === ".bn-block-group") {
        return null;
      }
      return null;
    },
  };

  return { target, outer };
}

describe("findToggleOuterFromTarget", () => {
  test("resolves collapsed toggle from text-like event targets", () => {
    const { target, outer } = createTarget({ collapsed: true });
    const textLikeTarget = { parentElement: target } as unknown as EventTarget;

    const result = findToggleOuterFromTarget(textLikeTarget);
    expect(result).toBe(outer as unknown as HTMLElement);
  });

  test("returns null for expanded toggles", () => {
    const { target } = createTarget({ collapsed: false });
    const textLikeTarget = { parentElement: target } as unknown as EventTarget;

    const result = findToggleOuterFromTarget(textLikeTarget);
    expect(result).toBe(null);
  });

  test("returns null when no element-like target is available", () => {
    const result = findToggleOuterFromTarget({} as EventTarget);
    expect(result).toBe(null);
  });
});

describe("findToggleOuterFromPoint", () => {
  test("resolves collapsed toggle when point is in center of header", () => {
    // Header rect: top=100, bottom=140 → center zone with 6px inset = 106..134
    const { target, outer } = createTarget({ collapsed: true });
    const container = {
      ownerDocument: {
        elementsFromPoint: () => [target],
      },
      contains: (node: unknown) => node === target,
    } as unknown as HTMLElement;

    const result = findToggleOuterFromPoint(container, 120, 120); // y=120 is inside center
    expect(result).toBe(outer as unknown as HTMLElement);
  });

  test("returns null when point is at top edge of header (insert-between zone)", () => {
    // Header rect: top=100, bottom=140 → edge inset 6px → top edge zone is y < 106
    const { target } = createTarget({ collapsed: true });
    const container = {
      ownerDocument: {
        elementsFromPoint: () => [target],
      },
      contains: (node: unknown) => node === target,
    } as unknown as HTMLElement;

    const result = findToggleOuterFromPoint(container, 120, 103); // y=103 is in top edge
    expect(result).toBe(null);
  });

  test("returns null when point is at bottom edge of header (insert-between zone)", () => {
    // Header rect: top=100, bottom=140 → edge inset 6px → bottom edge zone is y > 134
    const { target } = createTarget({ collapsed: true });
    const container = {
      ownerDocument: {
        elementsFromPoint: () => [target],
      },
      contains: (node: unknown) => node === target,
    } as unknown as HTMLElement;

    const result = findToggleOuterFromPoint(container, 120, 137); // y=137 is in bottom edge
    expect(result).toBe(null);
  });

  test("returns null when no toggle target exists at point", () => {
    const otherElement = {
      closest: () => null,
    };
    const container = {
      ownerDocument: {
        elementsFromPoint: () => [otherElement],
      },
      contains: () => true,
    } as unknown as HTMLElement;

    const result = findToggleOuterFromPoint(container, 10, 20);
    expect(result).toBe(null);
  });
});

describe("isSyntheticDnDEvent", () => {
  test("returns true when event carries synthetic flag", () => {
    const event = { synthetic: true, isTrusted: true } as unknown as DragEvent;
    expect(isSyntheticDnDEvent(event)).toBeTrue();
  });

  test("returns true for untrusted events", () => {
    const event = { isTrusted: false } as unknown as DragEvent;
    expect(isSyntheticDnDEvent(event)).toBeTrue();
  });

  test("returns false for trusted native-like events", () => {
    const event = { isTrusted: true } as unknown as DragEvent;
    expect(isSyntheticDnDEvent(event)).toBeFalse();
  });
});

describe("isToggleDropTargetBlock", () => {
  test("accepts cardToggle blocks", () => {
    expect(
      isToggleDropTargetBlock({
        type: "cardToggle",
        props: {},
      }),
    ).toBeTrue();
  });

  test("accepts projected cardToggle blocks used by inline embeds", () => {
    expect(
      isToggleDropTargetBlock({
        type: "cardToggle",
        props: {
          projectionOwnerId: "owner-1",
          projectionKind: "cardRef",
          projectionSourceProjectId: "default",
          projectionCardId: "card-1",
        },
      }),
    ).toBeTrue();
  });

  test("accepts toggle headings and rejects non-toggle headings", () => {
    expect(
      isToggleDropTargetBlock({
        type: "heading",
        props: { isToggleable: true },
      }),
    ).toBeTrue();

    expect(
      isToggleDropTargetBlock({
        type: "heading",
        props: { isToggleable: false },
      }),
    ).toBeFalse();
  });

  test("rejects non-toggle block types", () => {
    expect(
      isToggleDropTargetBlock({
        type: "paragraph",
        props: {},
      }),
    ).toBeFalse();
  });
});

describe("finalizeToggleDropDragSession", () => {
  test("clears ProseMirror dragging state and ends SideMenu drag when available", () => {
    let ended = false;
    const draggingState = { id: "stale" };
    const editor = {
      prosemirrorView: {
        state: { selection: {} },
        dragging: draggingState,
        root: {
          querySelectorAll: () => [],
        },
      },
      getExtension: () => ({
        blockDragEnd: () => {
          ended = true;
        },
      }),
    };

    finalizeToggleDropDragSession(
      editor as unknown as Parameters<typeof finalizeToggleDropDragSession>[0],
    );

    expect(editor.prosemirrorView.dragging).toBe(null);
    expect(ended).toBeTrue();
  });

  test("remains a no-op when SideMenu extension is unavailable", () => {
    const editor = {
      prosemirrorView: {
        state: { selection: {} },
        dragging: { id: "stale" },
        root: {
          querySelectorAll: () => [],
        },
      },
      getExtension: () => null,
    };

    finalizeToggleDropDragSession(
      editor as unknown as Parameters<typeof finalizeToggleDropDragSession>[0],
    );

    expect(editor.prosemirrorView.dragging).toBe(null);
  });
});
