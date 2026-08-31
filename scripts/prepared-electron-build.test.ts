import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  recordPreparedElectronBuild,
  verifyPreparedElectronBuild,
} from "./prepared-electron-build";

const temporaryRoots: string[] = [];

const skillFiles = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/nested-markdown.md",
  "references/page-editor.md",
  "references/project-database-views.md",
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
    "tsconfig.json",
    "tsconfig.node.json",
    "tsconfig.web.json",
    "out/main/bootstrap.js",
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

  test("rejects damaged and additional build outputs", () => {
    const fixture = makeFixture();
    recordPreparedElectronBuild(fixture);
    fs.appendFileSync(path.join(fixture.repositoryRoot, "out/main/bootstrap.js"), "changed\n");

    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("outputs are stale or damaged");

    recordPreparedElectronBuild(fixture);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "out/main/extra.js"), "extra\n");
    expect(() => verifyPreparedElectronBuild(fixture)).toThrow("outputs are stale or damaged");
  });

  test("rejects source-only workspace dependencies left external in Electron Main", () => {
    const fixture = makeFixture();
    fs.writeFileSync(
      path.join(fixture.repositoryRoot, "out/main/bootstrap.js"),
      'require("@nodex/effect-codex-app-server/client");\n',
    );

    expect(() => recordPreparedElectronBuild(fixture)).toThrow(
      "externalizes source-only workspace dependency @nodex/effect-codex-app-server",
    );
  });

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
