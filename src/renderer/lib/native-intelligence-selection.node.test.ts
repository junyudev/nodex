import { expect, test } from "vite-plus/test";
import {
  resolveNativeIntelligenceSelection,
  selectNativeModel,
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

test("changing a model retains advertised Context and clears an incompatible override", () => {
  const selection = { model: "source", effort: "default", context: "1m", thinking: true } as const;
  const options = [
    { value: "compatible", name: "Compatible", description: null, contextWindows: ["200k", "1m"] },
    { value: "limited", name: "Limited", description: null, contextWindows: ["200k"] },
  ];
  expect(selectNativeModel(selection, "compatible", "high", options)).toMatchObject({
    context: "1m",
    thinking: true,
  });
  expect(selectNativeModel(selection, "limited", "high", options)).toEqual({
    model: "limited",
    effort: "high",
    thinking: true,
  });
  expect(selectNativeModel(selection, "source", "high", options).context).toBe("1m");
  expect(selectNativeModel(selection, "default", "default", options).context).toBe("1m");
});
