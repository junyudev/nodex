import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { assessEvaluation, inspectRoute, renderAssessment, type RouteReview } from "./assessment";

const resultSchema = z.object({
  manifest: z.object({ schemaVersion: z.literal(3), repository: z.string().min(1) }),
  prompt: z.string().min(1),
  agent: z.object({
    status: z.enum(["completed", "failed", "interrupted", "systemError", "timedOut"]),
  }),
  conversation: z.object({
    file: z.literal("conversation.jsonl"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  verification: z.object({
    passed: z.boolean(),
    assertions: z
      .array(
        z.object({
          category: z.enum(["objective", "preservation"]),
          name: z.string(),
          passed: z.boolean(),
          detail: z.string().optional(),
        }),
      )
      .nonempty(),
  }),
});

/** Record a supervisor's route decision against exact archived bytes; never rerun the Agent. */
export async function reviewEvaluation(output: string, review: RouteReview) {
  const resultPath = path.join(output, "result.json");
  const raw: unknown = JSON.parse(await readFile(resultPath, "utf8"));
  const result = resultSchema.parse(raw);
  const contents = await readFile(path.join(output, result.conversation.file));
  const sha256 = createHash("sha256").update(contents).digest("hex");
  if (sha256 !== result.conversation.sha256)
    throw new Error("Archived conversation checksum changed");
  const evidence = inspectRoute(contents.toString("utf8"), {
    repository: result.manifest.repository,
    prompt: result.prompt,
  });
  const assessment = assessEvaluation({
    status: result.agent.status,
    verification: result.verification,
    evidence,
    conversationSha256: sha256,
    review,
  });
  // Keep all original observations and raw snapshot fields while replacing only the derived assessment.
  const updated = { ...(raw as Record<string, unknown>), assessment, passed: assessment.passed };
  await writeFile(resultPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
  await writeFile(path.join(output, "assessment.md"), renderAssessment(assessment, evidence), {
    mode: 0o600,
  });
  return assessment;
}

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !key ||
      !["--out", "--sha256", "--decision", "--note"].includes(key) ||
      !value ||
      options.has(key)
    ) {
      throw new Error(
        "Usage: agent:eval:review --out DIR --sha256 HASH --decision compliant|violated --note TEXT",
      );
    }
    options.set(key, value);
  }
  const directory = options.get("--out");
  const decision = options.get("--decision");
  const sha256 = options.get("--sha256");
  const note = options.get("--note");
  if (!directory || !sha256 || !note || (decision !== "compliant" && decision !== "violated")) {
    throw new Error("Route review requires --out, --sha256, --decision and --note");
  }
  const assessment = await reviewEvaluation(path.resolve(directory), {
    conversationSha256: sha256,
    decision,
    note,
  });
  process.stdout.write(`${assessment.outcome}: ${directory}/assessment.md\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
