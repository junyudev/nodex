import { describe, expect, test } from "bun:test";
import {
  applyCardToggleMetaEdit,
  cardInputFromCardToggleSnapshot,
  encodeCardToggleSnapshot,
  parseCardToggleSnapshot,
  updateCardToggleSnapshotForMetaEdit,
} from "./card-toggle-snapshot";

describe("card toggle snapshot helpers", () => {
  test("applyCardToggleMetaEdit updates existing tokens in place", () => {
    const meta = "[P2] [M] [In Progress] [infra]";
    const nextPriority = applyCardToggleMetaEdit(meta, "priority", "p0-critical");
    const nextEstimate = applyCardToggleMetaEdit(nextPriority, "estimate", "none");
    const nextStatus = applyCardToggleMetaEdit(nextEstimate, "status", "backlog");

    expect(nextPriority).toBe("[P0] [M] [In Progress] [infra]");
    expect(nextEstimate).toBe("[P0] [-] [In Progress] [infra]");
    expect(nextStatus).toBe("[P0] [-] [Backlog] [infra]");
  });

  test("updateCardToggleSnapshotForMetaEdit mutates snapshot card fields", () => {
    const snapshot = encodeCardToggleSnapshot({
      card: {
        title: "Card",
        description: "Body",
        priority: "p2-medium",
        estimate: "m",
        tags: ["ui"],
        dueDate: "2026-02-12T00:00:00.000Z",
        scheduledStart: "2026-02-12T09:00:00.000Z",
        scheduledEnd: "2026-02-12T10:00:00.000Z",
        isAllDay: true,
        assignee: "sam",
        agentBlocked: false,
      },
      projectId: "default",
      status: "in_progress",
      statusName: "In Progress",
      capturedAt: "2026-02-12T00:00:00.000Z",
    });

    const withPriority = updateCardToggleSnapshotForMetaEdit(snapshot, "priority", "p1-high");
    const withEstimate = updateCardToggleSnapshotForMetaEdit(withPriority, "estimate", "none");
    const withStatus = updateCardToggleSnapshotForMetaEdit(withEstimate, "status", "done");
    const decoded = parseCardToggleSnapshot(withStatus);

    expect(decoded?.card?.priority).toBe("p1-high");
    expect(decoded?.card?.estimate).toBe(null);
    expect(decoded?.status).toBe("done");
    expect(decoded?.statusName).toBe("Done");
  });

  test("clearing priority preserves an explicit null in the snapshot", () => {
    const snapshot = encodeCardToggleSnapshot({
      card: {
        title: "Card",
        priority: "p2-medium",
      },
    });

    const cleared = updateCardToggleSnapshotForMetaEdit(snapshot, "priority", "none");
    const decoded = parseCardToggleSnapshot(cleared);
    const input = cardInputFromCardToggleSnapshot(cleared);

    expect(Object.prototype.hasOwnProperty.call(decoded?.card ?? {}, "priority")).toBeTrue();
    expect(decoded?.card?.priority === null).toBeTrue();
    expect(input.priority === null).toBeTrue();
  });

  test("cardInputFromCardToggleSnapshot extracts persisted card properties", () => {
    const snapshot = encodeCardToggleSnapshot({
      card: {
        title: "Card",
        description: "Body",
        priority: "p3-low",
        estimate: "l",
        tags: ["ops"],
        dueDate: "2026-02-14T00:00:00.000Z",
        scheduledStart: "2026-02-14T13:00:00.000Z",
        scheduledEnd: "2026-02-14T14:15:00.000Z",
        isAllDay: true,
        assignee: "taylor",
        agentBlocked: true,
      },
      projectId: "default",
      status: "backlog",
      statusName: "Backlog",
      capturedAt: "2026-02-14T00:00:00.000Z",
    });

    const input = cardInputFromCardToggleSnapshot(snapshot);
    expect(input.priority).toBe("p3-low");
    expect(input.estimate).toBe("l");
    expect(JSON.stringify(input.tags)).toBe(JSON.stringify(["ops"]));
    expect(input.assignee).toBe("taylor");
    expect(input.agentBlocked).toBeTrue();
    expect(input.dueDate?.toISOString()).toBe("2026-02-14T00:00:00.000Z");
    expect(input.scheduledStart?.toISOString()).toBe("2026-02-14T13:00:00.000Z");
    expect(input.scheduledEnd?.toISOString()).toBe("2026-02-14T14:15:00.000Z");
    expect(input.isAllDay).toBeTrue();
  });

  test("cardInputFromCardToggleSnapshot skips invalid schedule ranges", () => {
    const snapshot = encodeCardToggleSnapshot({
      card: {
        title: "Card",
        priority: "p2-medium",
        scheduledStart: "2026-02-15T11:00:00.000Z",
        scheduledEnd: "2026-02-15T10:30:00.000Z",
      },
    });

    const input = cardInputFromCardToggleSnapshot(snapshot);
    expect(input.scheduledStart?.toISOString()).toBe("2026-02-15T11:00:00.000Z");
    expect(input.scheduledEnd).toBe(undefined);
  });
});
