import { describe, expect, test } from "vite-plus/test";
import { resolveRemoteSignal } from "./remote-signals";

const released = { preference: true, override: null, isPackaged: true, environment: {} };

describe("remote signal policy", () => {
  test("a released build follows the preference", () => {
    expect(resolveRemoteSignal(released)).toEqual({ active: true, blockedBy: null });
    expect(resolveRemoteSignal({ ...released, preference: false })).toEqual({
      active: false,
      blockedBy: null,
    });
  });

  test("development builds and automation stay silent even with the preference on", () => {
    expect(resolveRemoteSignal({ ...released, isPackaged: false }).blockedBy).toBe(
      "development-build",
    );
    expect(resolveRemoteSignal({ ...released, environment: { CI: "true" } }).blockedBy).toBe("ci");
  });

  test.each([
    ["1", true],
    ["true", true],
    ["0", false],
    ["false", false],
    ["", false],
  ])("DO_NOT_TRACK=%s opts out: %s", (value, optedOut) => {
    const decision = resolveRemoteSignal({ ...released, environment: { DO_NOT_TRACK: value } });
    expect(decision.active).toBe(!optedOut);
    expect(decision.blockedBy).toBe(optedOut ? "do-not-track" : null);
  });

  test("an explicit override wins over every default", () => {
    const development = { ...released, isPackaged: false, environment: { CI: "1" } };
    expect(resolveRemoteSignal({ ...development, override: true }).active).toBe(true);
    expect(resolveRemoteSignal({ ...released, override: false })).toEqual({
      active: false,
      blockedBy: "environment",
    });
  });
});
