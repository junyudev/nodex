import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { parseStylesheet } from "./parser";
import { collectSemanticMigrationViolations } from "./migration";
import { collectSemanticThemeIntegrityDiagnostics } from "./integrity";
import {
  COLLISION_RESOLUTIONS,
  SEMANTIC_THEME_EXCLUSIONS,
  MIGRATED_SURFACE_POLICIES,
  SEMANTIC_THEME_ARTIFACT_PATHS,
  SEMANTIC_THEME_GENERATOR_VERSION,
  SEMANTIC_THEME_PROFILE,
  SEMANTIC_THEME_REQUIRED_VARIABLES,
  SEMANTIC_THEME_RUNTIME_PROVIDERS,
  SEMANTIC_UTILITY_PROFILE,
} from "./profile";
import {
  createSemanticThemeProvenance,
  parseSemanticThemeProvenance,
  renderSemanticThemeProvenance,
  semanticThemeProfileSha256,
  sha256,
} from "./provenance";
import { renderSemanticThemeArtifacts } from "./renderer";
import type {
  SemanticThemeArtifact,
  SemanticThemeAuditChangeSet,
  SemanticThemeAuditReport,
  SemanticThemeCommand,
  SemanticThemeCommandResult,
  SemanticThemeDiagnostic,
  SemanticThemeGeneratedContract,
} from "./types";

interface SemanticThemeModuleOptions {
  readonly workspaceRoot?: string;
}

const diagnostic = (
  code: string,
  severity: SemanticThemeDiagnostic["severity"],
  message: string,
  subject?: string,
): SemanticThemeDiagnostic => ({ code, severity, message, ...(subject ? { subject } : {}) });

const artifactAbsolutePath = (workspaceRoot: string, path: string): string =>
  resolve(workspaceRoot, path);

const PROVIDER_PATHS = [
  "src/renderer/styles/theme-source.css",
  "src/renderer/styles/theme-token-bridge.css",
  "src/renderer/styles/theme-utilities.css",
  "src/renderer/styles/theme-surface.css",
] as const;

const INTEGRITY_OPTIONS = {
  collisionResolutions: COLLISION_RESOLUTIONS,
  requiredVariables: SEMANTIC_THEME_REQUIRED_VARIABLES,
  runtimeProviders: SEMANTIC_THEME_RUNTIME_PROVIDERS,
} as const;

const readSource = async (sourcePath: string): Promise<string> => {
  try {
    return await readFile(sourcePath, "utf8");
  } catch {
    throw new Error("THEME_SOURCE_UNREADABLE");
  }
};

const readCommittedArtifacts = async (
  workspaceRoot: string,
  paths: readonly string[],
): Promise<readonly SemanticThemeArtifact[]> =>
  Promise.all(
    paths.map(async (path) => ({
      path,
      content: await readFile(artifactAbsolutePath(workspaceRoot, path), "utf8"),
    })),
  );

const compareArtifacts = (
  expected: readonly SemanticThemeArtifact[],
  actual: readonly SemanticThemeArtifact[],
): readonly string[] => {
  const actualByPath = new Map(actual.map((artifact) => [artifact.path, artifact.content]));
  return expected
    .filter((artifact) => actualByPath.get(artifact.path) !== artifact.content)
    .map((artifact) => artifact.path)
    .sort();
};

const compareKeyedRecords = <T>(
  expected: readonly T[],
  actual: readonly T[],
  keyFor: (value: T) => string,
): SemanticThemeAuditChangeSet => {
  const expectedByKey = new Map(expected.map((value) => [keyFor(value), value]));
  const actualByKey = new Map(actual.map((value) => [keyFor(value), value]));
  return {
    added: [...expectedByKey.keys()].filter((key) => !actualByKey.has(key)).sort(),
    removed: [...actualByKey.keys()].filter((key) => !expectedByKey.has(key)).sort(),
    changed: [...expectedByKey.entries()]
      .filter(
        ([key, value]) =>
          actualByKey.has(key) && JSON.stringify(actualByKey.get(key)) !== JSON.stringify(value),
      )
      .map(([key]) => key)
      .sort(),
  };
};

const readGeneratedManifest = (
  artifacts: readonly SemanticThemeArtifact[],
): SemanticThemeGeneratedContract | null => {
  const content = artifacts.find(
    (artifact) => artifact.path === SEMANTIC_THEME_ARTIFACT_PATHS.manifest,
  )?.content;
  if (!content) return null;
  try {
    return JSON.parse(content) as SemanticThemeGeneratedContract;
  } catch {
    return null;
  }
};

const createAuditReport = (
  refVersion: string,
  expected: readonly SemanticThemeArtifact[],
  actual: readonly SemanticThemeArtifact[],
  changedArtifacts: readonly string[],
): SemanticThemeAuditReport => {
  const expectedManifest = readGeneratedManifest(expected);
  const actualManifest = readGeneratedManifest(actual);
  const expectedVariables = expectedManifest?.variables ?? [];
  const actualVariables = actualManifest?.variables ?? [];
  const expectedUtilities = expectedManifest?.utilities ?? [];
  const actualUtilities = actualManifest?.utilities ?? [];
  return {
    schemaVersion: 1,
    refVersion,
    artifacts: changedArtifacts,
    declarations: compareKeyedRecords(expectedVariables, actualVariables, ({ name }) => name),
    utilities: compareKeyedRecords(expectedUtilities, actualUtilities, ({ id }) => id),
    selectors: compareKeyedRecords(expectedUtilities, actualUtilities, ({ selector }) => selector),
    dependencies: compareKeyedRecords(
      expectedVariables.map(({ name, dependencies }) => ({ name, dependencies })),
      actualVariables.map(({ name, dependencies }) => ({ name, dependencies })),
      ({ name }) => name,
    ),
    collisionResolutions: Object.keys(COLLISION_RESOLUTIONS).sort(),
    exclusions: SEMANTIC_THEME_EXCLUSIONS,
  };
};

const writeArtifactsAtomically = async (
  workspaceRoot: string,
  artifacts: readonly SemanticThemeArtifact[],
): Promise<void> => {
  const transactionId = randomUUID();
  const temporaryPaths = new Map<string, string>();
  const previous = new Map<string, string | null>();
  const replaced: string[] = [];

  try {
    for (const artifact of artifacts) {
      const target = artifactAbsolutePath(workspaceRoot, artifact.path);
      await mkdir(dirname(target), { recursive: true });
      try {
        previous.set(target, await readFile(target, "utf8"));
      } catch {
        previous.set(target, null);
      }
      const temporary = `${target}.${transactionId}.tmp`;
      temporaryPaths.set(target, temporary);
      await writeFile(temporary, artifact.content, { encoding: "utf8", flag: "wx" });
      if ((await readFile(temporary, "utf8")) !== artifact.content) {
        throw new Error("THEME_ARTIFACT_WRITE_INVALID");
      }
    }

    for (const artifact of artifacts) {
      const target = artifactAbsolutePath(workspaceRoot, artifact.path);
      const temporary = temporaryPaths.get(target);
      if (!temporary) throw new Error("THEME_ARTIFACT_WRITE_INVALID");
      await rename(temporary, target);
      replaced.push(target);
    }
  } catch (error) {
    for (const target of replaced.reverse()) {
      const content = previous.get(target);
      if (content === null) {
        await unlink(target).catch(() => undefined);
      } else if (typeof content === "string") {
        await writeFile(target, content, "utf8").catch(() => undefined);
      }
    }
    for (const temporary of temporaryPaths.values()) {
      await unlink(temporary).catch(() => undefined);
    }
    throw error;
  }
};

const generateArtifacts = (
  sourceCss: string,
  refVersion: string,
): readonly SemanticThemeArtifact[] => {
  const generated = renderSemanticThemeArtifacts(sourceCss, refVersion);
  const provenance = createSemanticThemeProvenance(refVersion, generated);
  return [
    ...generated,
    {
      path: SEMANTIC_THEME_ARTIFACT_PATHS.provenance,
      content: renderSemanticThemeProvenance(provenance),
    },
  ];
};

const verifySourceFree = async (workspaceRoot: string): Promise<SemanticThemeCommandResult> => {
  const diagnostics: SemanticThemeDiagnostic[] = [];
  let provenance;
  try {
    provenance = parseSemanticThemeProvenance(
      await readFile(
        artifactAbsolutePath(workspaceRoot, SEMANTIC_THEME_ARTIFACT_PATHS.provenance),
        "utf8",
      ),
    );
  } catch {
    return {
      ok: false,
      mode: "verify-source-free",
      diagnostics: [
        diagnostic(
          "THEME_PROVENANCE_INVALID",
          "error",
          "Semantic theme provenance is missing or invalid.",
        ),
      ],
      changedArtifacts: [],
    };
  }

  if (provenance.profileSha256 !== semanticThemeProfileSha256()) {
    diagnostics.push(
      diagnostic(
        "THEME_PROFILE_STALE",
        "error",
        "The semantic theme profile changed without regenerating artifacts.",
      ),
    );
  }
  if (provenance.generatorVersion !== SEMANTIC_THEME_GENERATOR_VERSION) {
    diagnostics.push(
      diagnostic(
        "THEME_GENERATOR_VERSION_MISMATCH",
        "error",
        "The semantic theme generator version does not match provenance.",
      ),
    );
  }

  const artifacts: SemanticThemeArtifact[] = [];
  for (const identity of provenance.artifacts) {
    try {
      const content = await readFile(artifactAbsolutePath(workspaceRoot, identity.path), "utf8");
      artifacts.push({ path: identity.path, content });
      if (sha256(content) !== identity.sha256) {
        diagnostics.push(
          diagnostic(
            "THEME_ARTIFACT_DRIFT",
            "error",
            "A generated semantic theme artifact differs from provenance.",
            identity.path,
          ),
        );
      }
      if (identity.path.endsWith(".css")) parseStylesheet(content);
    } catch {
      diagnostics.push(
        diagnostic(
          "THEME_ARTIFACT_INVALID",
          "error",
          "A generated semantic theme artifact is missing or invalid.",
          identity.path,
        ),
      );
    }
  }

  const utilities =
    artifacts.find((artifact) => artifact.path === SEMANTIC_THEME_ARTIFACT_PATHS.utilities)
      ?.content ?? "";
  for (const utility of SEMANTIC_UTILITY_PROFILE) {
    const selector = utility.outputSelector ?? utility.selector;
    if (!utilities.includes(selector)) {
      diagnostics.push(
        diagnostic(
          "THEME_UTILITY_MISSING",
          "error",
          "A required semantic utility is missing.",
          selector,
        ),
      );
    }
  }

  const providers = await readCommittedArtifacts(workspaceRoot, PROVIDER_PATHS);
  diagnostics.push(
    ...collectSemanticThemeIntegrityDiagnostics(artifacts, providers, INTEGRITY_OPTIONS),
  );

  for (const policy of MIGRATED_SURFACE_POLICIES) {
    const sourceText = await readFile(artifactAbsolutePath(workspaceRoot, policy.path), "utf8");
    for (const violation of collectSemanticMigrationViolations(sourceText, policy)) {
      diagnostics.push(
        diagnostic(
          "THEME_MIGRATION_REGRESSION",
          "error",
          "A migrated surface reintroduced a deprecated visual token.",
          `${policy.path}:${violation.line}:${violation.column} ${violation.className}`,
        ),
      );
    }
  }

  return {
    ok: diagnostics.every((item) => item.severity !== "error"),
    mode: "verify-source-free",
    diagnostics,
    changedArtifacts: [],
  };
};

const verifyWithSource = async (
  workspaceRoot: string,
  sourcePath: string,
): Promise<SemanticThemeCommandResult> => {
  const sourceFree = await verifySourceFree(workspaceRoot);
  if (!sourceFree.ok) {
    return { ...sourceFree, mode: "verify-source-aware" };
  }
  const provenance = parseSemanticThemeProvenance(
    await readFile(
      artifactAbsolutePath(workspaceRoot, SEMANTIC_THEME_ARTIFACT_PATHS.provenance),
      "utf8",
    ),
  );
  const expected = generateArtifacts(await readSource(sourcePath), provenance.refVersion);
  const expectedIntegrityDiagnostics = collectSemanticThemeIntegrityDiagnostics(
    expected,
    await readCommittedArtifacts(workspaceRoot, PROVIDER_PATHS),
    INTEGRITY_OPTIONS,
  );
  if (expectedIntegrityDiagnostics.length > 0) {
    return {
      ok: false,
      mode: "verify-source-aware",
      diagnostics: expectedIntegrityDiagnostics,
      changedArtifacts: [],
    };
  }
  const actual = await readCommittedArtifacts(
    workspaceRoot,
    expected.map((item) => item.path),
  );
  const changedArtifacts = compareArtifacts(expected, actual);
  return {
    ok: changedArtifacts.length === 0,
    mode: "verify-source-aware",
    diagnostics:
      changedArtifacts.length === 0
        ? []
        : [
            diagnostic(
              "THEME_CONTRACT_DIFF",
              "error",
              "The supplied reference does not reproduce the committed semantic theme contract. Run audit before sync.",
            ),
          ],
    changedArtifacts,
  };
};

const findLatestBuildCss = async (workspaceRoot: string): Promise<string> => {
  const assetsDirectory = resolve(workspaceRoot, "out/renderer/assets");
  const candidates = await Promise.all(
    (await readdir(assetsDirectory))
      .filter((name) => /^globals-.*\.css$/.test(name))
      .map(async (name) => {
        const path = resolve(assetsDirectory, name);
        return { path, modifiedAt: (await stat(path)).mtimeMs };
      }),
  );
  const latest = candidates.sort((left, right) => left.modifiedAt - right.modifiedAt).at(-1);
  if (!latest) throw new Error("THEME_BUILD_ARTIFACT_MISSING");
  return latest.path;
};

const verifyBuild = async (
  workspaceRoot: string,
  buildCssPath?: string,
): Promise<SemanticThemeCommandResult> => {
  try {
    const css = await readFile(buildCssPath ?? (await findLatestBuildCss(workspaceRoot)), "utf8");
    const missing = SEMANTIC_UTILITY_PROFILE.map(
      (utility) => utility.outputSelector ?? utility.selector,
    ).filter((selector) => !css.includes(selector.replaceAll("\\", "")) && !css.includes(selector));
    const diagnostics = [
      ...missing.map((selector) =>
        diagnostic(
          "THEME_BUILD_UTILITY_MISSING",
          "error",
          "A required semantic utility is absent from the renderer build.",
          selector,
        ),
      ),
      ...collectSemanticThemeIntegrityDiagnostics(
        [{ path: "renderer-build.css", content: css }],
        [],
        INTEGRITY_OPTIONS,
      ),
    ];
    return {
      ok: diagnostics.length === 0,
      mode: "verify-build",
      diagnostics,
      changedArtifacts: [],
    };
  } catch {
    return {
      ok: false,
      mode: "verify-build",
      diagnostics: [
        diagnostic(
          "THEME_BUILD_ARTIFACT_MISSING",
          "error",
          "No renderer CSS build artifact is available to verify.",
        ),
      ],
      changedArtifacts: [],
    };
  }
};

export const executeSemanticThemeCommand = async (
  command: SemanticThemeCommand,
  options: SemanticThemeModuleOptions = {},
): Promise<SemanticThemeCommandResult> => {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  if (command.kind === "verify-build") {
    return verifyBuild(workspaceRoot, command.buildCssPath);
  }
  if (command.kind === "verify") {
    return command.sourcePath
      ? verifyWithSource(workspaceRoot, command.sourcePath)
      : verifySourceFree(workspaceRoot);
  }

  const sourceCss = await readSource(command.sourcePath);
  const expected = generateArtifacts(sourceCss, command.refVersion);
  const integrityDiagnostics = collectSemanticThemeIntegrityDiagnostics(
    expected,
    await readCommittedArtifacts(workspaceRoot, PROVIDER_PATHS),
    INTEGRITY_OPTIONS,
  );
  if (integrityDiagnostics.length > 0) {
    return {
      ok: false,
      mode: command.kind,
      diagnostics: integrityDiagnostics,
      changedArtifacts: [],
    };
  }
  let actual: readonly SemanticThemeArtifact[] = [];
  try {
    actual = await readCommittedArtifacts(
      workspaceRoot,
      expected.map((item) => item.path),
    );
  } catch {
    // A first sync legitimately has no committed neutral artifacts yet.
  }
  const changedArtifacts = compareArtifacts(expected, actual);

  if (command.kind === "audit") {
    return {
      ok: true,
      mode: "audit",
      diagnostics: [
        diagnostic(
          "THEME_AUDIT_COMPLETE",
          "info",
          changedArtifacts.length === 0
            ? "The supplied reference matches the committed semantic theme contract."
            : "The supplied reference changes the semantic theme contract.",
        ),
      ],
      changedArtifacts,
      auditReport: createAuditReport(command.refVersion, expected, actual, changedArtifacts),
    };
  }

  await writeArtifactsAtomically(workspaceRoot, expected);
  return {
    ok: true,
    mode: "sync",
    diagnostics: [
      diagnostic(
        "THEME_SYNC_COMPLETE",
        "info",
        "Semantic theme artifacts were regenerated atomically.",
      ),
    ],
    changedArtifacts,
  };
};

export const semanticThemeModuleProfile = SEMANTIC_THEME_PROFILE;

export const assertSemanticThemeSourceReadable = async (sourcePath: string): Promise<void> => {
  await access(sourcePath);
};

export const semanticThemeArtifactLabel = (path: string): string => basename(path);
