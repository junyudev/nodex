import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { inspectOfficialAgentSkillsArtifact } from "./official-agent-skills-artifact.mjs";
import {
  githubGitAuthorizationConfiguration,
  publishOfficialAgentSkills,
  resolveGithubToken,
} from "./publish-official-agent-skills";

const temporaryRoots: string[] = [];
const sourceRepository = "NodexApp/nodex";
const skillFiles = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/nested-markdown.md",
  "references/page-editor.md",
  "references/project-database-views.md",
  "references/queries-and-configuration.md",
  "references/troubleshooting.md",
] as const;

const gitEnvironment = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "tests@nodex.app",
  GIT_AUTHOR_NAME: "Nodex Tests",
  GIT_COMMITTER_EMAIL: "tests@nodex.app",
  GIT_COMMITTER_NAME: "Nodex Tests",
};

const git = (cwd: string, arguments_: readonly string[]): string =>
  execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment,
  }).trim();

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-skills-publisher-"));
  temporaryRoots.push(root);
  return root;
};

const writeArtifact = (root: string, version: string, marker = "default"): string => {
  const artifact = path.join(root, `artifact-${version}-${marker}`);
  const files = new Map(
    skillFiles.map((relativePath) => [
      relativePath,
      Buffer.from(`${relativePath}: ${marker}\n`, "utf8"),
    ]),
  );
  const hash = createHash("sha256");
  for (const relativePath of [...files.keys()].sort()) {
    const contents = files.get(relativePath);
    if (!contents) throw new Error(`Missing fixture Skill file: ${relativePath}`);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(contents.byteLength));
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  const treeSha256 = hash.digest("hex");
  for (const [relativePath, contents] of files) {
    const destination = path.join(artifact, "skills/nodex", relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  fs.writeFileSync(path.join(artifact, "README.md"), `Nodex Skills ${version}\n`);
  fs.writeFileSync(path.join(artifact, "LICENSE"), "MIT\n");
  fs.writeFileSync(
    path.join(artifact, "release-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        distribution: "NodexApp/skills",
        product: { name: "Nodex", releaseVersion: version },
        source: { repository: sourceRepository, ref: `v${version}` },
        agentInterface: { minimumRevision: 1, maximumRevision: 1 },
        skills: [
          {
            name: "nodex",
            path: "skills/nodex",
            treeSha256,
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
  return artifact;
};

const makeRemote = (root: string): string => {
  const remote = path.join(root, "skills.git");
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  const seed = path.join(root, "seed");
  git(root, ["clone", remote, seed]);
  fs.mkdirSync(path.join(seed, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(seed, ".github/workflows/keep.yml"), "name: preserve-me\n");
  git(seed, ["add", ".github/workflows/keep.yml"]);
  git(seed, ["commit", "-m", "chore: seed mirror automation"]);
  git(seed, ["push", "origin", "main"]);
  return remote;
};

const publish = (
  artifactDirectory: string,
  remoteUrl: string,
  version: string,
  extra: {
    readonly beforePush?: (worktree: string) => void;
    readonly token?: string;
  } = {},
) => {
  const artifact = inspectOfficialAgentSkillsArtifact(artifactDirectory);
  return publishOfficialAgentSkills({
    artifactDirectory,
    beforePush: extra.beforePush,
    expectedManifestSha256: artifact.manifestSha256,
    expectedSourceRef: `v${version}`,
    expectedSourceRepository: sourceRepository,
    expectedTreeSha256: artifact.treeSha256,
    expectedVersion: version,
    remoteUrl,
    token: extra.token,
  });
};

const cloneRemote = (root: string, remote: string, name: string): string => {
  const checkout = path.join(root, name);
  git(root, ["clone", remote, checkout]);
  return checkout;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("official Agent Skills publisher", () => {
  test("uses GitHub-scoped password authentication without embedding the token", () => {
    const secret = "github_pat_secret-sentinel";
    const authorization = githubGitAuthorizationConfiguration(secret);
    const encodedCredentials = authorization.value.slice("AUTHORIZATION: basic ".length);

    expect(authorization.key).toBe("http.https://github.com/.extraheader");
    expect(authorization.value).not.toContain(secret);
    expect(Buffer.from(encodedCredentials, "base64").toString("utf8")).toBe(
      `x-access-token:${secret}`,
    );
  });

  test("falls back to the GitHub CLI token when the legacy token is blank", () => {
    expect(resolveGithubToken(" \n", " github-cli-token ")).toBe("github-cli-token");
    expect(resolveGithubToken(" legacy-token ", "github-cli-token")).toBe("legacy-token");
  });

  test("publishes managed paths atomically and preserves mirror automation", () => {
    const root = makeRoot();
    const remote = makeRemote(root);
    const artifact = writeArtifact(root, "1.2.3");

    const result = publish(artifact, remote, "1.2.3");
    const checkout = cloneRemote(root, remote, "published");

    expect(result.status).toBe("published");
    expect(fs.readFileSync(path.join(checkout, ".github/workflows/keep.yml"), "utf8")).toBe(
      "name: preserve-me\n",
    );
    expect(fs.readFileSync(path.join(checkout, "skills/nodex/SKILL.md"), "utf8")).toContain(
      "default",
    );
    expect(git(checkout, ["tag", "-l", "v1.2.3"])).toBe("v1.2.3");
    expect(git(checkout, ["cat-file", "-t", "refs/tags/v1.2.3"])).toBe("tag");
    const commitBody = git(checkout, ["log", "-1", "--format=%B"]);
    expect(commitBody).toContain("Source: NodexApp/nodex@v1.2.3");
    expect(commitBody).toContain(`Skill tree SHA-256: ${result.treeSha256}`);
  });

  test("treats an exact release retry as a no-op", () => {
    const root = makeRoot();
    const remote = makeRemote(root);
    const artifact = writeArtifact(root, "1.2.3");
    const first = publish(artifact, remote, "1.2.3");

    const retried = publish(artifact, remote, "1.2.3");

    expect(retried).toEqual({ ...first, status: "unchanged" });
    expect(git(root, ["--git-dir", remote, "rev-list", "--count", "main"])).toBe("2");
  });

  test("rejects a reused tag with a different tree and any version rollback", () => {
    const root = makeRoot();
    const remote = makeRemote(root);
    publish(writeArtifact(root, "2.0.0"), remote, "2.0.0");

    expect(() => publish(writeArtifact(root, "2.0.0", "different"), remote, "2.0.0")).toThrow(
      "different official Agent Skills",
    );
    expect(() => publish(writeArtifact(root, "1.9.9"), remote, "1.9.9")).toThrow(
      "Refusing to roll back",
    );
  });

  test("fails the atomic push when remote main advances concurrently", () => {
    const root = makeRoot();
    const remote = makeRemote(root);
    const artifact = writeArtifact(root, "1.0.0");

    expect(() =>
      publish(artifact, remote, "1.0.0", {
        beforePush: () => {
          const racer = cloneRemote(root, remote, "racer");
          fs.writeFileSync(path.join(racer, "race.txt"), "advanced\n");
          git(racer, ["add", "race.txt"]);
          git(racer, ["commit", "-m", "chore: advance mirror"]);
          git(racer, ["push", "origin", "main"]);
        },
      }),
    ).toThrow("git push failed");
    expect(git(root, ["--git-dir", remote, "tag", "-l", "v1.0.0"])).toBe("");
  });

  test("keeps credentials out of results, remotes, and commits", () => {
    const root = makeRoot();
    const remote = makeRemote(root);
    const secret = "github_pat_secret-sentinel";
    const result = publish(writeArtifact(root, "1.0.0"), remote, "1.0.0", { token: secret });
    const checkout = cloneRemote(root, remote, "credential-check");
    const evidence = [
      JSON.stringify(result),
      git(checkout, ["remote", "-v"]),
      git(checkout, ["log", "--format=%B"]),
    ].join("\n");

    expect(evidence).not.toContain(secret);
  });

  test("rejects an invalid bundle before touching the remote", () => {
    const root = makeRoot();
    const remote = makeRemote(root);
    const artifact = writeArtifact(root, "1.0.0");
    fs.writeFileSync(path.join(artifact, "unknown.txt"), "not allowlisted\n");
    const before = git(root, ["--git-dir", remote, "rev-parse", "main"]);

    expect(() => publish(artifact, remote, "1.0.0")).toThrow("unknown file");
    expect(git(root, ["--git-dir", remote, "rev-parse", "main"])).toBe(before);
    expect(git(root, ["--git-dir", remote, "tag", "-l"])).toBe("");
  });

  test("rejects an artifact outside the verified Release Bundle identity", () => {
    const root = makeRoot();
    const remote = makeRemote(root);
    const artifactDirectory = writeArtifact(root, "1.0.0");
    const artifact = inspectOfficialAgentSkillsArtifact(artifactDirectory);
    const before = git(root, ["--git-dir", remote, "rev-parse", "main"]);

    expect(() =>
      publishOfficialAgentSkills({
        artifactDirectory,
        expectedManifestSha256: artifact.manifestSha256,
        expectedSourceRef: "v1.0.0",
        expectedSourceRepository: sourceRepository,
        expectedTreeSha256: "f".repeat(64),
        expectedVersion: "1.0.0",
        remoteUrl: remote,
      }),
    ).toThrow("verified Release Bundle identity");
    expect(git(root, ["--git-dir", remote, "rev-parse", "main"])).toBe(before);
  });
});
