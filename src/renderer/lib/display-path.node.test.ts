import { describe, expect, test } from "vitest";
import { formatDisplayPath } from "./display-path";

describe("formatDisplayPath", () => {
  test("spells paths from the working directory, then from home, then absolutely", () => {
    const cwd = "/Users/ada/repo/nodex";
    expect(formatDisplayPath(cwd, cwd)).toBe(".");
    expect(formatDisplayPath(`${cwd}/src/app.ts`, `${cwd}/`)).toBe("./src/app.ts");
    expect(formatDisplayPath("/Users/ada/Desktop/a.pdf", cwd)).toBe("~/Desktop/a.pdf");
    expect(formatDisplayPath("/Users/ada", cwd)).toBe("~");
    expect(formatDisplayPath("/tmp/out/", cwd)).toBe("/tmp/out");
    expect(formatDisplayPath("/", cwd)).toBe("/");
  });

  test("does not treat a sibling with a shared prefix as inside the working directory", () => {
    expect(formatDisplayPath("/Users/ada/repo/nodex-2/a.md", "/Users/ada/repo/nodex")).toBe(
      "~/repo/nodex-2/a.md",
    );
  });

  test("normalizes Windows separators and infers a Windows home", () => {
    expect(formatDisplayPath("C:\\Users\\ada\\docs\\a.md", "C:/Users/ada/work")).toBe(
      "~/docs/a.md",
    );
  });

  test("leaves paths absolute without a working directory", () => {
    expect(formatDisplayPath("/Users/ada/a.md", null)).toBe("/Users/ada/a.md");
  });
});
