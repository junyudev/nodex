import { describe, expect, test } from "vite-plus/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-assets-"));

import { makeProfileAssets } from "./assets";

const assetService = makeProfileAssets({ assetsRootPath: path.join(fixtureRoot, "assets") });

function resetFixture(): void {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });
}

async function withFixture<T>(run: () => Promise<T> | T): Promise<T> {
  resetFixture();
  return await run();
}

describe("asset service", () => {
  test("saveUploadedImage stores files in the flat assets root", async () => {
    await withFixture(async () => {
      const result = await assetService.saveUploadedImage({
        name: "diagram.png",
        mimeType: "image/png",
        bytes: new TextEncoder().encode("png"),
      });
      const absolutePath = path.join(fixtureRoot, "assets", result.fileName);

      expect(result.source).toBe(`nodex://assets/${result.fileName}`);
      expect(fs.existsSync(absolutePath)).toBe(true);
      expect(fs.readdirSync(path.join(fixtureRoot, "assets.staging"))).toEqual([]);
    });
  });

  test("materializes Canvas images by content identity", async () => {
    await withFixture(async () => {
      const input = {
        name: "diagram.png",
        mimeType: "image/png",
        bytes: new TextEncoder().encode("same-canvas-image"),
      };

      const first = assetService.materializeCanvasImage(input);
      const second = assetService.materializeCanvasImage({
        ...input,
        name: "renamed.png",
      });

      expect(second).toEqual(first);
      expect(first.fileName).toBe(`canvas-${first.contentHash}.png`);
      expect(first.byteLength).toBe(input.bytes.byteLength);
      expect(fs.readdirSync(path.join(fixtureRoot, "assets"))).toEqual([first.fileName]);
    });
  });

  test("saveUploadedImage rejects resources outside the raster allowlist", async () => {
    await withFixture(() => {
      expect(() =>
        assetService.saveUploadedImage({
          name: "vector.svg",
          mimeType: "image/svg+xml",
          bytes: new TextEncoder().encode("<svg />"),
        }),
      ).toThrow("Unsupported image type");
    });
  });

  test("saveUploadedResource stores text assets with stable metadata", async () => {
    await withFixture(async () => {
      const result = await assetService.saveUploadedResource({
        name: "notes.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("hello world"),
      });
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
      expect(manifest.truncated).toBe(true);
      expect(manifest.maxDepth).toBe(3);
      expect(manifest.maxEntries).toBe(100);
      expect(manifest.entries.some((entry) => entry.path === "a" && entry.kind === "folder")).toBe(
        true,
      );
      expect(
        manifest.entries.some((entry) => entry.path === "root.txt" && entry.kind === "file"),
      ).toBe(true);
      expect(manifest.entries.some((entry) => entry.path === "a/b/c/d")).toBe(false);

      expect(
        assetService.readManagedAssetPreview({
          source: result.source,
          kind: "folder",
        }),
      ).toEqual({
        kind: "folder",
        manifest,
      });
    });
  });

  test("readManagedAssetPreview bounds text and rejects image resources", async () => {
    await withFixture(() => {
      const text = Array.from({ length: 205 }, (_, index) => `line-${index}`).join("\n");
      const textAsset = assetService.saveUploadedResource({
        name: "notes.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode(text),
      });
      const imageAsset = assetService.saveUploadedImage({
        name: "diagram.png",
        mimeType: "image/png",
        bytes: new TextEncoder().encode("png"),
      });

      const preview = assetService.readManagedAssetPreview({
        source: textAsset.source,
        kind: "text",
      });
      expect(preview.kind).toBe("text");
      expect(preview.kind === "text" && preview.truncated).toBe(true);
      expect(preview.kind === "text" ? preview.content.split("\n") : []).toHaveLength(200);
      expect(() =>
        assetService.readManagedAssetPreview({
          source: imageAsset.source,
          kind: "text",
        }),
      ).toThrow("not text-previewable");
    });
  });

  test("managed image reads reject non-images and symlinks", async () => {
    await withFixture(() => {
      const textAsset = assetService.saveUploadedResource({
        name: "notes.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("hello"),
      });
      expect(() => assetService.readManagedAssetImage(textAsset.source)).toThrow(
        "not a supported image",
      );

      const assetsRoot = path.join(fixtureRoot, "assets");
      const outsidePath = path.join(fixtureRoot, "outside.png");
      const linkedFileName = "linked.png";
      fs.writeFileSync(outsidePath, "outside");
      fs.symlinkSync(outsidePath, path.join(assetsRoot, linkedFileName));
      expect(() => assetService.readManagedAssetImage(`nodex://assets/${linkedFileName}`)).toThrow(
        "regular file",
      );
    });
  });
});
