import { describe, expect, test } from "vite-plus/test";
import { decodeProductEvent, decodeRendererProductEvent } from "./catalog";
import { analyticsCode, analyticsDay, analyticsModelName, analyticsProviderName } from "./names";
import { resolveRemoteSignal } from "./remote-signals";

describe("catalog", () => {
  const threadStarted = {
    name: "thread_started",
    properties: {
      provider: "codex",
      model: "gpt-6-luna",
      source: "web",
      actor: "user",
      host: "local",
    },
  };

  describe("product event catalog", () => {
    test("admits a catalogued event", () => {
      expect(decodeProductEvent(threadStarted)).not.toBeNull();
    });

    test.each([
      ["an unknown event", { name: "prompt_sent", properties: { text: "hello" } }],
      [
        "an extra property",
        { ...threadStarted, properties: { ...threadStarted.properties, cwd: "/x" } },
      ],
      ["an extra top-level field", { ...threadStarted, prompt: "hello" }],
      [
        "a value outside a closed set",
        { ...threadStarted, properties: { ...threadStarted.properties, actor: "secret" } },
      ],
      [
        "free text in a code field",
        {
          ...threadStarted,
          properties: { ...threadStarted.properties, model: "fix the login bug" },
        },
      ],
      [
        "a path in a code field",
        { ...threadStarted, properties: { ...threadStarted.properties, model: "/Users/me/app" } },
      ],
    ])("rejects %s", (_label, candidate) => {
      expect(decodeProductEvent(candidate)).toBeNull();
    });

    test("a renderer can report window events but not installation or execution facts", () => {
      expect(
        decodeRendererProductEvent({ name: "feature_used", properties: { feature: "terminal" } }),
      ).not.toBeNull();
      for (const candidate of [
        threadStarted,
        { name: "app_active", properties: {} },
        { name: "installation_created", properties: { profile: "new" } },
      ]) {
        expect(decodeRendererProductEvent(candidate)).toBeNull();
      }
    });
  });

  describe("analytics vocabulary", () => {
    test("keeps public model names and hides private ones", () => {
      expect(analyticsModelName("GPT-6-Luna")).toBe("gpt-6-luna");
      expect(analyticsModelName("claude-opus-5-5")).toBe("claude-opus-5-5");
      expect(analyticsModelName("acme-internal-llm")).toBe("other");
      expect(analyticsModelName("gpt with spaces")).toBe("other");
      expect(analyticsModelName(null)).toBe("other");
    });

    test("reports the Agent family rather than the runtime driver", () => {
      expect(analyticsProviderName("claudeAgent")).toBe("claude");
      expect(analyticsProviderName("opencode2")).toBe("opencode");
      expect(analyticsProviderName("acpRegistry")).toBe("acp");
      expect(analyticsProviderName("mystery")).toBe("other");
    });

    test("fits labels to the code vocabulary", () => {
      expect(analyticsCode("rate limited/now")).toBe("rate_limited_now");
      expect(analyticsCode("x".repeat(200))).toHaveLength(64);
      expect(analyticsCode("   ")).toBeUndefined();
      expect(analyticsCode(null)).toBeUndefined();
    });

    test("a reporting day is the UTC calendar day", () => {
      expect(analyticsDay(Date.UTC(2026, 10, 7, 23, 59, 59))).toBe("2026-11-07");
      expect(analyticsDay(Date.UTC(2026, 10, 8, 0, 0, 0))).toBe("2026-11-08");
    });
  });
});

describe("remote signals", () => {
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
      expect(resolveRemoteSignal({ ...released, environment: { CI: "true" } }).blockedBy).toBe(
        "ci",
      );
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
});
