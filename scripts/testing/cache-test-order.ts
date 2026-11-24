import path from "node:path";
import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

export function prioritizeTests(root: string, files: readonly string[]) {
  const first = new Set(files.map((file) => path.resolve(root, file)));
  return class extends BaseSequencer {
    override async sort(specs: TestSpecification[]) {
      const ordered = await super.sort(specs);
      return ordered.sort((a, b) => Number(first.has(b.moduleId)) - Number(first.has(a.moduleId)));
    }
  };
}
