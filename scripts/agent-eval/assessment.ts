import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CaseVerification } from "./contracts";
import type { DesktopAgentResult } from "./desktop-driver";

type Location = { readonly line: number; readonly ordinal: number | null };
export interface RouteFinding extends Location {
  readonly kind: "repository_access" | "external_tool";
  readonly detail: string;
}
export interface RouteEvidence {
  readonly findings: readonly RouteFinding[];
  readonly interventions: readonly (Location & { readonly message: string })[];
  readonly commands: readonly (Location & {
    readonly command: readonly string[];
    readonly cwd: string | null;
  })[];
  readonly calls: readonly (Location & { readonly name: string; readonly input: string })[];
  readonly issues: readonly string[];
}
export interface RouteReview {
  readonly conversationSha256: string;
  readonly decision: "compliant" | "violated";
  readonly note: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const inside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};
const directory = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return value.startsWith("file:") ? fileURLToPath(value) : value;
  } catch {
    return null;
  }
};

function repositoryReads(
  item: Record<string, unknown>,
  cwd: string | null,
  repository: string,
  skillRoots: readonly string[],
): string[] {
  const parsedCommands = (Array.isArray(item.parsed_cmd) ? item.parsed_cmd : []).filter(record);
  const targets = parsedCommands.flatMap((parsed) => {
    if (
      !["read", "search", "list_files"].includes(String(parsed.type)) ||
      typeof parsed.path !== "string"
    )
      return [];
    if (!path.isAbsolute(parsed.path) && !cwd) return [];
    const target = path.resolve(cwd ?? repository, parsed.path);
    return inside(repository, target) && !skillRoots.some((root) => inside(root, target))
      ? [target]
      : [];
  });
  return [...new Set(targets)];
}

/** Index executed native events without evaluating Agent code or interpreting tool output as instructions.
 * Absence of a finding is not proof of shell compliance: every successful attempt needs route review.
 */
export function inspectRoute(
  contents: string,
  input: { repository: string; prompt: string },
): RouteEvidence {
  const findings: RouteFinding[] = [];
  const interventions: RouteEvidence["interventions"][number][] = [];
  const commands: RouteEvidence["commands"][number][] = [];
  const calls: RouteEvidence["calls"][number][] = [];
  const issues: string[] = [];
  const completedItems = new Set<string>();
  let sawPrompt = false;
  const skillRoots = ["agent-skills/nodex", ".generated/official-agent-skills/skills/nodex"].map(
    (relative) => path.join(input.repository, relative),
  );
  for (const [index, line] of contents.split("\n").entries()) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      issues.push(`Unreadable native record at line ${index + 1}`);
      continue;
    }
    if (!record(entry) || !record(entry.payload)) {
      issues.push(`Invalid native record at line ${index + 1}`);
      continue;
    }
    const payload = entry.payload;
    const location = {
      line: index + 1,
      ordinal: typeof entry.ordinal === "number" ? entry.ordinal : null,
    };
    if (entry.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const message = (Array.isArray(payload.content) ? payload.content : [])
        .filter(record)
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("\n");
      interventions.push(...(sawPrompt ? [{ ...location, message }] : []));
      sawPrompt ||= message.trim() === input.prompt.trim();
      continue;
    }
    if (
      entry.type === "response_item" &&
      (payload.type === "custom_tool_call" || payload.type === "function_call")
    ) {
      const name = typeof payload.name === "string" ? payload.name : "unknown";
      calls.push({
        ...location,
        name,
        input:
          typeof payload.input === "string"
            ? payload.input
            : JSON.stringify(payload.arguments ?? null),
      });
      // Tool transport alone cannot establish its purpose. Inspect arguments during route review.
      if (name.startsWith("mcp__"))
        findings.push({ ...location, kind: "external_tool", detail: name });
      continue;
    }
    if (entry.type !== "event_msg" || payload.type !== "item_completed" || !record(payload.item))
      continue;
    const item = payload.item;
    if (typeof item.id === "string" && completedItems.has(item.id)) continue;
    if (typeof item.id === "string") completedItems.add(item.id);
    if (
      item.type === "McpToolCall" ||
      item.type === "DynamicToolCall" ||
      item.type === "WebSearch"
    ) {
      const name = [item.type, item.server, item.tool]
        .filter((value) => typeof value === "string")
        .join(":");
      calls.push({
        ...location,
        name,
        input: JSON.stringify(item.arguments ?? item.action ?? null),
      });
      findings.push({
        ...location,
        kind: "external_tool",
        detail: name,
      });
      continue;
    }
    if (item.type !== "CommandExecution") continue;
    const command = strings(item.command);
    const cwd = directory(item.cwd);
    commands.push({ ...location, command, cwd });
    findings.push(
      ...repositoryReads(item, cwd, input.repository, skillRoots).map((target) => ({
        ...location,
        kind: "repository_access" as const,
        detail: target,
      })),
    );
  }
  if (!sawPrompt) issues.push("The initial evaluation prompt was not found in the archive");
  return { findings, interventions, commands, calls, issues };
}

/** Keep observed outcome, preservation and route qualification independent. */
export function assessEvaluation(input: {
  status: DesktopAgentResult["status"];
  verification: CaseVerification;
  evidence: RouteEvidence;
  conversationSha256: string;
  review?: RouteReview;
}) {
  const { evidence, review, verification, status } = input;
  if (review && (review.conversationSha256 !== input.conversationSha256 || !review.note.trim())) {
    throw new Error("Route review requires the exact conversation checksum and a nonempty note");
  }
  const summarize = (category: "objective" | "preservation") => {
    const assertions = verification.assertions.filter((item) => item.category === category);
    return { passed: assertions.length > 0 && assertions.every((item) => item.passed), assertions };
  };
  const objective = summarize("objective");
  const preservation = summarize("preservation");
  const route =
    evidence.findings.some((finding) => finding.kind === "repository_access") ||
    review?.decision === "violated"
      ? "violated"
      : review?.decision === "compliant" && evidence.issues.length === 0
        ? "compliant"
        : "needs_review";
  const outcome =
    status !== "completed" ||
    !verification.passed ||
    !objective.passed ||
    !preservation.passed ||
    evidence.interventions.length > 0 ||
    route === "violated"
      ? "failed"
      : route === "needs_review"
        ? "needs_review"
        : "passed";
  return {
    outcome,
    passed: outcome === "passed",
    runtimeStatus: status,
    objective,
    preservation,
    route,
    interventionCount: evidence.interventions.length,
    review: review ?? null,
  };
}

export type EvaluationAssessment = ReturnType<typeof assessEvaluation>;
export function renderAssessment(
  assessment: EvaluationAssessment,
  evidence: RouteEvidence,
): string {
  return [
    `Result: **${assessment.outcome.toUpperCase()}**`,
    `Runtime: ${assessment.runtimeStatus}; objective: ${assessment.objective.passed ? "PASS" : "FAIL"}; preservation: ${assessment.preservation.passed ? "PASS" : "FAIL"}.`,
    `CLI route: ${assessment.route}; interventions: ${assessment.interventionCount}.`,
    "",
    ...evidence.findings.map(
      (finding) => `- ${finding.kind} at native line ${finding.line}: ${finding.detail}`,
    ),
    ...evidence.interventions.map(
      (intervention) =>
        `- Human input or Stop at native line ${intervention.line}; see route-evidence.json.`,
    ),
    ...evidence.issues.map((issue) => `- Evidence issue: ${issue}`),
    ...(assessment.review
      ? [`Review: ${assessment.review.note}`]
      : [
          "Review the native command/tool inputs and route-evidence.json before recording a CLI route decision. Absence of a detected violation is not proof of compliance.",
        ]),
    "",
  ].join("\n");
}
