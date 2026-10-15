import { describe, expect, test } from "vite-plus/test";
import {
  canonicalizeCanvasPresenceEvent,
  canonicalizeCanvasPresencePublication,
  canonicalizeCanvasPresencePublishRequest,
  canonicalizeCanvasPresenceRealtimeEvent,
  MAX_CANVAS_PRESENCE_SELECTION_IDS,
} from "./document-presence";

const publication = {
  engine: "canvas_scene" as const,
  documentId: "document-1",
  generation: 3,
  clock: 8,
  state: {
    pointer: {
      x: 12.5,
      y: -4,
      button: "up" as const,
      tool: "pointer" as const,
    },
    selectedElementIds: ["element-a", "element-b"],
    idle: "active" as const,
  },
};

describe("Canvas document presence contract", () => {
  test("accepts a bounded canonical publication without transport identity", () => {
    expect(canonicalizeCanvasPresencePublication(publication)).toEqual(publication);
    expect("clientSessionId" in publication).toBe(false);
    expect("user" in publication).toBe(false);
    expect(
      canonicalizeCanvasPresencePublishRequest({
        routingContext: { kind: "project", projectId: "project-1" },
        clientSessionId: "session-1",
        publication,
      }),
    ).toMatchObject({ publication });
    expect(() =>
      canonicalizeCanvasPresencePublishRequest({
        routingContext: { kind: "project", projectId: "project-1" },
        publication,
      }),
    ).toThrow("client session");
  });

  test("rejects non-finite pointers and noncanonical or oversized selections", () => {
    expect(() =>
      canonicalizeCanvasPresencePublication({
        ...publication,
        state: {
          ...publication.state,
          pointer: { ...publication.state.pointer, x: Number.NaN },
        },
      }),
    ).toThrow("pointer");
    expect(() =>
      canonicalizeCanvasPresencePublication({
        ...publication,
        state: {
          ...publication.state,
          selectedElementIds: ["element-b", "element-a"],
        },
      }),
    ).toThrow("sorted and unique");
    expect(() =>
      canonicalizeCanvasPresencePublication({
        ...publication,
        state: {
          ...publication.state,
          selectedElementIds: Array.from(
            { length: MAX_CANVAS_PRESENCE_SELECTION_IDS + 1 },
            (_, index) => `element-${index}`,
          ),
        },
      }),
    ).toThrow("invalid");
  });

  test("binds and validates trusted event identity", () => {
    const event = canonicalizeCanvasPresenceEvent({
      ...publication,
      clientSessionId: "session-2",
      user: {
        id: "window-2",
        displayName: "Window 2",
        color: "#1971c2",
      },
    });
    expect(event.clientSessionId).toBe("session-2");
    expect(event.user.color).toBe("#1971c2");
    expect(() =>
      canonicalizeCanvasPresenceEvent({
        ...event,
        user: { ...event.user, color: "blue" },
      }),
    ).toThrow("color");
  });

  test("requires snapshots to contain current non-null peers only", () => {
    const event = {
      ...publication,
      clientSessionId: "session-2",
      user: {
        id: "window-2",
        displayName: "Window 2",
        color: "#1971c2",
      },
    };
    expect(
      canonicalizeCanvasPresenceRealtimeEvent({
        type: "canvas_presence_snapshot",
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: publication.documentId,
        generation: publication.generation,
        presences: [event],
      }),
    ).toMatchObject({ presences: [event] });
    expect(() =>
      canonicalizeCanvasPresenceRealtimeEvent({
        type: "canvas_presence_snapshot",
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: publication.documentId,
        generation: publication.generation,
        presences: [{ ...event, state: null }],
      }),
    ).toThrow("snapshot crossed");
    expect(() =>
      canonicalizeCanvasPresenceRealtimeEvent({
        type: "canvas_presence_snapshot",
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: publication.documentId,
        generation: publication.generation,
        presences: [event, event],
      }),
    ).toThrow("snapshot crossed");
    expect(() =>
      canonicalizeCanvasPresenceRealtimeEvent({
        type: "canvas_presence_snapshot",
        libraryId: "library-1",
        routingContext: { kind: "project", projectId: "project-1" },
        documentId: publication.documentId,
        generation: publication.generation,
        presences: Array.from({ length: 300 }, (_, index) => ({
          ...event,
          clientSessionId: `session-${index}`,
          user: {
            ...event.user,
            id: `window-${index}`,
            displayName: `Window ${index} ${"x".repeat(100)}`,
          },
        })),
      }),
    ).toThrow("byte bound");
  });
});
