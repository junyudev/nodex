import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Everything Nodex ships, stores and says carries its own name. The only exceptions are the
 * license notices that credit adapted code, recorded provider transcripts that keep the words they
 * captured, and the one migration that must recognize a retired message format.
 */
const FOREIGN_NAME =
  /(?<![A-Za-z0-9-])[tT]3(?:code|CODE|tools|[A-Z][a-z]|[^0-9A-Za-z\n]|$)|(?<=[a-z])T3[A-Z][a-z]/gmu;

const CREDIT_NOTICE = /LICENSE\.t3code/gu;

const EXEMPT_PATH =
  /(?:^|\/)(?:LICENSE(?:\.[^/]*)?|UPSTREAM\.json|pnpm-lock\.yaml)$|\/testkit\/fixtures\/|\/Migrations\/091_MessageWordsWithoutContextLinks(?:\.test)?\.ts$|^scripts\/ci\/verify-product-identity(?:\.test)?\.ts$/u;

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

export interface ProductIdentityViolation {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export function productIdentityViolations(
  path: string,
  content: string,
): readonly ProductIdentityViolation[] {
  if (EXEMPT_PATH.test(path) || content.includes("\0")) return [];
  const visible = content.replace(CREDIT_NOTICE, "");
  return [...visible.matchAll(FOREIGN_NAME)].map((match) => {
    const line = visible.slice(0, match.index).split("\n").length;
    return { path, line, text: visible.split("\n")[line - 1]!.trim().slice(0, 120) };
  });
}

function run(root: string): number {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  const violations = paths.flatMap((path) => {
    const absolute = resolve(root, path);
    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_TEXT_BYTES) return [];
    return productIdentityViolations(path, readFileSync(absolute, "utf8"));
  });
  for (const { path, line, text } of violations) console.error(`${path}:${line}: ${text}`);
  if (violations.length > 0) {
    console.error(`\n${violations.length} occurrences of a name that is not Nodex's.`);
    return 1;
  }
  console.log(`Product identity verified across ${paths.length} files.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = run(process.cwd());
}
