import { describe, expect, test } from "bun:test";

import type { CardInput } from "../../shared/types";
import { MAX_CARD_DESCRIPTION_LENGTH } from "../../shared/card-limits";
import { assertValidCardInput } from "./card-input-validation";

function createValidInput(): CardInput {
  return {
    title: "Ship hardening",
    description: "safe markdown",
    priority: "p2-medium",
    estimate: "m",
    tags: ["security", "nfm"],
    dueDate: new Date("2026-02-12T00:00:00.000Z"),
    assignee: "asc",
    agentBlocked: false,
    agentStatus: "working",
    runInTarget: "localProject",
    runInLocalPath: "/tmp/repo",
    runInBaseBranch: "main",
    runInWorktreePath: "/tmp/repo/.worktrees/feature",
    runInEnvironmentPath: ".codex/environments/environment.toml",
  };
}

describe("card input validation", () => {
  test("accepts a valid create payload", () => {
    expect(runValidation(() => assertValidCardInput(createValidInput(), "create"))).toBe(null);
  });

  test("accepts a valid partial update payload", () => {
    expect(
      runValidation(() =>
        assertValidCardInput({ description: "updated", tags: ["safe"] }, "update"),
      ),
    ).toBe(null);
  });

  test("accepts clearing priority with null", () => {
    expect(
      runValidation(() =>
        assertValidCardInput({ priority: null }, "update"),
      ),
    ).toBe(null);
  });

  test("rejects create payload with missing title", () => {
    expect(
      runValidation(() => assertValidCardInput({ description: "x" }, "create")),
    ).toBe("Card title is required");
  });

  test("rejects empty title on update", () => {
    expect(
      runValidation(() => assertValidCardInput({ title: "   " }, "update")),
    ).toBe("Card title cannot be empty");
  });

  test("rejects description above max length", () => {
    const tooLarge = "x".repeat(MAX_CARD_DESCRIPTION_LENGTH + 1);
    expect(
      runValidation(() => assertValidCardInput({ description: tooLarge }, "update")),
    ).toBe(`description exceeds ${MAX_CARD_DESCRIPTION_LENGTH} characters`);
  });

  test("rejects invalid dueDate type", () => {
    expect(
      runValidation(() =>
        assertValidCardInput({ dueDate: "2026-02-12" as unknown as Date }, "update"),
      ),
    ).toBe("Invalid dueDate value");
  });

  test("accepts valid scheduled range", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            scheduledStart: new Date("2026-02-18T09:00:00.000Z"),
            scheduledEnd: new Date("2026-02-18T10:00:00.000Z"),
          },
          "update",
        ),
      ),
    ).toBe(null);
  });

  test("accepts all-day schedule with explicit range", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            isAllDay: true,
            scheduledStart: new Date("2026-02-18T00:00:00.000Z"),
            scheduledEnd: new Date("2026-02-19T00:00:00.000Z"),
          },
          "update",
        ),
      ),
    ).toBe(null);
  });

  test("rejects invalid scheduled range", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            scheduledStart: new Date("2026-02-18T10:00:00.000Z"),
            scheduledEnd: new Date("2026-02-18T09:59:00.000Z"),
          },
          "update",
        ),
      ),
    ).toBe("scheduledEnd must be after scheduledStart");
  });

  test("rejects all-day without complete schedule range", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            isAllDay: true,
            scheduledStart: new Date("2026-02-18T00:00:00.000Z"),
          },
          "update",
        ),
      ),
    ).toBe("isAllDay requires scheduledStart and scheduledEnd");
  });

  test("accepts recurrence, reminders, and timezone", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            recurrence: {
              frequency: "weekly",
              interval: 1,
              byWeekdays: [1, 3],
              endCondition: { type: "untilDate", untilDate: "2026-12-31" },
            },
            reminders: [{ offsetMinutes: 10 }, { offsetMinutes: 60 }],
            scheduleTimezone: "America/New_York",
          },
          "update",
        ),
      ),
    ).toBe(null);
  });

  test("rejects weekly recurrence without weekdays", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            recurrence: {
              frequency: "weekly",
              interval: 1,
            },
          },
          "update",
        ),
      ),
    ).toBe("Invalid recurrence value");
  });

  test("rejects duplicate reminder offsets", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            reminders: [{ offsetMinutes: 15 }, { offsetMinutes: 15 }],
          },
          "update",
        ),
      ),
    ).toBe("Duplicate reminder offsets are not allowed");
  });

  test("rejects invalid schedule timezone", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            scheduleTimezone: "Mars/Olympus_Mons",
          },
          "update",
        ),
      ),
    ).toBe('Invalid scheduleTimezone "Mars/Olympus_Mons"');
  });

  test("rejects invalid runInTarget", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            runInTarget: "worktree" as unknown as CardInput["runInTarget"],
          },
          "update",
        ),
      ),
    ).toBe('Invalid runInTarget "worktree"');
  });

  test("accepts empty runInLocalPath", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            runInLocalPath: "",
          },
          "update",
        ),
      ),
    ).toBe(null);
  });

  test("rejects option-like runInBaseBranch", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            runInBaseBranch: "--detach",
          },
          "update",
        ),
      ),
    ).toBe("Invalid runInBaseBranch value");
  });

  test("accepts empty runInWorktreePath", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            runInWorktreePath: "",
          },
          "update",
        ),
      ),
    ).toBe(null);
  });

  test("rejects non-string runInWorktreePath", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            runInWorktreePath: 123 as unknown as string,
          },
          "update",
        ),
      ),
    ).toBe("Invalid runInWorktreePath value");
  });

  test("accepts empty runInEnvironmentPath", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            runInEnvironmentPath: "",
          },
          "update",
        ),
      ),
    ).toBe(null);
  });

  test("rejects non-string runInEnvironmentPath", () => {
    expect(
      runValidation(() =>
        assertValidCardInput(
          {
            runInEnvironmentPath: 123 as unknown as string,
          },
          "update",
        ),
      ),
    ).toBe("Invalid runInEnvironmentPath value");
  });
});

function runValidation(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
