import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const repositoryRoot = path.resolve(".");
const failures: string[] = [];

const read = (file: string): string => readFileSync(path.join(repositoryRoot, file), "utf8");

const assertAbsent = (file: string, forbidden: readonly RegExp[], label: string): void => {
  const content = read(file);
  for (const pattern of forbidden) {
    if (pattern.test(content)) failures.push(`${label}: ${file} matches ${pattern}`);
  }
};

const assertPresent = (file: string, required: readonly RegExp[], label: string): void => {
  const content = read(file);
  for (const pattern of required) {
    if (!pattern.test(content)) failures.push(`${label}: ${file} misses ${pattern}`);
  }
};

const sourceFiles = (directory: string, extensionPattern: RegExp = /\.rs$/): readonly string[] => {
  const entries = readdirSync(path.join(repositoryRoot, directory), {
    withFileTypes: true,
  });
  return entries.flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative, extensionPattern);
    return entry.isFile() && extensionPattern.test(entry.name) ? [relative] : [];
  });
};

assertAbsent(
  "crates/nodex-cli/Cargo.toml",
  [/\bnodex-core\s*=/, /\brusqlite\b/, /\byrs\b/],
  "native CLI must remain a protocol-only Adapter",
);
assertAbsent(
  "crates/nodex-core-protocol/Cargo.toml",
  [/\brusqlite\b/, /\byrs\b/],
  "protocol must not depend on store/document engines",
);

for (const moduleDirectory of [
  "administration",
  "automation",
  "database",
  "document",
  "library",
  "workspace",
]) {
  const directory = path.join(repositoryRoot, "crates/nodex-core/src", moduleDirectory);
  if (!statSync(directory).isDirectory()) {
    failures.push(`missing vertical Module directory: ${directory}`);
    continue;
  }
  for (const file of sourceFiles(path.join("crates/nodex-core/src", moduleDirectory))) {
    assertAbsent(
      file,
      [/\baxum\b/, /\bhyper\b/, /\bnodex_core_protocol\b/],
      "deep Module must not import an Adapter or transport",
    );
  }
}

for (const [file, contractVersion] of [
  ["crates/nodex-core/src/administration/mod.rs", "STORE_ADMINISTRATION_CONTRACT_VERSION"],
  ["crates/nodex-core/src/automation/mod.rs", "AUTOMATION_CONTRACT_VERSION"],
  ["crates/nodex-core/src/database/mod.rs", "DATABASE_CONTRACT_VERSION"],
  ["crates/nodex-core/src/document/module.rs", "OWNED_DOCUMENT_CONTRACT_VERSION"],
  ["crates/nodex-core/src/library/mod.rs", "LIBRARY_CONTRACT_VERSION"],
  ["crates/nodex-core/src/workspace/mod.rs", "PROJECT_WORKSPACE_CONTRACT_VERSION"],
] as const) {
  assertPresent(
    file,
    [
      new RegExp(`request\\.contract_version\\s*!=\\s*${contractVersion}`),
      new RegExp(`contract_version:\\s*${contractVersion}`),
    ],
    "each Core Module must enforce and emit its own contract version",
  );
}

for (const file of [
  ...sourceFiles("crates/nodex-core-contracts/src"),
  ...sourceFiles("crates/nodex-core/src"),
  ...sourceFiles("crates/nodex-core-server/src"),
  ...sourceFiles("src/main/core-client", /\.ts$/),
]) {
  assertAbsent(
    file,
    [/\bCORE_CONTRACT_VERSION\b/],
    "Core Modules must not collapse back onto one global contract version",
  );
}

for (const file of sourceFiles("crates/nodex-core-server/src")) {
  assertAbsent(file, [/\brusqlite\b/], "UDS routes must not import the SQLite implementation");
}

for (const file of sourceFiles("src/main/core-client", /\.ts$/)) {
  assertAbsent(
    file,
    [/\bbetter-sqlite3\b/, /\bgetDb\s*\(/, /local-store\//, /\bfetch\s*\(/],
    "Electron Core client must remain a generated-protocol UDS Adapter",
  );
}

const productionMainFiles = sourceFiles("src/main", /\.ts$/).filter(
  (file) => !/\.(?:test|integration)(?:\.[^.]+)?\.ts$/.test(file),
);
for (const file of productionMainFiles) {
  assertAbsent(
    file,
    [/\bbetter-sqlite3\b/, /from\s+["']yjs["']/, /\bthread_search(?:_|\b)/],
    "Desktop Host must not contain a retired SQLite, Yjs, or Thread-search authority",
  );
}

const productionMainBundlePromise = build({
  entryPoints: [path.join(repositoryRoot, "src/main/bootstrap.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  write: false,
  metafile: true,
  logLevel: "silent",
});
const retiredDocumentAuthorityInputs = [
  "document-operation-engine.ts",
  "block-document-codec.ts",
  "nfm-document-replacement.ts",
];
const auditProductionMainBundle = (
  productionMainBundle: Awaited<typeof productionMainBundlePromise>,
): void => {
  for (const [input, metadata] of Object.entries(productionMainBundle.metafile.inputs)) {
    const normalizedInput = input.replaceAll("\\", "/");
    for (const retiredInput of retiredDocumentAuthorityInputs) {
      if (normalizedInput.endsWith(`/${retiredInput}`)) {
        failures.push(
          `Desktop bootstrap transitively includes retired Document authority: ${input}`,
        );
      }
    }
    for (const imported of metadata.imports) {
      if (imported.path === "yjs" || imported.path.startsWith("yjs/")) {
        failures.push(`Desktop bootstrap transitively imports Yjs from ${input}`);
      }
    }
  }
};

for (const file of ["src/shared/ipc-api.ts"]) {
  assertAbsent(
    file,
    [/\bdb:(?:query|schema)\b/, /\/api\/db\/(?:query|schema)\b/],
    "Desktop renderer transport must not expose arbitrary SQL inspection",
  );
}

const retainedLocalStoreFiles = new Set([
  "ProfileAssets.ts",
  "assets.test.ts",
  "assets.ts",
  "codex-scheduled-automation-schedule.test.ts",
  "codex-scheduled-automation-schedule.ts",
  "managed-blob-path.node.test.ts",
  "managed-blob-path.ts",
  "notifier.test.ts",
  "notifier.ts",
  "persisted-atoms.test.ts",
  "persisted-atoms.ts",
  "store-maintenance-gate.test.ts",
  "store-maintenance-gate.ts",
]);
for (const entry of readdirSync(path.join(repositoryRoot, "src/main/local-store"))) {
  if (retainedLocalStoreFiles.has(entry)) continue;
  failures.push(`obsolete local-store authority remains: src/main/local-store/${entry}`);
}

const expectedRoutes = new Set([
  "/core/v1/admin/shutdown",
  "/core/v1/events",
  "/core/v1/handshake",
  "/core/v1/health",
  "/core/v1/local-mutations/resolve",
  // Page File metadata stays behind the Library Module. Exact bytes use these
  // separately bounded, authenticated streams so they never enter JSON commands.
  "/core/v1/page-files/blobs/prepare",
  "/core/v1/page-files/blobs/{file_id}",
  "/core/v1/requests/cancel",
  ...["administration", "automation", "database", "document", "library", "workspace"].flatMap(
    (module) => ["apply", "read"].map((operation) => `/core/v1/modules/${module}/${operation}`),
  ),
]);
interface OpenApiSchema {
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

const openApi = JSON.parse(read("packages/core-protocol/openapi.json")) as {
  readonly paths?: Readonly<Record<string, unknown>>;
  readonly components?: {
    readonly schemas?: Readonly<Record<string, OpenApiSchema>>;
  };
};
const actualRoutes = new Set(Object.keys(openApi.paths ?? {}));
for (const route of expectedRoutes) {
  if (!actualRoutes.has(route)) failures.push(`missing Core protocol route: ${route}`);
}
for (const route of actualRoutes) {
  if (!expectedRoutes.has(route)) failures.push(`forbidden Core protocol route: ${route}`);
}

const schemas = openApi.components?.schemas ?? {};
const moduleRequestSchemas = Object.entries(schemas).filter(([name]) =>
  /^Module(?:Read|Apply)Request_/.test(name),
);
if (moduleRequestSchemas.length !== 12) {
  failures.push(
    `generated Core protocol must expose 12 typed Module request schemas, found ${moduleRequestSchemas.length}`,
  );
}
for (const [name, schema] of moduleRequestSchemas) {
  const required = new Set(schema.required ?? []);
  const properties = new Set(Object.keys(schema.properties ?? {}));
  if (!required.has("contract_version") || !properties.has("contract_version")) {
    failures.push(`${name} does not require the Module-specific contract_version axis`);
  }
  if (properties.has("version")) {
    failures.push(`${name} exposes the retired ambiguous version field`);
  }
}

const compatibilityManifest = schemas.CoreCompatibilityManifest;
for (const axis of ["manifest_version", "transport", "event_versions", "modules", "store"]) {
  if (!compatibilityManifest?.required?.includes(axis)) {
    failures.push(`CoreCompatibilityManifest does not require ${axis}`);
  }
}

void productionMainBundlePromise.then((productionMainBundle) => {
  auditProductionMainBundle(productionMainBundle);
  if (failures.length > 0) {
    throw new Error(`Rust Core boundary audit failed:\n${failures.join("\n")}`);
  }

  console.log("Rust Core dependency boundaries: ok");
});
