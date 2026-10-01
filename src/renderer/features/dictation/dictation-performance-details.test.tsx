import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DictationPerformanceDetails } from "./dictation-performance-details";
import { dictationDiagnosticsFixture } from "../../../../tests/fixtures/dictation-diagnostics";
import { emptyDictationStreamDiagnostics } from "../../../shared/dictation-diagnostics";

vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), danger: vi.fn() } }));

it("distinguishes a connected WebSocket from the buffered result actually used and copies only diagnostics", async () => {
  const diagnostics = dictationDiagnosticsFixture();
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<DictationPerformanceDetails diagnostics={diagnostics} />);
  await act(async () => {
    fireEvent.click(screen.getByText("Performance details"));
    await Promise.resolve();
  });
  expect(screen.getByText("Buffered upload · 1.34 s after stop")).toBeTruthy();
  expect(
    within(screen.getByText("Handshake completed").parentElement!).getByText("Yes"),
  ).toBeTruthy();
  expect(within(screen.getByText("Result used").parentElement!).getByText("No")).toBeTruthy();
  expect(screen.getByText("abnormal-close")).toBeTruthy();
  expect(screen.getByText("Text cleanup · gpt-5.6-luna")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenCalledOnce();
  expect(JSON.parse(writeText.mock.calls[0]![0]!)).toEqual(diagnostics);
});

it("shows captured Main handshake evidence separately from stream completion", () => {
  const diagnostics = dictationDiagnosticsFixture();
  diagnostics.streaming = {
    ...diagnostics.streaming!,
    opened: false,
    started: false,
    headers: {
      originator: "Codex Desktop",
      userAgent: "Codex Desktop/1.0.0 (Mac OS; arm64)",
      authorizationPresent: true,
      accountHeaderPresent: true,
    },
    proxyMode: "socks",
    httpStatus: 403,
    edgeChallenge: "cloudflare",
    failureCode: "edge-challenge",
  };
  render(<DictationPerformanceDetails diagnostics={diagnostics} />);
  expect(
    within(screen.getByText("Handshake completed").parentElement!).getByText("No"),
  ).toBeTruthy();
  expect(
    within(screen.getByText("Handshake response").parentElement!).getByText("HTTP 403"),
  ).toBeTruthy();
  expect(
    within(screen.getByText("Edge challenge").parentElement!).getByText("Cloudflare"),
  ).toBeTruthy();
  expect(within(screen.getByText("Proxy").parentElement!).getByText("socks")).toBeTruthy();
  expect(screen.getByText("Bearer present · Account header present")).toBeTruthy();
});

it("measures initial file transcription independently of capture or retry", () => {
  const diagnostics = dictationDiagnosticsFixture();
  diagnostics.source = "file";
  diagnostics.delivery = "history";
  render(<DictationPerformanceDetails diagnostics={diagnostics} />);
  expect(screen.getByText("Buffered upload · 1.34 s total")).toBeTruthy();
  expect(screen.getByText("Transcription → saved text")).toBeTruthy();
});

it.each([
  {
    reason: { skipReason: "unavailable" as const },
    label: "Streaming skipped",
    value: "unavailable",
  },
  {
    reason: { failureCode: "capability-read-failed" as const },
    label: "Streaming failure",
    value: "capability-read-failed",
  },
])("explains why the WebSocket was not attempted ($value)", ({ reason, label, value }) => {
  const diagnostics = dictationDiagnosticsFixture();
  diagnostics.streaming = { ...emptyDictationStreamDiagnostics(), ...reason };
  render(<DictationPerformanceDetails diagnostics={diagnostics} />);
  expect(
    within(screen.getByText("WebSocket attempted").parentElement!).getByText("No"),
  ).toBeTruthy();
  expect(within(screen.getByText(label).parentElement!).getByText(value)).toBeTruthy();
});
