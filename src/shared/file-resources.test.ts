import { describe, expect, test } from "vitest";

import { fileSource, parseFileSource } from "./file-resources";

describe("File references", () => {
  test("round-trips stable identities without accepting path-shaped references", () => {
    const fileId = "019f-page-file:diagram 1";
    const source = fileSource(fileId);

    expect(source).toBe("nodex://files/019f-page-file:diagram 1");
    expect(parseFileSource(source)).toBe(fileId);
    expect(parseFileSource("nodex://files/../diagram")).toBeNull();
    expect(parseFileSource("nodex://files/%00diagram")).toBeNull();
    expect(parseFileSource("nodex://assets/diagram.png")).toBeNull();
  });
});
