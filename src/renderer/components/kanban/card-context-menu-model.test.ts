import { describe, expect, test } from "bun:test";
import {
  getCardActionMenuEntries,
  getCardMoveTargets,
} from "./card-context-menu-model";

describe("card context menu model", () => {
  test("returns the full action list in design order when search is empty", () => {
    const actions = getCardActionMenuEntries("");

    expect(actions.map((action) => action.label).join(",")).toBe(
      [
        "Add to Favorites",
        "Edit icon",
        "Edit property",
        "Layout",
        "Property visibility",
        "Open in",
        "Copy link",
        "Duplicate",
        "Move to",
        "Delete",
      ].join(","),
    );
  });

  test("keeps delete and copy link enabled for real actions", () => {
    const actions = getCardActionMenuEntries("");
    const copyLink = actions.find((action) => action.id === "copy-link");
    const deleteAction = actions.find((action) => action.id === "delete");

    expect(copyLink?.disabled ?? false).toBeFalse();
    expect(deleteAction?.disabled ?? false).toBeFalse();
  });

  test("filters action entries by label and keyword matches", () => {
    const actions = getCardActionMenuEntries("project");

    expect(actions.map((action) => action.label).join(",")).toBe("Move to");
  });

  test("builds move targets with current-project state and metadata", () => {
    const targets = getCardMoveTargets(
      [
        { id: "default", name: "Default", description: "Core workspace" },
        { id: "ops", name: "Ops", workspacePath: "/work/ops" },
        { id: "research", name: "Research" },
      ],
      "ops",
      "",
    );

    expect(targets.map((target) => target.label).join(",")).toBe("Default,Ops,Research");
    expect(targets[1]?.description).toBe("Current project · /work/ops");
    expect(targets[1]?.disabled).toBeTrue();
    expect(targets[2]?.description).toBe("Project");
  });

  test("filters move targets without disturbing project order", () => {
    const targets = getCardMoveTargets(
      [
        { id: "default", name: "Default", description: "Core workspace" },
        { id: "ops", name: "Ops", workspacePath: "/work/ops" },
        { id: "research", name: "Research" },
      ],
      "default",
      "/work",
    );

    expect(targets.map((target) => target.label).join(",")).toBe("Ops");
  });
});
