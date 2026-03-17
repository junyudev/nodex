import { describe, expect, test } from "bun:test";
import { resolveKanbanDropCapabilities } from "./kanban-drop-capabilities";

describe("resolveKanbanDropCapabilities", () => {
  test("keeps both card and column targets active under the default board sort", () => {
    const capabilities = resolveKanbanDropCapabilities({
      dragMode: { kind: "manual-rank" },
    });

    expect(capabilities.allowCardTargets).toBeTrue();
    expect(capabilities.allowColumnTargets).toBeTrue();
  });

  test("keeps card targets active for inferable property-sorted drags", () => {
    const capabilities = resolveKanbanDropCapabilities({
      dragMode: { kind: "property-sorted", field: "priority" },
    });

    expect(capabilities.allowCardTargets).toBeTrue();
    expect(capabilities.allowColumnTargets).toBeTrue();
  });

  test("disables only card targets under move-only derived sorts so cross-column drops still resolve", () => {
    const capabilities = resolveKanbanDropCapabilities({
      dragMode: { kind: "derived-move-only", field: "title" },
    });

    expect(capabilities.allowCardTargets).toBeFalse();
    expect(capabilities.allowColumnTargets).toBeTrue();
  });
});
