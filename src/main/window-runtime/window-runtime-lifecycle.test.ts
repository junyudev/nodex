import { describe, expect, test } from "vite-plus/test";
import {
  selectPreferredWindowRuntimeWindow,
  type WindowRuntimeSnapshot,
  type WindowRuntimeWindowSnapshot,
} from "./window-runtime-lifecycle";

function primary(
  webContentsId: number,
  overrides: Partial<WindowRuntimeWindowSnapshot> = {},
): WindowRuntimeWindowSnapshot {
  return {
    activeSessionId: `session-${webContentsId}`,
    focusSequence: null,
    focused: false,
    kind: "primary",
    layoutRevision: 1,
    webContentsId,
    windowId: webContentsId,
    windowSessionId: `window-session-${webContentsId}`,
    ...overrides,
  } as WindowRuntimeWindowSnapshot;
}

const eligiblePrimary = (window: WindowRuntimeWindowSnapshot): boolean =>
  window.kind === "primary" && window.activeSessionId !== null;

describe("selectPreferredWindowRuntimeWindow", () => {
  test("prefers focused, then most recently focused eligible windows", () => {
    const snapshot: WindowRuntimeSnapshot = {
      revision: 5,
      windows: [
        primary(1, { focusSequence: 3 }),
        primary(2, { focusSequence: 8 }),
        primary(3, { focusSequence: 5, focused: true }),
      ],
    };

    expect(selectPreferredWindowRuntimeWindow(snapshot, eligiblePrimary)?.webContentsId).toBe(3);
    expect(
      selectPreferredWindowRuntimeWindow(
        {
          ...snapshot,
          windows: snapshot.windows.map((window) => ({ ...window, focused: false })),
        },
        eligiblePrimary,
      )?.webContentsId,
    ).toBe(2);
  });

  test("uses a sole never-focused eligible window and rejects ambiguous candidates", () => {
    const sole = primary(1);
    expect(
      selectPreferredWindowRuntimeWindow({ revision: 0, windows: [sole] }, eligiblePrimary),
    ).toEqual(sole);
    expect(
      selectPreferredWindowRuntimeWindow(
        { revision: 0, windows: [sole, primary(2)] },
        eligiblePrimary,
      ),
    ).toBeNull();
  });
});
