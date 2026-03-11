import { describe, expect, test } from "bun:test";
import {
  normalizeBlockDropImportBody,
  normalizeCardMoveDropBody,
} from "./http-server";

describe("http drop payload normalization", () => {
  test("normalizes nested dueDate values in block-drop import payload", () => {
    const normalized = normalizeBlockDropImportBody({
      targetStatus: "in_progress",
      cards: [
        {
          title: "Card A",
          dueDate: "2026-02-15",
        },
      ],
      sourceUpdates: [
        {
          projectId: "default",
          cardId: "card-1",
          updates: {
            dueDate: "2026-02-16T00:00:00.000Z",
          },
        },
      ],
    });

    const normalizedCard = Array.isArray(normalized.cards)
      ? normalized.cards[0] as Record<string, unknown>
      : null;
    const normalizedUpdate = Array.isArray(normalized.sourceUpdates)
      ? normalized.sourceUpdates[0] as Record<string, unknown>
      : null;
    const normalizedUpdateFields = normalizedUpdate && typeof normalizedUpdate.updates === "object"
      ? normalizedUpdate.updates as Record<string, unknown>
      : null;

    expect(normalizedCard instanceof Object).toBeTrue();
    expect(normalizedCard?.dueDate instanceof Date).toBeTrue();
    expect((normalizedCard?.dueDate as Date | undefined)?.toISOString()).toBe(
      "2026-02-15T00:00:00.000Z",
    );
    expect(normalizedUpdateFields?.dueDate instanceof Date).toBeTrue();
    expect((normalizedUpdateFields?.dueDate as Date | undefined)?.toISOString()).toBe(
      "2026-02-16T00:00:00.000Z",
    );
  });

  test("normalizes nested dueDate values in card-move-drop payload", () => {
    const normalized = normalizeCardMoveDropBody({
      sourceCardId: "card-1",
      targetUpdates: [
        {
          projectId: "default",
          cardId: "card-2",
          updates: {
            dueDate: "2026-02-17",
          },
        },
      ],
    });

    const normalizedUpdate = Array.isArray(normalized.targetUpdates)
      ? normalized.targetUpdates[0] as Record<string, unknown>
      : null;
    const normalizedUpdateFields = normalizedUpdate && typeof normalizedUpdate.updates === "object"
      ? normalizedUpdate.updates as Record<string, unknown>
      : null;

    expect(normalizedUpdateFields?.dueDate instanceof Date).toBeTrue();
    expect((normalizedUpdateFields?.dueDate as Date | undefined)?.toISOString()).toBe(
      "2026-02-17T00:00:00.000Z",
    );
  });

  test("rejects invalid calendar dueDate values", () => {
    let errorMessage = "";
    try {
      normalizeBlockDropImportBody({
        targetStatus: "in_progress",
        cards: [
          {
            title: "Broken Date",
            dueDate: "2026-02-30",
          },
        ],
      });
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    expect(errorMessage).toBe('Invalid dueDate "2026-02-30"');
  });

  test("rejects invalid calendar scheduledStart values", () => {
    let errorMessage = "";
    try {
      normalizeCardMoveDropBody({
        sourceCardId: "card-1",
        targetUpdates: [
          {
            projectId: "default",
            cardId: "card-2",
            updates: {
              scheduledStart: "2026-02-30T10:00:00.000Z",
            },
          },
        ],
      });
    } catch (error) {
      errorMessage = (error as Error).message;
    }

    expect(errorMessage).toBe('Invalid scheduledStart "2026-02-30T10:00:00.000Z"');
  });
});
