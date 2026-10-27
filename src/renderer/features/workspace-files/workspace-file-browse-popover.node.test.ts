import { describe, expect, test } from "vite-plus/test";
import { workspaceBrowseListing } from "./workspace-file-browse-popover";

describe("workspaceBrowseListing", () => {
  test("lists the root's own contents for the workspace segment", () => {
    expect(workspaceBrowseListing("", true)).toEqual({
      directoryPath: "",
      selectedChild: null,
      expandSelected: false,
    });
  });

  test("lists a folder's parent with the folder selected and open", () => {
    expect(workspaceBrowseListing("src", true)).toEqual({
      directoryPath: "",
      selectedChild: "src",
      expandSelected: true,
    });
    expect(workspaceBrowseListing("src/lib", true)).toEqual({
      directoryPath: "src",
      selectedChild: "lib",
      expandSelected: true,
    });
  });

  test("lists a file's siblings with the file selected", () => {
    expect(workspaceBrowseListing("src/lib/a.ts", false)).toEqual({
      directoryPath: "src/lib",
      selectedChild: "a.ts",
      expandSelected: false,
    });
  });
});
