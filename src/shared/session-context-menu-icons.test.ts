import { describe, expect, test } from "vite-plus/test";
import { buildSessionContextMenuIconSvg } from "./session-context-menu-icons";

describe("native session context-menu icons", () => {
  test("uses the extracted Codex geometry for organization and primary actions", () => {
    expect(buildSessionContextMenuIconSvg("section")).toContain("M13.3336 11.4766");
    expect(buildSessionContextMenuIconSvg("project")).toContain("M14.6602 11.3291");
    expect(buildSessionContextMenuIconSvg("rename")).toContain("M11.7313 4.20472");
    expect(buildSessionContextMenuIconSvg("unread")).toContain("M10.8 7.20081");
  });

  test("materializes template-image SVGs with an explicit native color", () => {
    const svg = buildSessionContextMenuIconSvg("copy");
    expect(svg).toContain('viewBox="0 0 21 21"');
    expect(svg).toContain('fill="black"');
    expect(svg).not.toContain("currentColor");
  });
});
