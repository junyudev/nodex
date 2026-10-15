import { describe, expect, test, vi } from "vite-plus/test";
import type { SocketId } from "@excalidraw/excalidraw/types";
import {
  CANVAS_PRESENCE_HEARTBEAT_MS,
  CANVAS_PRESENCE_POINTER_INTERVAL_MS,
  type CanvasPresenceEvent,
} from "../../shared/block-documents";
import { createCanvasPresenceController } from "./canvas-presence-controller";

const remotePresence = (
  clock: number,
  state: CanvasPresenceEvent["state"],
): CanvasPresenceEvent => ({
  engine: "canvas_scene",
  documentId: "document-1",
  generation: 1,
  clock,
  state,
  clientSessionId: "remote-session",
  user: {
    id: "window:2",
    displayName: "Window 2",
    color: "#1971c2",
  },
});

describe("CanvasPresenceController", () => {
  test("throttles pointer publications while selection and heartbeat are immediate", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      const publications: Array<{
        readonly clock: number;
        readonly state:
          | Parameters<ReturnType<typeof createCanvasPresenceController>["updatePointer"]>[0]
          | null
          | object;
      }> = [];
      const controller = createCanvasPresenceController({
        now: () => now,
        schedule: (callback, delayMs) => {
          const timeout = setTimeout(callback, delayMs);
          return () => clearTimeout(timeout);
        },
        publish: async (clock, state) => {
          publications.push({ clock, state });
        },
        onCollaborators: () => undefined,
      });

      controller.updatePointer({
        x: 1,
        y: 2,
        button: "up",
        tool: "pointer",
      });
      controller.updatePointer({
        x: 3,
        y: 4,
        button: "down",
        tool: "pointer",
      });
      expect(publications).toHaveLength(1);
      now += CANVAS_PRESENCE_POINTER_INTERVAL_MS;
      await vi.advanceTimersByTimeAsync(CANVAS_PRESENCE_POINTER_INTERVAL_MS);
      expect(publications.at(-1)?.state).toMatchObject({
        pointer: { x: 3, y: 4 },
      });

      controller.updateSelection(["element-b", "element-a"]);
      expect(publications.at(-1)?.state).toMatchObject({
        selectedElementIds: ["element-a", "element-b"],
      });
      now += CANVAS_PRESENCE_HEARTBEAT_MS;
      await vi.advanceTimersByTimeAsync(CANVAS_PRESENCE_HEARTBEAT_MS);
      expect(publications.at(-1)?.clock).toBe(4);
      await controller.close();
      expect(publications.at(-1)?.state).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("maps snapshots and higher-clock updates to Excalidraw collaborators", () => {
    const observations: Array<ReadonlyMap<SocketId, unknown>> = [];
    const controller = createCanvasPresenceController({
      schedule: () => () => undefined,
      publish: async () => undefined,
      onCollaborators: (next) => observations.push(next),
    });
    const visible = remotePresence(2, {
      pointer: {
        x: 10,
        y: 20,
        button: "up",
        tool: "pointer",
      },
      selectedElementIds: ["element-1"],
      idle: "active",
    });
    controller.receive({
      type: "canvas_presence_snapshot",
      libraryId: "library-1",
      routingContext: { kind: "project", projectId: "project-1" },
      documentId: "document-1",
      generation: 1,
      presences: [visible],
    });
    expect(observations.at(-1)?.get("remote-session" as SocketId)).toMatchObject({
      username: "Window 2",
      pointer: { x: 10, y: 20 },
      selectedElementIds: { "element-1": true },
      color: { stroke: "#1971c2" },
    });

    controller.receive({
      type: "canvas_presence_updated",
      libraryId: "library-1",
      routingContext: { kind: "project", projectId: "project-1" },
      presence: remotePresence(1, null),
    });
    expect(observations.at(-1)?.size).toBe(1);
    controller.receive({
      type: "canvas_presence_updated",
      libraryId: "library-1",
      routingContext: { kind: "project", projectId: "project-1" },
      presence: remotePresence(2, null),
    });
    expect(observations.at(-1)?.size).toBe(0);
  });
});
