import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { reviewEvaluation } from "./review";

test("route review preserves raw observations and archived bytes, and rejects a changed archive", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "nodex-eval-review-"));
  try {
    const contents =
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Read the Page." }],
        },
      }) + "\n";
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const original = {
      manifest: { schemaVersion: 3, repository: "/repo/nodex" },
      prompt: "Read the Page.",
      agent: { status: "completed", snapshot: { sentinel: "preserve" } },
      conversation: { file: "conversation.jsonl", sha256 },
      verification: {
        passed: true,
        assertions: [
          { category: "objective", name: "Answer", passed: true },
          { category: "preservation", name: "Page preserved", passed: true },
        ],
      },
      passed: false,
    };
    await writeFile(path.join(output, "result.json"), JSON.stringify(original));
    await writeFile(path.join(output, "conversation.jsonl"), contents);
    const review = {
      conversationSha256: sha256,
      decision: "compliant" as const,
      note: "Checked all native records.",
    };
    const assessment = await reviewEvaluation(output, review);
    expect(assessment.outcome).toBe("passed");
    expect(JSON.parse(await readFile(path.join(output, "result.json"), "utf8"))).toEqual({
      ...original,
      assessment,
      passed: true,
    });
    expect(await readFile(path.join(output, "conversation.jsonl"), "utf8")).toBe(contents);
    await writeFile(path.join(output, "conversation.jsonl"), `${contents}changed`);
    await expect(reviewEvaluation(output, review)).rejects.toThrow("checksum changed");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
