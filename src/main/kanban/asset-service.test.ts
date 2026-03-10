import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-asset-service-"));
const previousKanbanDir = process.env.KANBAN_DIR;
const assetService = await import("./asset-service");

function resetFixture(): void {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
}

async function withFixture<T>(run: () => Promise<T> | T): Promise<T> {
  process.env.KANBAN_DIR = fixtureRoot;
  assetService.resetAssetPathCacheForTests();
  resetFixture();

  try {
    return await run();
  } finally {
    if (previousKanbanDir === undefined) {
      delete process.env.KANBAN_DIR;
    } else {
      process.env.KANBAN_DIR = previousKanbanDir;
    }
    assetService.resetAssetPathCacheForTests();
  }
}

describe("asset service", () => {
  test("saveUploadedImage stores files in the flat assets root", async () => {
    await withFixture(async () => {
      const file = new File([Buffer.from("png")], "diagram.png", {
        type: "image/png",
      });

      const result = await assetService.saveUploadedImage(file);
      const absolutePath = path.join(fixtureRoot, "assets", result.fileName);

      expect(result.source).toBe(`nodex://assets/${result.fileName}`);
      expect(fs.existsSync(absolutePath)).toBeTrue();
    });
  });

  test("saveUploadedResource stores text assets with stable metadata", async () => {
    await withFixture(async () => {
      const file = new File(["hello world"], "notes.txt", {
        type: "text/plain",
      });

      const result = await assetService.saveUploadedResource(file);
      const absolutePath = path.join(fixtureRoot, "assets", result.fileName);

      expect(result.source).toBe(`nodex://assets/${result.fileName}`);
      expect(result.name).toBe("notes.txt");
      expect(result.mimeType).toBe("text/plain");
      expect(result.bytes).toBe(11);
      expect(fs.readFileSync(absolutePath, "utf8")).toBe("hello world");
    });
  });

  test("materializeLocalResource copies a local file into managed assets", async () => {
    await withFixture(() => {
      const localFilePath = path.join(fixtureRoot, "fixture.md");
      fs.writeFileSync(localFilePath, "# title\n");

      const result = assetService.materializeLocalResource(localFilePath);
      const absolutePath = path.join(fixtureRoot, "assets", result.fileName);

      expect(result.source).toBe(`nodex://assets/${result.fileName}`);
      expect(result.name).toBe("fixture.md");
      expect(result.mimeType).toBe("text/markdown");
      expect(result.bytes).toBe(fs.statSync(localFilePath).size);
      expect(fs.readFileSync(absolutePath, "utf8")).toBe("# title\n");
    });
  });

  test("materializeLocalResource stores truncated folder manifests for directories", async () => {
    await withFixture(() => {
      const folderPath = path.join(fixtureRoot, "folder");
      const nestedLevelOne = path.join(folderPath, "a");
      const nestedLevelTwo = path.join(nestedLevelOne, "b");
      const nestedLevelThree = path.join(nestedLevelTwo, "c");
      const nestedLevelFour = path.join(nestedLevelThree, "d");

      fs.mkdirSync(nestedLevelFour, { recursive: true });
      fs.writeFileSync(path.join(folderPath, "root.txt"), "root");
      fs.writeFileSync(path.join(nestedLevelFour, "too-deep.txt"), "deep");

      const result = assetService.materializeLocalResource(folderPath);
      const manifestPath = path.join(fixtureRoot, "assets", result.fileName);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        rootName: string;
        truncated: boolean;
        maxDepth: number;
        maxEntries: number;
        entries: Array<{ path: string; kind: string }>;
      };

      expect(result.source).toBe(`nodex://assets/${result.fileName}`);
      expect(result.name).toBe("folder");
      expect(result.mimeType).toBe("application/json");
      expect(manifest.rootName).toBe("folder");
      expect(manifest.truncated).toBeTrue();
      expect(manifest.maxDepth).toBe(3);
      expect(manifest.maxEntries).toBe(100);
      expect(manifest.entries.some((entry) => entry.path === "a" && entry.kind === "folder")).toBeTrue();
      expect(manifest.entries.some((entry) => entry.path === "root.txt" && entry.kind === "file")).toBeTrue();
      expect(manifest.entries.some((entry) => entry.path === "a/b/c/d")).toBeFalse();
    });
  });
});
