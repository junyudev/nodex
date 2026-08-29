import { describe, expect, test } from "vite-plus/test";
import { buildSessionContextMenuIconSvg } from "./session-context-menu-icons";

describe("native session context-menu icons", () => {
  test("uses the extracted Codex geometry for organization and primary actions", () => {
    expect(buildSessionContextMenuIconSvg("section")).toContain("M13.3336 11.4766");
    expect(buildSessionContextMenuIconSvg("project")).toContain("M14.6602 11.3291");
    expect(buildSessionContextMenuIconSvg("rename")).toContain("M11.7313 4.20472");
    expect(buildSessionContextMenuIconSvg("unread")).toContain("M10.8 7.20081");
    expect(buildSessionContextMenuIconSvg("edit")).toContain("M11.3312 4.20472");
    expect(buildSessionContextMenuIconSvg("markRead")).toContain("M12.8961 3.64101");
    expect(buildSessionContextMenuIconSvg("folderOpen")).toContain("M6.584 2.874");
    expect(buildSessionContextMenuIconSvg("remove")).toContain("M14.6549 5.57307");
    expect(buildSessionContextMenuIconSvg("worktree")).toContain("M15.8 11.535");
    expect(buildSessionContextMenuIconSvg("openIn")).toContain("M11.949 3.47949");
  });

  test("materializes template-image SVGs with an explicit native color", () => {
    const svg = buildSessionContextMenuIconSvg("copy");
    expect(svg).toContain('viewBox="0 0 21 21"');
    expect(svg).toContain('fill="black"');
    expect(svg).not.toContain("currentColor");
  });
});
