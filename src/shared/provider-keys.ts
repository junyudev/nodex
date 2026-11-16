import { z } from "zod";
import { defineMessages } from "./i18n/messages";

/**
 * Model providers a person can connect with their own API key. Each serves an Anthropic-compatible
 * endpoint, so Nodex runs its models through its built-in Claude Code: nothing to install, and the
 * key is stored encrypted with the system keychain.
 */
export type ProviderKeyPresetId = "deepseek" | "moonshot" | "zhipu" | "minimax" | "custom";

export interface ProviderKeyEndpoint {
  /** The service's region; a preset with both offers the choice. */
  readonly id: "china" | "international";
  /** Claude Code's `ANTHROPIC_BASE_URL`. */
  readonly baseUrl: string;
  /** An OpenAI-compatible model list, read when the Anthropic-compatible one doesn't answer. */
  readonly modelsUrl?: string;
  /** Where the person creates a key for this endpoint. */
  readonly keyUrl: string;
}

export interface ProviderKeyModel {
  readonly id: string;
  readonly name: string;
}

export interface ProviderKeyPreset {
  readonly id: ProviderKeyPresetId;
  readonly name: string;
  /** The first endpoint is the default; a custom connection names its own. */
  readonly endpoints: readonly ProviderKeyEndpoint[];
  /** Models offered, best first, when the provider doesn't list its own. */
  readonly models: readonly ProviderKeyModel[];
  /** Which listed model ids are this provider's chat models; others (embeddings, audio) are left out. */
  readonly includes: RegExp;
  /** How the provider's keys begin, when they share a prefix. */
  readonly keyPlaceholder?: string;
}

export const PROVIDER_KEY_REGION_MESSAGES = defineMessages({
  china: { id: "providerKeys.region.china", defaultMessage: "China" },
  international: { id: "providerKeys.region.international", defaultMessage: "International" },
});

const anyModel = /^(?!.*(?:embed|rerank|tts|asr|audio|speech|image|vision|ocr|moderation))/iu;

export const PROVIDER_KEY_PRESETS: readonly ProviderKeyPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    endpoints: [
      {
        id: "international",
        baseUrl: "https://api.deepseek.com/anthropic",
        modelsUrl: "https://api.deepseek.com/models",
        keyUrl: "https://platform.deepseek.com/api_keys",
      },
    ],
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
    ],
    includes: /^deepseek-(?!.*(?:vision|exp))/iu,
    keyPlaceholder: "sk-…",
  },
  {
    id: "moonshot",
    name: "Kimi",
    endpoints: [
      {
        id: "china",
        baseUrl: "https://api.moonshot.cn/anthropic",
        modelsUrl: "https://api.moonshot.cn/v1/models",
        keyUrl: "https://platform.moonshot.cn/console/api-keys",
      },
      {
        id: "international",
        baseUrl: "https://api.moonshot.ai/anthropic",
        modelsUrl: "https://api.moonshot.ai/v1/models",
        keyUrl: "https://platform.moonshot.ai/console/api-keys",
      },
    ],
    models: [
      { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
      { id: "kimi-k3", name: "Kimi K3" },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    ],
    includes: /^kimi-(?!.*(?:vision|thinking-preview))/iu,
    keyPlaceholder: "sk-…",
  },
  {
    id: "zhipu",
    name: "GLM",
    endpoints: [
      {
        id: "china",
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        modelsUrl: "https://open.bigmodel.cn/api/paas/v4/models",
        keyUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
      },
      {
        id: "international",
        baseUrl: "https://api.z.ai/api/anthropic",
        modelsUrl: "https://api.z.ai/api/paas/v4/models",
        keyUrl: "https://z.ai/manage-apikey/apikey-list",
      },
    ],
    models: [
      { id: "glm-5.3", name: "GLM-5.3" },
      { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    ],
    includes: /^glm-(?!.*(?:\dv|-v-|vision|realtime|voice|image|video))/iu,
  },
  {
    id: "minimax",
    name: "MiniMax",
    endpoints: [
      {
        id: "china",
        baseUrl: "https://api.minimaxi.com/anthropic",
        keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
      },
      {
        id: "international",
        baseUrl: "https://api.minimax.io/anthropic",
        keyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
      },
    ],
    models: [
      { id: "MiniMax-M3", name: "MiniMax M3" },
      { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash" },
    ],
    includes: /^minimax-m/iu,
  },
  {
    id: "custom",
    name: "Other",
    endpoints: [],
    models: [],
    includes: anyModel,
  },
];

export const providerKeyPreset = (id: ProviderKeyPresetId): ProviderKeyPreset =>
  PROVIDER_KEY_PRESETS.find((preset) => preset.id === id)!;

/** The most connections a Profile keeps, and the most models one offers. */
export const PROVIDER_KEY_LIMIT = 16;
export const PROVIDER_KEY_MODEL_LIMIT = 64;

/** A saved connection as every reader sees it: the key itself never leaves Main. */
export interface ProviderKeyConnection {
  readonly id: string;
  readonly preset: ProviderKeyPresetId;
  /** A preset endpoint; null for a custom connection. */
  readonly endpoint: ProviderKeyEndpoint["id"] | null;
  /** A custom connection's own Anthropic-compatible base URL; null for a preset. */
  readonly baseUrl: string | null;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly models: readonly ProviderKeyModel[];
  /** The key's last four characters, so a person can tell keys apart. */
  readonly keyHint: string;
}

export interface ProviderKeySettings {
  readonly connections: readonly ProviderKeyConnection[];
}

const text = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !value.includes("\0"));

export const PROVIDER_KEY_BASE_URL_PROBLEM_MESSAGES = defineMessages({
  invalid: {
    id: "providerKeys.baseUrl.invalid",
    defaultMessage: "Enter the endpoint’s full URL, such as https://example.com/anthropic.",
  },
  credentials: {
    id: "providerKeys.baseUrl.credentials",
    defaultMessage: "Put the key in the key field, not the URL.",
  },
  query: {
    id: "providerKeys.baseUrl.query",
    defaultMessage: "Enter the base URL without a query or fragment.",
  },
  insecure: {
    id: "providerKeys.baseUrl.insecure",
    defaultMessage: "Use an https:// URL, or http:// only for this computer.",
  },
});
export type ProviderKeyBaseUrlProblem = keyof typeof PROVIDER_KEY_BASE_URL_PROBLEM_MESSAGES;

/** HTTPS, or plain HTTP to this computer for a local gateway. */
export const providerKeyBaseUrlProblem = (value: string): ProviderKeyBaseUrlProblem | null => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "invalid";
  }
  if (url.username || url.password) return "credentials";
  if (url.href.includes("?") || url.href.includes("#")) return "query";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    return null;
  return "insecure";
};

const BaseUrlSchema = text(2048).superRefine((value, context) => {
  const problem = providerKeyBaseUrlProblem(value);
  if (problem)
    context.addIssue({
      code: "custom",
      message: PROVIDER_KEY_BASE_URL_PROBLEM_MESSAGES[problem].defaultMessage as string,
    });
});
export const ProviderKeyModelSchema = z.object({ id: text(256), name: text(128) }).strict();
const ModelsSchema = z
  .array(ProviderKeyModelSchema)
  .max(PROVIDER_KEY_MODEL_LIMIT)
  .refine((models) => new Set(models.map(({ id }) => id)).size === models.length);
const ApiKeySchema = text(4096).refine((value) => !/\s/u.test(value), "A key has no spaces.");

/** Where a connection sends requests; identical for checking a key and for saving it. */
export const ProviderKeyTargetSchema = z.discriminatedUnion("preset", [
  z
    .object({
      preset: z.enum(["deepseek", "moonshot", "zhipu", "minimax"]),
      endpoint: z.enum(["china", "international"]),
    })
    .strict()
    .refine(
      ({ preset, endpoint }) =>
        providerKeyPreset(preset).endpoints.some(({ id }) => id === endpoint),
      "That provider has no such endpoint.",
    ),
  z.object({ preset: z.literal("custom"), baseUrl: BaseUrlSchema }).strict(),
]);
export type ProviderKeyTarget = z.infer<typeof ProviderKeyTargetSchema>;

/**
 * Checks the key against the provider and saves a connection with the models it lists. A custom
 * endpoint that lists none uses the models the person typed.
 */
export const ProviderKeyConnectInputSchema = z
  .object({
    target: ProviderKeyTargetSchema,
    apiKey: ApiKeySchema,
    displayName: text(128).optional(),
    models: ModelsSchema.optional(),
  })
  .strict();
export type ProviderKeyConnectInput = z.infer<typeof ProviderKeyConnectInputSchema>;

/** Changes one saved connection. A new key is checked before it replaces the old one. */
export const ProviderKeyUpdateInputSchema = z
  .object({
    id: text(128),
    displayName: text(128).optional(),
    enabled: z.boolean().optional(),
    apiKey: ApiKeySchema.optional(),
    models: ModelsSchema.min(1).optional(),
  })
  .strict();
export type ProviderKeyUpdateInput = z.infer<typeof ProviderKeyUpdateInputSchema>;

export const ProviderKeyIdInputSchema = z.object({ id: text(128) }).strict();

/** Why a key couldn't be used; the result's message says so in the display language. */
export type ProviderKeyFailureReason =
  /** The provider answered and refused the key. */
  | "rejected"
  /** The endpoint couldn't be reached or answered with something other than a model list. */
  | "unreachable"
  /** A custom endpoint lists no models and none were typed. */
  | "no-models"
  /** The keychain is locked or unavailable. */
  | "storage";

export type ProviderKeyResult =
  | { readonly ok: true; readonly settings: ProviderKeySettings; readonly connectionId: string }
  | {
      readonly ok: false;
      readonly reason: ProviderKeyFailureReason;
      readonly message: string;
    };

/** Runtime provider instances for connections are `key_<preset>_<connection id>`. */
const RUNTIME_INSTANCE_PATTERN =
  /^key_(deepseek|moonshot|zhipu|minimax|custom)_([a-z0-9-]{1,64})$/u;

export const providerKeyRuntimeInstanceId = (
  connection: Pick<ProviderKeyConnection, "id" | "preset">,
): string => `key_${connection.preset}_${connection.id}`;

export const isProviderKeyRuntimeInstanceId = (instanceId: string): boolean =>
  RUNTIME_INSTANCE_PATTERN.test(instanceId);

/** The preset a runtime instance belongs to, so its models show the provider's own mark. */
export const providerKeyPresetOfInstanceId = (instanceId: string): ProviderKeyPresetId | null =>
  (RUNTIME_INSTANCE_PATTERN.exec(instanceId)?.[1] as ProviderKeyPresetId | undefined) ?? null;

/** The connection a runtime instance runs, so its settings can open on it. */
export const providerKeyConnectionIdOfInstanceId = (instanceId: string): string | null =>
  RUNTIME_INSTANCE_PATTERN.exec(instanceId)?.[2] ?? null;

/** The endpoint a saved connection or a check sends requests to. */
export function providerKeyBaseUrl(target: ProviderKeyTarget): string {
  if (target.preset === "custom") return target.baseUrl.trim().replace(/\/+$/u, "");
  const preset = providerKeyPreset(target.preset);
  return (preset.endpoints.find(({ id }) => id === target.endpoint) ?? preset.endpoints[0]!)
    .baseUrl;
}

export function providerKeyTarget(connection: ProviderKeyConnection): ProviderKeyTarget {
  return connection.preset === "custom"
    ? { preset: "custom", baseUrl: connection.baseUrl ?? "" }
    : {
        preset: connection.preset,
        endpoint: connection.endpoint ?? providerKeyPreset(connection.preset).endpoints[0]!.id,
      };
}

/** A custom connection is named after its endpoint's host until the person names it. */
export function providerKeyDefaultName(target: ProviderKeyTarget): string {
  if (target.preset !== "custom") return providerKeyPreset(target.preset).name;
  try {
    return new URL(target.baseUrl).hostname.replace(/^(?:api|www)\./u, "");
  } catch {
    return "Custom endpoint";
  }
}

const BRAND_WORDS: Readonly<Record<string, string>> = {
  deepseek: "DeepSeek",
  glm: "GLM",
  kimi: "Kimi",
  minimax: "MiniMax",
  qwen: "Qwen",
  gpt: "GPT",
  claude: "Claude",
  gemini: "Gemini",
  llama: "Llama",
};

/**
 * A readable name for a model id the provider listed without one: `deepseek-v4-pro` →
 * `DeepSeek V4 Pro`, `claude-opus-5-5` → `Claude Opus 5.5`.
 */
export function providerKeyModelName(presetId: ProviderKeyPresetId, id: string): string {
  const known = providerKeyPreset(presetId).models.find((model) => model.id === id);
  if (known) return known.name;
  const words: string[] = [];
  for (const word of id.split(/[-_/]+/u).filter(Boolean)) {
    const lower = word.toLowerCase();
    const previous = words.at(-1);
    // A version written with dashes, such as `5-5`, reads as `5.5`.
    if (/^\d+$/u.test(word) && previous !== undefined && /\d$/u.test(previous)) {
      words[words.length - 1] = `${previous}.${word}`;
      continue;
    }
    words.push(
      BRAND_WORDS[lower] ??
        (/^v\d/u.test(lower) || /^[a-z]\d/u.test(lower)
          ? word.toUpperCase()
          : word.charAt(0).toUpperCase() + word.slice(1)),
    );
  }
  return words.join(" ");
}

/**
 * The models a connection offers from what the provider listed: its chat models, the preset's
 * known ones first in their order, then the rest as listed.
 */
export function providerKeyModels(
  presetId: ProviderKeyPresetId,
  listed: readonly { readonly id: string; readonly name?: string | null }[],
): ProviderKeyModel[] {
  const preset = providerKeyPreset(presetId);
  const seen = new Set<string>();
  const models = listed
    .filter(({ id }) => {
      if (!id || seen.has(id) || !preset.includes.test(id) || !anyModel.test(id)) return false;
      seen.add(id);
      return true;
    })
    // A listed name that only repeats the id says no more than the id does.
    .map(({ id, name }) => ({
      id,
      name: name?.trim() && name.trim() !== id ? name.trim() : providerKeyModelName(presetId, id),
    }));
  const rank = (id: string) => {
    const index = preset.models.findIndex((model) => model.id === id);
    return index === -1 ? preset.models.length : index;
  };
  return models
    .map((model, index) => ({ model, index }))
    .toSorted(
      (left, right) => rank(left.model.id) - rank(right.model.id) || left.index - right.index,
    )
    .map(({ model }) => model)
    .slice(0, PROVIDER_KEY_MODEL_LIMIT);
}

/**
 * Claude Code asks for Opus, Sonnet and Haiku by name for its own work, such as subagents and
 * quick summaries; these point each at a model the provider serves. The first model leads, and
 * the lightest-sounding one does quick work.
 */
export function providerKeyClaudeModelEnvironment(
  models: readonly ProviderKeyModel[],
): Readonly<Record<string, string>> {
  const main = models[0]?.id;
  if (!main) return {};
  const quick = models.find(({ id }) => /flash|turbo|fast|mini|lite|air|highspeed/iu.test(id))?.id;
  return {
    ANTHROPIC_MODEL: main,
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: quick ?? main,
    CLAUDE_CODE_SUBAGENT_MODEL: main,
  };
}

/** The last four characters of a key; shorter keys show nothing. */
export const providerKeyHint = (apiKey: string): string =>
  apiKey.trim().length >= 12 ? apiKey.trim().slice(-4) : "";
