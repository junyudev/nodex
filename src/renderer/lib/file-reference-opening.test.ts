import { describe, expect, test } from "vite-plus/test";
import { decideFileReferenceOpen } from "./file-reference-opening";
import {
  buildFileUrl,
  parseFileReferenceLocation,
  parseLocalFileLinkHref,
} from "../../shared/file-link-openers";

const base = { target: { path: "/repo/report.html" }, hostId: "local", browserAvailable: true };
describe("file opening intent", () => {
  test.each([
    [{}, "browser"],
    [{ sidePanel: false }, "browser"],
    [{ browserAvailable: false }, "files"],
    [{ browserAvailable: false, sidePanel: false }, "native"],
    [{ hostId: "ssh:build" }, "files"],
    [{ directory: true }, "file-manager"],
    [{ explicitTarget: true }, "native"],
    [{ target: { path: "/repo/report.html", line: 2, column: 4 } }, "files"],
    [{ target: { path: "/repo/report.html", column: 4 } }, "browser"],
    [{ target: { path: "/repo/report.xhtml" } }, "files"],
    [{ previewSource: true }, "files"],
  ] as const)("resolves %j to %s", (input, expected) => {
    expect(decideFileReferenceOpen({ ...base, ...input })).toBe(expected);
  });
  for (const platform of ["darwin", "win32"]) {
    const primary = platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
    const other = platform === "darwin" ? { ctrlKey: true } : { metaKey: true };
    test.each([
      [{}, "files", "browser"],
      [{ shiftKey: true }, "files", "browser"],
      [{ altKey: true }, "save", "save"],
      [{ altKey: true, shiftKey: true }, "files", "browser"],
      [other, "files", "browser"],
      [primary, "native", "files"],
      [{ ...primary, shiftKey: true }, "native", "files"],
      [{ button: 1 }, "native", "files"],
      [{ button: 1, altKey: true }, "native", "files"],
    ] as const)(`${platform} gesture %j preserves source intent`, (gesture, source, html) => {
      const activation = { platform, ...gesture };
      expect(
        decideFileReferenceOpen({ ...base, target: { path: "/repo/file.ts" }, activation }),
      ).toBe(source);
      expect(decideFileReferenceOpen({ ...base, activation })).toBe(html);
      if (html === "files")
        expect(decideFileReferenceOpen({ ...base, sidePanel: false, activation })).toBe("native");
    });
  }
});
describe("file reference locations", () => {
  test.each(["/repo/a.ts:3:4-8:9", "/repo/a.ts:3:4–8:9", "/repo/a.ts#L3C4-L8C9"])(
    "shares range grammar for %s",
    (input) => {
      expect(parseFileReferenceLocation(input)).toEqual({
        path: "/repo/a.ts",
        line: 3,
        column: 4,
        endLine: 8,
        endColumn: 9,
      });
      expect(parseLocalFileLinkHref(input)).toEqual(parseFileReferenceLocation(input));
    },
  );
  test("encodes native file paths once and preserves Windows drives", () => {
    expect(buildFileUrl({ path: "/repo/a #?% report.html" })).toBe(
      "file:///repo/a%20%23%3F%25%20report.html",
    );
    expect(buildFileUrl({ path: "C:\\repo\\a #.htm" })).toBe("file:///C:/repo/a%20%23.htm");
    expect(parseLocalFileLinkHref("file:///repo/a%3A3")).toEqual({ path: "/repo/a:3" });
    expect(parseLocalFileLinkHref("file:///repo/a%20%23%3F%25%20report.html")).toEqual({
      path: "/repo/a #?% report.html",
    });
  });
});
