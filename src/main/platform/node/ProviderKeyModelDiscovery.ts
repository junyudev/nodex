/* @effect-diagnostics asyncFunction:off -- bounded provider HTTP is a Node platform boundary. */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { z } from "zod";
import {
  providerKeyApi,
  providerKeyBaseUrl,
  providerKeyEndpointOf,
  providerKeyModels,
  providerKeyPreset,
  ProviderKeyModelSchema,
  type ProviderKeyResult,
} from "../../../shared/provider-keys";
import { getMainIntl } from "../../i18n/main-intl";
import type { ProviderKeyDiscovery } from "../../provider-keys/ProviderKeys";

const MAX_PAGES = 4;
const MAX_BODY_BYTES = 1024 * 1024;
const ModelEntrySchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine((id) => !id.includes("\0")),
  display_name: z.string().nullish().catch(null),
  name: z.string().nullish().catch(null),
});
const CodexModelTraitsSchema = z.object({
  context_window: ProviderKeyModelSchema.shape.contextWindow.catch(undefined),
  input_modalities: z.array(z.string()).optional().catch(undefined),
  effort: z
    .object({
      supported_levels: ProviderKeyModelSchema.shape.reasoningEfforts.catch(undefined),
      default_level: ProviderKeyModelSchema.shape.defaultReasoningEffort.catch(undefined),
    })
    .optional()
    .catch(undefined),
});
const ModelListSchema = z.object({
  data: z.array(z.unknown()),
  has_more: z.boolean().optional().catch(undefined),
  last_id: z.string().max(256).nullish().catch(null),
});
const code = z.union([z.string(), z.number()]).optional().catch(undefined);
const AuthErrorSchema = z.object({
  code,
  type: code,
  message: code,
  error: z
    .union([z.string(), z.object({ code, type: code, message: code })])
    .optional()
    .catch(undefined),
});
const isAuthFailure = (value: unknown): boolean => {
  const parsed = AuthErrorSchema.safeParse(value);
  if (!parsed.success) return false;
  const { error, ...outer } = parsed.data;
  const signals = [
    outer.code,
    outer.type,
    outer.message,
    typeof error === "string" ? error : error?.code,
    typeof error === "object" ? error.type : undefined,
    typeof error === "object" ? error.message : undefined,
  ];
  return signals.some(
    (entry) =>
      entry === 401 ||
      entry === 403 ||
      (typeof entry === "string" &&
        /^(401|403|unauthorized|forbidden)$|auth(?:entication|orization)[ _-]?(?:error|failed|required)|(?:invalid|missing|incorrect|expired)[ _-]?(?:api[ _-]?)?(?:key|token)|invalid[ _-]?api[ _-]?key/iu.test(
          entry.trim(),
        )),
  );
};

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error("Model list response exceeded its size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

type Rejection = Extract<ProviderKeyResult, { ok: false }>;

export const providerKeyModelDiscovery =
  (request: typeof fetch = fetch): ProviderKeyDiscovery =>
  (target, key, manualModels) => {
    const preset = providerKeyPreset(target.preset);
    const base = providerKeyBaseUrl(target);
    const provider = target.preset === "custom" ? new URL(base).hostname : preset.name;
    const intl = getMainIntl();
    const rejected: Rejection = {
      ok: false,
      reason: "rejected",
      message: intl.formatMessage(
        {
          id: "main.providerKeys.keyRejected",
          defaultMessage: "{provider} didn’t accept this key.",
        },
        { provider },
      ),
    };
    const unreachable: Rejection = {
      ok: false,
      reason: "unreachable",
      message: intl.formatMessage(
        {
          id: "main.providerKeys.unreachable",
          defaultMessage: "Couldn’t reach {provider}. Check the URL and your connection.",
        },
        { provider },
      ),
    };
    // Codex speaks the provider's OpenAI-compatible API, so its models list there.
    const codex = providerKeyApi(target.agent) === "responses";
    const fallback = providerKeyEndpointOf(target)?.modelsUrl;
    const listing = `${base}${codex ? "" : "/v1"}/models`;

    return Effect.tryPromise({
      catch: (cause) => (cause === rejected ? rejected : unreachable),
      try: async (signal) => {
        const apiKey = Redacted.value(key);
        const bearer = { Authorization: `Bearer ${apiKey}` };
        const anthropic = { ...bearer, "x-api-key": apiKey, "anthropic-version": "2023-06-01" };

        const read = async (url: URL, headers: Record<string, string>) => {
          const response = await request(url, {
            method: "GET",
            headers,
            redirect: "error",
            signal,
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            if (response.status === 401 || response.status === 403) throw rejected;
            if (response.status === 404 || response.status === 405) return null;
            throw unreachable;
          }
          const body = await readJson(response);
          if (isAuthFailure(body)) throw rejected;
          const page = ModelListSchema.safeParse(body);
          return page.success ? page.data : undefined;
        };

        const headers = codex ? bearer : anthropic;
        let url = new URL(listing);
        let page = await read(url, headers);
        const pages = [];
        if (fallback && fallback !== listing && (page === null || (!codex && !page))) {
          page = await read(new URL(fallback), bearer);
          if (page) pages.push(page);
        } else {
          for (let index = 0; page && index < MAX_PAGES; index += 1) {
            pages.push(page);
            if (
              codex ||
              !page.has_more ||
              !page.last_id ||
              page.last_id.includes(apiKey) ||
              url.searchParams.get("after_id") === page.last_id ||
              index + 1 === MAX_PAGES
            )
              break;
            const nextUrl = new URL(url);
            nextUrl.searchParams.set("after_id", page.last_id);
            url = nextUrl;
            page = await read(url, headers);
          }
        }

        const listed = pages.flatMap(({ data }) =>
          data.flatMap((entry) => {
            const model = ModelEntrySchema.safeParse(entry);
            if (!model.success || model.data.id.includes(apiKey)) return [];
            const { id, display_name, name } = model.data;
            const label = display_name?.trim() || name?.trim();
            const traits = codex ? CodexModelTraitsSchema.safeParse(entry).data : undefined;
            const efforts = traits?.effort?.supported_levels?.filter(
              (effort) => !effort.includes(apiKey),
            );
            const defaultEffort = traits?.effort?.default_level;
            return [
              {
                id,
                name:
                  label && !label.includes(apiKey) && !label.includes("\0")
                    ? label.slice(0, 128)
                    : null,
                contextWindow: traits?.context_window,
                reasoningEfforts: efforts?.length ? efforts : undefined,
                defaultReasoningEffort: defaultEffort?.includes(apiKey) ? undefined : defaultEffort,
                images: traits?.input_modalities?.includes("image"),
              },
            ];
          }),
        );
        const models = providerKeyModels(target.preset, listed).flatMap(({ name, ...model }) =>
          name
            ? [
                codex
                  ? { ...model, name: name.slice(0, 128) }
                  : { id: model.id, name: name.slice(0, 128) },
              ]
            : [],
        );
        if (models.length) return { ok: true, models } as const;
        const alternative = target.preset === "custom" ? manualModels : preset.models;
        if (alternative?.length) return { ok: true, models: alternative } as const;
        return {
          ok: false,
          reason: "no-models",
          message: intl.formatMessage(
            {
              id: "main.providerKeys.noModels",
              defaultMessage: "{provider} doesn’t list its models. Enter the model IDs to use.",
            },
            { provider },
          ),
        } as const;
      },
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catch((failure) => Effect.succeed(failure === rejected ? rejected : unreachable)),
    );
  };
