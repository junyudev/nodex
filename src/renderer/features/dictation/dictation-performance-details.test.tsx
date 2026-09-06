import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DictationPerformanceDetails } from "./dictation-performance-details";
import { dictationDiagnosticsFixture } from "../../../../tests/fixtures/dictation-diagnostics";

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
