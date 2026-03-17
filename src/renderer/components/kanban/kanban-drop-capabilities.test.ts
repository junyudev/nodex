import { describe, expect, test } from "bun:test";
import { resolveKanbanDropCapabilities } from "./kanban-drop-capabilities";

describe("resolveKanbanDropCapabilities", () => {
  test("keeps both card and column targets active under the default board sort", () => {
    const capabilities = resolveKanbanDropCapabilities({
      hasNonDefaultSort: false,
    });

    expect(capabilities.allowCardTargets).toBeTrue();
    expect(capabilities.allowColumnTargets).toBeTrue();
  });

  test("disables only card targets under non-default sort so cross-column drops still resolve", () => {
    const capabilities = resolveKanbanDropCapabilities({
      hasNonDefaultSort: true,
    });

    expect(capabilities.allowCardTargets).toBeFalse();
    expect(capabilities.allowColumnTargets).toBeTrue();
  });
});
