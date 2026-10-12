import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Y from "yjs";

import { removePrivateTemporaryDirectory } from "../../scripts/verify-native-runtime";
import { initializeStandaloneDataAuthority } from "./core-client/standalone-data-authority";
import type { RustDataAuthorityRuntime } from "./core-client/desktop-data-authority";
import { createCoreDocumentSyncAdapter } from "./core-client/document-sync-adapter";
import { makeDesktopDocumentSessionHarness } from "./core-client/testing/desktop-document-session-harness.test-support";
import type { CoreEventEnvelope } from "./core-client/types";
import { NodexYProvider } from "../renderer/lib/nodex-y-provider";

const execFileAsync = promisify(execFile);
const packagedCli = process.env.NODEX_PACKAGED_CLI
  ? path.resolve(process.env.NODEX_PACKAGED_CLI)
  : null;
const temporaryDirectories: string[] = [];

type JsonObject = Record<string, unknown>;

interface CliEnvelope<T> {
  readonly version: number;
  readonly ok: true;
  readonly result: T;
}

const waitUntil = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
};

const cliEnvironment = (home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  NODEX_HOME: home,
  ...extra,
});

const runCli = async <T>(
  home: string,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<CliEnvelope<T>> => {
  if (!packagedCli) throw new Error("NODEX_PACKAGED_CLI is required");
  const { stdout } = await execFileAsync(packagedCli, ["--json", ...args], {
    encoding: "utf8",
    env: cliEnvironment(home, extraEnvironment),
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as CliEnvelope<T>;
};

const runCliText = async (home: string, args: readonly string[]): Promise<string> => {
  if (!packagedCli) throw new Error("NODEX_PACKAGED_CLI is required");
  const { stdout } = await execFileAsync(packagedCli, [...args], {
    encoding: "utf8",
    env: cliEnvironment(home),
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

const commandResult = (value: unknown): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("native CLI result is not an object");
  }
  return value as JsonObject;
};

const stringField = (value: JsonObject, key: string): string => {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`native CLI result omitted ${key}`);
  }
  return field;
};

const readRuntimePid = (home: string): number => {
  const descriptor = JSON.parse(readFileSync(path.join(home, "run/core/core.json"), "utf8")) as {
    pid?: unknown;
  };
  if (typeof descriptor.pid !== "number") {
    throw new Error("Core runtime descriptor omitted its PID");
  }
  return descriptor.pid;
};

afterEach(() => {
  delete process.env.NODEX_CORE_EXECUTABLE;
  delete process.env.NODEX_HOME;
  for (const directory of temporaryDirectories.splice(0)) {
    removePrivateTemporaryDirectory(directory);
  }
});

describe.skipIf(!packagedCli)("packaged native CLI and Electron authority", () => {
  test("share one cold-started Core and converge semantic edits without database access", async () => {
    if (!packagedCli) throw new Error("NODEX_PACKAGED_CLI is required");
    expect(process.versions.electron).toBeTruthy();
    expect(existsSync(packagedCli)).toBe(true);
    const packagedBin = path.dirname(packagedCli);
    const packagedCore = path.join(packagedBin, "nodex-core");
    const packagedRipgrep = path.resolve(packagedBin, "..", "codex-path", "rg");
    expect(existsSync(packagedCore)).toBe(true);
    expect(existsSync(packagedRipgrep)).toBe(true);
    const linkage = execFileSync("/usr/bin/otool", ["-L", packagedCli], {
      encoding: "utf8",
    }).toLowerCase();
    expect(linkage).not.toContain("sqlite");
    expect(linkage).not.toContain("better-sqlite3");

    const home = mkdtempSync(path.join(tmpdir(), "nodex-packaged-cli-electron-"));
    temporaryDirectories.push(home);
    const bodyFile = path.join(home, "initial-body.nested.md");
    writeFileSync(bodyFile, "Cold CLI body\n", { encoding: "utf8", mode: 0o600 });

    let runtime: RustDataAuthorityRuntime | null = null;
    let eventSubscription: { close(): void } | null = null;
    let provider: NodexYProvider | null = null;
    let document: Y.Doc | null = null;
    let documentScope: Scope.Closeable | null = null;
    try {
      const capabilities = commandResult((await runCli<JsonObject>(home, ["capabilities"])).result);
      const bundle = commandResult(capabilities.bundle);
      const commands = commandResult(capabilities.commands);
      expect(commands.skills).toBe(1);
      expect(bundle.status).toBe("available");
      expect(stringField(bundle, "releaseVersion")).toMatch(/^\d+\.\d+\.\d+/u);
      expect(stringField(bundle, "treeSha256")).toMatch(/^[a-f0-9]{64}$/u);

      const coldDoctor = await runCli<JsonObject>(home, ["doctor"]);
      expect(coldDoctor.ok).toBe(true);
      const coldCorePid = readRuntimePid(home);

      process.env.NODEX_CORE_EXECUTABLE = packagedCore;
      process.env.NODEX_HOME = home;
      const selected = await initializeStandaloneDataAuthority({
        appResourcesPath: path.resolve(packagedBin, ".."),
        buildId: "packaged-native-cli-electron-acceptance",
        isPackaged: true,
        nodexHome: home,
      });
      expect(selected.backend).toBe("rust");
      if (selected.backend !== "rust") throw new Error("Expected Rust authority");
      runtime = selected;
      expect(runtime.rootClient.handshake.generation.pid).toBe(coldCorePid);

      const projects = await runtime.rootClient.workspaceRead({
        kind: "project_window",
        include_archived: false,
        window: { first: 50 },
      });
      if (projects.value.kind !== "project_window") {
        throw new Error("Core did not return a Workspace Project window");
      }
      const project = projects.value.projects.items[0];
      if (!project) throw new Error("fresh Profile has no default Project");
      const defaultViewId = project.default_database_view_id;
      if (!defaultViewId) throw new Error("fresh Project has no default database View");
      const databasePath = path.join(home, "nodex.db");
      const electronFiles = execFileSync(
        "/usr/sbin/lsof",
        ["-a", "-p", String(process.pid), "-Fn"],
        { encoding: "utf8" },
      );
      expect(electronFiles).not.toContain(databasePath);

      const coreEvents: CoreEventEnvelope[] = [];
      eventSubscription = await runtime.rootClient.openEventStream(
        runtime.rootClient.handshake.commit_head,
        (event) => coreEvents.push(event),
        () => undefined,
      );
      const createdEnvelope = await runCli<JsonObject>(home, [
        "--project",
        project.id,
        "page",
        "create",
        "--parent",
        "library",
        "--title",
        "CLI Electron Page",
        "--file",
        bodyFile,
        "--idempotency-key",
        "packaged-cli-create-page",
      ]);
      const created = commandResult(createdEnvelope.result);
      const pageId = stringField(created, "page_id");
      const documentId = stringField(created, "document_id");
      await waitUntil(
        () =>
          coreEvents.some(
            (event) => event.packet.manifest.operation_id === "packaged-cli-create-page",
          ),
        "Electron did not observe the CLI Page creation event",
      );

      const databasePage = commandResult(
        (
          await runCli<JsonObject>(home, [
            "--project",
            project.id,
            "page",
            "create",
            "--parent",
            "database",
            "--view",
            `@${defaultViewId}`,
            "--title",
            "Packaged Board acceptance",
            "--file",
            bodyFile,
            "--idempotency-key",
            "packaged-cli-create-database-page",
          ])
        ).result,
      );
      const databasePageId = stringField(databasePage, "page_id");
      const queriedView = commandResult(
        (
          await runCli<JsonObject>(home, [
            "--project",
            project.id,
            "view",
            "query",
            `@${defaultViewId}`,
            "--limit",
            "50",
          ])
        ).result,
      );
      const rows = queriedView.rows;
      if (!Array.isArray(rows)) throw new Error("View query omitted rows");
      const databaseRow = rows.find(
        (row): row is JsonObject =>
          Boolean(row) &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          (row as JsonObject).pageId === databasePageId,
      );
      if (!databaseRow) throw new Error("View query omitted the created database Page");
      const moveEtag = stringField(commandResult(databaseRow.etags), "move");
      const movedPage = commandResult(
        (
          await runCli<JsonObject>(home, [
            "--project",
            project.id,
            "page",
            "move",
            `@${databasePageId}`,
            "--to",
            "database",
            "--view",
            `@${defaultViewId}`,
            "--at",
            "start",
            "--if-match",
            moveEtag,
            "--idempotency-key",
            "packaged-cli-guarded-view-move",
          ])
        ).result,
      );
      expect(movedPage.duplicate).toBe(false);

      const body = await runCliText(home, ["--project", project.id, "read", `@${pageId}`]);
      expect(body).toBe("Cold CLI body\n");
      await expect(
        runCliText(home, ["--project", project.id, "sed", "-n", "1p", `@${pageId}`]),
      ).resolves.toBe("Cold CLI body\n");

      const projected = await runtime.rootClient.libraryRead({
        kind: "page_projection_file",
        page_id: pageId,
        file_kind: "body_nested_markdown",
        prepare: null,
      });
      if (projected.value.kind !== "page_projection_file") {
        throw new Error("Electron did not receive the Page file projection");
      }
      expect(projected.value.value.content).toBe(body);
      expect(projected.value.value.document_id).toBe(documentId);

      const documents = createCoreDocumentSyncAdapter(runtime.rootClient);
      const preparedOwner = await documents.prepareOwner({
        ownerBlockId: pageId,
        operationId: "packaged-cli-electron-owner-prepare",
        clientSessionId: "renderer:packaged-cli-electron",
      });
      if (!preparedOwner.ok) {
        throw new Error(
          `Page Document preparation failed: ${preparedOwner.error.code}: ${preparedOwner.error.message}`,
        );
      }
      document = new Y.Doc({ guid: documentId });
      documentScope = await Effect.runPromise(Scope.make());
      const rendererDocumentAdapter = await Effect.runPromise(
        makeDesktopDocumentSessionHarness(runtime.rootClient, {
          kind: "project",
          projectId: project.id,
        }).pipe(Effect.provideService(Scope.Scope, documentScope)),
      );
      provider = new NodexYProvider({
        documentId,
        document,
        adapter: rendererDocumentAdapter,
        clientSessionId: "renderer:packaged-cli-electron",
        autoConnect: false,
        localCheckpointStore: null,
      });
      await provider.connect();
      expect(document.getText("title").toString()).toBe("CLI Electron Page");

      const preparedTitle = await runCli<JsonObject>(home, [
        "--project",
        project.id,
        "read",
        `@${pageId}`,
        "--meta",
        "--prepare",
        "title.set",
      ]);
      const preparedTitleResult = commandResult(preparedTitle.result);
      const validators = commandResult(preparedTitleResult.validators);
      const titleEtag = stringField(validators, "title_etag");
      const titleSetArgs = [
        "--project",
        project.id,
        "page",
        "title",
        "set",
        `@${pageId}`,
        "--if-match",
        titleEtag,
        "--value",
        "CLI live update",
        "--idempotency-key",
        "packaged-cli-title-live-update",
      ] as const;
      const firstTitle = commandResult((await runCli<JsonObject>(home, titleSetArgs)).result);
      expect(firstTitle.duplicate).toBe(false);
      await waitUntil(
        () => document?.getText("title").toString() === "CLI live update",
        "the connected Electron Document provider did not receive the CLI mutation",
      );
      const retriedTitle = commandResult((await runCli<JsonObject>(home, titleSetArgs)).result);
      expect(retriedTitle.duplicate).toBe(true);
      await waitUntil(
        () =>
          coreEvents.some(
            (event) => event.packet.manifest.operation_id === "packaged-cli-title-live-update",
          ),
        "Electron did not observe the CLI title event",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        coreEvents.filter(
          (event) => event.packet.manifest.operation_id === "packaged-cli-title-live-update",
        ),
      ).toHaveLength(1);

      document.transact(() => {
        const title = document?.getText("title");
        if (!title) return;
        title.delete(0, title.length);
        title.insert(0, "Electron live update");
      });
      await provider.flush();
      const electronMeta = commandResult(
        (await runCli<JsonObject>(home, ["--project", project.id, "read", `@${pageId}`, "--meta"]))
          .result,
      );
      expect(stringField(electronMeta, "content")).toContain('title: "Electron live update"');

      const concurrentFragment = path.join(home, "concurrent-fragment.nested.md");
      writeFileSync(concurrentFragment, "CLI concurrent body\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      document.transact(() => {
        const title = document?.getText("title");
        if (!title) return;
        title.delete(0, title.length);
        title.insert(0, "Electron concurrent title");
      });
      const [, concurrentInsert] = await Promise.all([
        provider.flush(),
        runCli<JsonObject>(home, [
          "--project",
          project.id,
          "page",
          "insert",
          `@${pageId}`,
          "--at",
          "end",
          "--file",
          concurrentFragment,
          "--idempotency-key",
          "packaged-cli-concurrent-body",
        ]),
      ]);
      expect(commandResult(concurrentInsert.result).duplicate).toBe(false);
      await waitUntil(
        () => document?.getText("title").toString() === "Electron concurrent title",
        "the unrelated concurrent renderer title was lost",
      );
      await expect(
        runCliText(home, ["--project", project.id, "read", `@${pageId}`]),
      ).resolves.toContain("CLI concurrent body");

      const staleTitleProjection = commandResult(
        (
          await runCli<JsonObject>(home, [
            "--project",
            project.id,
            "read",
            `@${pageId}`,
            "--meta",
            "--prepare",
            "title.set",
          ])
        ).result,
      );
      const staleTitleEtag = stringField(
        commandResult(staleTitleProjection.validators),
        "title_etag",
      );
      document.transact(() => {
        const title = document?.getText("title");
        if (!title) return;
        title.delete(0, title.length);
        title.insert(0, "Electron overlap winner");
      });
      await provider.flush();
      const staleTitleSet = spawnSync(
        packagedCli,
        [
          "--json",
          "--project",
          project.id,
          "page",
          "title",
          "set",
          `@${pageId}`,
          "--if-match",
          staleTitleEtag,
          "--value",
          "CLI overlap loser",
          "--idempotency-key",
          "packaged-cli-overlap-title",
        ],
        {
          encoding: "utf8",
          env: cliEnvironment(home),
        },
      );
      expect(staleTitleSet.status).toBe(2);
      expect(staleTitleSet.stdout).toBe("");
      expect(staleTitleSet.stderr).toContain('"code":"ETAG_CONFLICT"');
      const overlapMeta = commandResult(
        (await runCli<JsonObject>(home, ["--project", project.id, "read", `@${pageId}`, "--meta"]))
          .result,
      );
      expect(stringField(overlapMeta, "content")).toContain('title: "Electron overlap winner"');

      const rg = await runCliText(home, [
        "--project",
        project.id,
        "rg",
        "-n",
        "Cold CLI body",
        `@${pageId}`,
      ]);
      expect(rg).toContain(pageId);
      expect(rg).toContain("Cold CLI body");
      const noMatch = spawnSync(
        packagedCli,
        ["--project", project.id, "rg", "definitely-no-match-packaged-cli", `@${pageId}`],
        {
          encoding: "utf8",
          env: cliEnvironment(home),
        },
      );
      expect(noMatch.status).toBe(1);
      expect(noMatch.stdout).toBe("");
      expect(noMatch.stderr).toBe("");

      const draftDirectory = path.join(home, "acceptance-draft");
      await runCli<JsonObject>(home, [
        "--project",
        project.id,
        "draft",
        "create",
        `@${pageId}`,
        "--output",
        draftDirectory,
      ]);
      const workMetaPath = path.join(draftDirectory, "work/meta.yaml");
      const workBodyPath = path.join(draftDirectory, "work/body.nested.md");
      const workMeta = readFileSync(workMetaPath, "utf8").replace(
        /^title:.*$/mu,
        'title: "Draft accepted"',
      );
      writeFileSync(workMetaPath, workMeta, "utf8");
      writeFileSync(workBodyPath, `${readFileSync(workBodyPath, "utf8")}Draft body line\n`, "utf8");
      const draftDiff = commandResult(
        (await runCli<JsonObject>(home, ["draft", "diff", draftDirectory])).result,
      );
      expect(draftDiff.changed).toBe(true);
      const draftApply = commandResult(
        (
          await runCli<JsonObject>(home, [
            "--project",
            project.id,
            "draft",
            "apply",
            draftDirectory,
          ])
        ).result,
      );
      expect(draftApply.duplicate).toBe(false);
      const draftReplay = commandResult(
        (
          await runCli<JsonObject>(home, [
            "--project",
            project.id,
            "draft",
            "apply",
            draftDirectory,
          ])
        ).result,
      );
      expect(draftReplay.duplicate).toBe(true);
      await waitUntil(
        () => document?.getText("title").toString() === "Draft accepted",
        "the connected Electron Document provider did not receive the draft mutation",
      );
      await runCli<JsonObject>(home, ["draft", "discard", draftDirectory]);
      expect(existsSync(draftDirectory)).toBe(false);

      const fakeRipgrep = path.join(home, "blocking-rg");
      const fakeRipgrepStarted = path.join(home, "blocking-rg.started");
      writeFileSync(
        fakeRipgrep,
        `#!/bin/sh\ntouch '${fakeRipgrepStarted}'\nexec sleep 10\n`,
        "utf8",
      );
      chmodSync(fakeRipgrep, 0o700);
      const heldCli = spawn(
        packagedCli,
        ["--project", project.id, "rg", "Cold CLI body", `@${pageId}`],
        {
          env: cliEnvironment(home, { NODEX_RG_BINARY: fakeRipgrep }),
          stdio: "ignore",
        },
      );
      await waitUntil(
        () => existsSync(fakeRipgrepStarted),
        "blocking ripgrep fixture did not start",
      );
      if (!heldCli.pid) throw new Error("native CLI fixture has no PID");
      const cliFiles = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(heldCli.pid), "-Fn"], {
        encoding: "utf8",
      });
      expect(cliFiles).not.toContain(databasePath);
      expect(cliFiles).not.toContain(`${databasePath}-wal`);
      expect(cliFiles).not.toContain(`${databasePath}-shm`);
      const heldExitPromise = new Promise<number | null>((resolve, reject) => {
        heldCli.once("error", reject);
        heldCli.once("exit", (code) => resolve(code));
      });
      heldCli.kill("SIGINT");
      const heldExit = await heldExitPromise;
      expect(heldExit).toBe(130);

      const service = commandResult((await runCli<JsonObject>(home, ["service", "status"])).result);
      expect([
        "disabled",
        "enabled",
        "enabled_other_profile",
        "requires_approval",
        "unavailable",
        "unsupported",
      ]).toContain(service.status);
      await runCli<JsonObject>(home, ["backup", "create", "--label", "packaged-cli-acceptance"]);
      const finalDoctor = commandResult(
        (await runCli<JsonObject>(home, ["doctor", "--full"])).result,
      );
      expect(finalDoctor.status).toBeTruthy();
      expect(readRuntimePid(home)).toBe(coldCorePid);
    } finally {
      provider?.destroy();
      document?.destroy();
      if (documentScope) await Effect.runPromise(Scope.close(documentScope, Exit.void));
      eventSubscription?.close();
      if (runtime) {
        await runtime.rootClient.shutdown().catch(() => undefined);
        await waitUntil(
          () => !existsSync(path.join(home, "run/core/core.sock")),
          "Core runtime socket remained after packaged acceptance shutdown",
        );
      } else if (existsSync(path.join(home, "run/core/core.json"))) {
        try {
          process.kill(readRuntimePid(home), "SIGTERM");
        } catch {
          // The cold-started Core may already have exited.
        }
      }
    }
  }, 60_000);
});
