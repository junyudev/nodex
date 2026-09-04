import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GlobalDictationBar, GlobalDictationRoot } from "./global-dictation-page";

describe("GlobalDictationBar", () => {
  it("exposes retry and dismiss actions in an actionable error state", () => {
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    render(
      <GlobalDictationBar
        state="error"
        waveform={[]}
        error={{ kind: "paste-failed", operation: "paste", retryable: true }}
        onDismiss={onDismiss}
        onRetry={onRetry}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(screen.getAllByText("Couldn’t paste text")).toHaveLength(2);
  });

  it("keeps permission errors compact and actionable", () => {
    render(
      <GlobalDictationBar
        state="error"
        waveform={[]}
        error={{ kind: "accessibility-denied", operation: "paste", retryable: true }}
        onDismiss={() => undefined}
        onRetry={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByText("Accessibility access is required")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  });

  it("renders the live waveform without adding retry during capture", () => {
    const { container } = render(
      <GlobalDictationBar
        state="listening"
        waveform={[0.02, 0.08, 0.04, 0.06]}
        onDismiss={() => undefined}
        onRetry={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("Listening")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("replaces the waveform with the transcribing status as soon as capture stops", () => {
    const props = {
      waveform: [0.02, 0.08, 0.04, 0.06],
      onDismiss: () => undefined,
      onRetry: () => undefined,
      onClose: () => undefined,
    } as const;
    const { container, rerender } = render(<GlobalDictationBar state="listening" {...props} />);
    expect(container.querySelector("canvas")).not.toBeNull();

    rerender(<GlobalDictationBar state="transcribing" {...props} />);

    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.getByText("Transcribing…")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("GlobalDictationRoot", () => {
  it("announces readiness through the restricted bridge", async () => {
    const sendEvent = vi.fn(async () => true);
    const commandHandlers: Array<
      (command: import("../../../shared/global-dictation").GlobalDictationRendererCommand) => void
    > = [];
    const descriptor = Object.getOwnPropertyDescriptor(window, "globalDictation");
    Object.defineProperty(window, "globalDictation", {
      configurable: true,
      value: {
        invoke: async (channel: string) =>
          channel === "codex:dictation:settings:read"
            ? {
                microphoneInputDeviceId: null,
                keepGlobalBarVisible: false,
                playStartSound: true,
                playStopSound: true,
                globalShortcutNudgeDismissed: false,
                dictionary: [],
              }
            : null,
        onCommand: (callback: (typeof commandHandlers)[number]) => {
          commandHandlers.push(callback);
          return () => {
            commandHandlers.length = 0;
          };
        },
        sendEvent,
        showContextMenu: async () => null,
      },
    });
    try {
      render(<GlobalDictationRoot />);
      await waitFor(() => expect(sendEvent).toHaveBeenCalledWith({ type: "ready" }));
      expect(screen.queryByText("Dictation ready")).toBeNull();
      await act(async () => {
        commandHandlers[0]?.({
          type: "idle",
          configuredHotkey: "Fn",
          configuredToggleHotkey: "Command+Shift+D",
        });
        await Promise.resolve();
      });
      await screen.findByText("Dictation ready");
    } finally {
      if (descriptor) Object.defineProperty(window, "globalDictation", descriptor);
      else Reflect.deleteProperty(window, "globalDictation");
    }
  });
});
