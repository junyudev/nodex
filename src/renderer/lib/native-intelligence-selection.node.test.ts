import { expect, test } from "vite-plus/test";
import {
  fitNativeSelection,
  nativeSelectionsMatch,
  resolveNativeIntelligenceSelection,
} from "./native-intelligence-selection";

test("live native state never substitutes requested preferences for unobserved applied values", () => {
  expect(
    resolveNativeIntelligenceSelection(
      { model: "requested-model", effort: "high", fast: true, thinking: false },
      { model: null, effort: null, fast: null, thinking: null },
      false,
    ),
  ).toEqual({ model: "", effort: "default", fast: null, thinking: null });
});

test("draft inheritance uses resolved native state while explicit false choices remain explicit", () => {
  expect(
    resolveNativeIntelligenceSelection(
      { model: "default", effort: "default", fast: false, thinking: false },
      { model: "resolved-model", effort: "medium", fast: true, thinking: true },
      true,
    ),
  ).toEqual({ model: "resolved-model", effort: "medium", fast: false, thinking: false });
});

test("a different draft model does not borrow another model's default effort", () => {
  expect(
    resolveNativeIntelligenceSelection(
      { model: "next-model", effort: "default" },
      { model: "profile-model", effort: "high" },
      true,
    ),
  ).toMatchObject({ model: "next-model", effort: "default" });
});

test("live Context uses native model decoration while drafts preserve their unsent override", () => {
  const requested = { model: "default", effort: "default", context: "1m" } as const;
  const observed = { model: "gateway/private[200k]", effort: "high" };
  expect(resolveNativeIntelligenceSelection(requested, observed, false).context).toBe("200k");
  expect(resolveNativeIntelligenceSelection(requested, observed, true).context).toBe("1m");
  expect(
    resolveNativeIntelligenceSelection(requested, { model: null, effort: null }, false).context,
  ).toBeUndefined();
});

const capable = {
  value: "capable",
  name: "Capable",
  description: null,
  reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  fastMode: true,
  adaptiveThinking: true,
  disableThinking: true,
  contextWindows: ["200k", "1m"],
};
const limited = {
  value: "limited",
  name: "Limited",
  description: null,
  reasoningEfforts: ["low", "medium", "high"],
  fastMode: false,
  adaptiveThinking: true,
  contextWindows: ["200k"],
};

test("preferences a model cannot honor are fitted for it and return on a capable model", () => {
  const intent = {
    model: "capable",
    effort: "max",
    fast: true,
    thinking: false,
    context: "1m",
  } as const;
  expect(fitNativeSelection({ ...intent, model: "limited" }, limited)).toEqual({
    model: "limited",
    effort: "high",
    fast: false,
  });
  expect(fitNativeSelection(intent, capable)).toEqual(intent);
});

test("effort falls back to the nearest lower advertised level, else the lowest, else the default", () => {
  const sparse = { ...limited, reasoningEfforts: ["medium", "xhigh"] };
  const fit = (effort: "low" | "high" | "max", target = sparse) =>
    fitNativeSelection({ model: target.value, effort }, target).effort;
  expect(fit("high")).toBe("medium");
  expect(fit("max")).toBe("xhigh");
  expect(fit("low")).toBe("medium");
  expect(fit("high", { ...limited, reasoningEfforts: [] })).toBe("default");
  expect(fitNativeSelection({ model: "limited", effort: "default" }, limited).effort).toBe(
    "default",
  );
});

test("thinking off bounds effort to the levels the model permits without thinking", () => {
  const bounded = { ...capable, disabledThinkingEfforts: ["low", "medium", "high"] };
  expect(
    fitNativeSelection({ model: "capable", effort: "max", thinking: false }, bounded),
  ).toMatchObject({ effort: "high", thinking: false });
});

test("an unknown model leaves intent for the runtime to resolve", () => {
  const intent = { model: "unlisted", effort: "max", fast: true } as const;
  expect(fitNativeSelection(intent, undefined)).toBe(intent);
});

test("an absent Fast override matches an explicit Fast off", () => {
  const selection = { model: "limited", effort: "high" } as const;
  expect(nativeSelectionsMatch(selection, { ...selection, fast: false })).toBe(true);
  expect(nativeSelectionsMatch(selection, { ...selection, fast: true })).toBe(false);
  expect(nativeSelectionsMatch(selection, { ...selection, effort: "low" })).toBe(false);
});
