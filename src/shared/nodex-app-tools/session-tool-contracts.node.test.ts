import { describe, expect, it } from "vite-plus/test";
import { sessionControlSchemas, sessionQueueSchema } from "./session-control-schemas";
import { readSessionQueue, reorderedQueueIds } from "./session-queue";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  sessionObservationSchemas,
  sessionObservationToolCatalog,
} from "./session-observation-schemas";
import { appToolCatalog } from "./catalog";
import { sessionQuestionSchema } from "./session-question-schema";
import { resolveSessionScope } from "./session-scope";

describe("session control schemas", () => {
  describe("Session controls", () => {
    it("validates exact action fields and bounded windows", () => {
      expect(
        sessionControlSchemas.stop_session.safeParse({
          sessionId: "target",
          execution: { threadId: "child" },
          reason: "cancelled",
        }).success,
      ).toBe(true);
      expect(sessionControlSchemas.set_session_unread.parse({ unread: false })).toEqual({
        unread: false,
      });
      for (const args of [
        { action: "edit", queuedId: "id" },
        { action: "reorder", queuedId: "id" },
        { action: "list", limit: 21 },
        { action: "remove", queuedId: "id", text: "ignored" },
        { action: "list", cursor: "" },
        { action: "steer" },
      ])
        expect(sessionQueueSchema.safeParse({ sessionId: "target", ...args }).success).toBe(false);
      expect(sessionQueueSchema.parse({ sessionId: "target", action: "list" })).toEqual({
        sessionId: "target",
        action: "list",
        limit: 20,
      });
      expect(
        sessionQueueSchema.safeParse({
          sessionId: "target",
          action: "reorder",
          queuedId: "id",
          beforeId: null,
        }).success,
      ).toBe(true);
    });
    it("moves stable identities before another entry or to the end", () => {
      expect(reorderedQueueIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
      expect(reorderedQueueIds(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
      expect(() => reorderedQueueIds(["a"], "started", null)).toThrow();
      expect(() => reorderedQueueIds(["a"], "a", "started")).toThrow();
    });
    it("bounds native queue pages by Unicode characters and rejects cross-execution cursors", () => {
      const entries = [
        {
          queuedId: "one",
          text: "😀".repeat(7000),
          truncated: false,
          kind: "message" as const,
          held: true,
        },
        {
          queuedId: "two",
          text: "second",
          truncated: false,
          kind: "message" as const,
          held: false,
        },
      ];
      const listed = readSessionQueue("thread", entries, {
        sessionId: "session",
        action: "list",
        limit: 1,
      });
      if (!("items" in listed)) throw new Error("Expected page");
      expect(listed.items[0]?.text).toBe("😀".repeat(250));
      expect(listed.items[0]?.truncated).toBe(true);
      expect(() =>
        readSessionQueue("another", entries, {
          sessionId: "session",
          action: "list",
          limit: 1,
          cursor: listed.nextCursor!,
        }),
      ).toThrow();
      const read = readSessionQueue("thread", entries, {
        sessionId: "session",
        action: "read",
        queuedId: "one",
      });
      if (!("queuedId" in read)) throw new Error("Expected message");
      expect(read.text).toBe("😀".repeat(6000));
      expect(read.truncated).toBe(true);
      expect(read.held).toBe(true);
    });
  });

  it("requires a snooze deadline with an offset or an explicit null", () => {
    const schema = sessionControlSchemas.set_session_snooze;
    for (const until of [null, "2026-11-02T09:00:00Z", "2026-11-02T10:00:00+01:00"])
      expect(schema.parse({ until })).toEqual({ until });
    for (const input of [
      {},
      { until: "tomorrow" },
      { until: "2026-11-02T09:00:00" },
      { until: "2026-02-30T09:00:00Z" },
      { until: null, execution: { threadId: "child" } },
    ])
      expect(schema.safeParse(input).success).toBe(false);
  });
});

describe("session observation schemas", () => {
  const single = [{ sessionId: "one" }];
  const multiple = [...single, { sessionId: "two" }];

  describe("Session wait admission", () => {
    it("defaults single waits to ten minutes and retains two-minute multi-target waits", () => {
      expect(sessionObservationSchemas.wait_sessions.parse({ targets: single }).timeoutMs).toBe(
        600_000,
      );
      expect(sessionObservationSchemas.wait_sessions.parse({ targets: multiple }).timeoutMs).toBe(
        120_000,
      );
      expect(
        sessionObservationSchemas.wait_sessions.parse({ targets: single, timeoutMs: 0 }).timeoutMs,
      ).toBe(0);
    });

    it("allows an hour for one target without widening multi-target or invalid budgets", () => {
      expect(
        sessionObservationSchemas.wait_sessions.parse({ targets: single, timeoutMs: 3_600_000 })
          .timeoutMs,
      ).toBe(3_600_000);
      for (const input of [
        { targets: single, timeoutMs: 3_600_001 },
        { targets: multiple, timeoutMs: 120_001 },
        { targets: single, timeoutMs: -1 },
        { targets: single, timeoutMs: 0.5 },
        { targets: [{ sessionId: "one" }, { sessionId: "one" }] },
      ])
        expect(sessionObservationSchemas.wait_sessions.safeParse(input).success).toBe(false);
    });

    it("exports a valid MCP input schema despite contextual timeout defaults", () => {
      const tool = sessionObservationToolCatalog.find((tool) => tool.name === "wait_sessions");
      expect(ToolSchema.safeParse(tool).success).toBe(true);
      expect(tool?.inputSchema.type).toBe("object");
    });
  });
});

describe("Session questions", () => {
  it("admits typed answers and requires the addressed question for reads and responses", () => {
    expect(sessionQuestionSchema.parse({ action: "list", sessionId: " session " })).toEqual({
      action: "list",
      sessionId: " session ",
    });
    expect(sessionQuestionSchema.safeParse({ action: "read", sessionId: "session" }).success).toBe(
      false,
    );
    expect(
      sessionQuestionSchema.safeParse({ action: "respond", sessionId: "session", requestId: "r" })
        .success,
    ).toBe(false);
    expect(
      sessionQuestionSchema.parse({
        action: "respond",
        sessionId: "session",
        execution: { threadId: "child" },
        requestId: "r",
        answers: { one: "Yes", two: ["A", "B"] },
      }).answers,
    ).toEqual({ one: "Yes", two: ["A", "B"] });
    expect(
      sessionQuestionSchema.parse({
        action: "respond",
        sessionId: "session",
        requestId: "r",
        answers: {},
        idempotencyKey: "answer-1",
      }).idempotencyKey,
    ).toBe("answer-1");
    for (const answers of [{ one: true }, { one: { decision: "accept" } }, { one: [1] }])
      expect(
        sessionQuestionSchema.safeParse({
          action: "respond",
          sessionId: "session",
          requestId: "r",
          answers,
        }).success,
      ).toBe(false);
    expect(
      sessionQuestionSchema.safeParse({
        action: "respond",
        sessionId: "session",
        requestId: "r",
        answers: {},
        decision: "accept",
      }).success,
    ).toBe(false);
  });

  it("publishes the tool as an object schema with bounded execution identities", () => {
    const tool = appToolCatalog.find(({ name }) => name === "session_question");
    expect(tool?.inputSchema.type).toBe("object");
    expect(tool?.inputSchema.required).toEqual(["action", "sessionId"]);
    expect(
      sessionQuestionSchema.safeParse({
        action: "list",
        sessionId: "session",
        execution: { threadId: " " },
      }).success,
    ).toBe(false);
    expect(
      sessionQuestionSchema.safeParse({ action: "list", sessionId: "session", operationId: "bad" })
        .success,
    ).toBe(false);
  });
});

describe("Session discovery scope", () => {
  it("defaults to the caller Project or projectless lane with explicit Profile opt-in", () => {
    expect(resolveSessionScope({}, "project:caller")).toEqual({ projectId: "project:caller" });
    expect(resolveSessionScope({}, null)).toEqual({ projectlessOnly: true });
    expect(resolveSessionScope({ projectId: "project:other" }, "project:caller")).toEqual({
      projectId: "project:other",
    });
    expect(resolveSessionScope({ scope: "profile" }, "project:caller")).toEqual({});
    expect(resolveSessionScope({ scope: "profile" }, null)).toEqual({});
  });
  it("rejects ambiguous Profile and Project scopes at the public boundary", () => {
    expect(
      sessionObservationSchemas.list_sessions.safeParse({ scope: "profile", projectId: "project" })
        .success,
    ).toBe(false);
    expect(sessionObservationSchemas.list_sessions.parse({}).includeSubagents).toBe(true);
  });
});
