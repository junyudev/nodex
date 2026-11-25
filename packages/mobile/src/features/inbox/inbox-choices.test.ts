import type { Project } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vitest";

import { inboxChoices } from "./inbox-choices";

const project = (id: string, name: string, inboxCount = 0): Project => ({
  id,
  name,
  supportsWorktree: false,
  inboxCount,
});

const space = {
  projects: [project("p1", "Website", 2), project("p2", "Nodex")],
  libraryInboxCount: 7,
};

describe("inboxChoices", () => {
  it("shows the Library's however a scope spells it", () => {
    for (const kind of ["all", "library"] as const) {
      const { library, projects, shown } = inboxChoices(space, { kind });
      expect(shown).toBe(library);
      expect(projects.some((choice) => choice.selected)).toBe(false);
    }
  });

  it("shows the chosen Project's and no other", () => {
    const { library, projects, shown } = inboxChoices(space, { kind: "project", projectId: "p2" });
    expect(shown?.label).toBe("Nodex");
    expect(library.selected).toBe(false);
    expect(projects.map((choice) => choice.selected)).toEqual([false, true]);
  });

  it("offers each Project's own Inbox to choose", () => {
    const { projects } = inboxChoices(space, { kind: "all" });
    expect(projects.map((choice) => choice.scope)).toEqual([
      { kind: "project", projectId: "p1" },
      { kind: "project", projectId: "p2" },
    ]);
  });

  it("never passes a Project its Space has not listed for the Library", () => {
    const { library, shown } = inboxChoices(space, { kind: "project", projectId: "gone" });
    expect(shown).toBeUndefined();
    expect(library.selected).toBe(false);
  });
});
