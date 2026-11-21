import { stripVTControlCharacters } from "node:util";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Types from "effect/Types";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type {
  CodexSettings,
  CustomModelSetting,
  ServerProvider,
  ServerProviderAuth,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderModel,
  ServerProviderSkill,
} from "@nodex/runtime-contracts";
import { PREFERRED_DEFAULT_CODEX_MODELS } from "@nodex/runtime-contracts";

import {
  codexModelFamily,
  createModelCapabilities,
  formatCodexModelName,
  readCustomModelEntries,
} from "@nodex/runtime-shared/model";
import { resolveSpawnCommand } from "@nodex/runtime-shared/shell";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@nodex/provider-core/server/snapshotProbe";
import { expandHomePath } from "@nodex/provider-core/server/pathExpansion";
import { makeUnavailableUsageLimits } from "@nodex/provider-core/server/usageLimits";
import {
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  type CodexRateLimitSnapshot,
  type CodexResetCreditsSummary,
} from "./codexUsageLimits.ts";
import * as HostProcess from "@nodex/runtime-shared/HostProcess";
import packageJson from "../../package.json" with { type: "json" };
const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);
const RATE_LIMITS_PROBE_TIMEOUT_MS = 3_000;

type CodexRateLimitsProbe =
  | {
      readonly snapshot: CodexRateLimitSnapshot;
      readonly rateLimitsByLimitId?:
        | Readonly<Record<string, CodexRateLimitSnapshot>>
        | null
        | undefined;
      readonly resetCredits: CodexResetCreditsSummary | null | undefined;
      /** The ChatGPT workspace the usage belongs to, when the backend names it. */
      readonly accountId?: string | null | undefined;
    }
  | { readonly failure: string };

const CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER = "2 seconds" as const;
const CODEX_MODEL_LIST_TIMEOUT_MS = 7_000;
const CODEX_SKILLS_PROBE_TIMEOUT_MS = 3_000;
const CODEX_CATALOG_REFRESH_TIMEOUT_MS = 3_000;
const CODEX_FAST_MODEL_LIST_MS = 1_000;
const CODEX_CATALOG_REFRESH_POLL = "100 millis" as const;

/**
 * How long an optional step may still take: its own limit, but never past the probe's deadline.
 * Waiting on a catalog refresh or on usage must never cost the account and models already read.
 */
export const codexProbeStepBudgetMs = (limitMs: number, nowMs: number, deadlineMs: number) =>
  Math.max(0, Math.min(limitMs, deadlineMs - nowMs));
/** Matches the identity Nodex uses for every native Codex connection. */
const CODEX_CLIENT_NAME = "nodex";
const CODEX_CLIENT_TITLE = "Nodex";

const CODEX_PRESENTATION = {
  displayName: "Codex",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
  // Native rollback truncates the conversation at any earlier Turn, so any user message can be edited.
  supportsConversationRollback: true,
} as const;

interface PreparedCodexSnapshot {
  readonly snapshot: ServerProviderDraft;
  readonly complete: Effect.Effect<ServerProviderDraft>;
}

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const DEFAULT_SERVICE_TIER_ID = "default";

/** Shorter copy for tiers whose catalog description wraps in the traits menu. */
const SERVICE_TIER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ultrafast: "Even faster, more expensive",
};

function reasoningEffortLabel(reasoningEffort: string): string {
  return REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort;
}

function codexAccountAuthLabel(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type !== "chatgpt") return undefined;
  return codexPlanLabel(account.planType);
}

/** Shared with usage-limit sources, which report the same `planType` slugs. */
export function codexPlanLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 20x Subscription";
    case "prolite":
      return "ChatGPT Pro 5x Subscription";
    case "promax":
      return "ChatGPT Pro Max Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_prolite":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "sci":
      return "ChatGPT Academic Researchers Subscription";
    case "sci_plus":
      return "ChatGPT Academic Researchers Plus Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return undefined;
  }
}

function codexAccountEmail(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account || account.type !== "chatgpt") return undefined;
  return account.email;
}

export function mapCodexModelCapabilities(
  model: CodexSchema.V2ModelListResponse__Model,
): ModelCapabilities {
  const reasoningOptions = model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
    reasoningEffort === model.defaultReasoningEffort
      ? {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
          isDefault: true,
        }
      : {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
        },
  );
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const serviceTiers =
    model.serviceTiers && model.serviceTiers.length > 0
      ? model.serviceTiers
      : (model.additionalSpeedTiers ?? []).map((id) => ({
          id,
          name: id === "fast" ? "Fast" : id,
          description: "",
        }));
  const catalogDefaultServiceTier = serviceTiers.some(
    (tier) => tier.id === model.defaultServiceTier,
  )
    ? model.defaultServiceTier
    : null;
  const defaultServiceTier = catalogDefaultServiceTier ?? DEFAULT_SERVICE_TIER_ID;
  const optionDescriptors: ProviderOptionDescriptor[] = [];

  if (reasoningOptions.length > 0) {
    optionDescriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: reasoningOptions,
      ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
    });
  }
  if (serviceTiers.length > 0) {
    optionDescriptors.push({
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        {
          id: DEFAULT_SERVICE_TIER_ID,
          label: "Standard",
          ...(defaultServiceTier === DEFAULT_SERVICE_TIER_ID ? { isDefault: true } : {}),
        },
        ...serviceTiers.map((tier) => {
          const description = SERVICE_TIER_DESCRIPTIONS[tier.id] ?? tier.description;
          return {
            id: tier.id,
            label: tier.name,
            ...(description ? { description } : {}),
            ...(defaultServiceTier === tier.id ? { isDefault: true } : {}),
          };
        }),
      ],
      currentValue: defaultServiceTier,
    });
  }

  return createModelCapabilities({
    inputModalities: model.inputModalities?.filter(
      (modality) => modality === "text" || modality === "image",
    ),
    optionDescriptors,
  });
}

function parseCodexModelListResponse(
  response: CodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> {
  return response.data.map((model) => ({
    slug: model.model,
    name: formatCodexModelName(model.displayName),
    isCustom: false,
    ...(model.isDefault ? { isDefault: true } : {}),
    capabilities: mapCodexModelCapabilities(model),
  }));
}

/**
 * Prefer our own default-model ranking when one of the preferred slugs is in
 * the live catalog; otherwise keep whatever Codex itself flagged as default.
 */
export function applyPreferredCodexDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const preferredSlug = PREFERRED_DEFAULT_CODEX_MODELS.flatMap((slug) =>
    models.filter((model) => !model.isCustom && codexModelFamily(model.slug) === slug),
  )[0]?.slug;
  if (!preferredSlug) {
    return models;
  }
  return models.map((model) => {
    if (model.slug === preferredSlug) {
      return model.isDefault ? model : { ...model, isDefault: true };
    }
    if (!model.isDefault) {
      return model;
    }
    const { isDefault: _isDefault, ...rest } = model;
    return rest;
  });
}

/**
 * Codex has no static default capability set, so a bare custom slug borrows
 * the first built-in's descriptors; an entry with its own capabilities keeps
 * them.
 */
function appendCustomCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  if (customModels.length === 0) {
    return models;
  }

  const seen = new Set(models.map((model) => model.slug));
  const fallbackCapabilities = models.find((model) => model.capabilities)?.capabilities ?? null;
  const customEntries: ServerProviderModel[] = [];
  for (const entry of readCustomModelEntries(customModels)) {
    if (seen.has(entry.slug)) {
      continue;
    }
    seen.add(entry.slug);
    customEntries.push({
      slug: entry.slug,
      name: entry.name,
      isCustom: true,
      capabilities: entry.capabilities ?? fallbackCapabilities,
    });
  }
  return customEntries.length === 0 ? models : [...models, ...customEntries];
}

function parseCodexSkillsListResponse(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Types.Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }
    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }
    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }
    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    return parsedSkill;
  });
}

const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: Pick<CodexProbeClient, "request">,
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

const decodeCodexModelsCacheStamp = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ fetched_at: Schema.String })),
);

/** When Codex last wrote `models_cache.json`, in epoch millis; NaN when unreadable. */
const readCodexModelsCacheFetchedAt = Effect.fn("readCodexModelsCacheFetchedAt")(function* (
  codexHome: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fileSystem
    .readFileString(path.join(codexHome, "models_cache.json"))
    .pipe(Effect.option);
  return Option.flatMap(text, decodeCodexModelsCacheStamp).pipe(
    Option.flatMap((stamp) => DateTime.make(stamp.fetched_at)),
    Option.match({ onNone: () => Number.NaN, onSome: DateTime.toEpochMillis }),
  );
});

/**
 * Lists the ChatGPT model catalog as fetched for Nodex.
 *
 * `model/list` serves `CODEX_HOME/models_cache.json` while it is under five
 * minutes old. Every Codex client on the machine shares that file, and the
 * backend tailors the catalog to each client's originator: the plain CLI does
 * not get Sol Ultrafast. So the first answer can be another client's catalog.
 * App-server refreshes the catalog online at startup, so wait until a write
 * newer than this process's spawn lands, then list again. If no refresh
 * lands in time, keep the first answer. Another client writing in the same
 * few hundred milliseconds can still win; the next probe corrects it.
 *
 * Only a fast first list might have been served while startup refresh was
 * still in flight. A slow list has already given that refresh time to finish.
 */
export const requestCodexChatGptModels = Effect.fn("requestCodexChatGptModels")(function* (input: {
  readonly client: Pick<CodexProbeClient, "request">;
  readonly codexHome: string;
  readonly spawnedAtMs: number;
  readonly deadlineMs: number;
}) {
  const fetchedBeforeList = yield* readCodexModelsCacheFetchedAt(input.codexHome);
  const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
  const models = yield* requestAllCodexModels(input.client);
  const listedAt = DateTime.toEpochMillis(yield* DateTime.now);
  if (fetchedBeforeList >= input.spawnedAtMs || listedAt - startedAt >= CODEX_FAST_MODEL_LIST_MS) {
    return models;
  }
  const waitMs = codexProbeStepBudgetMs(
    CODEX_CATALOG_REFRESH_TIMEOUT_MS,
    listedAt,
    input.deadlineMs,
  );
  if (waitMs === 0) return models;
  const refreshed = yield* readCodexModelsCacheFetchedAt(input.codexHome).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(CODEX_CATALOG_REFRESH_POLL),
      until: (fetchedAtMs) => fetchedAtMs >= input.spawnedAtMs,
    }),
    Effect.timeoutOption(Duration.millis(waitMs)),
  );
  if (Option.isNone(refreshed)) {
    yield* Effect.logWarning(
      "Codex did not refresh its model catalog in time; using the cached catalog.",
    );
    return models;
  }
  const remaining = input.deadlineMs - DateTime.toEpochMillis(yield* DateTime.now);
  if (remaining <= 0) return models;
  return yield* requestAllCodexModels(input.client).pipe(
    Effect.timeoutOption(Duration.millis(remaining)),
    Effect.orElseSucceed(() => Option.none()),
    Effect.map(Option.getOrElse(() => models)),
  );
});

/**
 * Environment for every `codex app-server` Nodex spawns.
 *
 * Codex sends its client name as the `originator` header, and the backend
 * tailors the model catalog to it. App-server starts its catalog refresh
 * before `initialize` names the client, so that first fetch goes out as the
 * plain CLI, misses tiers like Sol Ultrafast, and overwrites the shared
 * `models_cache.json`. Naming the originator at spawn closes that race.
 * A value the user already set wins.
 */
export const codexAppServerEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv => ({
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: CODEX_CLIENT_NAME,
  ...environment,
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: CODEX_CLIENT_NAME,
      title: CODEX_CLIENT_TITLE,
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

const launchCodexProbeClient = Effect.fn("launchCodexProbeClient")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly launchArgs?: string | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}) {
  // `~` is not shell-expanded when env vars are set via `child_process.spawn`,
  // so `CODEX_HOME=~/.codex_work` would reach codex verbatim and trip
  // "CODEX_HOME points to '~/.codex_work', but that path does not exist".
  // Expand here for parity with `CodexTextGeneration`.
  const resolvedHomePath = input.homePath
    ? expandHomePath(input.homePath, yield* HostProcess.HomeDirectory)
    : undefined;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = {
    ...codexAppServerEnvironment(input.environment),
    ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
  };
  const spawnCommand = yield* resolveSpawnCommand(
    input.binaryPath,
    codexAppServerArgs(input.launchArgs),
    { env: environment, extendEnv: true },
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        env: environment,
        extendEnv: true,
        // These short-lived probes have no independent lifetime. Keep them in
        // the Runtime's process group so Main can still stop them if it exits.
        detached: false,
        forceKillAfter: CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${input.binaryPath} app-server`,
            cause,
          }),
      ),
    );
  const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
  return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );
});

/** Opens a handshaken app-server for the lifetime of the caller's scope. */
export const withCodexAppServerClient = Effect.fn("withCodexAppServerClient")(function* (
  input: Parameters<typeof launchCodexProbeClient>[0],
) {
  const client = yield* launchCodexProbeClient(input);
  const initialize = yield* client.request("initialize", buildCodexInitializeParams());
  yield* client.notify("initialized", undefined);
  return { client, initialize };
});

const CODEX_COMMANDS = [
  COMPACT_SLASH_COMMAND,
  {
    name: "goal",
    description: "Set a goal Codex keeps working toward until it is done",
    input: { hint: "Objective, or pause, resume, clear" },
  },
  {
    name: "feedback",
    description: "Send this thread and Codex logs to OpenAI",
    input: { hint: "Describe the issue (optional)" },
  },
];

const SIGNED_OUT = {
  status: "error",
  auth: { status: "unauthenticated" },
  message: "Codex CLI is not authenticated. Run `codex login` and try again.",
} as const;

function localCodexAuth(
  authMethod: CodexSchema.GetAuthStatusResponse["authMethod"],
): ServerProviderAuth {
  if (authMethod === "chatgpt" || authMethod === "chatgptAuthTokens")
    return { status: "authenticated", type: "chatgpt", label: "ChatGPT" };
  if (authMethod === "apikey")
    return { status: "authenticated", type: "apiKey", label: "OpenAI API Key" };
  if (typeof authMethod === "string" && authMethod.length > 0)
    return { status: "authenticated", type: authMethod };
  return { status: "unknown" };
}

/** Provider output can contain credentials, terminal escapes, or URLs with secrets. */
function sanitizeCodexDiagnostic(value: string): string {
  return stripVTControlCharacters(value)
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/\b(?:authorization|cookie|api[_-]?key|(?:auth|access|refresh|session|id)[_-]?token|password)\s*["']?\s*[:=]/i.test(
          line,
        ),
    )
    .join("\n")
    .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_.=-]+/gi, "[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => (/[?#@]/.test(url) ? "[redacted URL]" : url))
    .trim()
    .slice(-2_000);
}

const decodeCachedCodexModels = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      client_version: Schema.String,
      models: Schema.Array(
        Schema.Struct({
          slug: Schema.String,
          display_name: Schema.String,
          visibility: Schema.String,
        }),
      ),
    }),
  ),
);

/** A ChatGPT-only seed while the native catalog (and its full capabilities) is loading. */
const readCachedCodexModels = Effect.fn("readCachedCodexModels")(function* (
  codexHome: string,
  version: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cached = yield* fs
    .readFileString(path.join(codexHome, "models_cache.json"))
    .pipe(Effect.option, Effect.map(Option.flatMap(decodeCachedCodexModels)));
  if (Option.isNone(cached) || cached.value.client_version !== version) return [];
  const models = cached.value.models
    .filter(
      ({ slug, display_name, visibility }) =>
        slug.trim() && display_name.trim() && visibility === "list",
    )
    .map(({ slug, display_name }): ServerProviderModel => ({
      slug: slug.trim(),
      name: formatCodexModelName(display_name.trim()),
      isCustom: false,
      capabilities: null,
    }));
  return applyPreferredCodexDefaultModel(models);
});

const readCodexUsage = Effect.fn("readCodexUsage")(function* (client: CodexProbeClient) {
  return yield* client.request("account/rateLimits/read", undefined).pipe(
    Effect.map((response): CodexRateLimitsProbe => ({
      snapshot: response.rateLimits,
      rateLimitsByLimitId: response.rateLimitsByLimitId,
      resetCredits: response.rateLimitResetCredits,
      accountId: response.accountId,
    })),
    Effect.timeoutOption(Duration.millis(RATE_LIMITS_PROBE_TIMEOUT_MS)),
    Effect.map(
      Option.getOrElse((): CodexRateLimitsProbe => ({
        failure: "Codex did not answer the usage request.",
      })),
    ),
    Effect.catch((error) =>
      Effect.succeed<CodexRateLimitsProbe>({ failure: codexRateLimitsFailureMessage(error) }),
    ),
  );
});

type CodexProbeClient = Pick<CodexClient.CodexAppServerClient["Service"], "request" | "notify"> & {
  readonly raw?: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "stderrTail">;
};

export const probeCodexSkillsForCwd = Effect.fn("probeCodexSkillsForCwd")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly exactCwd?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const { client } = yield* withCodexAppServerClient(input);
  const skillsResponse = yield* client.request("skills/list", { cwds: [input.cwd] });
  const response = input.exactCwd
    ? { ...skillsResponse, data: skillsResponse.data.filter(({ cwd }) => cwd === input.cwd) }
    : skillsResponse;
  return parseCodexSkillsListResponse(response, input.cwd);
});

const emptyCodexModelsFromSettings = (codexSettings: CodexSettings): ServerProvider["models"] =>
  appendCustomCodexModels([], codexSettings.customModels);

const makePendingCodexProvider = (
  codexSettings: CodexSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = emptyCodexModelsFromSettings(codexSettings);

    if (!codexSettings.enabled) {
      return buildServerProvider({
        presentation: CODEX_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        skills: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Codex is disabled in Nodex settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex provider status has not been checked in this session yet.",
      },
    });
  });

function accountProbeAuth(
  response: CodexSchema.V2GetAccountResponse,
  localAuth: ServerProviderAuth,
): ServerProviderAuth {
  const account = response.account;
  if (!account) return localAuth;
  const label = codexAccountAuthLabel(account);
  const email = codexAccountEmail(account);
  const workspaceId = response.workspaceRouting?.chatgptAccountId.trim();
  return {
    status: "authenticated",
    type: account.type,
    ...(label ? { label } : {}),
    ...(email ? { email } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

/**
 * Establishes executable and account readiness. Optional calls reuse the same
 * app-server and scope after the caller publishes the first snapshot.
 */
export const prepareCodexProviderStatus = Effect.fn("prepareCodexProviderStatus")(function* (
  codexSettings: CodexSettings,
  launch: (
    input: Parameters<typeof launchCodexProbeClient>[0],
  ) => Effect.Effect<
    CodexProbeClient,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  > = launchCodexProbeClient,
  environment: NodeJS.ProcessEnv = process.env,
  managedAuth?: ServerProviderAuth,
) {
  const now = yield* DateTime.now;
  const checkedAt = DateTime.formatIso(now);
  const spawnedAtMs = DateTime.toEpochMillis(now);
  const customModels = codexSettings.customModels;
  const cwd = process.cwd();
  const build = (
    probe: ProviderProbeResult,
    models = emptyCodexModelsFromSettings(codexSettings),
    skills: ServerProvider["skills"] = [],
  ) =>
    buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models,
      skills,
      ...(probe.installed ? { slashCommands: CODEX_COMMANDS } : {}),
      probe,
    });

  if (!codexSettings.enabled) return yield* makePendingCodexProvider(codexSettings);
  let version: string | null = null;
  let auth: ServerProviderAuth = managedAuth ?? { status: "unknown" };
  let client: CodexProbeClient | undefined;
  let readingAccount = false;
  const accountUnavailable = (detail: string) => {
    const summary =
      auth.type === "chatgpt"
        ? "Codex is signed in but couldn’t reach your ChatGPT account. Check your network connection or proxy."
        : "Codex is signed in but couldn’t read its account. Check your connection or provider configuration.";
    return build({
      installed: true,
      version,
      status: "error",
      issue: "account-unavailable",
      auth,
      message: detail ? `${summary} ${detail}` : summary,
    });
  };

  const essential = yield* Effect.gen(function* () {
    client = yield* launch({
      binaryPath: codexSettings.binaryPath,
      homePath: codexSettings.homePath,
      launchArgs: resolveCodexLaunchArgs(codexSettings.launchArgs, environment),
      cwd,
      environment,
    });
    const initialize = yield* client.request("initialize", buildCodexInitializeParams());
    version = initialize.userAgent.match(/\/([^\s]+)/)?.[1] ?? null;
    yield* client.notify("initialized", undefined);
    if (!managedAuth) {
      const local = yield* client
        .request("getAuthStatus", {
          includeToken: false,
          refreshToken: false,
        })
        .pipe(
          // Reading this computer's sign-in only lets the check answer without the network.
          // An app-server that can't answer it, or answers in another shape, still has
          // account/read, which stays the authority on who is signed in.
          Effect.orElseSucceed(() => null),
        );
      if (local) {
        auth = localCodexAuth(local.authMethod);
        if (local.authMethod === null && local.requiresOpenaiAuth === true) return null;
      }
    }
    readingAccount = true;
    const account = yield* client.request("account/read", { refreshToken: false });
    if (!managedAuth && !account.account && account.requiresOpenaiAuth)
      return auth.status === "authenticated" ? ("account-missing" as const) : null;
    auth = managedAuth ?? accountProbeAuth(account, auth);
    return { client, initialize, chatGpt: account.account?.type === "chatgpt" };
  }).pipe(Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS)), Effect.result);

  if (Result.isFailure(essential)) {
    const error = essential.failure;
    const installed = !isCodexAppServerSpawnError(error);
    if (!installed) {
      return build({
        installed,
        version,
        status: "error",
        auth,
        message: "Could not start Codex. Make sure the Codex executable is present and can run.",
      });
    }
    if (readingAccount && auth.status === "authenticated")
      return accountUnavailable(sanitizeCodexDiagnostic(error.message));
    const stderr = client?.raw?.stderrTail ? yield* client.raw.stderrTail : "";
    const detail = sanitizeCodexDiagnostic(stderr) || sanitizeCodexDiagnostic(error.message);
    return build({
      installed,
      version,
      status: "error",
      issue: "failed",
      auth,
      message: detail
        ? `Codex failed its readiness check. ${detail}`
        : "Codex failed its readiness check.",
    });
  }

  if (Option.isNone(essential.success))
    return build({
      installed: true,
      version,
      status: "error",
      issue: "unresponsive",
      auth,
      message: "Codex didn’t answer its readiness check within 30 seconds.",
    });

  const connected = essential.success.value;
  if (!connected) {
    const signedOut = { installed: true, version, ...SIGNED_OUT };
    const snapshot = build(signedOut);
    if (!client) return snapshot;
    // Publish sign-out immediately. Public model discovery is optional, just as
    // it is for an authenticated account.
    const complete = requestAllCodexModels(client).pipe(
      Effect.timeoutOption(Duration.millis(CODEX_FAST_MODEL_LIST_MS)),
      Effect.map((listed) =>
        Option.isSome(listed)
          ? build(
              signedOut,
              applyPreferredCodexDefaultModel(appendCustomCodexModels(listed.value, customModels)),
            )
          : snapshot,
      ),
      Effect.orElseSucceed(() => snapshot),
    );
    return { snapshot, complete } satisfies PreparedCodexSnapshot;
  }
  if (connected === "account-missing")
    return accountUnavailable("Codex returned no account for this sign-in.");
  const { client: active, initialize, chatGpt } = connected;
  const cached =
    chatGpt && !managedAuth
      ? yield* readCachedCodexModels(initialize.codexHome, version).pipe(
          Effect.timeoutOption("250 millis"),
          Effect.map(Option.getOrElse((): ReadonlyArray<ServerProviderModel> => [])),
        )
      : [];
  const fallback = appendCustomCodexModels(cached, customModels);
  const ready = { installed: true, version, status: "ready", auth } as const;
  const usageUnsupported = auth.type === "apiKey" || !chatGpt;
  const initialProbe = {
    ...ready,
    ...(usageUnsupported && !managedAuth
      ? { usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }) }
      : {}),
  };
  const snapshot = {
    ...build(
      fallback.length
        ? initialProbe
        : {
            ...initialProbe,
            status: "warning",
            message: "Codex is available. Its model catalog is still loading.",
          },
      fallback,
    ),
    modelsProvisional: true as const,
  };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const complete = Effect.gen(function* () {
    const deadlineMs = DateTime.toEpochMillis(yield* DateTime.now) + CODEX_MODEL_LIST_TIMEOUT_MS;
    const [models, skills, rateLimits] = yield* Effect.all(
      [
        (chatGpt
          ? requestCodexChatGptModels({
              client: active,
              codexHome: initialize.codexHome,
              spawnedAtMs,
              deadlineMs,
            })
          : requestAllCodexModels(active)
        ).pipe(
          Effect.timeoutOption(Duration.millis(CODEX_MODEL_LIST_TIMEOUT_MS)),
          Effect.orElseSucceed(() => Option.none()),
        ),
        active.request("skills/list", { cwds: [cwd] }).pipe(
          Effect.map((response) => parseCodexSkillsListResponse(response, cwd)),
          Effect.timeoutOption(Duration.millis(CODEX_SKILLS_PROBE_TIMEOUT_MS)),
          Effect.orElseSucceed(() => Option.none()),
        ),
        managedAuth || usageUnsupported ? Effect.succeed(undefined) : readCodexUsage(active),
      ],
      { concurrency: "unbounded" },
    );
    const listed = Option.getOrUndefined(models);
    const catalog = listed?.length ? listed : undefined;
    const usageLimits =
      rateLimits === undefined
        ? initialProbe.usageLimits
        : "failure" in rateLimits
          ? makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: rateLimits.failure,
            })
          : codexRateLimitsToLimits({
              snapshot: rateLimits.snapshot,
              rateLimitsByLimitId: rateLimits.rateLimitsByLimitId,
              resetCredits: rateLimits.resetCredits,
              checkedAt,
            });
    const workspaceId =
      rateLimits && "accountId" in rateLimits ? rateLimits.accountId?.trim() : undefined;
    const draft = build(
      {
        ...ready,
        ...(!catalog || Option.isNone(skills)
          ? {
              status: "warning",
              message: !catalog
                ? "Codex couldn’t refresh its model catalog."
                : "Codex couldn’t read its skills.",
            }
          : {}),
        auth: workspaceId && !auth.workspaceId ? { ...auth, workspaceId } : auth,
        ...(usageLimits ? { usageLimits } : {}),
      },
      catalog
        ? applyPreferredCodexDefaultModel(appendCustomCodexModels(catalog, customModels))
        : fallback,
      Option.getOrElse(skills, () => []),
    );
    return catalog ? draft : { ...draft, modelsProvisional: true as const };
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
  return { snapshot, complete } satisfies PreparedCodexSnapshot;
});

/** Checks and collects the full snapshot for callers without progressive publication. */
export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  ...args: Parameters<typeof prepareCodexProviderStatus>
) {
  const checked = yield* prepareCodexProviderStatus(...args);
  return "complete" in checked ? yield* checked.complete : checked;
}, Effect.scoped);

export { makePendingCodexProvider };
