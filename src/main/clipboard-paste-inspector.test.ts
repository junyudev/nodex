import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { inspectClipboardPasteItemsFromStrings } from "./clipboard-paste-inspector";

describe("clipboard paste inspector", () => {
  test("collects unique pasted file and folder paths from text payloads", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-clipboard-inspect-"));
    const filePath = path.join(fixtureRoot, "notes.txt");
    const folderPath = path.join(fixtureRoot, "folder");
    fs.writeFileSync(filePath, "hello");
    fs.mkdirSync(folderPath, { recursive: true });

    const result = inspectClipboardPasteItemsFromStrings([
      `file://${filePath}\n${folderPath}`,
      `${filePath}\n${filePath}`,
      "# comment\nmissing.txt",
    ]);

    expect(result.items.length).toBe(2);
    expect(result.items[0]?.path).toBe(filePath);
    expect(result.items[0]?.kind).toBe("file");
    expect(result.items[0]?.bytes).toBe(5);
    expect(result.items[1]?.path).toBe(folderPath);
    expect(result.items[1]?.kind).toBe("folder");
  });

  test("ignores non-absolute and missing clipboard entries", () => {
    const result = inspectClipboardPasteItemsFromStrings([
      "relative/path.txt",
      "",
      "https://example.com/file.txt",
    ]);

    expect(result.items.length).toBe(0);
  });
});
