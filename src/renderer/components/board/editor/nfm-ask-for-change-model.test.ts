import { describe, expect, test } from "vite-plus/test";
import {
  buildNfmAskForChangeRequest,
  reduceNfmAskForChange,
  type NfmAskForChangeState,
} from "./nfm-ask-for-change-model";

const source = { markdown: "Draft **text**", before: "Intro", after: "" };

describe("Ask for change review", () => {
  test("rewrites the selection first, then refines the proposal on screen", () => {
    let state: NfmAskForChangeState = reduceNfmAskForChange(
      { phase: "closed" },
      { type: "open", source },
    );
    state = reduceNfmAskForChange(state, { type: "ask", instruction: "  Shorter  " });
    expect(state).toMatchObject({
      phase: "working",
      basis: "Draft **text**",
      instruction: "Shorter",
    });

    state = reduceNfmAskForChange(state, { type: "settled", proposal: "Draft" });
    expect(state).toMatchObject({ phase: "review", proposal: "Draft" });

    state = reduceNfmAskForChange(state, { type: "ask", instruction: "In French" });
    expect(state).toMatchObject({ phase: "working", basis: "Draft", instruction: "In French" });
  });

  test("Try again repeats the same request; failures keep it for another try", () => {
    const working = reduceNfmAskForChange(
      { phase: "compose", source },
      { type: "ask", instruction: "Shorter" },
    );
    const failed = reduceNfmAskForChange(working, { type: "failed", message: "Timed out" });
    expect(failed).toMatchObject({ phase: "failed", message: "Timed out" });
    expect(reduceNfmAskForChange(failed, { type: "retry" })).toEqual(working);
  });

  test("ignores blank instructions, a second ask while working and late results", () => {
    const compose: NfmAskForChangeState = { phase: "compose", source };
    expect(reduceNfmAskForChange(compose, { type: "ask", instruction: " " })).toBe(compose);
    const working = reduceNfmAskForChange(compose, { type: "ask", instruction: "Shorter" });
    expect(reduceNfmAskForChange(working, { type: "ask", instruction: "Longer" })).toBe(working);
    const closed = reduceNfmAskForChange(working, { type: "close" });
    expect(reduceNfmAskForChange(closed, { type: "settled", proposal: "late" })).toBe(closed);
  });

  test("sends only the surrounding text that exists, bounded to the nearest characters", () => {
    const longBefore = `${"x".repeat(5_000)}END`;
    const request = buildNfmAskForChangeRequest({
      phase: "working",
      source: { markdown: "Body", before: longBefore, after: "  " },
      basis: "Body",
      instruction: "Shorter",
    });
    expect(request.markdown).toBe("Body");
    expect(request.context?.after).toBeUndefined();
    expect(request.context?.before?.length).toBe(2_000);
    expect(request.context?.before?.endsWith("END")).toBe(true);
  });
});
