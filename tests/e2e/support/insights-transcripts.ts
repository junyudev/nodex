import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The same run of days every time, so a test can state exactly what the page must show. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export interface InsightsFixtureTotals {
  readonly tokens: number;
  readonly messages: number;
  readonly claudeTokens: number;
  readonly codexTokens: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Agent history as Claude Code and Codex leave it: a growing year of daily work, some of it in
 * compressed rollouts, with the repeated blocks and copied records real transcripts contain.
 */
export async function writeInsightsTranscripts(input: {
  readonly claudeHome: string;
  readonly codexHome: string;
  readonly nowMs: number;
  readonly days?: number;
}): Promise<InsightsFixtureTotals> {
  const days = input.days ?? 330;
  const next = random(20261107);
  const claudeDirectory = path.join(input.claudeHome, "projects", "-work-repo");
  const codexDirectory = path.join(input.codexHome, "sessions", "2026", "11");
  await mkdir(claudeDirectory, { recursive: true });
  await mkdir(codexDirectory, { recursive: true });

  let claudeTokens = 0;
  let codexTokens = 0;
  let messages = 0;
  for (let index = 0; index < days; index += 1) {
    const dayMs = input.nowMs - (days - 1 - index) * DAY_MS;
    const weekday = new Date(dayMs).getUTCDay();
    const quiet = weekday === 0 ? 0.55 : weekday === 6 ? 0.35 : 0.08;
    // The first weeks are sparse, like anyone picking up a new tool.
    if (next() < quiet + Math.max(0, 0.5 - index / 90)) continue;
    const growth = 0.15 + (index / days) ** 2.4 * 5;
    const scale = growth * (0.4 + next() * 1.3);
    const startMs = dayMs - 3 * 60 * 60 * 1000 + next() * 2 * 60 * 60 * 1000;

    const claude: string[] = [];
    const requests = 2 + Math.floor(next() * 4);
    for (let request = 0; request < requests; request += 1) {
      const timestamp = iso(startMs + request * 60_000);
      const usage = {
        input_tokens: Math.round(40_000 * scale),
        cache_read_input_tokens: Math.round(9_000_000 * scale),
        cache_creation_input_tokens: Math.round(120_000 * scale),
        output_tokens: Math.round(30_000 * scale),
      };
      claudeTokens +=
        usage.input_tokens +
        usage.cache_read_input_tokens +
        usage.cache_creation_input_tokens +
        usage.output_tokens;
      if (request === 0) {
        claude.push(
          JSON.stringify({
            type: "user",
            timestamp,
            uuid: `user-${index}`,
            message: { role: "user", content: "Keep going" },
          }),
        );
        messages += 1;
      }
      const assistant = JSON.stringify({
        type: "assistant",
        timestamp,
        requestId: `req_${index}_${request}`,
        message: { id: `msg_${index}_${request}`, model: "claude-opus-5-5", usage },
      });
      // Each content block repeats its message's usage; only one may count.
      claude.push(assistant, assistant);
    }
    await writeFile(path.join(claudeDirectory, `session-${index}.jsonl`), `${claude.join("\n")}\n`);

    const input_tokens = Math.round(14_000_000 * scale);
    const cached_input_tokens = Math.round(input_tokens * 0.94);
    const output_tokens = Math.round(50_000 * scale);
    const usage = {
      input_tokens,
      cached_input_tokens,
      output_tokens,
      total_tokens: input_tokens + output_tokens,
    };
    codexTokens += input_tokens + output_tokens;
    messages += 1;
    const timestamp = iso(startMs + 30 * 60_000);
    const id = `rollout-${index}`;
    const rollout = `${[
      JSON.stringify({ type: "session_meta", timestamp, payload: { id } }),
      JSON.stringify({ type: "turn_context", timestamp, payload: { model: "gpt-6.1-sol" } }),
      JSON.stringify({ type: "event_msg", timestamp, payload: { type: "task_started" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: { total_token_usage: usage, last_token_usage: usage },
        },
      }),
    ].join("\n")}\n`;
    const name = path.join(codexDirectory, `rollout-${index}-${id}.jsonl`);
    // Older rollouts are compressed, as Codex does to its own history.
    if (index % 3 === 0) await writeFile(`${name}.zst`, zstdCompressSync(Buffer.from(rollout)));
    else await writeFile(name, rollout);
  }
  return { tokens: claudeTokens + codexTokens, messages, claudeTokens, codexTokens };
}

const per = (dollars: number) => dollars / 1_000_000;

/** Prices a run reads from disk, so a test never depends on the network. */
export const insightsTestRates = {
  fetchedAtMs: 0,
  rates: {
    "claude-opus-5-5": {
      input_cost_per_token: per(4),
      cache_read_input_token_cost: per(0.2),
      cache_creation_input_token_cost: per(5),
      output_cost_per_token: per(20),
    },
    "gpt-6.1-sol": {
      input_cost_per_token: per(2),
      cache_read_input_token_cost: per(0.1),
      output_cost_per_token: per(10),
    },
  },
};
