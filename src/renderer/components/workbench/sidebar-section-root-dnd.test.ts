import { describe, expect, test } from "vite-plus/test";

import {
  getSidebarSectionRootDndId,
  parseSidebarSectionRootDndId,
  readSidebarSectionRootDndPayload,
} from "./sidebar-section-root-dnd";

describe("sidebar Section root DnD identity", () => {
  test("round-trips Section ids without colliding with project ids", () => {
    const id = getSidebarSectionRootDndId("section-alpha");

    expect(parseSidebarSectionRootDndId(id)).toBe("section-alpha");
    expect(parseSidebarSectionRootDndId("sidebar-group:section-alpha")).toBe(null);
  });

  test("accepts only the Section root payload kind", () => {
    const controller = { handleDragEnd: () => undefined };
    const payload = {
      kind: "sidebar-section-root" as const,
      controller,
      dragOverlay: null,
      sectionId: "section-alpha",
    };

    expect(readSidebarSectionRootDndPayload(payload)).toBe(payload);
    expect(readSidebarSectionRootDndPayload({ ...payload, kind: "sidebar-group" })).toBe(null);
  });
});
