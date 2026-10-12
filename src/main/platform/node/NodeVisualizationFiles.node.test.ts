/* oxlint-disable effecttsgo/strict-effect-provide -- Each test is the scoped entry point for its complete isolated filesystem Layer. */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { NodeVisualizationFiles, live } from "./NodeVisualizationFiles";

const directory = Effect.acquireRelease(
  Effect.promise(() =>
    mkdtemp(path.join(tmpdir(), "nodex-visualization-")).then((root) => realpath(root)),
  ),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

it.effect("reads a regular UTF-8 HTML file and distinguishes missing from oversized", () =>
  Effect.gen(function* () {
    const root = yield* directory;
    const files = yield* NodeVisualizationFiles;
    const target = path.join(root, "plot.html");
    const contents = "<html>图表</html>";
    yield* Effect.promise(() => writeFile(target, contents));
    assert.deepEqual(
      yield* files.read({ path: target, boundary: root, maxBytes: Buffer.byteLength(contents) }),
      { kind: "read", contents },
    );
    assert.deepEqual(
      yield* files.read({
        path: target,
        boundary: root,
        maxBytes: Buffer.byteLength(contents) - 1,
      }),
      { kind: "too-large" },
    );
    assert.deepEqual(
      yield* files.read({ path: path.join(root, "missing.html"), boundary: root, maxBytes: 100 }),
      { kind: "missing" },
    );
  }).pipe(Effect.provide(live), Effect.scoped),
);

it.effect("rejects a symlink file and a symlink parent without following their target", () =>
  Effect.gen(function* () {
    const root = yield* directory;
    const files = yield* NodeVisualizationFiles;
    const directoryPath = path.join(root, "real");
    const target = path.join(directoryPath, "plot.html");
    yield* Effect.promise(() => mkdir(directoryPath));
    yield* Effect.promise(() => writeFile(target, "<html>private</html>"));
    yield* Effect.promise(() => symlink(target, path.join(root, "link.html")));
    yield* Effect.promise(() => symlink(directoryPath, path.join(root, "linked-directory"), "dir"));
    assert.isTrue(
      (yield* Effect.result(
        files.read({ path: path.join(root, "link.html"), boundary: root, maxBytes: 100 }),
      ))._tag === "Failure",
    );
    assert.isTrue(
      (yield* Effect.result(
        files.read({
          path: path.join(root, "linked-directory", "plot.html"),
          boundary: root,
          maxBytes: 100,
        }),
      ))._tag === "Failure",
    );
  }).pipe(Effect.provide(live), Effect.scoped),
);

it.effect("rejects a path outside its boundary and a directory presented as HTML", () =>
  Effect.gen(function* () {
    const root = yield* directory;
    const files = yield* NodeVisualizationFiles;
    const boundary = path.join(root, "authorized");
    yield* Effect.promise(() => mkdir(boundary));
    const outside = path.join(root, "outside.html");
    yield* Effect.promise(() => writeFile(outside, "<html>outside</html>"));
    assert.isTrue(
      (yield* Effect.result(files.read({ path: outside, boundary, maxBytes: 100 })))._tag ===
        "Failure",
    );
    const fake = path.join(boundary, "directory.html");
    yield* Effect.promise(() => mkdir(fake));
    assert.isTrue(
      (yield* Effect.result(files.read({ path: fake, boundary, maxBytes: 100 })))._tag ===
        "Failure",
    );
  }).pipe(Effect.provide(live), Effect.scoped),
);

it.effect("canonicalizes only a trusted root alias before inspecting its descendants", () =>
  Effect.gen(function* () {
    const root = yield* directory;
    const files = yield* NodeVisualizationFiles;
    const target = path.join(root, "physical");
    yield* Effect.promise(() => mkdir(target));
    const alias = path.join(root, "configured-home");
    yield* Effect.promise(() => symlink(target, alias, "dir"));
    assert.strictEqual(yield* files.canonicalRoot(alias), target);
    assert.strictEqual(yield* files.canonicalRoot(path.join(root, "missing")), null);
  }).pipe(Effect.provide(live), Effect.scoped),
);

it.effect("accepts the exact HTML byte ceiling and rejects an additional byte", () =>
  Effect.gen(function* () {
    const root = yield* directory;
    const files = yield* NodeVisualizationFiles;
    const target = path.join(root, "large.html");
    const maxBytes = 5_000_000;
    yield* Effect.promise(() => writeFile(target, "a".repeat(maxBytes)));
    const accepted = yield* files.read({ path: target, boundary: root, maxBytes });
    assert.strictEqual(accepted.kind, "read");
    if (accepted.kind === "read")
      assert.strictEqual(Buffer.byteLength(accepted.contents), maxBytes);
    yield* Effect.promise(() => writeFile(target, "a".repeat(maxBytes + 1)));
    assert.deepEqual(yield* files.read({ path: target, boundary: root, maxBytes }), {
      kind: "too-large",
    });
  }).pipe(Effect.provide(live), Effect.scoped),
);

it.effect("rejects a parent chain that exceeds the bounded directory walk", () =>
  Effect.gen(function* () {
    const root = yield* directory;
    const files = yield* NodeVisualizationFiles;
    const parent = path.join(
      root,
      ...Array.from({ length: 64 }, (_, index) => `directory-${index}`),
    );
    yield* Effect.promise(() => mkdir(parent, { recursive: true }));
    const target = path.join(parent, "plot.html");
    yield* Effect.promise(() => writeFile(target, "<html>deep</html>"));
    assert.isTrue(
      (yield* Effect.result(files.read({ path: target, boundary: root, maxBytes: 100 })))._tag ===
        "Failure",
    );
  }).pipe(Effect.provide(live), Effect.scoped),
);
