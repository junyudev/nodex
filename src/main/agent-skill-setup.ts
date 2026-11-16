import { execFile } from "./platform/node/child-stdio-errors";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { getMainIntl } from "./i18n/main-intl";
import * as Schema from "effect/Schema";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";

const AGENT_SKILL_CLI_TIMEOUT_MS = 30_000;
const AGENT_SKILL_CLI_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const AVAILABLE_TARGET_STATES = new Set(["managed-current", "compatible-external"]);

export type SupportedAgentSkillTarget = "codex" | "claude-code";

export interface AgentSkillCliInvocation {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly shell: false;
}

export interface AgentSkillCliProcessResult {
  readonly stderr: string;
  readonly stdout: string;
}

export type AgentSkillCliRunner = (
  invocation: AgentSkillCliInvocation,
) => Effect.Effect<AgentSkillCliProcessResult, AgentSkillCliProcessError>;

export interface AgentSkillTargetStatus {
  readonly agent: string;
  readonly changed: boolean;
  readonly detected: boolean;
  readonly detail?: string;
  readonly outcome: string;
  readonly path: string;
  readonly state: string;
}

export interface AgentSkillCommandResult {
  readonly schemaVersion: number;
  readonly operation: string;
  readonly dryRun: boolean;
  readonly changed: boolean;
  readonly targets: readonly AgentSkillTargetStatus[];
}

export interface AgentSkillSetupResult {
  readonly status: "already-configured" | "cancelled" | "failed" | "installed";
  readonly commandResult?: AgentSkillCommandResult;
}

export interface RunAgentSkillSetupOptions {
  readonly cliPath: string;
  readonly onlyWhenMissing?: boolean;
  readonly pathConfigured?: boolean;
  readonly runCli?: AgentSkillCliRunner;
  readonly showMessageBox: (options: MessageBoxOptions) => Effect.Effect<MessageBoxReturnValue>;
}

interface CliSuccessEnvelope {
  readonly version: number;
  readonly ok: true;
  readonly result: unknown;
}

interface CliErrorEnvelope {
  readonly version?: number;
  readonly ok?: false;
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly path?: unknown;
  };
}

export class AgentSkillCliProcessError extends Schema.TaggedError<AgentSkillCliProcessError>()(
  "AgentSkillCliProcessError",
  {
    message: Schema.String,
    stderr: Schema.String,
    stdout: Schema.String,
  },
) {}

export class AgentSkillSetupError extends Schema.TaggedError<AgentSkillSetupError>()(
  "AgentSkillSetupError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const runAgentSkillCli: AgentSkillCliRunner = (invocation) =>
  Effect.callback((resume) => {
    const child = execFile(
      invocation.executable,
      [...invocation.argv],
      {
        encoding: "utf8",
        maxBuffer: AGENT_SKILL_CLI_MAX_BUFFER_BYTES,
        shell: invocation.shell,
        timeout: AGENT_SKILL_CLI_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new AgentSkillCliProcessError({
                message: error.message,
                stdout: typeof stdout === "string" ? stdout : "",
                stderr: typeof stderr === "string" ? stderr : "",
              }),
            ),
          );
          return;
        }
        resume(
          Effect.succeed({
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
          }),
        );
      },
    );
    return Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
  });

const assertPackagedCliPath = (candidate: string): string => {
  if (!isAbsolute(candidate)) {
    throw new Error("The packaged Nodex CLI path must be absolute.");
  }
  const normalized = resolve(candidate);
  const binDirectory = dirname(normalized);
  const resourcesDirectory = dirname(binDirectory);
  const contentsDirectory = dirname(resourcesDirectory);
  const appDirectory = dirname(contentsDirectory);
  if (
    basename(normalized) !== "nodex" ||
    basename(binDirectory) !== "bin" ||
    basename(resourcesDirectory) !== "Resources" ||
    basename(contentsDirectory) !== "Contents" ||
    !basename(appDirectory).startsWith("Nodex") ||
    !basename(appDirectory).endsWith(".app")
  ) {
    throw new Error(`The packaged Nodex CLI path is invalid: ${normalized}`);
  }
  return normalized;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const parseTarget = (value: unknown): AgentSkillTargetStatus | null => {
  const target = asRecord(value);
  if (!target) return null;
  if (
    typeof target.agent !== "string" ||
    typeof target.changed !== "boolean" ||
    typeof target.detected !== "boolean" ||
    typeof target.outcome !== "string" ||
    typeof target.path !== "string" ||
    !isAbsolute(target.path) ||
    typeof target.state !== "string"
  ) {
    return null;
  }
  return {
    agent: target.agent,
    changed: target.changed,
    detected: target.detected,
    detail: typeof target.detail === "string" ? target.detail : undefined,
    outcome: target.outcome,
    path: target.path,
    state: target.state,
  };
};

export const parseAgentSkillCommandResult = (value: unknown): AgentSkillCommandResult => {
  const result = asRecord(value);
  if (
    !result ||
    typeof result.schemaVersion !== "number" ||
    typeof result.operation !== "string" ||
    typeof result.dryRun !== "boolean" ||
    typeof result.changed !== "boolean" ||
    !Array.isArray(result.targets)
  ) {
    throw new Error("The Nodex CLI returned an invalid Agent Skill result.");
  }
  if (result.schemaVersion !== 1) {
    throw new Error("The Nodex CLI returned an unsupported Agent Skill schema.");
  }
  const targets = result.targets.map(parseTarget);
  if (targets.some((target) => target === null)) {
    throw new Error("The Nodex CLI returned an invalid Agent Skill target.");
  }
  return {
    schemaVersion: result.schemaVersion,
    operation: result.operation,
    dryRun: result.dryRun,
    changed: result.changed,
    targets: targets as AgentSkillTargetStatus[],
  };
};

const parseSuccessEnvelope = (stdout: string): AgentSkillCommandResult => {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("The Nodex CLI returned malformed JSON.");
  }
  const envelope = asRecord(value) as CliSuccessEnvelope | null;
  if (!envelope || envelope.version !== 1 || envelope.ok !== true) {
    throw new Error("The Nodex CLI returned an invalid success envelope.");
  }
  return parseAgentSkillCommandResult(envelope.result);
};

const invokeAgentSkillCli = (
  cliPath: string,
  argv: readonly string[],
  runCli: AgentSkillCliRunner,
): Effect.Effect<AgentSkillCommandResult, AgentSkillCliProcessError | AgentSkillSetupError> =>
  runCli({
    executable: cliPath,
    argv,
    shell: false,
  }).pipe(
    Effect.flatMap((processResult) =>
      Effect.try({
        try: () => parseSuccessEnvelope(processResult.stdout),
        catch: (cause) => new AgentSkillSetupError({ operation: "parse-cli-result", cause }),
      }),
    ),
  );

const selectedAgentsForResponse = (response: number): readonly SupportedAgentSkillTarget[] => {
  switch (response) {
    case 0:
      return ["codex", "claude-code"];
    case 1:
      return ["codex"];
    case 2:
      return ["claude-code"];
    default:
      return [];
  }
};

const targetPathsDetail = (
  status: AgentSkillCommandResult,
  pathConfigured: boolean | undefined,
): string => {
  const paths = status.targets
    .filter((target) => target.agent === "codex" || target.agent === "claude-code")
    .map((target) => `${target.agent}: ${target.path}`);
  const pathNote =
    pathConfigured === false
      ? getMainIntl().formatMessage({
          id: "main.dialog.setupSkills.pathNote",
          defaultMessage:
            "\n\nThe Skill can be linked now, but Agents will need ~/.local/bin on PATH to run nodex.",
        })
      : "";
  return getMainIntl().formatMessage(
    {
      id: "main.dialog.setupSkills.locations",
      defaultMessage: "Nodex manages only these global discovery locations:\n{paths}{pathNote}",
    },
    { paths: ["", ...paths].join("\n"), pathNote },
  );
};

const errorDetail = (error: unknown): string => {
  if (error instanceof AgentSkillSetupError) return errorDetail(error.cause);
  if (error instanceof AgentSkillCliProcessError) {
    try {
      const envelope = JSON.parse(error.stderr) as CliErrorEnvelope;
      const message =
        typeof envelope.error?.message === "string" ? envelope.error.message : error.message;
      const path =
        typeof envelope.error?.path === "string"
          ? getMainIntl().formatMessage(
              { id: "main.dialog.setupSkills.errorTarget", defaultMessage: "\n\nTarget: {path}" },
              { path: envelope.error.path },
            )
          : "";
      const code =
        typeof envelope.error?.code === "string"
          ? getMainIntl().formatMessage(
              { id: "main.dialog.setupSkills.errorCode", defaultMessage: "\n\nCode: {code}" },
              { code: envelope.error.code },
            )
          : "";
      return `${message}${path}${code}`;
    } catch {
      return error.stderr.trim() || error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
};

export function runAgentSkillSetup(
  options: RunAgentSkillSetupOptions,
): Effect.Effect<AgentSkillSetupResult> {
  const workflow = Effect.gen(function* () {
    const cliPath = yield* Effect.try({
      try: () => assertPackagedCliPath(options.cliPath),
      catch: (cause) => new AgentSkillSetupError({ operation: "validate-cli-path", cause }),
    });
    const runCli = options.runCli ?? runAgentSkillCli;
    const status = yield* invokeAgentSkillCli(cliPath, ["--json", "skills", "status"], runCli);
    const configuredAgents = new Set(
      status.targets
        .filter((target) => AVAILABLE_TARGET_STATES.has(target.state))
        .map((target) => target.agent),
    );
    if (
      options.onlyWhenMissing &&
      configuredAgents.has("codex") &&
      configuredAgents.has("claude-code")
    ) {
      return {
        status: "already-configured",
        commandResult: status,
      } satisfies AgentSkillSetupResult;
    }

    const selection = yield* options.showMessageBox({
      type: "question",
      buttons: [
        getMainIntl().formatMessage({
          id: "main.dialog.setupSkills.installBoth",
          defaultMessage: "Install for Codex + Claude Code",
        }),
        getMainIntl().formatMessage({
          id: "main.dialog.setupSkills.codexOnly",
          defaultMessage: "Codex only",
        }),
        getMainIntl().formatMessage({
          id: "main.dialog.setupSkills.claudeOnly",
          defaultMessage: "Claude Code only",
        }),
        getMainIntl().formatMessage({
          id: "main.dialog.setupSkills.notNow",
          defaultMessage: "Not now",
        }),
      ],
      defaultId: 0,
      cancelId: 3,
      noLink: true,
      message: getMainIntl().formatMessage({
        id: "main.dialog.setupSkills.question",
        defaultMessage: "Set up the official Nodex Agent Skill?",
      }),
      detail: targetPathsDetail(status, options.pathConfigured),
    });
    const agents = selectedAgentsForResponse(selection.response);
    if (agents.length === 0) {
      return { status: "cancelled", commandResult: status } satisfies AgentSkillSetupResult;
    }

    const argv = ["--json", "skills", "install"];
    for (const agent of agents) {
      argv.push("--agent", agent);
    }
    argv.push("--yes");
    const installed = yield* invokeAgentSkillCli(cliPath, argv, runCli);
    const installedTargets = installed.targets
      .map((target) => `${target.agent}: ${target.path} (${target.outcome})`)
      .join("\n");
    yield* options.showMessageBox({
      type: "info",
      buttons: [getMainIntl().formatMessage({ id: "main.dialog.common.ok", defaultMessage: "OK" })],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: installed.changed
        ? getMainIntl().formatMessage({
            id: "main.dialog.setupSkills.installed",
            defaultMessage: "The official Nodex Agent Skill was set up.",
          })
        : getMainIntl().formatMessage({
            id: "main.dialog.setupSkills.alreadyAvailable",
            defaultMessage: "The official Nodex Agent Skill is already available.",
          }),
      detail: installedTargets,
    });
    return {
      status: "installed",
      commandResult: installed,
    } satisfies AgentSkillSetupResult;
  });

  return workflow.pipe(
    Effect.catch((error) =>
      options
        .showMessageBox({
          type: "error",
          buttons: [
            getMainIntl().formatMessage({ id: "main.dialog.common.ok", defaultMessage: "OK" }),
          ],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: getMainIntl().formatMessage({
            id: "main.dialog.setupSkills.failed",
            defaultMessage: "Could not set up the official Nodex Agent Skill.",
          }),
          detail: errorDetail(error),
        })
        .pipe(Effect.as({ status: "failed" } satisfies AgentSkillSetupResult)),
    ),
  );
}
