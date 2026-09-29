import { expect, test } from "vite-plus/test";
import { resolveNativeIntelligenceSelection } from "./native-intelligence-selection";

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
