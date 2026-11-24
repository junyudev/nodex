import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";
import { relativeInput } from "./test-cache-policy.ts";

// Discovery records workspace-relative paths, while Vitest uses Vite's module IDs.
export function testFileSelection(root: string, files: readonly string[]) {
  const selected = new Set(files);
  return {
    size: selected.size,
    matches({ moduleId }: TestSpecification) {
      const file = relativeInput(root, moduleId);
      return file !== undefined && selected.has(file);
    },
  };
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
