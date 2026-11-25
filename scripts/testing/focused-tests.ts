import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { ownerOfTest, type SuiteId } from "../../config/test-suites.ts";

const codeFile = /\.[cm]?[jt]sx?$/u;
const testSuffix = /(?:\.(?:browser|jsdom|node))?\.(?:test\.[cm]?[jt]sx?|integration\.ts)$/u;

export const isTestFile = (file: string) => testSuffix.test(file);
export const isCodeFile = (file: string) => codeFile.test(file);

export function findFocusedTests(
  changed: readonly string[],
  present: ReadonlySet<string>,
  siblings: (directory: string) => readonly string[],
  includeNightly = false,
): Partial<Record<SuiteId, string[]>> {
  const candidates = new Set<string>();
  const directories = new Map<string, readonly string[]>();
  for (const file of changed) {
    const isTest = isTestFile(file);
    const isPresent = present.has(file);
    const includeNightlySiblings = includeNightly && isPresent;
    if (isTest && isPresent) candidates.add(file);
    if (!isCodeFile(file)) continue;
    // An edited default half of a split suite also selects its nightly half.
    if (isTest && (!includeNightlySiblings || ownerOfTest(file)?.tier !== "default")) continue;

    const lastSlash = file.lastIndexOf("/");
    const directory = file.slice(0, lastSlash + 1);
    const stem = file.slice(lastSlash + 1).replace(isTest ? testSuffix : codeFile, "");
    const entries = directories.get(directory) ?? siblings(directory);
    directories.set(directory, entries);
    for (const name of entries) {
      if (!name.startsWith(stem + ".") || !isTestFile(name)) continue;
      if (name.includes(".nightly.") ? includeNightlySiblings : !isTest)
        candidates.add(directory + name);
    }
  }

  const result: Partial<Record<SuiteId, string[]>> = {};
  for (const file of [...candidates].sort()) {
    const owner = ownerOfTest(file);
    if (owner?.tier === "default" || (includeNightly && owner?.tier === "nightly"))
      (result[owner.suite] ??= []).push(file);
  }
  return result;
}

export function presentFiles(root: string, files: readonly string[]) {
  return files.filter((file) =>
    lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile(),
  );
}

function presentSiblings(root: string, directory: string) {
  try {
    return readdirSync(path.join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return [];
  }
}

export function findCheckoutFocusedTests(
  root: string,
  changed: readonly string[],
  includeNightly: boolean,
  present: ReadonlySet<string> = new Set(presentFiles(root, changed)),
) {
  return findFocusedTests(
    changed,
    present,
    (directory) => presentSiblings(root, directory),
    includeNightly,
  );
}
