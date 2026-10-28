import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  type InitialProjectJournal,
  InitialProjectRecoveryJournal,
  resolveInitialProjectJournalPath,
} from "./initial-project-journal-store";
import { resolveInitialProjectProjectsDirectory } from "./initial-project-filesystem";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "nodex-initial-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeAttempt(sourceRoot: string): InitialProjectJournal {
  return {
    schemaVersion: 2,
    attemptId: "11111111-1111-4111-8111-111111111111",
    operationId: "22222222-2222-4222-8222-222222222222",
    payload: {
      projectId: "33333333-3333-4333-8333-333333333333",
      name: "My Project",
      description: "",
      appearance: {
        color: "black",
        marker: { kind: "icon", icon: "folder" },
      },
      sources: [sourceRoot],
      starterPage: {
        pageId: "44444444-4444-4444-8444-444444444444",
        documentId: "55555555-5555-4555-8555-555555555555",
        titleMarkdown: "Welcome to Nodex",
        markdown: "Welcome to **Nodex**.",
      },
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("InitialProjectRecoveryJournal", () => {
  test("durably round-trips the exact initial aggregate payload", async () => {
    const root = createTemporaryDirectory();
    const filePath = resolveInitialProjectJournalPath(join(root, ".nodex"));
    const journal = new InitialProjectRecoveryJournal({ filePath });
    const attempt = makeAttempt(join(root, "workspace", "My Project"));

    await journal.save(attempt);

    expect(await journal.load(123)).toEqual(attempt);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual(attempt);
  });

  test("rejects relative sources before publishing a recovery record", async () => {
    const root = createTemporaryDirectory();
    const journal = new InitialProjectRecoveryJournal({
      filePath: resolveInitialProjectJournalPath(join(root, ".nodex")),
    });

    await expect(journal.save(makeAttempt("workspace/My Project"))).rejects.toThrow(
      "sources must be absolute",
    );
  });

  test("quarantines a symlink instead of following untrusted recovery data", async () => {
    const root = createTemporaryDirectory();
    const recoveryDirectory = join(root, ".nodex", "recovery");
    const filePath = resolveInitialProjectJournalPath(join(root, ".nodex"));
    const target = join(root, "outside.json");
    const attempt = makeAttempt(join(root, "workspace", "My Project"));
    mkdirSync(recoveryDirectory, { recursive: true });
    writeFileSync(target, JSON.stringify(attempt));
    symlinkSync(target, filePath, "file");
    const journal = new InitialProjectRecoveryJournal({ filePath });

    expect(await journal.load(123)).toBeNull();
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(attempt);
    expect(readdirSync(recoveryDirectory)).toEqual(["initial-project-v2.json.corrupt-123"]);
  });
});

describe("resolveInitialProjectProjectsDirectory", () => {
  test("defaults to Documents/Nodex and accepts an absolute isolation override", () => {
    expect(
      resolveInitialProjectProjectsDirectory({
        documentsDirectory: "/Users/alex/Documents",
      }),
    ).toBe("/Users/alex/Documents/Nodex");
    expect(
      resolveInitialProjectProjectsDirectory({
        configuredDirectory: "/tmp/nodex-profile/workspace",
        documentsDirectory: "/Users/alex/Documents",
      }),
    ).toBe("/tmp/nodex-profile/workspace");
  });

  test("rejects a relative isolation override", () => {
    expect(() =>
      resolveInitialProjectProjectsDirectory({
        configuredDirectory: "../workspace",
        documentsDirectory: "/Users/alex/Documents",
      }),
    ).toThrow("must be an absolute path");
  });

  test("rejects a relative Electron Documents directory", () => {
    expect(() =>
      resolveInitialProjectProjectsDirectory({
        documentsDirectory: "Documents",
      }),
    ).toThrow("Electron Documents directory must be absolute");
  });
});
