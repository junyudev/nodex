import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

import { cachedAppLanes, parseCiGatePlan, type CiGatePlan } from "./ci-gate-plan.ts";

interface ClassificationDocument {
  readonly changedPaths: readonly string[];
  readonly plan: CiGatePlan;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseClassificationDocument = (value: unknown): ClassificationDocument => {
  if (!isRecord(value)) throw new Error("Classification document must be an object.");
  const unknown = Object.keys(value).filter((key) => key !== "changedPaths" && key !== "plan");
  if (unknown.length > 0)
    throw new Error(`Classification document has unknown fields: ${unknown.join(", ")}.`);
  if (
    !Array.isArray(value.changedPaths) ||
    !value.changedPaths.every((entry) => typeof entry === "string")
  ) {
    throw new Error("Classification changedPaths must be a string array.");
  }
  if (value.changedPaths.some((entry) => /[\r\n]/u.test(entry))) {
    throw new Error("Classification changedPaths must not contain line breaks.");
  }
  return {
    changedPaths: value.changedPaths,
    plan: parseCiGatePlan(value.plan),
  };
};

export const githubOutputForClassification = (document: ClassificationDocument): string => {
  const serialized = JSON.stringify(document.plan);
  const changedPaths = JSON.stringify(document.changedPaths);
  if (serialized.includes("\n") || serialized.includes("\r")) {
    throw new Error("Serialized CI gate plan must fit on one GitHub output line.");
  }
  const appLanes = JSON.stringify([...cachedAppLanes(document.plan).keys()]);
  return `changed_paths=${changedPaths}\nplan=${serialized}\napp_lanes=${appLanes}\n`;
};

const readOption = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
};

const main = (): void => {
  const input = readOption(process.argv.slice(2), "--input");
  const output = process.env.GITHUB_OUTPUT;
  if (!input || !output) throw new Error("--input and GITHUB_OUTPUT are required.");
  const document = parseClassificationDocument(JSON.parse(readFileSync(input, "utf8")));
  appendFileSync(output, githubOutputForClassification(document), "utf8");
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const draftNotice = document.plan.draft
    ? "Draft PR: only cheap static checks are eligible. Mark ready for review or add `ci:full` to run the full selected gate.\n\n"
    : "";
  appendFileSync(
    summary,
    `## Change classification\n\n${document.changedPaths.length} changed path(s).\n\n${draftNotice}    ${JSON.stringify(document.plan)}\n`,
    "utf8",
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
