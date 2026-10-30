/* @effect-diagnostics asyncFunction:off -- bounded HTTP requests are a Node platform boundary. */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { z } from "zod";
import { NodexModelAccessError, NodexModelAccessPlatform } from "../NodexModelAccessPlatform";

const unavailable = () => new NodexModelAccessError({ code: "unavailable" });
export const modelAccessSchema = z.object({
  apiKey: z.string().min(1).max(16_384),
  openaiBaseUrl: z.literal("https://api.jyu.app/v1"),
  anthropicBaseUrl: z.literal("https://api.jyu.app"),
  models: z
    .array(
      z.object({ id: z.string(), label: z.string(), protocol: z.enum(["openai", "anthropic"]) }),
    )
    .max(100),
  consoleUrl: z
    .string()
    .url()
    .refine((value) => new URL(value).origin === "https://console.nodex.jyu.app"),
  topUpUrl: z.literal("https://console.nodex.jyu.app/topup"),
});
const errorSchema = z.object({
  error: z.object({
    code: z.enum(["unauthenticated", "forbidden_client", "email_unverified", "unavailable"]),
  }),
});
const request = (url: string, init: RequestInit) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal, redirect: "error" });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (reader) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 64 * 1024) throw unavailable();
          chunks.push(part.value);
        }
      } finally {
        await reader?.cancel().catch(() => undefined);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (response.ok) return body;
      const error = errorSchema.safeParse(body);
      throw error.success
        ? new NodexModelAccessError({ code: error.data.error.code })
        : unavailable();
    },
    catch: (cause) => (cause instanceof NodexModelAccessError ? cause : unavailable()),
  }).pipe(Effect.timeout("15 seconds"), Effect.catchTag("TimeoutError", unavailable));

/** Only a development test build can route credentials to the explicit loopback fixture. */
export const make = (host: {
  readonly isPackaged: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly openExternal: (url: string) => Promise<void>;
}) => {
  const override = host.environment.NODEX_TEST_MODEL_ACCESS_ORIGIN;
  const loopback =
    !host.isPackaged &&
    host.environment.NODEX_TEST_CLERK_LOOPBACK === "1" &&
    override &&
    /^http:\/\/127\.0\.0\.1:\d+$/u.test(override)
      ? override
      : null;
  return NodexModelAccessPlatform.of({
    exchange: (token) =>
      request(`${loopback ?? "https://api.nodex.jyu.app"}/v1/model-access`, {
        method: "POST",
        headers: { authorization: `Bearer ${Redacted.value(token)}` },
      }).pipe(
        Effect.flatMap((body) => {
          const parsed = modelAccessSchema.safeParse(body);
          return parsed.success
            ? Effect.succeed({ ...parsed.data, apiKey: Redacted.make(parsed.data.apiKey) })
            : unavailable();
        }),
      ),
    balance: (access) =>
      request(`${loopback ?? "https://api.jyu.app"}/v1/usage`, {
        headers: { authorization: `Bearer ${Redacted.value(access.apiKey)}` },
      }).pipe(
        Effect.flatMap((body) => {
          const parsed = z
            .object({ balance: z.number().finite(), unit: z.literal("USD") })
            .safeParse(body);
          return parsed.success ? Effect.succeed(parsed.data.balance) : unavailable();
        }),
      ),
    openTopUp: Effect.tryPromise({
      try: () => host.openExternal("https://console.nodex.jyu.app/topup"),
      catch: unavailable,
    }),
  });
};
