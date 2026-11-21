import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerTipLine } from "./composer-tip-line";

vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));

describe("ComposerTipLine", () => {
  it("says the tip politely, with its one thing to try and a way to put it away", async () => {
    const run = vi.fn();
    const dismiss = vi.fn();
    render(
      <ComposerTipLine
        tip={{
          key: "tip:second-opinion",
          text: "Want a second opinion? Codex can review this.",
          action: { label: "Ask Codex", run },
          dismiss,
        }}
      />,
    );

    const tip = screen.getByRole("status");
    expect(tip.getAttribute("aria-live")).toBe("polite");
    expect(tip.textContent).toContain("Want a second opinion? Codex can review this.");

    await act(async () => {
      screen.getByRole("button", { name: "Ask Codex" }).click();
      await Promise.resolve();
    });
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen.getByRole("button", { name: "Dismiss tip" }).click();
      await Promise.resolve();
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("names what it is doing while its action is pending, and takes no second press", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(
      <ComposerTipLine
        tip={{
          key: "tip:notifications",
          text: "Get a notification when an agent finishes?",
          action: { label: "Turn on", pendingLabel: "Asking…", run },
          dismiss: vi.fn(),
        }}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: "Turn on" }).click();
      await Promise.resolve();
    });
    const asking = screen.getByRole("button", { name: "Asking…" }) as HTMLButtonElement;
    expect(asking.disabled).toBe(true);

    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Turn on" })).toBeTruthy();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("offers nothing to press when the tip only explains", () => {
    render(<ComposerTipLine tip={{ key: "tip:page", text: "That’s a Page.", dismiss: vi.fn() }} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
