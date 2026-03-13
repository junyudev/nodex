import { describe, expect, test } from "bun:test";
import {
  buildExternalCardDropMoveRequest,
  resolveExternalCardDropTarget,
} from "./board-drop-routing";
import { registerCardDropTarget } from "./editor/card-drop-target-registry";
import type { ExternalCardDragSession } from "./editor/external-card-drag-session";

function createTargetElement(): HTMLElement {
  const ownerDocument = {
    elementsFromPoint: () => [element],
  };

  const element = {
    ownerDocument,
    contains: (node: unknown) => node === element,
  };

  return element as unknown as HTMLElement;
}

function createSession(pointer: { x: number; y: number } | null): ExternalCardDragSession {
  return {
    id: "session-1",
    pointer,
    payload: {
      projectId: "default",
      cards: [
        {
          columnId: "in_progress",
          columnName: "In Progress",
          card: {
            id: "card-1",
            status: "in_progress",
            archived: false,
            title: "Title",
            description: "",
            priority: "p2-medium",
            tags: [],
            agentBlocked: false,
            created: new Date("2026-02-14T00:00:00.000Z"),
            order: 0,
          },
        },
      ],
    },
  };
}

describe("board card-drop routing", () => {
  test("prefers editor drop target when pointer is over a registered editor target", () => {
    const element = createTargetElement();
    const unregister = registerCardDropTarget({
      id: "target-1",
      element,
      canDrop: () => true,
      applyDrop: () => null,
    });

    const target = resolveExternalCardDropTarget(createSession({ x: 10, y: 10 }));
    unregister();

    expect(target?.id).toBe("target-1");
  });

  test("allows editor drop routing while a filtered board search is active", () => {
    const element = createTargetElement();
    const unregister = registerCardDropTarget({
      id: "target-2",
      element,
      canDrop: () => true,
      applyDrop: () => null,
    });

    const target = resolveExternalCardDropTarget(createSession({ x: 10, y: 10 }));
    unregister();

    expect(target?.id).toBe("target-2");
  });

  test("buildExternalCardDropMoveRequest keeps same-project drop payload local", () => {
    const request = buildExternalCardDropMoveRequest({
      sourceProjectId: "default",
      sourceCards: [
        {
          cardId: "source-1",
          status: "in_progress",
        },
      ],
      groupId: "group-1",
      targetUpdates: [
        {
          projectId: "default",
          status: "in_progress",
          cardId: "target-1",
          updates: { description: "Updated" },
        },
      ],
    });

    expect(request?.targetProjectId).toBe("default");
    expect(request?.input.sourceProjectId).toBe(undefined);
    expect(request?.input.sourceCardId).toBe("source-1");
    expect(request?.input.sourceCards?.map((source) => source.cardId).join(",")).toBe("source-1");
  });

  test("buildExternalCardDropMoveRequest sets sourceProjectId for cross-project drop", () => {
    const request = buildExternalCardDropMoveRequest({
      sourceProjectId: "alpha",
      sourceCards: [
        {
          cardId: "source-1",
          status: "in_progress",
        },
        {
          cardId: "source-2",
          status: "in_review",
        },
      ],
      groupId: "group-2",
      targetUpdates: [
        {
          projectId: "beta",
          status: "in_progress",
          cardId: "target-1",
          updates: { description: "Updated" },
        },
      ],
    });

    expect(request?.targetProjectId).toBe("beta");
    expect(request?.input.sourceProjectId).toBe("alpha");
    expect(request?.input.groupId).toBe("group-2");
    expect(request?.input.sourceCards?.map((source) => source.cardId).join(",")).toBe("source-1,source-2");
  });

  test("buildExternalCardDropMoveRequest rejects mixed target projects", () => {
    const request = buildExternalCardDropMoveRequest({
      sourceProjectId: "default",
      sourceCards: [
        {
          cardId: "source-1",
          status: "in_progress",
        },
      ],
      groupId: "group-3",
      targetUpdates: [
        {
          projectId: "default",
          status: "in_progress",
          cardId: "target-1",
          updates: { description: "One" },
        },
        {
          projectId: "other",
          status: "in_progress",
          cardId: "target-2",
          updates: { description: "Two" },
        },
      ],
    });

    expect(request).toBe(null);
  });
});
