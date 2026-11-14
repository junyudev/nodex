import { describe, expect, test } from "vite-plus/test";
import { groupPageInsertItems } from "./page-insert-menu";

const item = (key: string, group: string) => ({ key, group });

describe("groupPageInsertItems", () => {
  test("leads with Agent, Pages and Blocks, then other groups in catalog order", () => {
    const sections = groupPageInsertItems(
      [
        item("emoji", "Text"),
        item("divider", "Blocks"),
        item("embed", "Media"),
        item("subpage", "Pages"),
        item("prompt", "Agent"),
        item("table", "Blocks"),
      ],
      new Set(),
    );

    expect(
      sections.map((section) => [section.label, section.items.map((entry) => entry.key)]),
    ).toEqual([
      ["Agent", ["prompt"]],
      ["Pages", ["subpage"]],
      ["Blocks", ["divider", "table"]],
      ["Inline", ["emoji"]],
      ["Media", ["embed"]],
    ]);
  });

  test("drops excluded entries and any section they leave empty", () => {
    const sections = groupPageInsertItems(
      [item("heading", "Text"), item("bullet_list", "Lists"), item("emoji", "Text")],
      new Set(["heading", "bullet_list"]),
    );

    expect(sections).toEqual([{ label: "Inline", items: [item("emoji", "Text")] }]);
  });
});
