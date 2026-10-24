import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function versionParts(value: string): readonly [number, number, number] {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) throw new Error(`Expected a stable, exact Node version; received ${value}`);
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (!parts.every(Number.isSafeInteger)) throw new Error(`Invalid Node version: ${value}`);
  return parts;
}

/** The contributor pin is also the supported host-runtime floor, never an Electron pin. */
export function verifyNodeRuntime(input: {
  readonly pinned: string;
  readonly engines: unknown;
  readonly actual: string;
  readonly electron?: string;
  readonly exact?: boolean;
}): void {
  const minimum = versionParts(input.pinned);
  const actual = versionParts(input.actual);
  const range = `>=${input.pinned} <${minimum[0] + 1}`;
  if (input.engines !== range) {
    throw new Error(`package.json engines.node must be ${range}, matching .node-version`);
  }
  if (input.electron) {
    throw new Error("Host tooling requires standalone Node; Electron must be audited separately");
  }
  const supported =
    actual[0] === minimum[0] &&
    (actual[1] > minimum[1] || (actual[1] === minimum[1] && actual[2] >= minimum[2]));
  if (!supported || (input.exact && actual.some((part, index) => part !== minimum[index]))) {
    throw new Error(
      `Node ${input.actual} does not satisfy ${input.exact ? input.pinned : range}. ` +
        "Use the repository's Vite+ Node environment before installing or building.",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--exact")) {
      throw new Error("Usage: node scripts/verify-node-runtime.mts [--exact]");
    }
    const root = new URL("../", import.meta.url);
    const pinned = readFileSync(new URL(".node-version", root), "utf8").trim();
    const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
      engines?: { node?: unknown };
    };
    verifyNodeRuntime({
      pinned,
      engines: manifest.engines?.node,
      actual: process.versions.node,
      electron: process.versions.electron,
      exact: args[0] === "--exact",
    });
    process.stdout.write(
      `${JSON.stringify({ executable: process.execPath, pinned, versions: process.versions })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
