import { BaseSequencer, type TestSpecification, type Vitest } from "vite-plus/test/node";
import { relativeInput } from "./test-cache-policy.ts";

// Discovery records workspace-relative paths, while Vitest uses Vite's module IDs.
function testFileSelection(root: string, files: readonly string[]) {
  const selected = new Set(files);
  return {
    size: selected.size,
    matches({ moduleId }: TestSpecification) {
      const file = relativeInput(root, moduleId);
      return file !== undefined && selected.has(file);
    },
  };
}

export async function runSelectedTestFiles(runner: Vitest, root: string, files: readonly string[]) {
  const selected = testFileSelection(root, files);
  await runner.standalone();
  const specifications = (await runner.globTestSpecifications()).filter(selected.matches);
  if (specifications.length !== selected.size)
    throw new Error("Test selection changed during discovery.");
  await runner.runTestSpecifications(specifications);
}

export function prioritizeTests(root: string, files: readonly string[]) {
  const { matches } = testFileSelection(root, files);
  return class extends BaseSequencer {
    override async sort(specs: TestSpecification[]) {
      const ordered = await super.sort(specs);
      return ordered.sort((a, b) => Number(matches(b)) - Number(matches(a)));
    }
  };
}
