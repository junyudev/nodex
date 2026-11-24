/* @effect-diagnostics asyncFunction:off -- bounded provider HTTP is a Node platform boundary. */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { z } from "zod";
import type { ProviderKeyUsageWindow } from "../../../shared/provider-key-usage";
import type { ProviderKeyConnection } from "../../../shared/provider-keys";
import type {
  ProviderKeyReading,
  ProviderKeyUsageReader,
} from "../../provider-keys/ProviderKeyUsage";

const MAX_BODY_BYTES = 64 * 1024;
const READ_FAILED = "read-failed" as const;

type Parse = (body: unknown) => ProviderKeyReading | null | undefined;

const DeepSeekBalance = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(z.unknown()),
});
const DeepSeekCurrency = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  total_balance: z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/u)
    .transform(Number)
    .pipe(z.number()),
});

const deepSeek: Parse = (body) => {
  const answer = DeepSeekBalance.safeParse(body);
  if (!answer.success) return;
  let balance: ProviderKeyReading["balance"] = null;
  for (const row of answer.data.balance_infos) {
    const item = DeepSeekCurrency.safeParse(row);
    if (!item.success) continue;
    const { currency, total_balance: amount } = item.data;
    if (!balance || amount > balance.amount) balance = { currency, amount };
  }
  if (balance) return { balance, windows: [] };
};

const MoonshotBalance = z.object({
  code: z.literal(0),
  status: z.literal(true),
  data: z.object({ available_balance: z.number() }),
});

const moonshot =
  (currency: string): Parse =>
  (body) => {
    const answer = MoonshotBalance.safeParse(body);
    if (!answer.success) return;
    return { balance: { amount: answer.data.data.available_balance, currency }, windows: [] };
  };

const MiniMaxStatus = z.object({ base_resp: z.object({ status_code: z.number() }) });
const MiniMaxPlan = z.object({ model_remains: z.array(z.unknown()) });
const optionalNumber = z.number().nullish().catch(null);
const MiniMaxModel = z.object({
  model_name: z.string(),
  end_time: optionalNumber,
  current_interval_total_count: optionalNumber,
  current_interval_usage_count: optionalNumber,
  current_interval_remaining_percent: optionalNumber,
  weekly_end_time: optionalNumber,
  current_weekly_total_count: optionalNumber,
  current_weekly_usage_count: optionalNumber,
  current_weekly_remaining_percent: optionalNumber,
});

function miniMaxWindow(
  id: "five_hour" | "weekly",
  resetsAt: number | null | undefined,
  total: number | null | undefined,
  remaining: number | null | undefined,
  remainingPercent: number | null | undefined,
): ProviderKeyUsageWindow[] {
  // MiniMax calls remaining counts "usage_count". Time-based plans use remaining percent instead.
  const percent =
    total && total > 0 && remaining != null ? (remaining / total) * 100 : remainingPercent;
  if (percent == null || !Number.isFinite(percent)) return [];
  return [
    {
      id,
      usedPercent: Math.min(100, Math.max(0, 100 - percent)),
      durationMins: id === "five_hour" ? 5 * 60 : 7 * 24 * 60,
      resetsAt: resetsAt && resetsAt > 0 ? resetsAt : null,
    },
  ];
}

const miniMax: Parse = (body) => {
  const status = MiniMaxStatus.safeParse(body);
  if (!status.success) return;
  if (status.data.base_resp.status_code === 1004) return null;
  if (status.data.base_resp.status_code !== 0) return;

  const answer = MiniMaxPlan.safeParse(body);
  if (!answer.success) return;
  if (answer.data.model_remains.length === 0) return null;
  const models = answer.data.model_remains.flatMap((row) => {
    const model = MiniMaxModel.safeParse(row);
    return model.success ? [model.data] : [];
  });
  const model =
    models.find(({ model_name }) => /^(?:general$|minimax-m)/iu.test(model_name)) ?? models[0];
  if (!model) return;
  const windows = [
    ...miniMaxWindow(
      "five_hour",
      model.end_time,
      model.current_interval_total_count,
      model.current_interval_usage_count,
      model.current_interval_remaining_percent,
    ),
    ...miniMaxWindow(
      "weekly",
      model.weekly_end_time,
      model.current_weekly_total_count,
      model.current_weekly_usage_count,
      model.current_weekly_remaining_percent,
    ),
  ];
  if (windows.length) return { balance: null, windows };
};

interface ReaderEndpoint {
  readonly url: string;
  readonly parse: Parse;
  readonly planOnly?: true;
}

const endpoints = {
  deepseek: { international: { url: "https://api.deepseek.com/user/balance", parse: deepSeek } },
  moonshot: {
    china: { url: "https://api.moonshot.cn/v1/users/me/balance", parse: moonshot("CNY") },
    international: { url: "https://api.moonshot.ai/v1/users/me/balance", parse: moonshot("USD") },
  },
  minimax: {
    china: {
      url: "https://api.minimaxi.com/v1/token_plan/remains",
      parse: miniMax,
      planOnly: true,
    },
    international: {
      url: "https://api.minimax.io/v1/token_plan/remains",
      parse: miniMax,
      planOnly: true,
    },
  },
} as const satisfies Partial<
  Record<
    ProviderKeyConnection["preset"],
    Partial<Record<NonNullable<ProviderKeyConnection["endpoint"]>, ReaderEndpoint>>
  >
>;

function endpoint({ preset, endpoint: region }: ProviderKeyConnection): ReaderEndpoint | undefined {
  if (preset === "deepseek") return endpoints.deepseek.international;
  if (preset === "minimax" || preset === "moonshot") return endpoints[preset][region ?? "china"];
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw READ_FAILED;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export const providerKeyUsageReader =
  (request: typeof fetch = fetch): ProviderKeyUsageReader =>
  (connection) => {
    const target = endpoint(connection);
    if (!target) return;
    return (key) =>
      Effect.tryPromise({
        try: async (signal) => {
          const apiKey = Redacted.value(key);
          const response = await request(target.url, {
            method: "GET",
            headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
            redirect: "error",
            signal,
          });
          if (!response.ok) {
            void response.body?.cancel().catch(() => undefined);
            if (target.planOnly && (response.status === 401 || response.status === 403))
              return null;
            throw READ_FAILED;
          }
          const reading = target.parse(await readJson(response));
          if (reading === undefined || reading?.balance?.currency.includes(apiKey))
            throw READ_FAILED;
          return reading;
        },
        catch: () => READ_FAILED,
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError(() => READ_FAILED),
      );
  };
