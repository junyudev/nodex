import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, expect, test } from "vite-plus/test";
import {
  prepareElectronRuntime,
  type PrepareElectronRuntimeOptions,
} from "./prepare-electron-runtime";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function archiveServer(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP server address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function upstreamDownloader(project: PrepareElectronRuntimeOptions, url: string) {
  const require = createRequire(import.meta.url);
  const electronRequire = createRequire(require.resolve("electron/package.json"));
  type Archive = Parameters<
    NonNullable<PrepareElectronRuntimeOptions["installer"]>["downloadArtifact"]
  >[0];
  const { downloadArtifact } = electronRequire("@electron/get") as {
    downloadArtifact: (
      input: Archive & {
        readonly cacheRoot: string;
        readonly mirrorOptions: { readonly mirror: string };
        readonly downloadOptions: { readonly quiet: boolean };
      },
    ) => Promise<string>;
  };
  let attempts = 0;
  return {
    downloadArtifact: async (input: Archive) => {
      attempts++;
      return await downloadArtifact({
        ...input,
        cacheRoot: path.join(project.projectRoot, "electron-download-cache"),
        mirrorOptions: { mirror: url },
        downloadOptions: { quiet: true },
      });
    },
    attempts: () => attempts,
  };
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "nodex-electron-prepare-"));
  roots.push(root);
  const archivePath = path.join(root, "electron.zip");
  writeFileSync(archivePath, "verified electron archive");
  const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  const cachePath = path.join(root, "cache");
  let downloads = 0;
  let extractions = 0;
  let extractionFailure: Error | undefined;
  const installer: NonNullable<PrepareElectronRuntimeOptions["installer"]> = {
    downloadArtifact: async (input) => {
      expect(input).toMatchObject({ version: "44.4.4", platform: "darwin", arch: "arm64" });
      downloads++;
      return archivePath;
    },
    extract: async (_archive, { dir }) => {
      extractions++;
      if (extractionFailure) throw extractionFailure;
      const executable = path.join(dir, "Electron.app/Contents/MacOS/Electron");
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(executable, "electron executable");
      chmodSync(executable, 0o755);
      writeFileSync(path.join(dir, "version"), "44.4.4");
      writeFileSync(path.join(dir, "electron.d.ts"), "upstream types");
    },
  };
  const project = (name: string): PrepareElectronRuntimeOptions => {
    const projectRoot = path.join(root, name);
    const packageRoot = path.join(projectRoot, "node_modules/electron");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ devDependencies: { electron: "44.4.4" } }),
    );
    writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "electron", version: "44.4.4" }),
    );
    writeFileSync(
      path.join(packageRoot, "checksums.json"),
      JSON.stringify({ "electron-v44.4.4-darwin-arm64.zip": sha256 }),
    );
    return { projectRoot, arch: "arm64", platform: "darwin", cachePath, installer };
  };
  return {
    project,
    archivePath,
    cachedExecutable: path.join(
      cachePath,
      sha256,
      "dist-v1/content/Electron.app/Contents/MacOS/Electron",
    ),
    counters: () => ({ downloads, extractions }),
    failExtraction: (error = new Error("extract failed")) => {
      extractionFailure = error;
    },
  };
}

test("concurrent worktrees extract once and own independent verified distributions", async () => {
  const setup = fixture();
  const first = setup.project("first");
  const second = setup.project("second");
  const [firstExecutable, secondExecutable] = await Promise.all([
    prepareElectronRuntime(first),
    prepareElectronRuntime(second),
  ]);
  expect(setup.counters()).toEqual({ downloads: 1, extractions: 1 });
  expect(statSync(firstExecutable).ino).not.toBe(statSync(secondExecutable).ino);
  const before = statSync(firstExecutable).mtimeMs;
  await prepareElectronRuntime(first);
  expect(statSync(firstExecutable).mtimeMs).toBe(before);
  writeFileSync(firstExecutable, "changed by first worktree");
  expect(readFileSync(secondExecutable, "utf8")).toBe("electron executable");
  expect(readFileSync(setup.cachedExecutable, "utf8")).toBe("electron executable");
  await prepareElectronRuntime(first);
  expect(readFileSync(firstExecutable, "utf8")).toBe("electron executable");
  expect(setup.counters()).toEqual({ downloads: 1, extractions: 1 });
  const packageRoot = path.join(first.projectRoot, "node_modules/electron");
  expect(readFileSync(path.join(packageRoot, "path.txt"), "utf8")).toBe(
    "Electron.app/Contents/MacOS/Electron",
  );
  expect(existsSync(path.join(packageRoot, "dist/electron.d.ts"))).toBe(false);
});

test("repairs damaged extraction caches before cloning to another worktree", async () => {
  const setup = fixture();
  await prepareElectronRuntime(setup.project("first"));
  writeFileSync(setup.cachedExecutable, "damaged cache");
  const executable = await prepareElectronRuntime(setup.project("second"));
  expect(readFileSync(executable, "utf8")).toBe("electron executable");
  expect(setup.counters()).toEqual({ downloads: 2, extractions: 2 });
});

test("rejects an archive for another identity before extraction", async () => {
  const setup = fixture();
  const project = setup.project("first");
  writeFileSync(setup.archivePath, "unexpected archive");
  await expect(prepareElectronRuntime(project)).rejects.toThrow("checksum mismatch");
  expect(setup.counters()).toEqual({ downloads: 1, extractions: 0 });
  await expect(prepareElectronRuntime({ ...project, arch: "x64" })).rejects.toThrow(
    "no pinned SHA-256",
  );
});

test("recovers dropped downloads through Electron's pinned downloader before publishing", async () => {
  const setup = fixture();
  const project = setup.project("recovering-network");
  let requests = 0;
  const server = await archiveServer((request, response) => {
    requests++;
    if (requests < 3) {
      request.socket.destroy();
      return;
    }
    response.end(readFileSync(setup.archivePath));
  });
  const downloader = upstreamDownloader(project, server.url);
  const options = { ...project, installer: { ...project.installer!, ...downloader } };
  try {
    const executable = await prepareElectronRuntime(options);
    expect(downloader.attempts()).toBe(3);
    expect(requests).toBe(3);
    expect(setup.counters().extractions).toBe(1);
    expect(readFileSync(executable, "utf8")).toBe("electron executable");
    await prepareElectronRuntime(options);
    expect(downloader.attempts()).toBe(3);
  } finally {
    await server.close();
  }
});

test("bounds persistent transport failures without publishing an Electron distribution", async () => {
  const setup = fixture();
  const project = setup.project("offline-network");
  const server = await archiveServer((request) => request.socket.destroy());
  const downloader = upstreamDownloader(project, server.url);
  try {
    await expect(
      prepareElectronRuntime({ ...project, installer: { ...project.installer!, ...downloader } }),
    ).rejects.toThrow("fetch failed");
    expect(downloader.attempts()).toBe(3);
    expect(setup.counters().extractions).toBe(0);
    expect(existsSync(setup.cachedExecutable)).toBe(false);
    expect(existsSync(path.join(project.projectRoot, "node_modules/electron/path.txt"))).toBe(
      false,
    );
  } finally {
    await server.close();
  }
});

test("retries the connection timeout preserved in native fetch's cause", async () => {
  const setup = fixture();
  const project = setup.project("connection-timeout");
  const download = project.installer!.downloadArtifact;
  let attempts = 0;
  const executable = await prepareElectronRuntime({
    ...project,
    installer: {
      ...project.installer!,
      downloadArtifact: async (input) => {
        attempts++;
        if (attempts === 1) {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("Connect Timeout Error"), {
              code: "UND_ERR_CONNECT_TIMEOUT",
            }),
          });
        }
        return await download(input);
      },
    },
  });
  expect(attempts).toBe(2);
  expect(readFileSync(executable, "utf8")).toBe("electron executable");
  expect(setup.counters()).toEqual({ downloads: 1, extractions: 1 });
});

test.each([403, 404, 503])("does not retry an HTTP %s response", async (status) => {
  const setup = fixture();
  const project = setup.project("http-error");
  const server = await archiveServer((_request, response) => {
    response.writeHead(status).end();
  });
  const downloader = upstreamDownloader(project, server.url);
  try {
    await expect(
      prepareElectronRuntime({ ...project, installer: { ...project.installer!, ...downloader } }),
    ).rejects.toThrow(`Response code ${status}`);
    expect(downloader.attempts()).toBe(1);
    expect(setup.counters().extractions).toBe(0);
    expect(existsSync(setup.cachedExecutable)).toBe(false);
  } finally {
    await server.close();
  }
});

test.each([
  Object.assign(new Error("untrusted TLS certificate"), { code: "CERT_HAS_EXPIRED" }),
  Object.assign(new Error("invalid archive checksum"), { code: "CHECKSUM_MISMATCH" }),
  new Error("unrecognized download failure"),
])("does not retry a fatal download failure: %s", async (failure) => {
  const setup = fixture();
  const project = setup.project("fatal-download");
  let attempts = 0;
  await expect(
    prepareElectronRuntime({
      ...project,
      installer: {
        ...project.installer!,
        downloadArtifact: async () => {
          attempts++;
          throw failure;
        },
      },
    }),
  ).rejects.toThrow(failure.message);
  expect(attempts).toBe(1);
  expect(setup.counters().extractions).toBe(0);
  expect(existsSync(setup.cachedExecutable)).toBe(false);
});

test("retains the previous complete distribution when replacement generation fails", async () => {
  const setup = fixture();
  const project = setup.project("first");
  const executable = await prepareElectronRuntime(project);
  const receipt = path.join(project.projectRoot, "node_modules/electron/.nodex-electron.json");
  rmSync(receipt);
  writeFileSync(setup.cachedExecutable, "damaged cache");
  setup.failExtraction(Object.assign(new Error("extract failed"), { code: "ECONNRESET" }));
  await expect(prepareElectronRuntime(project)).rejects.toThrow("extract failed");
  expect(readFileSync(executable, "utf8")).toBe("electron executable");
  expect(setup.counters()).toEqual({ downloads: 2, extractions: 2 });
});

test("requires the installed package to match the exact repository version", async () => {
  const setup = fixture();
  const project = setup.project("first");
  writeFileSync(
    path.join(project.projectRoot, "package.json"),
    JSON.stringify({ devDependencies: { electron: "^44.4.4" } }),
  );
  await expect(prepareElectronRuntime(project)).rejects.toThrow("exact version");
  expect(setup.counters()).toEqual({ downloads: 0, extractions: 0 });
});

test.each(["cjs", "esm"] as const)(
  "prepares the caller's project from a %s bundle outside that project",
  async (format) => {
    const setup = fixture();
    const project = setup.project("target");
    const bundleRoot = path.join(
      realpathSync(path.dirname(project.projectRoot)),
      "bundled-evaluation",
    );
    const distribution = path.join(bundleRoot, "distribution");
    mkdirSync(bundleRoot);
    await project.installer!.extract(setup.archivePath, { dir: distribution });
    const output = path.join(
      bundleRoot,
      ".generated/agent-eval",
      `prepare.${format === "esm" ? "mjs" : "cjs"}`,
    );
    await build({
      stdin: {
        contents: `
          import { cpSync } from "node:fs";
          import { prepareElectronRuntime } from "./scripts/prepare-electron-runtime";
          void prepareElectronRuntime({
            ...${JSON.stringify({ ...project, installer: undefined })},
            installer: {
              downloadArtifact: async () => ${JSON.stringify(setup.archivePath)},
              extract: async (_archive, { dir }) => cpSync(${JSON.stringify(distribution)}, dir, { recursive: true }),
            },
          }).then(
            (executable) => process.stdout.write(executable),
            (error) => { console.error(error); process.exitCode = 1; },
          );
        `,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      outfile: output,
      bundle: true,
      platform: "node",
      target: "node24",
      format,
      logLevel: "silent",
    });
    const { stdout } = await promisify(execFile)(process.execPath, [output], {
      cwd: bundleRoot,
      timeout: 15_000,
    });
    expect(stdout).toBe(
      path.join(
        realpathSync(project.projectRoot),
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
    );
    expect(readFileSync(stdout, "utf8")).toBe("electron executable");
    expect(existsSync(path.join(bundleRoot, "node_modules"))).toBe(false);
  },
);
