import { describe, expect, test } from "vite-plus/test";
import {
  CANVAS_PRESENCE_TTL_MS,
  type CanvasPresenceRealtimeEvent,
} from "../../shared/block-documents/document-presence";
import { createCanvasPresenceHub, type CanvasPresenceHubBinding } from "../canvas-presence-hub";

const state = (x: number) => ({
  pointer: {
    x,
    y: 4,
    button: "up" as const,
    tool: "pointer" as const,
  },
  selectedElementIds: ["element-1"],
  idle: "active" as const,
});

describe("CanvasPresenceHub", () => {
  test("uses higher clocks, sender exclusion, snapshots, clean removal, and TTL", () => {
    let now = 1_000;
    const events = new Map<string, CanvasPresenceRealtimeEvent[]>();
    const hub = createCanvasPresenceHub({
      now: () => now,
    });
    const binding = (key: string, targetId: number): CanvasPresenceHubBinding => ({
      key,
      targetId,
      libraryId: "library-1",
      routingContext: { kind: "project", projectId: "project-1" },
      documentId: "document-1",
      clientSessionId: `session-${key}`,
      send: (event) => {
        const current = events.get(key) ?? [];
        current.push(event);
        events.set(key, current);
      },
    });
    hub.register(binding("a", 1));
    hub.register(binding("b", 2));
    hub.adoptBoundary("a", 3);
    hub.adoptBoundary("b", 3);
    events.clear();

    expect(
      hub.publish("a", {
        engine: "canvas_scene",
        documentId: "document-1",
        generation: 3,
        clock: 1,
        state: state(1),
      }),
    ).toEqual({ accepted: true, applied: true });
    expect(events.get("a")).toBeUndefined();
    expect(events.get("b")?.at(-1)).toMatchObject({
      type: "canvas_presence_updated",
      presence: {
        clientSessionId: "session-a",
        state: { pointer: { x: 1 } },
        user: { id: "window:1", displayName: "Window 1" },
      },
    });

    expect(
      hub.publish("a", {
        engine: "canvas_scene",
        documentId: "document-1",
        generation: 3,
        clock: 1,
        state: state(2),
      }).applied,
    ).toBe(false);
    expect(
      hub.publish("a", {
        engine: "canvas_scene",
        documentId: "document-1",
        generation: 3,
        clock: 2,
        state: state(2),
      }).applied,
    ).toBe(true);

    hub.register(binding("c", 3));
    hub.adoptBoundary("c", 3);
    expect(events.get("c")?.at(-1)).toMatchObject({
      type: "canvas_presence_snapshot",
      presences: [{ clientSessionId: "session-a", clock: 2 }],
    });

    now += CANVAS_PRESENCE_TTL_MS - 1;
    hub.sweep();
    expect(events.get("b")?.at(-1)).toMatchObject({
      presence: { state: { pointer: { x: 2 } } },
    });
    now += 1;
    hub.sweep();
    expect(events.get("b")?.at(-1)).toMatchObject({
      presence: { clock: 2, state: null },
    });

    expect(
      hub.publish("a", {
        engine: "canvas_scene",
        documentId: "document-1",
        generation: 3,
        clock: 2,
        state: state(3),
      }).applied,
    ).toBe(false);
    expect(
      hub.publish("a", {
        engine: "canvas_scene",
        documentId: "document-1",
        generation: 3,
        clock: 3,
        state: state(3),
      }).applied,
    ).toBe(true);
    hub.unregister("a");
    expect(events.get("b")?.at(-1)).toMatchObject({
      presence: { clock: 3, state: null },
    });
    hub.destroy();
  });

  test("accepts equal-clock null only for a visible state and resets on generation", () => {
    const received: CanvasPresenceRealtimeEvent[] = [];
    const hub = createCanvasPresenceHub();
    hub.register({
      key: "a",
      targetId: 1,
      libraryId: "library-1",
      routingContext: { kind: "project", projectId: "project-1" },
      documentId: "document-1",
      clientSessionId: "session-a",
      send: () => undefined,
    });
    hub.register({
      key: "b",
      targetId: 2,
      libraryId: "library-1",
      routingContext: { kind: "project", projectId: "project-1" },
      documentId: "document-1",
      clientSessionId: "session-b",
      send: (event) => received.push(event),
    });
    hub.adoptBoundary("a", 1);
    hub.adoptBoundary("b", 1);
    const publish = (clock: number, nextState: ReturnType<typeof state> | null) =>
      hub.publish("a", {
        engine: "canvas_scene",
        documentId: "document-1",
        generation: 1,
        clock,
        state: nextState,
      });

    expect(publish(4, state(4)).applied).toBe(true);
    expect(publish(4, null).applied).toBe(true);
    expect(publish(4, null).applied).toBe(false);
    hub.adoptBoundary("a", 2);
    expect(received.at(-1)).toMatchObject({
      presence: { generation: 1, clock: 4, state: null },
    });
    expect(() => publish(5, state(5))).toThrow("generation boundary");
    hub.destroy();
  });
});
