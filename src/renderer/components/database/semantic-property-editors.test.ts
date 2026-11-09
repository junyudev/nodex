import { describe, expect, test } from "vite-plus/test";
import {
  orderSemanticPropertyOptions,
  presentSemanticPropertyOptions,
} from "./semantic-property-editors";

describe("semantic Property option authority", () => {
  test("orders fixed semantic identities independently of renamed labels", () => {
    expect(
      orderSemanticPropertyOptions("status", [
        { id: "review", name: "QA" },
        { id: "triage", name: "Inbox" },
        { id: "done", name: "Done" },
        { id: "plan", name: "Ready" },
        { id: "doing", name: "Doing" },
      ]).map((option) => option.name),
    ).toEqual(["Inbox", "Ready", "Doing", "QA", "Done"]);
  });

  test("never restores a fixed option that ready registry authority deleted", () => {
    expect(
      presentSemanticPropertyOptions("status", [{ id: "doing", name: "Doing" }], "doing", "ready"),
    ).toEqual([{ id: "doing", name: "Doing" }]);
  });

  test("uses a non-authoritative fallback only to present the selected value while loading", () => {
    expect(presentSemanticPropertyOptions("status", [], "review", "loading")).toEqual([
      { id: "review", name: "In Review" },
    ]);
  });

  test("fails closed on retired or unknown Priority registry options", () => {
    expect(
      presentSemanticPropertyOptions(
        "priority",
        [
          { id: "p4-later", name: "P4 - Later" },
          { id: "custom", name: "Custom" },
          { id: "p3-low", name: "Low" },
        ],
        "p4-later",
        "loading",
      ),
    ).toEqual([{ id: "p3-low", name: "Low" }]);
  });
});
