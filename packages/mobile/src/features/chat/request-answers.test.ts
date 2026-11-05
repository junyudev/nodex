import type { ChatQuestion } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vitest";

import { answersFromSelections, isQuestionAnswered, toggleSelection } from "./request-answers";

const question = (id: string): ChatQuestion => ({
  id,
  prompt: id,
  header: null,
  multiSelect: false,
  options: [],
  allowsText: true,
});

describe("toggleSelection", () => {
  it("replaces a single choice and clears it when tapped again", () => {
    expect(toggleSelection(["a"], "b", false)).toEqual(["b"]);
    expect(toggleSelection(["a"], "a", false)).toEqual([]);
  });

  it("adds and removes in a multiple choice", () => {
    expect(toggleSelection(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleSelection(["a", "b"], "a", true)).toEqual(["b"]);
  });
});

describe("isQuestionAnswered", () => {
  it("accepts a choice or real text, not blank text", () => {
    expect(isQuestionAnswered(["a"], "")).toBe(true);
    expect(isQuestionAnswered([], " x ")).toBe(true);
    expect(isQuestionAnswered([], "   ")).toBe(false);
  });
});

describe("answersFromSelections", () => {
  it("combines choices and trimmed text per question", () => {
    expect(
      answersFromSelections(
        [question("q1"), question("q2")],
        { q1: ["a"] },
        { q1: " why ", q2: "" },
      ),
    ).toEqual({ q1: ["a", "why"], q2: [] });
  });
});
