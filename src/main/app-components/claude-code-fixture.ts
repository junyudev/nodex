import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AppComponentPayload } from "./AppComponentCatalog";

export function writeClaudeCodeFixture(source: string, executable: string) {
  mkdirSync(path.join(source, "package"), { recursive: true });
  for (const filename of ["LICENSE.md", "README.md", "package.json"]) {
    writeFileSync(path.join(source, "package", filename), "");
  }
  writeFileSync(path.join(source, "package/claude"), executable);
  return {
    kind: "claude-code",
    executable: {
      path: "package/claude",
      size: Buffer.byteLength(executable),
      sha256: createHash("sha256").update(executable).digest("hex"),
    },
  } as const satisfies AppComponentPayload;
}
