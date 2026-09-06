import { describe, expect, it, vi } from "vitest";
import { ClipboardSafePasteError, ClipboardSafePasteService } from "./clipboard-safe-paste-service";

describe("ClipboardSafePasteService", () => {
  it("delegates one native transaction with normalized trailing space", async () => {
    const safePaste = vi.fn(async () => ({ clipboardRestoreMs: 710 }));
    const service = new ClipboardSafePasteService({
      helper: {
        capabilities: async () => ({ inputMonitoring: true, accessibility: true }),
        safePaste,
      },
    });
    const target = { pid: 42, bundleIdentifier: "example.app" };

    await service.paste("  hello  ", target);

    expect(safePaste).toHaveBeenCalledWith("hello ", target);
  });

  it("checks Accessibility before asking the helper to mutate the pasteboard", async () => {
    const safePaste = vi.fn(async () => ({ clipboardRestoreMs: 710 }));
    const service = new ClipboardSafePasteService({
      helper: {
        capabilities: async () => ({ inputMonitoring: true, accessibility: false }),
        safePaste,
      },
    });

    await expect(
      service.paste("hello", { pid: 42, bundleIdentifier: "example.app" }),
    ).rejects.toMatchObject({
      dictationError: { kind: "accessibility-denied", operation: "paste", retryable: true },
    });
    expect(safePaste).not.toHaveBeenCalled();
  });

  it("maps a rejected native transaction to a retryable paste error", async () => {
    const service = new ClipboardSafePasteService({
      helper: {
        capabilities: async () => ({ inputMonitoring: true, accessibility: true }),
        safePaste: async () => {
          throw new Error("target-changed");
        },
      },
    });

    await expect(
      service.paste("hello", { pid: 42, bundleIdentifier: "example.app" }),
    ).rejects.toBeInstanceOf(ClipboardSafePasteError);
  });
});
