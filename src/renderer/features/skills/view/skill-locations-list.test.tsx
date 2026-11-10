import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { skillContext, skillInventory } from "../skill-test-fixtures";
import { SkillLocationsList } from "./skill-locations-list";

const setEnabled = vi.hoisted(() => vi.fn(async () => ({ status: "ok", value: undefined })));
vi.mock("../skill-inventory", () => ({ useSkillCommands: () => ({ setEnabled }) }));

test("lists folders with their readers, and switches only the chosen Agent", async () => {
  const onOpenSkill = vi.fn();
  const props = { context: skillContext, snapshot: skillInventory, onOpenSkill };
  const view = render(<SkillLocationsList {...props} search="" />);
  const project = screen.getByRole("region", { name: "/workspace/.agents/skills" });
  expect(within(project).getByRole("img", { name: "Codex reads this folder" })).toBeTruthy();
  const empty = screen.getByRole("region", { name: "Empty skill folders" });
  expect(within(empty).getByRole("img", { name: "Claude reads this folder" })).toBeTruthy();
  expect(within(empty).getByRole("button", { name: "New skill in ~/.claude/skills" })).toBeTruthy();
  await act(async () => {
    fireEvent.click(within(project).getByRole("switch", { name: "Use inspect in Codex" }));
  });
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith({
    skillId: "inspect",
    reader: { agent: "codex", instanceId: "codex-default" },
    scope: "project",
    enabled: false,
  });
  expect(onOpenSkill).not.toHaveBeenCalled();

  view.rerender(<SkillLocationsList {...props} search="release" />);
  expect(screen.queryByRole("region", { name: "Empty skill folders" })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /inspect/u }));
  });
  expect(onOpenSkill).toHaveBeenCalledExactlyOnceWith("inspect");
  view.rerender(<SkillLocationsList {...props} search="missing" />);
  expect(screen.queryByRole("region", { name: "/workspace/.agents/skills" })).toBeNull();
});
