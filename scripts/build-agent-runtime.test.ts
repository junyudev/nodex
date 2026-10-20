import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { buildAgentRuntime } from "./build-agent-runtime";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, renameSync: vi.fn(fs.renameSync) };
});
const { renameSync: renameFile } = await vi.importActual<typeof import("node:fs")>("node:fs");

const roots: string[] = [];
let bundles = 0;
let failBuild = false;
let duringBuild: (() => void) | undefined;
let compilerInputs: string[];

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  bundles = 0;
  failBuild = false;
  duringBuild = undefined;
  compilerInputs = [
    "packages/agent-runtime/src/nodex/entry.ts",
    "node_modules/dependency/index.js",
  ];
  vi.mocked(renameSync).mockImplementation(renameFile);
  for (const key of ["NODE_ENV", "NODE_PATH", "NODE_OPTIONS", "ESBUILD_BINARY_PATH"]) {
    vi.stubEnv(key, undefined);
  }
  vi.mocked(execFileSync).mockImplementation((_command, arguments_, options) => {
    bundles += 1;
    const output = arguments_!.find((argument) => argument.startsWith("--outdir="))!.slice(9);
    const metafile = arguments_!.find((argument) => argument.startsWith("--metafile="))!.slice(11);
    const root = String(options!.cwd);
    write(join(output, "entry.mjs"), `export const generation = ${bundles};`);
    write(join(output, "chunks/engine.mjs"), "export const engine = true;");
    write(
      join(output, "compiled-inputs.json"),
      JSON.stringify(
        Object.fromEntries(
          compilerInputs.map((file) => [file, readFileSync(join(root, file), "utf8")]),
        ),
      ),
    );
    write(
      metafile,
      JSON.stringify({
        inputs: Object.fromEntries(compilerInputs.map((file) => [file, { bytes: 10 }])),
        outputs: { [join(output, "entry.mjs")]: { bytes: 10 } },
      }),
    );
    duringBuild?.();
    if (failBuild) throw new Error(`bundle failed in ${root}`);
    return "";
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nodex-agent-bundle-"));
  roots.push(root);
  const sources = {
    "package.json": '{"name":"nodex"}',
    "pnpm-lock.yaml": "lockfileVersion: 9",
    "pnpm-workspace.yaml": "packages: [packages/*]",
    "tsconfig.json": '{"compilerOptions":{}}',
    "config/node-build-optimization.ts": "export const optimization = true;",
    "packages/agent-runtime/package.json": '{"name":"@nodex/agent-runtime"}',
    "packages/agent-runtime/src/nodex/entry.ts": "export const runtime = true;",
    "packages/agent-runtime/LICENSE.t3code": "license",
    "packages/agent-runtime/UPSTREAM.json": '{"upstream":"example"}',
    "node_modules/esbuild/package.json": '{"name":"esbuild"}',
    "node_modules/esbuild/bin/esbuild": "bundler",
    "node_modules/dependency/package.json": '{"name":"dependency","main":"index.js"}',
    "node_modules/dependency/index.js": "export const dependency = true;",
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json": '{"main":"sdk.mjs"}',
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs": "export const sdk = true;",
    "node_modules/@anthropic-ai/claude-agent-sdk/native/worker": "native helper",
  };
  for (const [path, contents] of Object.entries(sources)) write(join(root, path), contents);
  const output = join(root, "out/agent-runtime");
  return { root, output, build: () => buildAgentRuntime(root) };
}

test("reuses unchanged verified bundles and copied SDK contents without invoking esbuild", () => {
  const instance = fixture();
  expect(instance.build()).toBe("built");
  const entry = readFileSync(join(instance.output, "entry.mjs"));
  expect(instance.build()).toBe("reused");
  expect(bundles).toBe(2);
  expect(readFileSync(join(instance.output, "entry.mjs"))).toEqual(entry);
  expect(
    readFileSync(
      join(instance.output, "node_modules/@anthropic-ai/claude-agent-sdk/native/worker"),
      "utf8",
    ),
  ).toBe("native helper");
});

test.each([
  "packages/agent-runtime/src/nodex/entry.ts",
  "packages/agent-runtime/src/nodex/added.ts",
  "packages/agent-runtime/vendor/new-package/package.json",
  "packages/agent-runtime/LICENSE.t3code",
  "packages/agent-runtime/UPSTREAM.json",
  "config/node-build-optimization.ts",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "node_modules/esbuild/bin/esbuild",
  "node_modules/dependency/index.js",
  "node_modules/dependency/package.json",
  "node_modules/dependency/new-module.js",
  "node_modules/@anthropic-ai/claude-agent-sdk/native/worker",
])("rebuilds when input %s changes", (path) => {
  const instance = fixture();
  instance.build();
  write(join(instance.root, path), "changed input");
  expect(instance.build()).toBe("built");
  expect(instance.build()).toBe("reused");
  expect(bundles).toBe(3);
});

test("invalidates mode and NODE_ENV independently", () => {
  const instance = fixture();
  instance.build();
  expect(buildAgentRuntime(instance.root, "development")).toBe("built");
  expect(buildAgentRuntime(instance.root, "development")).toBe("reused");
  vi.stubEnv("NODE_ENV", "test");
  expect(buildAgentRuntime(instance.root, "development")).toBe("built");
  expect(bundles).toBe(4);
});

test.each(["sidecar map", "unembedded source", "inline map source"])(
  "tracks %s read by esbuild outside its metafile",
  (input) => {
    const instance = fixture();
    const map = JSON.stringify({
      version: 3,
      sources: ["original.ts"],
      names: [],
      mappings: "AAAA",
    });
    write(join(instance.root, "node_modules/dependency/original.ts"), "export const value = 1;");
    write(join(instance.root, "node_modules/dependency/sidecar.map"), map);
    const reference =
      input === "inline map source"
        ? `data:application/json;base64,${Buffer.from(map).toString("base64")}`
        : "sidecar.map";
    write(
      join(instance.root, "node_modules/dependency/index.js"),
      `export const value = 1;\n//# sourceMappingURL=${reference}\n`,
    );
    instance.build();
    if (input === "sidecar map") {
      write(
        join(instance.root, "node_modules/dependency/sidecar.map"),
        map.replace("AAAA", "AACA"),
      );
    } else {
      write(join(instance.root, "node_modules/dependency/original.ts"), "export const value = 2;");
    }
    expect(instance.build()).toBe("built");
    expect(instance.build()).toBe("reused");
    expect(bundles).toBe(3);
  },
);

test.each([
  "missing chunk",
  "tampered chunk",
  "added output",
  "changed mode",
  "symlink",
  "metafile",
  "receipt",
])("repairs %s even when its receipt exists", (damage) => {
  const instance = fixture();
  instance.build();
  const chunk = join(instance.output, "chunks/engine.mjs");
  if (damage === "missing chunk") rmSync(chunk);
  if (damage === "tampered chunk") writeFileSync(chunk, "modified engine");
  if (damage === "added output") writeFileSync(join(instance.output, "extra.mjs"), "extra");
  if (damage === "changed mode") chmodSync(chunk, 0o755);
  if (damage === "symlink") {
    rmSync(chunk);
    symlinkSync(join(instance.root, "package.json"), chunk);
  }
  if (damage === "metafile")
    writeFileSync(join(instance.root, ".generated/agent-runtime-build.json"), "invalid");
  if (damage === "receipt")
    writeFileSync(join(instance.root, ".generated/agent-runtime-build-receipt.json"), "invalid");
  expect(instance.build()).toBe("built");
  expect(instance.build()).toBe("reused");
  expect(bundles).toBe(damage === "receipt" ? 4 : 3);
});

test("keeps the previous complete bundle when esbuild fails after writing partial output", () => {
  const instance = fixture();
  instance.build();
  const entry = readFileSync(join(instance.output, "entry.mjs"));
  write(join(instance.root, "packages/agent-runtime/src/nodex/entry.ts"), "new source");
  failBuild = true;
  expect(instance.build).toThrow("bundle failed");
  expect(readFileSync(join(instance.output, "entry.mjs"))).toEqual(entry);
  expect(existsSync(join(instance.output, "chunks/engine.mjs"))).toBe(true);
  expect(readdirSync(join(instance.root, "out"))).toEqual(["agent-runtime"]);
  failBuild = false;
  expect(instance.build()).toBe("built");
  expect(instance.build()).toBe("reused");
});

test("rejects source edits made during bundling and keeps the previous complete bundle", () => {
  const instance = fixture();
  instance.build();
  const entry = readFileSync(join(instance.output, "entry.mjs"));
  write(join(instance.root, "packages/agent-runtime/src/nodex/entry.ts"), "start rebuild");
  duringBuild = () =>
    write(join(instance.root, "packages/agent-runtime/src/nodex/entry.ts"), "concurrent edit");
  expect(instance.build).toThrow("inputs changed while bundling");
  expect(readFileSync(join(instance.output, "entry.mjs"))).toEqual(entry);
});

test("never certifies a first bundle against source bytes edited after the compiler read them", () => {
  const instance = fixture();
  const entry = "packages/agent-runtime/src/nodex/entry.ts";
  duringBuild = () => {
    write(join(instance.root, entry), "export const runtime = 2;");
    duringBuild = undefined;
  };
  expect(instance.build()).toBe("built");
  const compiled = JSON.parse(readFileSync(join(instance.output, "compiled-inputs.json"), "utf8"));
  expect(compiled[entry]).toBe("export const runtime = 2;");
  expect(instance.build()).toBe("reused");
  expect(bundles).toBe(2);
});

test.each(["packages/agent-runtime/src/nodex/new.ts", "node_modules/new-dependency/index.js"])(
  "takes a pre-compilation snapshot of newly discovered %s",
  (newInput) => {
    const instance = fixture();
    instance.build();
    write(join(instance.root, newInput), "export const value = 1;");
    compilerInputs.push(newInput);
    duringBuild = () => {
      write(join(instance.root, newInput), "export const value = 2;");
      duringBuild = undefined;
    };
    expect(instance.build()).toBe("built");
    const compiled = JSON.parse(
      readFileSync(join(instance.output, "compiled-inputs.json"), "utf8"),
    );
    expect(compiled[newInput]).toBe("export const value = 2;");
    expect(instance.build()).toBe("reused");
    expect(bundles).toBe(4);
  },
);

test("leaves no cached output when the discovered graph keeps changing", () => {
  const instance = fixture();
  const additional = Array.from(
    { length: 3 },
    (_, index) => `packages/agent-runtime/src/nodex/extra-${index}.ts`,
  );
  for (const file of additional) write(join(instance.root, file), "export const value = true;");
  duringBuild = () => {
    compilerInputs.push(additional.shift()!);
  };
  expect(instance.build).toThrow("input graph kept changing");
  expect(existsSync(instance.output)).toBe(false);
  expect(existsSync(join(instance.root, ".generated/agent-runtime-build-receipt.json"))).toBe(
    false,
  );
});

test("restores the complete output and metadata if publishing its receipt fails", () => {
  const instance = fixture();
  instance.build();
  const entry = readFileSync(join(instance.output, "entry.mjs"));
  const metafile = join(instance.root, ".generated/agent-runtime-build.json");
  const metadata = readFileSync(metafile);
  const receipt = join(instance.root, ".generated/agent-runtime-build-receipt.json");
  const previousReceipt = readFileSync(receipt);
  write(join(instance.root, "packages/agent-runtime/src/nodex/entry.ts"), "new source");
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (to === receipt) throw new Error("receipt publication failed");
    return renameFile(from, to);
  });
  expect(instance.build).toThrow("receipt publication failed");
  expect(readFileSync(join(instance.output, "entry.mjs"))).toEqual(entry);
  expect(readFileSync(metafile)).toEqual(metadata);
  expect(readFileSync(receipt)).toEqual(previousReceipt);
  expect(readdirSync(join(instance.root, "out"))).toEqual(["agent-runtime"]);
});

test("reclaims an interrupted build lock", () => {
  const instance = fixture();
  const lock = join(instance.root, ".generated/agent-runtime-build.lock");
  write(join(lock, "owner.json"), JSON.stringify({ pid: 2147483647, token: "abandoned" }));
  expect(instance.build()).toBe("built");
  expect(existsSync(lock)).toBe(false);
});

test("accepts pnpm's worktree-local NODE_PATH without disabling reuse", () => {
  const instance = fixture();
  const lookup = join(instance.root, "node_modules/.pnpm/node_modules");
  mkdirSync(lookup, { recursive: true });
  vi.stubEnv("NODE_PATH", lookup);
  expect(instance.build()).toBe("built");
  expect(instance.build()).toBe("reused");
  expect(bundles).toBe(2);
});

test.each(["NODE_PATH", "ESBUILD_BINARY_PATH", "NODE_OPTIONS"])(
  "builds without caching custom %s dependency hooks",
  (key) => {
    const instance = fixture();
    vi.stubEnv(key, key === "NODE_OPTIONS" ? "--import /external/hook.mjs" : "/external/input");
    expect(instance.build()).toBe("built");
    expect(instance.build()).toBe("built");
    expect(bundles).toBe(4);
    expect(existsSync(join(instance.root, ".generated/agent-runtime-build-receipt.json"))).toBe(
      false,
    );
  },
);
