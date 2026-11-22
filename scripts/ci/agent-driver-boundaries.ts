import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Visitor } from "oxc-parser";
import { agentDefinitions } from "../../src/shared/agents/registry";
import { parseTypeScriptSource } from "../lib/oxc-source";
import { compareBaseline, type CountBaseline } from "./count-ratchet";

const baselinePath = "scripts/ci/agent-driver-baseline.json";
const tracked = new Set([
  "claude",
  "acp",
  ...agentDefinitions.flatMap(({ driver, aliases }) => [driver, ...(aliases ?? [])]),
]);

// These modules own a single driver's native protocol, executable, Profile configuration,
// or setup UI. Mixed-driver consumers are checked even when they live near an Adapter.
const driverModule =
  /^(?:src\/shared\/agents\/|src\/(?:main|host)\/(?:codex(?:-application)?|acp-agents)\/|src\/main\/agent-backend\/(?:claude|opencode|antigravity)\/|src\/renderer\/features\/(?:acp-agents|antigravity-runtime|opencode-setup)\/)/;
const sourceModule = /^src\/.*\.[cm]?tsx?$/;
const fixture =
  /(?:^|\/)(?:__tests__|fixtures|testkit|testing|workbench-testkit)\/|\.(?:test|spec|test-support|test-fixtures|generated)\./;
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "src/"],
  { encoding: "utf8" },
).split("\0");

type Baseline = Record<string, { reason: string; literals: Record<string, number> }>;
const counts: CountBaseline = {};
for (const file of [...new Set(files)].sort()) {
  if (
    !sourceModule.test(file) ||
    driverModule.test(file) ||
    fixture.test(file) ||
    !existsSync(file)
  )
    continue;
  const source = readFileSync(file, "utf8");
  if (![...tracked].some((driver) => source.includes(driver))) continue;
  const literals: Record<string, number> = {};
  const visit = (value: unknown) => {
    if (typeof value !== "string" || !tracked.has(value)) return;
    literals[value] = (literals[value] ?? 0) + 1;
  };
  new Visitor({
    Literal: (node) => visit(node.value),
    TemplateLiteral: (node) => {
      if (!node.expressions.length) visit(node.quasis[0]?.value.cooked);
    },
  }).visit(parseTypeScriptSource(file, source));
  if (Object.keys(literals).length > 0) counts[file] = literals;
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
const previous = Object.fromEntries(
  Object.entries(baseline).map(([file, { reason, literals }]) => {
    if (!reason.trim()) throw new Error(`Missing Agent driver exception reason for ${file}`);
    return [file, literals];
  }),
);
const { regressions, stale } = compareBaseline(counts, previous);
for (const { file, rule, count, previous } of regressions)
  console.error(`${file}: driver literal '${rule}' grew from ${previous} to ${count}`);
if (regressions.length) {
  console.error("Use an Agent definition, a reported capability, or the owning driver module.");
  process.exitCode = 1;
} else if (process.argv.includes("--update")) {
  const next = Object.fromEntries(
    Object.entries(counts).map(([file, literals]) => [file, { ...baseline[file], literals }]),
  );
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
} else if (stale.length > 0) {
  console.error("Agent driver baseline can shrink. Run vp run agent-drivers:verify --update.");
  process.exitCode = 1;
} else {
  console.log(
    `Agent driver boundaries verified across ${Object.keys(counts).length} exception files.`,
  );
}
