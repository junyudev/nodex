import { expect, it } from "vitest";
import { DictationDiagnosticsSchema, serializeDictationDiagnostics } from "./dictation-diagnostics";
import { dictationDiagnosticsFixture } from "../../tests/fixtures/dictation-diagnostics";

it("exports only the bounded diagnostics contract", () => {
  const diagnostics = dictationDiagnosticsFixture();
  expect(JSON.parse(serializeDictationDiagnostics(diagnostics))).toEqual(diagnostics);
  expect(() =>
    serializeDictationDiagnostics({
      ...diagnostics,
      transcript: "private text",
    } as typeof diagnostics),
  ).toThrow();
  expect(
    DictationDiagnosticsSchema.safeParse({
      ...diagnostics,
      streaming: { ...diagnostics.streaming, protocols: ["openai-bearer.secret"] },
    }).success,
  ).toBe(false);
  expect(
    DictationDiagnosticsSchema.safeParse({
      ...diagnostics,
      requests: [{ ...diagnostics.requests[0], headers: { authorization: "secret" } }],
    }).success,
  ).toBe(false);
});

it("rejects non-finite, negative and unbounded diagnostic data", () => {
  const diagnostics = dictationDiagnosticsFixture();
  for (const stopToTextMs of [Number.NaN, Infinity, -1]) {
    expect(DictationDiagnosticsSchema.safeParse({ ...diagnostics, stopToTextMs }).success).toBe(
      false,
    );
  }
  expect(
    DictationDiagnosticsSchema.safeParse({
      ...diagnostics,
      phases: Array(13).fill(diagnostics.phases[0]),
    }).success,
  ).toBe(false);
});

it.each(["backpressure-overflow", "invalid-audio-frame"])(
  "keeps saved %s diagnostics readable after transport changes",
  (failureCode) => {
    const diagnostics = dictationDiagnosticsFixture();
    const saved = { ...diagnostics, streaming: { ...diagnostics.streaming, failureCode } };
    expect(DictationDiagnosticsSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  },
);
