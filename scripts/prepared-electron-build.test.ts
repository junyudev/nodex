import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { resolveAgentRuntimeNode } from "./agent-runtime-native";
import {
  recordPreparedElectronBuild,
  verifyPreparedElectronBuild,
} from "./prepared-electron-build";

vi.mock("./agent-runtime-native", () => ({
  resolveAgentRuntimeNode: vi.fn(() => ({
    executable: "/staged/node",
    sha256: "node-sha",
    modules: "137",
    napi: "10",
    version: "24.21.0",
    platform: process.platform,
    architecture: process.arch,
  })),
}));

const temporaryRoots: string[] = [];

const skillFiles = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/nested-markdown.md",
  "references/page-editor.md",
  "references/project-database-views.md",
  "references/queries-and-configuration.md",
  "references/troubleshooting.md",
] as const;

const writeAgentSkillsArtifact = (repositoryRoot: string): void => {
  const files = new Map(
    skillFiles.map((relativePath) => [relativePath, Buffer.from(`${relativePath}\n`, "utf8")]),
  );
  const hash = createHash("sha256");
  for (const relativePath of [...files.keys()].sort()) {
    const contents = files.get(relativePath);
    if (!contents) throw new Error(`Missing test Skill file: ${relativePath}`);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  const skillRoot = path.join(repositoryRoot, ".generated/official-agent-skills/skills/nodex");
  for (const [relativePath, contents] of files) {
    const destination = path.join(skillRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  const artifactRoot = path.join(repositoryRoot, ".generated/official-agent-skills");
  fs.writeFileSync(path.join(artifactRoot, "README.md"), "README\n");
  fs.writeFileSync(path.join(artifactRoot, "LICENSE"), "LICENSE\n");
  fs.writeFileSync(
    path.join(artifactRoot, "release-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        distribution: "NodexApp/skills",
        product: { name: "Nodex", releaseVersion: "1.2.3" },
        source: { repository: "NodexApp/nodex", ref: "v1.2.3" },
        agentInterface: { minimumRevision: 1, maximumRevision: 1 },
        skills: [
          {
            name: "nodex",
            path: "skills/nodex",
            treeSha256: hash.digest("hex"),
            fileCount: files.size,
            totalBytes: [...files.values()].reduce(
              (total, contents) => total + contents.byteLength,
              0,
            ),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
};

const makeFixture = (): {
  manifestPath: string;
  repositoryRoot: string;
} => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-prepared-build-"));
  temporaryRoots.push(repositoryRoot);
  const requiredInputs = [
    ".cargo/config.toml",
    "agent-skills/nodex/SKILL.md",
    "config/value.ts",
    "native/macos-sparkle/binding.gyp",
    "packages/codex-app-server-protocol/value.ts",
    "packages/core-protocol/value.ts",
    "packages/effect-codex-app-server/value.ts",
    "packages/nodex-app-tools-mcp/value.ts",
    "packages/agent-runtime/value.ts",
    "resources/icon.icon/value.json",
    "resources/icon.png",
    "resources/nodex-icon.svg",
    "resources/nodex-notification.aiff",
    "resources/third-party/codex/LICENSE",
    "resources/third-party/codex/NOTICE",
    "scripts/build-resources.ts",
    "scripts/generate-third-party-notices.ts",
    "scripts/official-agent-skills-artifact.d.mts",
    "scripts/official-agent-skills-artifact.mjs",
    "scripts/official-agent-skills.ts",
    "scripts/prepared-electron-build.ts",
    "scripts/sync-app-icons.ts",
    "src/value.ts",
    "src/shared/build-resources.ts",
    "src/shared/nfm/agent-guide.ts",
    "src/shared/nfm/parser.ts",
    "src/shared/nfm/serializer.ts",
    "third_party/blocknote/packages/value.ts",
    "third_party/blocknote/tsconfig.base.json",
    "third_party/blocknote/vite-shared.ts",
    "crates/example/Cargo.toml",
    "crates/example/src/lib.rs",
    ".node-version",
    "Cargo.lock",
    "Cargo.toml",
    "LICENSE",
    "electron-builder.yml",
    "electron.vite.config.ts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "rust-toolchain.toml",
    "tsconfig.base.json",
    "tsconfig.effect.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "tsconfig.web.json",
    "out/main/bootstrap.js",
    "out/agent-runtime/entry.mjs",
    "out/agent-runtime/native-dependencies.json",
    "out/agent-runtime/node_modules/node-pty/package.json",
    "out/agent-runtime/node_modules/node-pty/lib/index.js",
    ...(process.platform === "darwin"
      ? ["out/agent-runtime/node_modules/node-pty/build/Release/spawn-helper"]
      : []),
    "out/agent-runtime/node_modules/node-pty/build/Release/pty.node",
    "out/agent-runtime/LICENSE.t3code",
    "out/agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    "out/agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "out/preload/index.js",
    "out/renderer/index.html",
  ];
  for (const relativePath of requiredInputs) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `${relativePath}\n`, "utf8");
  }
  fs.writeFileSync(
    path.join(repositoryRoot, "package.json"),
    `${JSON.stringify({ name: "nodex", version: "1.2.3" })}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(repositoryRoot, "out/agent-runtime/native-dependencies.json"),
    JSON.stringify({ node: resolveAgentRuntimeNode(repositoryRoot) }),
  );
  writeAgentSkillsArtifact(repositoryRoot);
  return {
    repositoryRoot,
    manifestPath: path.join(repositoryRoot, ".generated/prepared.json"),
  };
};

const initializeGitFixture = (
  repositoryRoot: string,
): {
  commit: string;
  tree: string;
} => {
  fs.writeFileSync(path.join(repositoryRoot, ".gitignore"), ".generated/prepared.json\n", "utf8");
  execFileSync("git", ["init"], { cwd: repositoryRoot });
  execFileSync("git", ["config", "user.email", "prepared-build@example.invalid"], {
    cwd: repositoryRoot,
  });
  execFileSync("git", ["config", "user.name", "Prepared Build Test"], {
    cwd: repositoryRoot,
  });
  execFileSync("git", ["add", "."], { cwd: repositoryRoot });
  execFileSync("git", ["commit", "-m", "test fixture"], { cwd: repositoryRoot });
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
  };
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("prepared Electron build", () => {
  test("records clean and dirty Git source state without conflating empty status output with failure", () => {
    const fixture = makeFixture();
    const source = initializeGitFixture(fixture.repositoryRoot);

    const clean = recordPreparedElectronBuild(fixture);
    expect(clean.source).toMatchObject({
      baseCommit: source.commit,
      baseTree: source.tree,
      state: "clean",
    });

    fs.appendFileSync(path.join(fixture.repositoryRoot, "src/value.ts"), "changed\n");
    expect(recordPreparedElectronBuild(fixture).source.state).toBe("dirty");
  });

  test("reuses only the exact recorded inputs and output closure", () => {
    const fixture = makeFixture();
    const recorded = recordPreparedElectronBuild(fixture);

    expect(verifyPreparedElectronBuild(fixture).generationId).toBe(recorded.generationId);

    fs.appendFileSync(path.join(fixture.repositoryRoot, "src/value.ts"), "changed\n");
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("inputs are stale");
  });

  test("invalidates prepared outputs when the bundled account pair or its presence changes", () => {
    const fixture = makeFixture();
    vi.stubEnv("NODEX_BUILD_CLERK_ISSUER", undefined);
    vi.stubEnv("NODEX_BUILD_CLERK_CLIENT_ID", undefined);
    recordPreparedElectronBuild(fixture);
    vi.stubEnv("NODEX_BUILD_CLERK_ISSUER", "");
    vi.stubEnv("NODEX_BUILD_CLERK_CLIENT_ID", "");
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("inputs are stale");

    vi.stubEnv("NODEX_BUILD_CLERK_ISSUER", "https://clerk.example.test");
    vi.stubEnv("NODEX_BUILD_CLERK_CLIENT_ID", "first-client");
    recordPreparedElectronBuild(fixture);
    vi.stubEnv("NODEX_BUILD_CLERK_CLIENT_ID", "second-client");
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("inputs are stale");

    recordPreparedElectronBuild(fixture);
    vi.stubEnv("NODEX_BUILD_CLERK_ISSUER", "https://other.example.test");
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("inputs are stale");
  });

  test("treats Rust and packaging sources as part of the build closure", () => {
    const fixture = makeFixture();
    recordPreparedElectronBuild(fixture);

    fs.appendFileSync(
      path.join(fixture.repositoryRoot, "crates/example/src/lib.rs"),
      "pub fn changed() {}\n",
    );
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("inputs are stale");

    recordPreparedElectronBuild(fixture);
    fs.appendFileSync(path.join(fixture.repositoryRoot, "electron-builder.yml"), "changed: true\n");
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("inputs are stale");

    recordPreparedElectronBuild(fixture);
    fs.appendFileSync(path.join(fixture.repositoryRoot, ".cargo/config.toml"), "changed = true\n");
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("inputs are stale");
  });

  test.each([
    "tsconfig.base.json",
    "tsconfig.effect.json",
    "third_party/blocknote/tsconfig.base.json",
    "third_party/blocknote/vite-shared.ts",
  ])("invalidates prepared outputs when inherited configuration %s changes", (configuration) => {
    const fixture = makeFixture();
    recordPreparedElectronBuild(fixture);

    fs.appendFileSync(path.join(fixture.repositoryRoot, configuration), "changed\n");
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("inputs are stale");
  });

  test("ignores generated editor declarations while retaining authored type inputs", () => {
    const fixture = makeFixture();
    const authoredTypes = path.join(fixture.repositoryRoot, "src/domain/types/value.ts");
    fs.mkdirSync(path.dirname(authoredTypes), { recursive: true });
    fs.writeFileSync(authoredTypes, "export type Value = string;\n");
    const recorded = recordPreparedElectronBuild(fixture);

    const declaration = path.join(
      fixture.repositoryRoot,
      "third_party/blocknote/packages/core/types/src/index.d.ts",
    );
    fs.mkdirSync(path.dirname(declaration), { recursive: true });
    fs.writeFileSync(declaration, "export declare const value: string;\n");
    expect(verifyPreparedElectronBuild(fixture).generationId).toBe(recorded.generationId);
    fs.writeFileSync(declaration, "export declare const value: number;\n");
    expect(verifyPreparedElectronBuild(fixture).generationId).toBe(recorded.generationId);

    fs.appendFileSync(authoredTypes, "export type UpdatedValue = number;\n");
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("inputs are stale");
  });

  test("rejects damaged and additional build outputs", () => {
    const fixture = makeFixture();
    recordPreparedElectronBuild(fixture);
    fs.appendFileSync(path.join(fixture.repositoryRoot, "out/main/bootstrap.js"), "changed\n");

    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("outputs are stale or damaged");

    recordPreparedElectronBuild(fixture);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "out/main/extra.js"), "extra\n");
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("outputs are stale or damaged");
  });

  test.each([
    {
      dependency: "@nodex/effect-codex-app-server",
      specifier: "@nodex/effect-codex-app-server/client",
    },
    { dependency: "@opencode-ai/sdk", specifier: "@opencode-ai/sdk/v2" },
  ])(
    "rejects external runtime loading of $specifier in Electron Main",
    ({ dependency, specifier }) => {
      const fixture = makeFixture();
      fs.writeFileSync(
        path.join(fixture.repositoryRoot, "out/main/bootstrap.js"),
        `require(${JSON.stringify(specifier)});\n`,
      );

      expect(() => recordPreparedElectronBuild(fixture)).toThrow(
        `externalizes required bundled dependency ${dependency}`,
      );
    },
  );

  test("binds the exact generated Agent Skills artifact", () => {
    const fixture = makeFixture();
    const recorded = recordPreparedElectronBuild(fixture);

    expect(recorded.agentSkills.treeSha256).toMatch(/^[a-f0-9]{64}$/u);
    fs.appendFileSync(
      path.join(fixture.repositoryRoot, ".generated/official-agent-skills/skills/nodex/SKILL.md"),
      "tampered\n",
    );

    expect(() => verifyPreparedElectronBuild(fixture)).toThrow(
      "tree does not match its release manifest",
    );
  });

  test("refuses to bind outputs to a different pre-build input digest", () => {
    const fixture = makeFixture();

    expect(() => recordPreparedElectronBuild(fixture, "0".repeat(64))).toThrow(
      "inputs changed while the production build was running",
    );
  });
});

test("rejects reuse when native execution output targets an older staged Node", () => {
  const fixture = makeFixture();
  recordPreparedElectronBuild(fixture);
  vi.mocked(resolveAgentRuntimeNode).mockReturnValueOnce({
    ...resolveAgentRuntimeNode(fixture.repositoryRoot),
    sha256: "new-node",
  });
  expect(() => verifyPreparedElectronBuild(fixture)).toThrow("different staged Node");
});
