import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export interface CcusageTokens {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
}

interface CcusageDay extends CcusageTokens {
  readonly period: string;
  readonly totalCost?: number;
  readonly agents: readonly (CcusageTokens & { readonly agent: string })[];
  readonly modelBreakdowns: readonly (CcusageTokens & {
    readonly modelName: string;
    readonly cost?: number;
  })[];
}

interface CcusageWindow {
  readonly since: string;
  readonly until: string;
}

export interface CcusageReport {
  readonly daily: readonly CcusageDay[];
  readonly sessionCount: number;
  readonly sessionWindow: CcusageWindow;
}

export class CcusageError extends Error {
  override readonly name = "CcusageError";

  constructor(
    message: string,
    readonly kind: "missing-binary" | "process" | "invalid-report",
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const require = createRequire(import.meta.url);
const tokenFields = [
  "inputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "outputTokens",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTokens(value: unknown): value is Record<string, unknown> & CcusageTokens {
  return (
    isRecord(value) &&
    tokenFields.every((key) => {
      const count = value[key];
      return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
    })
  );
}

function isOptionalCost(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDay(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

function isDailyRow(value: unknown): value is CcusageDay {
  return (
    hasTokens(value) &&
    isIsoDay(value.period) &&
    isOptionalCost(value.totalCost) &&
    Array.isArray(value.agents) &&
    value.agents.every((agent) => hasTokens(agent) && isNonemptyString(agent.agent)) &&
    Array.isArray(value.modelBreakdowns) &&
    value.modelBreakdowns.every(
      (model) =>
        hasTokens(model) && isNonemptyString(model.modelName) && isOptionalCost(model.cost),
    )
  );
}

function isSessionRow(value: unknown): boolean {
  return isRecord(value) && isNonemptyString(value.agent) && isNonemptyString(value.period);
}

export function parseCcusageReport(
  stdout: string,
  sessionWindow: CcusageWindow,
  stderr = "",
): CcusageReport {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    throw new CcusageError("ccusage returned invalid JSON.", "invalid-report", stderr, { cause });
  }
  if (!isRecord(value) || !Array.isArray(value.daily) || !value.daily.every(isDailyRow)) {
    throw new CcusageError("ccusage returned an invalid daily report.", "invalid-report", stderr);
  }
  if (!Array.isArray(value.session) || !value.session.every(isSessionRow)) {
    throw new CcusageError("ccusage returned an invalid session report.", "invalid-report", stderr);
  }
  return { daily: value.daily, sessionCount: value.session.length, sessionWindow };
}

export async function readCcusage({
  since,
  until,
  timeZone,
  cost,
}: CcusageWindow & {
  readonly timeZone: string;
  readonly cost: boolean;
}): Promise<CcusageReport> {
  let entry: string;
  try {
    // The npm wrapper selects the matching native optional dependency, including on Windows.
    entry = require.resolve("ccusage/src/cli.js");
  } catch (cause) {
    throw new CcusageError("Could not find the installed ccusage CLI.", "missing-binary", "", {
      cause,
    });
  }

  const args = [
    entry,
    "daily",
    "--json",
    "--by-agent",
    "--sections",
    "daily,session",
    "--offline",
    "--since",
    since,
    "--until",
    until,
    "--timezone",
    timeZone,
    // The cards show an API-price estimate. The default mode can use recorded costs.
    "--mode",
    "calculate",
    ...(cost ? [] : ["--no-cost"]),
  ];
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, args, {
        env: { ...process.env, CCUSAGE_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (cause) => {
        reject(new CcusageError("Could not start ccusage.", "process", stderr, { cause }));
      });
      child.once("close", (code, signal) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const status = signal ? `signal ${signal}` : `exit code ${code}`;
        const message = `ccusage failed (${status}). ${stderr.trim()}`.trimEnd();
        reject(new CcusageError(message, "process", stderr));
      });
    },
  );
  return parseCcusageReport(stdout, { since, until }, stderr);
}
