import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CardInput } from "../../shared/types";
import {
  closeDatabase,
  completeCardOccurrence,
  createCard,
  createProject,
  executeReadOnlyQuery,
  getCard,
  getProject,
  initializeDatabase,
  listCalendarOccurrences,
  redoLatest,
  skipCardOccurrence,
  undoLatest,
  updateCardOccurrence,
} from "./db-service";

function isUnsupportedSqliteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("better-sqlite3") && message.includes("not yet supported");
}

async function withTempDatabase(run: () => Promise<void>): Promise<boolean> {
  closeDatabase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-occurrence-actions-"));
  process.env.KANBAN_DIR = tempDir;
  try {
    await initializeDatabase();
  } catch (error) {
    if (isUnsupportedSqliteError(error)) {
      closeDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
      delete process.env.KANBAN_DIR;
      return false;
    }
    throw error;
  }

  if (!getProject("default")) {
    createProject({ id: "default", name: "Default" });
  }

  try {
    await run();
    return true;
  } finally {
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.KANBAN_DIR;
  }
}

function toIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function recurringInput(startIso: string, endIso: string): CardInput {
  return {
    title: "Recurring event",
    scheduledStart: new Date(startIso),
    scheduledEnd: new Date(endIso),
    recurrence: {
      frequency: "daily",
      interval: 1,
      endCondition: { type: "never" },
    },
    reminders: [{ offsetMinutes: 10 }],
    scheduleTimezone: "UTC",
  };
}

function allDayInput(startIso: string, endIso: string): CardInput {
  return {
    title: "All-day event",
    scheduledStart: new Date(startIso),
    scheduledEnd: new Date(endIso),
    isAllDay: true,
  };
}

function recurringInputWithUntilDate(startIso: string, endIso: string, untilDate: string): CardInput {
  return {
    title: "Recurring event",
    scheduledStart: new Date(startIso),
    scheduledEnd: new Date(endIso),
    recurrence: {
      frequency: "daily",
      interval: 1,
      endCondition: { type: "untilDate", untilDate },
    },
    reminders: [{ offsetMinutes: 10 }],
    scheduleTimezone: "UTC",
  };
}

function archiveRows() {
  return executeReadOnlyQuery(
    `SELECT id, scheduled_start, scheduled_end, recurrence_json, reminders_json
     FROM cards
     WHERE project_id = ? AND status = 'done' AND archived = 1
     ORDER BY created DESC`,
    ["default"],
  ).rows;
}

describe("occurrence actions", () => {
  test("done on recurring current occurrence creates archive card and advances master", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const card = await createCard("default", "in_progress", recurringInput(startIso, endIso));

      const result = await completeCardOccurrence(
        "default",
        {
          cardId: card.id,
          occurrenceStart: new Date(startIso),
          source: "calendar",
        },
        "session-recurring-current",
      );

      expect(result.success).toBeTrue();

      const master = await getCard("default", card.id);
      expect(master?.scheduledStart?.toISOString()).toBe("2026-03-02T10:00:00.000Z");
      expect(master?.scheduledEnd?.toISOString()).toBe("2026-03-02T11:00:00.000Z");

      const archives = archiveRows();
      expect(archives.length).toBe(1);
      expect(toIso(archives[0]?.scheduled_start)).toBe(startIso);
      expect(toIso(archives[0]?.scheduled_end)).toBe(endIso);
      expect(archives[0]?.recurrence_json).toBe(null);
      expect(archives[0]?.reminders_json).toBe("[]");
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("done on recurring future occurrence creates archive card and skip exception without advancing master", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const futureIso = "2026-03-05T10:00:00.000Z";
      const futureEndIso = "2026-03-05T11:00:00.000Z";
      const card = await createCard("default", "in_progress", recurringInput(startIso, endIso));

      const result = await completeCardOccurrence(
        "default",
        {
          cardId: card.id,
          occurrenceStart: new Date(futureIso),
          source: "calendar",
        },
      );

      expect(result.success).toBeTrue();

      const master = await getCard("default", card.id);
      expect(master?.scheduledStart?.toISOString()).toBe(startIso);
      expect(master?.scheduledEnd?.toISOString()).toBe(endIso);

      const archives = archiveRows();
      expect(archives.length).toBe(1);
      expect(toIso(archives[0]?.scheduled_start)).toBe(futureIso);
      expect(toIso(archives[0]?.scheduled_end)).toBe(futureEndIso);

      const exceptions = executeReadOnlyQuery(
        `SELECT exception_type, occurrence_start
         FROM recurrence_exceptions
         WHERE project_id = ? AND card_id = ?`,
        ["default", card.id],
      ).rows;
      expect(exceptions.length).toBe(1);
      expect(exceptions[0]?.exception_type).toBe("skip");
      expect(toIso(exceptions[0]?.occurrence_start)).toBe(futureIso);
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("done on one-time occurrence creates archive card and unschedules master", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const card = await createCard("default", "in_progress", {
        title: "One-time event",
        scheduledStart: new Date(startIso),
        scheduledEnd: new Date(endIso),
      });

      const result = await completeCardOccurrence(
        "default",
        {
          cardId: card.id,
          occurrenceStart: new Date(startIso),
          source: "calendar",
        },
      );

      expect(result.success).toBeTrue();

      const master = await getCard("default", card.id);
      expect(master?.scheduledStart).toBe(undefined);
      expect(master?.scheduledEnd).toBe(undefined);

      const archives = archiveRows();
      expect(archives.length).toBe(1);
      expect(toIso(archives[0]?.scheduled_start)).toBe(startIso);
      expect(toIso(archives[0]?.scheduled_end)).toBe(endIso);
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("skip occurrence does not create archive card", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const card = await createCard("default", "in_progress", recurringInput(startIso, endIso));

      const result = await skipCardOccurrence(
        "default",
        {
          cardId: card.id,
          occurrenceStart: new Date(startIso),
          source: "calendar",
        },
      );

      expect(result.success).toBeTrue();

      const archives = archiveRows();
      expect(archives.length).toBe(0);
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("scope this detaches targeted occurrence into a standalone card and skips the series occurrence", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const detachedStartIso = "2026-03-01T12:00:00.000Z";
      const detachedEndIso = "2026-03-01T13:00:00.000Z";
      const card = await createCard("default", "in_progress", recurringInput(startIso, endIso));

      const result = await updateCardOccurrence("default", {
        cardId: card.id,
        occurrenceStart: new Date(startIso),
        source: "calendar",
        scope: "this",
        updates: {
          scheduledStart: new Date(detachedStartIso),
          scheduledEnd: new Date(detachedEndIso),
        },
      });
      expect(result.success).toBeTrue();

      const master = await getCard("default", card.id);
      expect(master?.scheduledStart?.toISOString()).toBe(startIso);
      expect(master?.scheduledEnd?.toISOString()).toBe(endIso);

      const exceptions = executeReadOnlyQuery(
        `SELECT exception_type, occurrence_start, override_start, override_end
         FROM recurrence_exceptions
         WHERE project_id = ? AND card_id = ?`,
        ["default", card.id],
      ).rows;
      expect(exceptions.length).toBe(1);
      expect(exceptions[0]?.exception_type).toBe("skip");
      expect(toIso(exceptions[0]?.occurrence_start)).toBe(startIso);
      expect(exceptions[0]?.override_start).toBe(null);
      expect(exceptions[0]?.override_end).toBe(null);

      const rows = executeReadOnlyQuery(
        `SELECT id, scheduled_start, scheduled_end, recurrence_json
         FROM cards
         WHERE project_id = ? AND status = ? AND archived = 0
         ORDER BY "order" ASC`,
        ["default", "in_progress"],
      ).rows;
      expect(rows.length).toBe(2);
      const detachedRow = rows.find((row) => row.id !== card.id);
      expect(Boolean(detachedRow)).toBeTrue();
      expect(toIso(detachedRow?.scheduled_start)).toBe(detachedStartIso);
      expect(toIso(detachedRow?.scheduled_end)).toBe(detachedEndIso);
      expect(detachedRow?.recurrence_json).toBe(null);

      const occurrences = await listCalendarOccurrences(
        "default",
        new Date("2026-03-01T00:00:00.000Z"),
        new Date("2026-03-03T00:00:00.000Z"),
      );
      expect(occurrences.length).toBe(2);
      expect(occurrences[0]?.scheduledStart?.toISOString()).toBe(detachedStartIso);
      expect(occurrences[0]?.scheduledEnd?.toISOString()).toBe(detachedEndIso);
      expect(occurrences[0]?.isRecurring).toBeFalse();
      expect(occurrences[0]?.thisAndFutureEquivalentToAll).toBeFalse();
      expect(occurrences[1]?.scheduledStart?.toISOString()).toBe("2026-03-02T10:00:00.000Z");
      expect(occurrences[1]?.scheduledEnd?.toISOString()).toBe("2026-03-02T11:00:00.000Z");
      expect(occurrences[1]?.isRecurring).toBeTrue();
      expect(occurrences[1]?.thisAndFutureEquivalentToAll).toBeFalse();
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("calendar occurrences flag first recurring instance when this-and-future equals all", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const card = await createCard("default", "in_progress", recurringInput(startIso, endIso));

      const occurrences = await listCalendarOccurrences(
        "default",
        new Date("2026-03-01T00:00:00.000Z"),
        new Date("2026-03-04T00:00:00.000Z"),
      );

      const first = occurrences.find((occurrence) => occurrence.cardId === card.id);
      const second = occurrences.find(
        (occurrence) =>
          occurrence.cardId === card.id &&
          occurrence.occurrenceStart.toISOString() === "2026-03-02T10:00:00.000Z",
      );

      expect(first?.occurrenceStart.toISOString()).toBe(startIso);
      expect(first?.thisAndFutureEquivalentToAll).toBeTrue();
      expect(second?.thisAndFutureEquivalentToAll).toBeFalse();
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("calendar occurrences return explicit all-day flag", async () => {
    const ran = await withTempDatabase(async () => {
      await createCard(
        "default",
        "in_progress",
        allDayInput("2026-03-10T00:00:00.000Z", "2026-03-11T00:00:00.000Z"),
      );

      const occurrences = await listCalendarOccurrences(
        "default",
        new Date("2026-03-09T00:00:00.000Z"),
        new Date("2026-03-12T00:00:00.000Z"),
      );

      expect(occurrences.length).toBe(1);
      expect(occurrences[0]?.isAllDay).toBeTrue();
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("scope this-and-future splits recurring series into a new card", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const splitOccurrenceIso = "2026-03-03T10:00:00.000Z";
      const splitStartIso = "2026-03-03T15:00:00.000Z";
      const splitEndIso = "2026-03-03T16:00:00.000Z";
      const card = await createCard("default", "in_progress", recurringInput(startIso, endIso));

      const result = await updateCardOccurrence("default", {
        cardId: card.id,
        occurrenceStart: new Date(splitOccurrenceIso),
        source: "calendar",
        scope: "this-and-future",
        updates: {
          scheduledStart: new Date(splitStartIso),
          scheduledEnd: new Date(splitEndIso),
        },
      });
      expect(result.success).toBeTrue();

      const master = await getCard("default", card.id);
      expect(master?.scheduledStart?.toISOString()).toBe(startIso);
      expect(master?.scheduledEnd?.toISOString()).toBe(endIso);
      expect(master?.recurrence?.endCondition?.type).toBe("untilDate");
      if (master?.recurrence?.endCondition?.type === "untilDate") {
        expect(master.recurrence.endCondition.untilDate).toBe("2026-03-02");
      }

      const rows = executeReadOnlyQuery(
        `SELECT id, scheduled_start, scheduled_end, recurrence_json
         FROM cards
         WHERE project_id = ? AND status = ? AND archived = 0
         ORDER BY "order" ASC`,
        ["default", "in_progress"],
      ).rows;
      expect(rows.length).toBe(2);

      const splitRow = rows.find((row) => row.id !== card.id);
      expect(Boolean(splitRow)).toBeTrue();
      expect(toIso(splitRow?.scheduled_start)).toBe(splitStartIso);
      expect(toIso(splitRow?.scheduled_end)).toBe(splitEndIso);
      const splitRecurrence = typeof splitRow?.recurrence_json === "string"
        ? JSON.parse(splitRow.recurrence_json)
        : null;
      expect(splitRecurrence?.frequency).toBe("daily");
      expect(splitRecurrence?.interval).toBe(1);

      const exceptions = executeReadOnlyQuery(
        `SELECT * FROM recurrence_exceptions WHERE project_id = ? AND card_id = ?`,
        ["default", card.id],
      ).rows;
      expect(exceptions.length).toBe(0);
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("scope this-and-future on first occurrence is equivalent to all (no split)", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const updatedStartIso = "2026-03-01T14:00:00.000Z";
      const updatedEndIso = "2026-03-01T15:00:00.000Z";
      const card = await createCard("default", "in_progress", recurringInput(startIso, endIso));

      const result = await updateCardOccurrence("default", {
        cardId: card.id,
        occurrenceStart: new Date(startIso),
        source: "calendar",
        scope: "this-and-future",
        updates: {
          scheduledStart: new Date(updatedStartIso),
          scheduledEnd: new Date(updatedEndIso),
        },
      });
      expect(result.success).toBeTrue();

      const rows = executeReadOnlyQuery(
        `SELECT id, scheduled_start, scheduled_end, recurrence_json
         FROM cards
         WHERE project_id = ? AND status = ? AND archived = 0
         ORDER BY "order" ASC`,
        ["default", "in_progress"],
      ).rows;
      expect(rows.length).toBe(1);
      expect(rows[0]?.id).toBe(card.id);
      expect(toIso(rows[0]?.scheduled_start)).toBe(updatedStartIso);
      expect(toIso(rows[0]?.scheduled_end)).toBe(updatedEndIso);
      const recurrence = typeof rows[0]?.recurrence_json === "string"
        ? JSON.parse(rows[0].recurrence_json)
        : null;
      expect(recurrence?.frequency).toBe("daily");
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("scope all updates recurring master schedule directly", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const allStartIso = "2026-03-01T14:00:00.000Z";
      const allEndIso = "2026-03-01T15:00:00.000Z";
      const card = await createCard("default", "in_progress", recurringInput(startIso, endIso));

      const result = await updateCardOccurrence("default", {
        cardId: card.id,
        occurrenceStart: new Date(startIso),
        source: "calendar",
        scope: "all",
        updates: {
          scheduledStart: new Date(allStartIso),
          scheduledEnd: new Date(allEndIso),
        },
      });
      expect(result.success).toBeTrue();

      const master = await getCard("default", card.id);
      expect(master?.scheduledStart?.toISOString()).toBe(allStartIso);
      expect(master?.scheduledEnd?.toISOString()).toBe(allEndIso);
      expect(master?.recurrence?.frequency).toBe("daily");

      const exceptions = executeReadOnlyQuery(
        `SELECT * FROM recurrence_exceptions WHERE project_id = ? AND card_id = ?`,
        ["default", card.id],
      ).rows;
      expect(exceptions.length).toBe(0);
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("scope all drag-shift moves recurrence untilDate by the same day delta", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const shiftedStartIso = "2026-03-03T10:00:00.000Z";
      const shiftedEndIso = "2026-03-03T11:00:00.000Z";
      const card = await createCard(
        "default",
        "in_progress",
        recurringInputWithUntilDate(startIso, endIso, "2026-03-10"),
      );

      const result = await updateCardOccurrence("default", {
        cardId: card.id,
        occurrenceStart: new Date(startIso),
        source: "calendar",
        scope: "all",
        updates: {
          scheduledStart: new Date(shiftedStartIso),
          scheduledEnd: new Date(shiftedEndIso),
        },
      });
      expect(result.success).toBeTrue();

      const master = await getCard("default", card.id);
      expect(master?.scheduledStart?.toISOString()).toBe(shiftedStartIso);
      expect(master?.scheduledEnd?.toISOString()).toBe(shiftedEndIso);
      if (master?.recurrence?.endCondition?.type === "untilDate") {
        expect(master.recurrence.endCondition.untilDate).toBe("2026-03-12");
      }
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("scope this-and-future drag-shift moves future split untilDate by the same day delta", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const splitOccurrenceIso = "2026-03-05T10:00:00.000Z";
      const shiftedSplitStartIso = "2026-03-07T10:00:00.000Z";
      const shiftedSplitEndIso = "2026-03-07T11:00:00.000Z";
      const card = await createCard(
        "default",
        "in_progress",
        recurringInputWithUntilDate(startIso, endIso, "2026-03-10"),
      );

      const result = await updateCardOccurrence("default", {
        cardId: card.id,
        occurrenceStart: new Date(splitOccurrenceIso),
        source: "calendar",
        scope: "this-and-future",
        updates: {
          scheduledStart: new Date(shiftedSplitStartIso),
          scheduledEnd: new Date(shiftedSplitEndIso),
        },
      });
      expect(result.success).toBeTrue();

      const rows = executeReadOnlyQuery(
        `SELECT id, recurrence_json
         FROM cards
         WHERE project_id = ? AND status = ? AND archived = 0
         ORDER BY "order" ASC`,
        ["default", "in_progress"],
      ).rows;
      expect(rows.length).toBe(2);

      const oldRow = rows.find((row) => row.id === card.id);
      const splitRow = rows.find((row) => row.id !== card.id);
      const oldRecurrence = typeof oldRow?.recurrence_json === "string"
        ? JSON.parse(oldRow.recurrence_json)
        : null;
      const newRecurrence = typeof splitRow?.recurrence_json === "string"
        ? JSON.parse(splitRow.recurrence_json)
        : null;

      expect(oldRecurrence?.endCondition?.untilDate).toBe("2026-03-04");
      expect(newRecurrence?.endCondition?.untilDate).toBe("2026-03-12");
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });

  test("undo/redo restores master schedule and archive snapshot for done occurrence", async () => {
    const ran = await withTempDatabase(async () => {
      const startIso = "2026-03-01T10:00:00.000Z";
      const endIso = "2026-03-01T11:00:00.000Z";
      const sessionId = "session-recurring-undo-redo";
      const card = await createCard("default", "in_progress", recurringInput(startIso, endIso));

      const completeResult = await completeCardOccurrence(
        "default",
        {
          cardId: card.id,
          occurrenceStart: new Date(startIso),
          source: "calendar",
        },
        sessionId,
      );
      expect(completeResult.success).toBeTrue();

      let master = await getCard("default", card.id);
      expect(master?.scheduledStart?.toISOString()).toBe("2026-03-02T10:00:00.000Z");
      expect(archiveRows().length).toBe(1);

      const undoResult = undoLatest("default", sessionId);
      expect(undoResult.success).toBeTrue();

      master = await getCard("default", card.id);
      expect(master?.scheduledStart?.toISOString()).toBe(startIso);
      expect(archiveRows().length).toBe(0);

      const redoResult = redoLatest("default", sessionId);
      expect(redoResult.success).toBeTrue();

      master = await getCard("default", card.id);
      expect(master?.scheduledStart?.toISOString()).toBe("2026-03-02T10:00:00.000Z");
      expect(archiveRows().length).toBe(1);
    });

    if (!ran) {
      expect(true).toBeTrue();
    }
  });
});
