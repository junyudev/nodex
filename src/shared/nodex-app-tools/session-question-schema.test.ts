import { describe, expect, it } from "vite-plus/test";
import { appToolCatalog } from "./catalog";
import { sessionQuestionSchema } from "./session-question-schema";

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
