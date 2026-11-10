import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  personalSkills,
  projectSkills,
  skill,
  skillContext,
  skillDocument,
  skillInventory,
} from "../skill-test-fixtures";
import { SkillPage } from "./skill-page";

const io = vi.hoisted(() => ({
  inventory: vi.fn(),
  document: vi.fn(),
  rename: vi.fn(),
  writeDocument: vi.fn(),
  transfer: vi.fn(),
}));

vi.mock("../skill-inventory", () => ({
  useSkillInventory: io.inventory,
  useSkillDocument: io.document,
  useSkillCommands: () => io,
}));
vi.mock("../skill-body-editor", async (original) => ({
  ...(await original<typeof import("../skill-body-editor")>()),
  SkillBodyEditor: () => null,
}));

beforeEach(() => {
  vi.resetAllMocks();
  io.inventory.mockReturnValue({ data: { status: "ok", value: skillInventory } });
  io.document.mockReturnValue({ data: { status: "ok", value: skillDocument } });
});

function show() {
  const onOpenSkill = vi.fn();
  render(
    <SkillPage
      context={skillContext}
      skillId={skill.id}
      onOpenSkill={onOpenSkill}
      onClose={vi.fn()}
    />,
  );
  return { onOpenSkill };
}

test("renames on blur and retargets the page to the receipt", async () => {
  io.rename.mockResolvedValue({ status: "ok", value: { ...skillDocument, skillId: "audit-id" } });
  const { onOpenSkill } = show();
  const title = screen.getByRole("textbox", { name: "Skill name" });
  await act(async () => {
    fireEvent.change(title, { target: { value: "Audit release" } });
    fireEvent.blur(title);
  });
  expect(io.rename).toHaveBeenCalledExactlyOnceWith({
    skillId: skill.id,
    baseRevision: "1",
    slug: "audit-release",
  });
  expect(onOpenSkill).toHaveBeenCalledExactlyOnceWith("audit-id");
});

test("edits the description through a frontmatter-only patch", async () => {
  const markdown = skillDocument.markdown.replace("Review a release.", '"Check release metadata."');
  io.writeDocument.mockResolvedValue({
    status: "ok",
    value: { ...skillDocument, revision: "2", markdown },
  });
  show();
  const field = screen.getByRole("textbox", { name: "When to use this skill" });
  await act(async () => {
    fireEvent.change(field, { target: { value: "Check release metadata." } });
    fireEvent.blur(field);
  });
  expect(io.writeDocument).toHaveBeenCalledExactlyOnceWith({
    skillId: skill.id,
    baseRevision: "1",
    markdown,
  });
});

test("offers to duplicate a read-only plugin skill into a personal folder", async () => {
  io.document.mockReturnValue({
    data: { status: "ok", value: { ...skillDocument, writable: false } },
  });
  io.inventory.mockReturnValue({
    data: {
      status: "ok",
      value: {
        ...skillInventory,
        locations: [personalSkills, { ...projectSkills, scope: "plugin", writable: false }],
      },
    },
  });
  io.transfer.mockResolvedValue({ status: "ok", value: { skillId: "personal-copy" } });
  const { onOpenSkill } = show();
  expect(screen.getByRole("heading", { name: "inspect" })).toBeTruthy();
  expect(screen.getByText(/belongs to a plugin/u)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Duplicate to edit" }));
  });
  expect(io.transfer).toHaveBeenCalledExactlyOnceWith({
    skillId: skill.id,
    locationId: personalSkills.id,
    slug: "inspect",
    mode: "copy",
  });
  expect(onOpenSkill).toHaveBeenCalledExactlyOnceWith("personal-copy");
});

test("keeps a restored page usable when the skill is missing", () => {
  io.document.mockReturnValue({ data: { status: "failed", message: "The file is gone." } });
  show();
  expect(screen.getByText("This skill is no longer here")).toBeTruthy();
});
