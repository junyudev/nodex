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

it.each([
  { skipReason: "unavailable" },
  { skipReason: "unknown" },
  { skipReason: "language-selected" },
  { failureCode: "capability-read-failed" },
] as const)(
  "exports a closed reason for an unattempted stream ($skipReason $failureCode)",
  (reason) => {
    const diagnostics = dictationDiagnosticsFixture();
    const report = {
      ...diagnostics,
      streaming: { ...diagnostics.streaming!, attempted: false, opened: false, ...reason },
    };
    expect(JSON.parse(serializeDictationDiagnostics(report))).toEqual(report);
    expect(
      DictationDiagnosticsSchema.safeParse({
        ...report,
        streaming: { ...report.streaming, skipReason: "private error or account data" },
      }).success,
    ).toBe(false);
  },
);

it.each([
  "backpressure-overflow",
  "invalid-audio-frame",
  "connect-info-failed",
  "invalid-connect-info",
  "start-timeout",
])("keeps saved %s diagnostics readable after transport changes", (failureCode) => {
  const diagnostics = dictationDiagnosticsFixture();
  const saved = { ...diagnostics, streaming: { ...diagnostics.streaming, failureCode } };
  expect(DictationDiagnosticsSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
});

it("retains selected desktop headers, proxy strategy, and classified handshake rejection evidence", () => {
  const diagnostics = dictationDiagnosticsFixture();
  const rejected = {
    ...diagnostics,
    streaming: {
      ...diagnostics.streaming!,
      opened: false,
      started: false,
      failureCode: "edge-challenge" as const,
      httpStatus: 403,
      edgeChallenge: "cloudflare" as const,
      networkError: "proxy" as const,
      proxyMode: "http" as const,
      headers: {
        originator: "Codex Desktop",
        userAgent: "Codex Desktop/test (Mac OS; arm64)",
        authorizationPresent: true,
        accountHeaderPresent: true,
      },
    },
  };
  expect(JSON.parse(serializeDictationDiagnostics(rejected))).toEqual(rejected);
  for (const streaming of [
    { ...rejected.streaming, httpStatus: 600 },
    { ...rejected.streaming, networkError: "ECONNRESET private endpoint" },
    { ...rejected.streaming, edgeChallenge: "<html>private response</html>" },
    { ...rejected.streaming, websocketUrl: "wss://private.example/account" },
    {
      ...rejected.streaming,
      headers: { ...rejected.streaming.headers, authorization: "Bearer secret" },
    },
    {
      ...rejected.streaming,
      headers: { ...rejected.streaming.headers, accountId: "private-account" },
    },
  ]) {
    expect(DictationDiagnosticsSchema.safeParse({ ...rejected, streaming }).success).toBe(false);
  }
});
