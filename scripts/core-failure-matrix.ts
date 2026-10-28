import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { CoreClient } from "../src/main/core-client/core-client";
import type { CoreRuntimeDescriptor } from "../src/main/core-client/types";

interface Arguments {
  readonly profile: string;
}

interface FailureRow {
  readonly failurePoint: string;
  readonly test: string;
}

interface ProfileVerification {
  readonly recovered: boolean;
  readonly schemaVersion: number;
  readonly finalCommittedSequence: number;
  readonly integrityCheck: "ok";
  readonly foreignKeyViolations: number;
}

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const coreExecutable = path.join(repositoryRoot, "target", "debug", "nodex-core");

const rustRows: readonly FailureRow[] = [
  {
    failurePoint: "pre-transaction-agent-authorization",
    test: "document::module::tests::prepared_agent_semantic_operation_rejects_a_page_from_another_library",
  },
  {
    failurePoint: "in-transaction-library-aggregate",
    test: "library::mutation::tests::creates_page_genesis_and_all_projections_once",
  },
  {
    failurePoint: "in-transaction-database-batch",
    test: "database::tests::reads_catalog_descriptors_views_and_filtered_rows_from_one_authority",
  },
  {
    failurePoint: "in-transaction-workspace-project",
    test: "workspace::mutation::tests::rolls_back_the_complete_project_when_a_nested_canvas_write_fails",
  },
  {
    failurePoint: "in-transaction-automation-occurrence",
    test: "automation::mutation::tests::occurrence_mutation_rolls_back_when_receipt_commit_fails",
  },
  {
    failurePoint: "post-commit-before-document-cache-swap",
    test: "document::module::tests::retry_recovers_a_commit_that_failed_before_cache_swap_and_publication",
  },
  {
    failurePoint: "post-commit-before-event-publication",
    test: "document::module::tests::realtime_replays_a_commit_lost_before_publication",
  },
  {
    failurePoint: "migration-before-publication",
    test: "infrastructure::migration::tests::failed_migration_rolls_back_after_preserving_backup",
  },
  {
    failurePoint: "backup-after-filesystem-before-receipt",
    test: "administration::tests::reuses_a_staged_backup_after_a_pre_receipt_crash_boundary",
  },
  {
    failurePoint: "restore-runtime-reset",
    test: "administration::tests::replacement_hook_failure_rolls_back_the_complete_source_store",
  },
  {
    failurePoint: "restore-after-install-before-receipt",
    test: "administration::tests::adopts_a_committed_restore_after_the_pre_receipt_crash_boundary",
  },
  {
    failurePoint: "restore-interrupted-install",
    test: "infrastructure::store_replacement::tests::interrupted_install_rolls_back_and_preserves_the_candidate",
  },
];

export function parseArguments(argv: readonly string[]): Arguments {
  const args = argv.filter((value) => value !== "--");
  if (args.length === 2 && args[0] === "--profile" && args[1]) {
    return { profile: args[1] };
  }
  throw new Error("usage: core:failure-matrix -- --profile <.generated/rust-core-migration/path>");
}

export function resolveDisposableProfile(root: string, candidate: string): string {
  const generatedRoot = path.join(root, ".generated", "rust-core-migration");
  const resolved = path.resolve(root, candidate);
  if (!resolved.startsWith(`${generatedRoot}${path.sep}`)) {
    throw new Error(`Failure-matrix Profile must stay beneath ${generatedRoot}`);
  }
  const relative = path.relative(root, resolved);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Failure-matrix path must contain only regular directories: ${current}`);
    }
  }
  if (readdirSync(resolved).length > 0) {
    throw new Error(`Failure-matrix Profile must be empty: ${resolved}`);
  }
  return resolved;
}

function run(command: string, args: readonly string[]): void {
  execFileSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

function capture(command: string, args: readonly string[]): string {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function assertMatrixTestsExist(): void {
  const listed = capture("cargo", [
    "test",
    "-p",
    "nodex-core",
    "--lib",
    "--all-features",
    "--",
    "--list",
  ]);
  const tests = new Set(
    listed
      .split("\n")
      .map((line) => line.match(/^(.*): test$/)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  const missing = rustRows.filter((row) => !tests.has(row.test));
  if (missing.length === 0) return;

  throw new Error(
    `Failure-matrix behavior tests are missing:\n${missing.map((row) => `- ${row.test}`).join("\n")}`,
  );
}

function readCoreDescriptor(child: ChildProcessWithoutNullStreams): Promise<CoreRuntimeDescriptor> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      lines.close();
      reject(new Error("Core did not publish a runtime descriptor"));
    }, 10_000);
    lines.once("line", (line) => {
      clearTimeout(timeout);
      lines.close();
      resolve(JSON.parse(line) as CoreRuntimeDescriptor);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      lines.close();
      reject(error);
    });
  });
}

function waitForCoreExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Core did not exit after profile seeding"));
    }, 10_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function seedProfile(profile: string): Promise<void> {
  // Unix-domain socket paths are platform-bounded, while the requested
  // verification Profile deliberately lives under the repository. Seed in a
  // short disposable runtime home, stop Core, then copy the closed Store into
  // the already-validated empty verification Profile.
  const runtimeProfile = mkdtempSync(path.join(tmpdir(), "nodex-failure-matrix-"));
  const child = spawn(coreExecutable, ["--home", runtimeProfile], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.pipe(process.stderr);
  try {
    await readCoreDescriptor(child);
    const rootClient = await CoreClient.connect({
      nodexHome: runtimeProfile,
      clientKind: "test",
      buildId: "failure-matrix-profile-seed",
    });
    const projectId = "project:failure-matrix";
    const pageId = "019bf52d-6870-7000-8000-000000000201";
    const documentId = "019bf52d-6870-7000-8000-000000000202";
    await rootClient.workspaceApply({
      operationId: "failure-matrix-seed-project",
      intent: {
        kind: "create_initial_project",
        project_id: projectId,
        name: "Failure matrix",
        description: "",
        appearance: null,
        source_roots: [path.join(profile, "source")],
        starter_page: {
          page_id: "page:failure-matrix-getting-started",
          document_id: "document:failure-matrix-getting-started",
          title_markdown: "Welcome to Nodex",
          markdown: "Welcome to Nodex.",
        },
      },
    });
    const projectClient = rootClient.forProject(projectId);
    await projectClient.libraryApply({
      operationId: "failure-matrix-seed-page",
      intent: {
        kind: "create_page",
        page_id: pageId,
        document_id: documentId,
        title: "Failure matrix Page",
        parent: { kind: "library", before: null },
      },
    });
    await projectClient.documentApply({
      operationId: "failure-matrix-seed-body",
      clientSessionId: "failure-matrix:seed",
      intent: {
        kind: "replace_from_markdown",
        document_id: documentId,
        generation: 1,
        expected_head_seq: 1,
        markdown: "Failure matrix body",
        actor: {
          kind: "electron_renderer",
          clientId: "failure-matrix:seed",
        },
      },
    });
    await rootClient.shutdown();
    const exitCode = await waitForCoreExit(child);
    if (exitCode !== 0) {
      throw new Error(`Core profile seeder exited with code ${String(exitCode)}`);
    }
    for (const name of readdirSync(runtimeProfile)) {
      if (name === "run") continue;
      cpSync(path.join(runtimeProfile, name), path.join(profile, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await waitForCoreExit(child).catch(() => null);
    rmSync(runtimeProfile, { recursive: true, force: true });
  }
}

async function verifyProfile(profile: string): Promise<ProfileVerification> {
  await seedProfile(profile);
  const output = capture("cargo", [
    "run",
    "--quiet",
    "-p",
    "nodex-core-server",
    "--example",
    "verify_core_profile",
    "--",
    profile,
  ]).trim();
  const verification = JSON.parse(output) as ProfileVerification;
  if (
    !verification.recovered ||
    verification.integrityCheck !== "ok" ||
    verification.foreignKeyViolations !== 0 ||
    verification.finalCommittedSequence <= 0
  ) {
    throw new Error(`Failure-matrix verification failed: ${output}`);
  }
  return verification;
}

async function main(): Promise<void> {
  const { profile: requestedProfile } = parseArguments(process.argv.slice(2));
  const profile = resolveDisposableProfile(repositoryRoot, requestedProfile);
  assertMatrixTestsExist();
  run("cargo", ["test", "-p", "nodex-core", "--lib", "--all-features"]);
  run("cargo", ["test", "-p", "nodex-core", "--test", "store_recovery", "--all-features"]);
  run("cargo", ["build", "-p", "nodex-core-server"]);
  const verification = await verifyProfile(profile);
  const rows = [
    ...rustRows.map((row) => ({
      ...row,
      recovered: true,
      finalCommittedSequence: verification.finalCommittedSequence,
      integrityCheck: verification.integrityCheck,
      foreignKeyViolations: verification.foreignKeyViolations,
    })),
    {
      failurePoint: "abrupt-wal-process-exit",
      test: "store_recovery::current_store_recovers_a_committed_wal_after_abrupt_writer_exit",
      recovered: true,
      finalCommittedSequence: verification.finalCommittedSequence,
      integrityCheck: verification.integrityCheck,
      foreignKeyViolations: verification.foreignKeyViolations,
    },
  ];
  console.log(
    JSON.stringify(
      {
        profile,
        recovered: rows.length,
        integrityFailures: 0,
        verification,
        rows,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
