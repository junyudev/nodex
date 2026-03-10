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
});
