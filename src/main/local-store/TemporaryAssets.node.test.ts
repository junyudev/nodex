import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import { TemporaryAssets, live } from "./TemporaryAssets";

it.effect("keeps temporary media outside the Core Blob namespace", () =>
  Effect.gen(function* () {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-temporary-media-"));
    try {
      fs.mkdirSync(path.join(home, "assets"));
      fs.writeFileSync(path.join(home, "assets", "retained.png"), "Core-owned bytes");
      yield* Effect.gen(function* () {
        const media = yield* TemporaryAssets;
        assert.throws(() => media.readManagedAssetImage("nodex://assets/retained.png"));
        const saved = media.saveUploadedImage({
          name: "capture.png",
          mimeType: "image/png",
          bytes: new TextEncoder().encode("temporary capture"),
        });
        const resolved = media.resolveAssetPath(saved.fileName);
        assert.strictEqual(path.dirname(resolved), path.join(home, "cache", "media"));
        assert.strictEqual(fs.readFileSync(resolved, "utf8"), "temporary capture");
        assert.strictEqual(
          fs.readFileSync(path.join(home, "assets", "retained.png"), "utf8"),
          "Core-owned bytes",
        );
        if (process.platform !== "win32")
          assert.strictEqual(fs.statSync(resolved).mode & 0o777, 0o600);
      }).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete temporary-media application layer.
        Effect.provide(live.pipe(Layer.provide(mainConfigLayer({ nodexHome: home })))),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }),
);
