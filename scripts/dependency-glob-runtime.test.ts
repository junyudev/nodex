import { mkdtempSync, mkdirSync, readFileSync, readdir, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const asarRequire = createRequire(appBuilderRequire.resolve("@electron/asar/package.json"));
const universalRequire = createRequire(
  appBuilderRequire.resolve("@electron/universal/package.json"),
);
const codegenRequire = createRequire(
  new URL("../packages/core-protocol-codegen/package.json", import.meta.url),
);
const openapiRequire = createRequire(codegenRequire.resolve("openapi-typescript"));
const sentryRequire = createRequire(require.resolve("@sentry/vite-plugin"));
const bundlerRequire = createRequire(sentryRequire.resolve("@sentry/bundler-plugins/package.json"));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Readonly<Record<string, string>>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nodex-dependency-glob-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const filename = path.join(root, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, contents);
  }
  return root;
}

test("packaging preserves archive contents and native unpack globs", async () => {
  const asar = appBuilderRequire("@electron/asar") as {
    createPackageWithOptions: (
      source: string,
      destination: string,
      options: { unpack: string; unpackDir: string },
    ) => Promise<unknown>;
    extractFile: (archive: string, filename: string) => Buffer;
    statFile: (archive: string, filename: string) => { unpacked?: boolean };
  };
  const root = fixture({
    "app/index.js": "app entry",
    "app/resources/addon.node": "native addon",
    "app/resources/templates/message.txt": "template",
    "app/.metadata": "hidden metadata",
  });
  const archive = path.join(root, "app.asar");
  // ASAR 3 resolves archive entries with the host path separator.
  const addonPath = path.join("resources", "addon.node");
  const templatePath = path.join("resources", "templates", "message.txt");

  await asar.createPackageWithOptions(path.join(root, "app"), archive, {
    unpack: "*.node",
    unpackDir: "resources/*plates",
  });

  expect(asar.extractFile(archive, "index.js").toString()).toBe("app entry");
  expect(asar.extractFile(archive, ".metadata").toString()).toBe("hidden metadata");
  expect(asar.statFile(archive, addonPath).unpacked).toBe(true);
  expect(asar.statFile(archive, templatePath).unpacked).toBe(true);
  expect(readFileSync(path.join(`${archive}.unpacked`, addonPath), "utf8")).toBe("native addon");
  expect(readFileSync(path.join(`${archive}.unpacked`, templatePath), "utf8")).toBe("template");
});

interface GlobOptions {
  readonly cwd: string;
  readonly dot?: boolean;
  readonly nodir: boolean;
  readonly nocase?: boolean;
  readonly ignore: string | readonly string[];
}

test("modern glob stops filesystem traversal when its signal is cancelled", async () => {
  const root = fixture({
    "a/nested/one.txt": "",
    "b/nested/two.txt": "",
    "c/nested/three.txt": "",
  });
  const controller = new AbortController();
  const reason = new Error("traversal cancelled");
  let reads = 0;
  const countedFs = {
    readdir: (...args: Parameters<typeof readdir>) => {
      if (++reads === 1) controller.abort(reason);
      return readdir(...args);
    },
  };
  const { glob } = bundlerRequire("glob") as {
    glob: (
      pattern: string,
      options: { cwd: string; signal: AbortSignal; fs: typeof countedFs },
    ) => Promise<string[]>;
  };

  await expect(glob("**", { cwd: root, signal: controller.signal, fs: countedFs })).rejects.toBe(
    reason,
  );
  const readsAtRejection = reads;
  await new Promise<void>((resolve) => setTimeout(resolve, 100));

  expect(readsAtRejection).toBe(1);
  expect(reads).toBe(readsAtRejection);
});

interface CallbackGlob {
  (
    pattern: string,
    options: GlobOptions,
    callback: (error: Error | null, matches: string[]) => void,
  ): void;
  sync: (pattern: string, options: GlobOptions) => string[];
}

test.each(["callback", "sync"] as const)(
  "legacy %s glob traversal preserves recursive, dotfile, case and ignore rules",
  async (mode) => {
    const glob = asarRequire("glob") as CallbackGlob;
    const root = fixture({
      "src/alpha.ts": "",
      "src/UPPER.TS": "",
      "src/deep/leaf.ts": "",
      "src/.hidden.ts": "",
      "src/node_modules/excluded.ts": "",
      "node_modules/node-pty/prebuilds/win32-x64/conpty.node": "",
      "node_modules/node-pty/prebuilds/win32-arm64/conpty.node": "",
      "node_modules/node-pty/prebuilds/darwin-arm64/pty.node": "",
      "node_modules/node-pty/build/Release/pty.node": "",
      "node_modules/node-pty/build/Release/nested/support.dll": "",
      "node_modules/node-pty/build/Debug/pty.node": "",
      "node_modules/node-pty/build/config.gypi": "",
      "node_modules/node-pty/build/obj.target/pty.node": "",
    });
    const options: GlobOptions = {
      cwd: root,
      nodir: true,
      nocase: true,
      ignore: "**/node_modules/**",
    };
    const find = async (pattern: string, settings = options) => {
      if (mode === "sync") return glob.sync(pattern, settings).sort();
      return await new Promise<string[]>((resolve, reject) => {
        glob(pattern, settings, (error, matches) => {
          if (error) return reject(error);
          resolve(matches.sort());
        });
      });
    };

    expect(await find("src/**/@(alpha|UPPER|leaf).{ts,TS}")).toEqual([
      "src/UPPER.TS",
      "src/alpha.ts",
      "src/deep/leaf.ts",
    ]);
    expect(await find("src/**/.*.ts")).toEqual(["src/.hidden.ts"]);
    expect(await find("src/**/*.ts", { ...options, dot: true })).toEqual([
      "src/.hidden.ts",
      "src/UPPER.TS",
      "src/alpha.ts",
      "src/deep/leaf.ts",
    ]);

    // Packaging excludes prebuilds and build outputs outside Release.
    expect(
      await find("node_modules/node-pty/{build,prebuilds}/**/*", {
        ...options,
        ignore: [
          "node_modules/node-pty/prebuilds/**",
          "node_modules/node-pty/build/!(Release){,/**/*}",
        ],
      }),
    ).toEqual([
      "node_modules/node-pty/build/Release/nested/support.dll",
      "node_modules/node-pty/build/Release/pty.node",
    ]);
  },
);

test("universal packaging directory filters retain include and exclude semantics", async () => {
  const compare = universalRequire("dir-compare") as {
    compare: (
      left: string,
      right: string,
      options: { compareContent: boolean; includeFilter: string; excludeFilter: string },
    ) => Promise<{ same: boolean; equal: number; distinct: number }>;
  };
  const root = fixture({
    "left/entry.js": "same entry",
    "right/entry.js": "same entry",
    "left/skip.js": "left generated file",
    "right/skip.js": "right generated file",
    "left/readme.md": "left docs",
    "right/readme.md": "right docs",
  });

  const result = await compare.compare(path.join(root, "left"), path.join(root, "right"), {
    compareContent: true,
    includeFilter: "*.js",
    excludeFilter: "skip.js",
  });

  expect(result).toMatchObject({ same: true, equal: 1, distinct: 0 });
});

test("protocol generation sends configured headers only to matching schema URLs", async () => {
  const { readFileFromUrl } = openapiRequire("@redocly/openapi-core/lib/utils.js") as {
    readFileFromUrl: (
      url: string,
      config: {
        headers: ReadonlyArray<{ name: string; matches: string; value: string }>;
        customFetch: typeof fetch;
      },
    ) => Promise<{ body: string; mimeType: string }>;
  };
  let observedHeaders: Headers | undefined;
  const result = await readFileFromUrl("https://schema.example.test/openapi/pet.json", {
    headers: [
      { name: "X-Schema", matches: "schema.example.test/openapi/**", value: "schema token" },
      { name: "X-Unrelated", matches: "https://other.example.test/**", value: "unrelated token" },
    ],
    customFetch: async (_url, init) => {
      observedHeaders = new Headers(init?.headers);
      return new Response('{"openapi":"3.1.0"}', {
        headers: { "content-type": "application/json" },
      });
    },
  });

  expect(result).toEqual({ body: '{"openapi":"3.1.0"}', mimeType: "application/json" });
  expect(observedHeaders?.get("X-Schema")).toBe("schema token");
  expect(observedHeaders?.has("X-Unrelated")).toBe(false);
});
