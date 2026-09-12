import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OFFICIAL_AGENT_SKILLS_ARTIFACT_FILES,
  inspectOfficialAgentSkillsArtifact,
  type InspectedOfficialAgentSkillsArtifact,
} from "./official-agent-skills-artifact.mjs";

const DEFAULT_REMOTE = "https://github.com/NodexApp/skills.git";
const MANAGED_ROOTS = ["README.md", "LICENSE", "release-manifest.json", "skills"] as const;
const TEMPORARY_REMOVAL_OPTIONS = {
  force: true,
  maxRetries: 10,
  recursive: true,
  retryDelay: 100,
} as const;

interface PublishOptions {
  readonly artifactDirectory: string;
  readonly beforePush?: (worktree: string) => void;
  readonly expectedManifestSha256: string;
  readonly expectedSourceRef: string;
  readonly expectedSourceRepository: string;
  readonly expectedTreeSha256: string;
  readonly expectedVersion: string;
  readonly remoteUrl?: string;
  readonly token?: string;
}

export interface PublishResult {
  readonly commit: string;
  readonly manifestSha256: string;
  readonly status: "published" | "unchanged";
  readonly tag: string;
  readonly treeSha256: string;
  readonly version: string;
}

interface GitResult {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

const redact = (value: string, secret: string | undefined): string => {
  if (!secret) return value;
  const encodedCredentials = Buffer.from(`x-access-token:${secret}`).toString("base64");
  return value.replaceAll(secret, "[REDACTED]").replaceAll(encodedCredentials, "[REDACTED]");
};

export const githubGitAuthorizationConfiguration = (
  token: string,
): {
  readonly key: string;
  readonly value: string;
} => ({
  key: "http.https://github.com/.extraheader",
  value: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
});

export const resolveGithubToken = (
  legacyToken: string | undefined,
  githubCliToken: string | undefined,
): string | undefined => legacyToken?.trim() || githubCliToken?.trim() || undefined;

const gitEnvironment = (token: string | undefined): NodeJS.ProcessEnv => {
  const authorization = token ? githubGitAuthorizationConfiguration(token) : null;
  return {
    ...process.env,
    GIT_AUTHOR_EMAIL: "release@nodex.app",
    GIT_AUTHOR_NAME: "Nodex Release Bot",
    GIT_COMMITTER_EMAIL: "release@nodex.app",
    GIT_COMMITTER_NAME: "Nodex Release Bot",
    GIT_CONFIG_COUNT: authorization ? "1" : "0",
    ...(authorization
      ? {
          GIT_CONFIG_KEY_0: authorization.key,
          GIT_CONFIG_VALUE_0: authorization.value,
        }
      : {}),
    GIT_TERMINAL_PROMPT: "0",
  };
};

const git = (
  cwd: string,
  arguments_: readonly string[],
  token: string | undefined,
  allowFailure = false,
): GitResult => {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(token),
    maxBuffer: 16 * 1024 * 1024,
  });
  const status = result.status ?? 1;
  const stderr = redact(result.stderr ?? "", token);
  const stdout = redact(result.stdout ?? "", token);
  if (!allowFailure && (result.error || status !== 0)) {
    throw new Error(
      `git ${arguments_[0] ?? "command"} failed: ${redact(
        result.error?.message ?? (stderr || stdout),
        token,
      ).trim()}`,
    );
  }
  return { status, stderr, stdout };
};

const assertSafeRemote = (remoteUrl: string): void => {
  if (/^https?:\/\//u.test(remoteUrl)) {
    const parsed = new URL(remoteUrl);
    if (parsed.username || parsed.password) {
      throw new Error("Agent Skills remote URL must not contain credentials");
    }
  }
  if (/[\r\n\0]/u.test(remoteUrl)) {
    throw new Error("Agent Skills remote URL is invalid");
  }
};

const stableVersion = (value: string, label: string): readonly [number, number, number] => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (!match) throw new Error(`${label} must be a stable semantic version`);
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
};

const compareVersions = (left: string, right: string): number => {
  const leftParts = stableVersion(left, "Remote release version");
  const rightParts = stableVersion(right, "Requested release version");
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
};

const validateRequestedArtifact = (
  options: PublishOptions,
): InspectedOfficialAgentSkillsArtifact => {
  const artifact = inspectOfficialAgentSkillsArtifact(options.artifactDirectory);
  stableVersion(options.expectedVersion, "Expected release version");
  if (
    artifact.releaseVersion !== options.expectedVersion ||
    artifact.sourceRepository !== options.expectedSourceRepository ||
    artifact.sourceRef !== options.expectedSourceRef ||
    artifact.manifestSha256 !== options.expectedManifestSha256 ||
    artifact.treeSha256 !== options.expectedTreeSha256 ||
    options.expectedSourceRef !== `v${options.expectedVersion}`
  ) {
    throw new Error(
      "Official Agent Skills artifact does not match the verified Release Bundle identity",
    );
  }
  return artifact;
};

const refExists = (worktree: string, ref: string, token: string | undefined): boolean =>
  git(worktree, ["rev-parse", "--verify", "--quiet", ref], token, true).status === 0;

const materializeManagedRef = (
  worktree: string,
  ref: string,
  destination: string,
  token: string | undefined,
): InspectedOfficialAgentSkillsArtifact => {
  const tree = git(
    worktree,
    [
      "ls-tree",
      "-r",
      "--full-tree",
      ref,
      "--",
      "README.md",
      "LICENSE",
      "release-manifest.json",
      "skills",
    ],
    token,
  ).stdout;
  const entries = tree
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d{6}) blob [a-f0-9]+\t(.+)$/u.exec(line);
      if (!match) throw new Error(`Public Skill mirror contains an unsupported entry: ${line}`);
      return { mode: match[1]!, path: match[2]! };
    });
  const paths = entries.map((entry) => entry.path).sort();
  const expected = [...OFFICIAL_AGENT_SKILLS_ARTIFACT_FILES].sort();
  if (
    JSON.stringify(paths) !== JSON.stringify(expected) ||
    entries.some((entry) => entry.mode !== "100644")
  ) {
    throw new Error("Public Skill mirror managed paths are not an exact regular-file artifact");
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const contents = spawnSync("git", ["show", `${ref}:${entry.path}`], {
      cwd: worktree,
      encoding: null,
      env: gitEnvironment(token),
      maxBuffer: 2 * 1024 * 1024,
    });
    if (contents.error || contents.status !== 0 || !Buffer.isBuffer(contents.stdout)) {
      throw new Error(`Could not read public Skill mirror entry ${entry.path}`);
    }
    const destinationPath = path.join(destination, ...entry.path.split("/"));
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    writeFileSync(destinationPath, contents.stdout, { mode: 0o644 });
  }
  return inspectOfficialAgentSkillsArtifact(destination);
};

const inspectRef = (
  worktree: string,
  ref: string,
  temporaryRoot: string,
  token: string | undefined,
): InspectedOfficialAgentSkillsArtifact =>
  materializeManagedRef(
    worktree,
    ref,
    mkdtempSync(path.join(temporaryRoot, ".ref-artifact-")),
    token,
  );

const assertSameArtifact = (
  actual: InspectedOfficialAgentSkillsArtifact,
  expected: InspectedOfficialAgentSkillsArtifact,
  label: string,
): void => {
  if (
    actual.manifestSha256 !== expected.manifestSha256 ||
    actual.treeSha256 !== expected.treeSha256
  ) {
    throw new Error(`${label} already exists with different official Agent Skills`);
  }
};

const initializeMainWorktree = (
  worktree: string,
  hasRemoteMain: boolean,
  token: string | undefined,
): void => {
  if (hasRemoteMain) {
    git(worktree, ["checkout", "-B", "main", "refs/remotes/origin/main"], token);
    return;
  }
  git(worktree, ["checkout", "--orphan", "main"], token);
  for (const entry of readdirSync(worktree)) {
    if (entry === ".git") continue;
    rmSync(path.join(worktree, entry), { recursive: true, force: true });
  }
};

const replaceManagedPaths = (worktree: string, artifactDirectory: string): void => {
  for (const root of MANAGED_ROOTS) {
    const destination = path.join(worktree, root);
    rmSync(destination, { recursive: true, force: true });
    const source = path.join(artifactDirectory, root);
    const metadata = lstatSync(source);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Official Agent Skills artifact contains a symlink: ${root}`);
    }
    cpSync(source, destination, {
      recursive: metadata.isDirectory(),
      force: true,
      preserveTimestamps: false,
    });
  }
  const stagedArtifact = mkdtempSync(path.join(path.dirname(worktree), ".staged-artifact-"));
  try {
    for (const root of MANAGED_ROOTS) {
      cpSync(path.join(worktree, root), path.join(stagedArtifact, root), {
        recursive: root === "skills",
        force: true,
        preserveTimestamps: false,
      });
    }
    inspectOfficialAgentSkillsArtifact(stagedArtifact);
  } finally {
    rmSync(stagedArtifact, TEMPORARY_REMOVAL_OPTIONS);
  }
};

const commitMessage = (artifact: InspectedOfficialAgentSkillsArtifact): string =>
  [
    `release: Nodex Agent Skills v${artifact.releaseVersion}`,
    "",
    `Source: ${artifact.sourceRepository}@${artifact.sourceRef}`,
    `Skill tree SHA-256: ${artifact.treeSha256}`,
    `Release manifest SHA-256: ${artifact.manifestSha256}`,
  ].join("\n");

export function publishOfficialAgentSkills(options: PublishOptions): PublishResult {
  const artifact = validateRequestedArtifact(options);
  const remoteUrl = options.remoteUrl ?? DEFAULT_REMOTE;
  assertSafeRemote(remoteUrl);
  const token = options.token?.trim() || undefined;
  const tag = `v${artifact.releaseVersion}`;
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "nodex-skills-publish-"));
  const worktree = path.join(temporaryRoot, "mirror");
  try {
    git(temporaryRoot, ["clone", "--no-tags", remoteUrl, worktree], token);
    git(worktree, ["fetch", "--tags", "--force", "origin"], token);
    const hasRemoteMain = refExists(worktree, "refs/remotes/origin/main", token);
    initializeMainWorktree(worktree, hasRemoteMain, token);

    const remoteMain =
      hasRemoteMain && existsSync(path.join(worktree, "release-manifest.json"))
        ? inspectRef(worktree, "refs/remotes/origin/main", temporaryRoot, token)
        : null;
    if (remoteMain && compareVersions(remoteMain.releaseVersion, artifact.releaseVersion) > 0) {
      throw new Error(
        `Refusing to roll back public Agent Skills from ${remoteMain.releaseVersion} to ${artifact.releaseVersion}`,
      );
    }

    const tagRef = `refs/tags/${tag}`;
    const existingTag = refExists(worktree, tagRef, token)
      ? inspectRef(worktree, tagRef, temporaryRoot, token)
      : null;
    if (existingTag) assertSameArtifact(existingTag, artifact, `Tag ${tag}`);

    if (remoteMain?.releaseVersion === artifact.releaseVersion) {
      assertSameArtifact(remoteMain, artifact, "Remote main release");
      if (!existingTag) {
        throw new Error(`Remote main contains ${tag}, but its annotated tag is missing`);
      }
      const commit = git(worktree, ["rev-parse", `${tagRef}^{commit}`], token).stdout.trim();
      return {
        commit,
        manifestSha256: artifact.manifestSha256,
        status: "unchanged",
        tag,
        treeSha256: artifact.treeSha256,
        version: artifact.releaseVersion,
      };
    }
    if (existingTag) {
      throw new Error(`Tag ${tag} exists while remote main points at another release`);
    }

    replaceManagedPaths(worktree, path.resolve(options.artifactDirectory));
    git(worktree, ["add", "--all", "--", ...MANAGED_ROOTS], token);
    const message = commitMessage(artifact);
    git(worktree, ["commit", "-m", message], token);
    git(worktree, ["tag", "-a", tag, "-m", message], token);
    options.beforePush?.(worktree);
    git(
      worktree,
      ["push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}:refs/tags/${tag}`],
      token,
    );
    const commit = git(worktree, ["rev-parse", "HEAD"], token).stdout.trim();
    return {
      commit,
      manifestSha256: artifact.manifestSha256,
      status: "published",
      tag,
      treeSha256: artifact.treeSha256,
      version: artifact.releaseVersion,
    };
  } finally {
    rmSync(temporaryRoot, TEMPORARY_REMOVAL_OPTIONS);
  }
}

const readOption = (arguments_: readonly string[], option: string): string | null => {
  const index = arguments_.indexOf(option);
  if (index < 0) return null;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
};

const requiredOption = (arguments_: readonly string[], option: string): string => {
  const value = readOption(arguments_, option);
  if (!value) throw new Error(`Missing required ${option}`);
  return value;
};

const main = (): void => {
  const arguments_ = process.argv.slice(2);
  const result = publishOfficialAgentSkills({
    artifactDirectory: requiredOption(arguments_, "--artifact"),
    expectedManifestSha256: requiredOption(arguments_, "--manifest-sha256"),
    expectedSourceRef: requiredOption(arguments_, "--source-ref"),
    expectedSourceRepository: requiredOption(arguments_, "--source-repository"),
    expectedTreeSha256: requiredOption(arguments_, "--tree-sha256"),
    expectedVersion: requiredOption(arguments_, "--version"),
    remoteUrl: readOption(arguments_, "--remote") ?? undefined,
    token: resolveGithubToken(process.env.NODEX_SKILLS_GITHUB_TOKEN, process.env.GH_TOKEN),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
