import { describe, expect, test } from "vite-plus/test";

import {
  createDefaultWorkbenchLayoutSnapshot,
  createDefaultWorkbenchLayoutSnapshotV3,
} from "../workbench-layout";
import {
  LegacyWindowSessionCatalogV1Schema,
  LegacyWindowSessionCatalogV2Schema,
  WindowSessionCatalogSchema,
} from "./window-session";

function record(
  lifecycle: { state: "open" } | { state: "closed"; closedAt: string } = {
    state: "open",
  },
) {
  return {
    id: "window-1",
    lifecycle,
    layoutRevision: 3,
    layout: createDefaultWorkbenchLayoutSnapshot(),
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    focusedAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("WindowSession schemas", () => {
  test("accepts catalog v3 with strict open and closed lifecycles", () => {
    const parsed = WindowSessionCatalogSchema.parse({
      version: 3,
      lastActiveSessionId: "window-1",
      sessions: [
        record(),
        {
          ...record({
            state: "closed",
            closedAt: "2026-07-24T00:00:00.000Z",
          }),
          id: "window-2",
        },
      ],
    });

    expect(parsed.sessions[0]?.layoutRevision).toBe(3);
    expect(parsed.sessions[0]?.layout.version).toBe(8);
    expect(parsed.sessions[1]?.lifecycle).toEqual({
      state: "closed",
      closedAt: "2026-07-24T00:00:00.000Z",
    });
  });

  test("rejects invalid lifecycle and revision combinations", () => {
    const missing = record() as Record<string, unknown>;
    delete missing.layoutRevision;
    const missingLifecycle = record() as Record<string, unknown>;
    delete missingLifecycle.lifecycle;

    expect(() =>
      WindowSessionCatalogSchema.parse({
        version: 3,
        lastActiveSessionId: "window-1",
        sessions: [missing],
      }),
    ).toThrow();
    expect(() =>
      WindowSessionCatalogSchema.parse({
        version: 3,
        lastActiveSessionId: "window-1",
        sessions: [{ ...record(), layoutRevision: -1 }],
      }),
    ).toThrow();
    expect(() =>
      WindowSessionCatalogSchema.parse({
        version: 3,
        lastActiveSessionId: "window-1",
        sessions: [missingLifecycle],
      }),
    ).toThrow();
    expect(() =>
      WindowSessionCatalogSchema.parse({
        version: 3,
        lastActiveSessionId: "window-1",
        sessions: [record({ state: "closed", closedAt: "" })],
      }),
    ).toThrow();
    expect(() =>
      WindowSessionCatalogSchema.parse({
        version: 3,
        lastActiveSessionId: "window-1",
        sessions: [
          {
            ...record(),
            lifecycle: { state: "open", closedAt: "2026-07-24T00:00:00.000Z" },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      WindowSessionCatalogSchema.parse({
        version: 3,
        lastActiveSessionId: "window-1",
        sessions: [
          {
            ...record(),
            lifecycle: { state: "closed" },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      WindowSessionCatalogSchema.parse({
        version: 2,
        lastActiveSessionId: "window-1",
        sessions: [record()],
      }),
    ).toThrow();
  });

  test("decodes legacy catalog v2 without accepting lifecycle fields", () => {
    const legacyRecord = record() as Record<string, unknown>;
    delete legacyRecord.lifecycle;
    const parsed = LegacyWindowSessionCatalogV2Schema.parse({
      version: 2,
      lastActiveSessionId: "window-1",
      sessions: [legacyRecord],
    });

    expect(parsed.sessions[0]?.id).toBe("window-1");
    expect(parsed.sessions[0]?.layoutRevision).toBe(3);
    expect(() =>
      LegacyWindowSessionCatalogV2Schema.parse({
        version: 2,
        lastActiveSessionId: "window-1",
        sessions: [record()],
      }),
    ).toThrow();
  });

  test("decodes legacy catalog layouts into the current Workbench layout", () => {
    const legacyLayout: Record<string, unknown> = {
      ...createDefaultWorkbenchLayoutSnapshotV3(),
      version: 2,
    };
    delete legacyLayout.sessionViewsBySessionId;

    const legacyRecord = record() as Record<string, unknown>;
    delete legacyRecord.lifecycle;
    delete legacyRecord.layoutRevision;
    const parsed = LegacyWindowSessionCatalogV1Schema.parse({
      version: 1,
      lastActiveSessionId: "window-1",
      sessions: [
        {
          ...legacyRecord,
          layout: legacyLayout,
        },
      ],
    });

    expect(parsed.sessions[0]?.layout.version).toBe(8);
    expect(parsed.sessions[0]?.layout.scenesByOwnerKey).toEqual({});
  });
});
