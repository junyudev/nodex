import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { z } from "zod";
import {
  GitHubApi,
  PinnedGitHubCredential,
  SourceAccount,
  type GitHubRestResponse,
} from "@nodex/agent-runtime/github-source";
import type { components } from "@nodex/core-protocol";
const jsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
type Model = components["schemas"];
export type Source = Model["Source"];
export type Repository = Model["SourceRepository"];
export type Position = Model["SourcePosition"];
export type ExternalThread = Model["ExternalThread"];
export type Trigger = Model["SourceTriggerInput"];
export type Cursor = Model["SourceCursor"];
export class SourceReadError extends Schema.TaggedError<SourceReadError>()("SourceReadError", {
  reason: Schema.String,
  retryAtMs: Schema.optional(Schema.Finite),
}) {}
const timestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const bodySchema = z.string().refine((value) => new TextEncoder().encode(value).length <= 65536);
const userSchema = z.object({
  login: z.string(),
  id: z.number().int().positive(),
  type: z.string().optional(),
});
const threadSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string().max(2000),
  state: z.string(),
  html_url: z.string(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  body: bodySchema.nullish(),
  user: userSchema,
  pull_request: z.unknown().optional(),
  draft: z.boolean().optional(),
  merged_at: z.string().nullish(),
  head: z
    .object({
      sha: z.string().regex(/^[a-f0-9]{1,64}$/i),
      ref: z.string().optional(),
      repo: z.object({ id: z.number().int().positive(), full_name: z.string() }).nullish(),
    })
    .optional(),
});
const eventSchema = z.object({
  id: z.number().int().positive(),
  body: bodySchema.nullish(),
  user: userSchema.nullish(),
  actor: userSchema.nullish(),
  event: z.string().optional(),
  state: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullish(),
  created_at: timestampSchema.nullish(),
  updated_at: timestampSchema.nullish(),
  submitted_at: timestampSchema.nullish(),
  completed_at: timestampSchema.nullish(),
  started_at: timestampSchema.nullish(),
  html_url: z.string().optional(),
  details_url: z.string().nullish(),
  target_url: z.string().nullish(),
  context: z.string().optional(),
  name: z.string().optional(),
});
const digest = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)));
const timestamp = (value: string | undefined | null) => (value ? Date.parse(value) : NaN);
export const overlapStart = (watermark: number, boundary: number) =>
  Math.max(boundary, watermark - 5000);
export function responseDelay(headers: GitHubRestResponse["headers"], now: number): number {
  const poll = Number(headers["x-poll-interval"]);
  const retry = headers["retry-after"];
  const retryMs =
    retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - now : 0;
  return Math.max(
    60000,
    Number.isFinite(poll) ? poll * 1000 : 0,
    Number.isFinite(retryMs) ? retryMs : 0,
  );
}
export interface PollResult {
  threads: ExternalThread[];
  triggers: Trigger[];
  cursor: Cursor;
  delayMs: number;
  quarantine: unknown[];
}
export interface PollInput {
  source: Source;
  repository: Repository;
  position: Position;
  known: readonly ExternalThread[];
  pullRequestNumbers: readonly number[];
  workspaceBranches?: readonly string[];
  nowMs: number;
}
export interface GitHubSourceReader {
  verify(
    host: string,
    account?: string,
  ): Effect.Effect<{ login: string; id: string }, SourceReadError>;
  repository(
    host: string,
    name: string,
    account: string,
  ): Effect.Effect<Repository, SourceReadError>;
  verifyThread(source: Source, url: string): Effect.Effect<ExternalThread, SourceReadError>;
  poll(input: PollInput): Effect.Effect<PollResult, SourceReadError>;
}
export class GitHubSourceAdapter extends Context.Service<GitHubSourceAdapter, GitHubSourceReader>()(
  "nodex/GitHubSourceAdapter",
) {}
/** One credential is pinned across identity verification and every page of a poll. */
export const makeGitHubSourceAdapter = (api: GitHubApi["Service"]): GitHubSourceReader => {
  const authenticated = Effect.fn("GitHubSourceAdapter.authenticated")(function* <A, E, R>(
    host: string,
    account: string | undefined,
    id: string | undefined,
    use: () => Effect.Effect<A, E, R>,
  ) {
    const credential = yield* api.credential(host).pipe(
      Effect.provideService(SourceAccount, account),
      Effect.mapError(() => new SourceReadError({ reason: "credential" })),
    );
    return yield* Effect.gen(function* () {
      const response = yield* api
        .rest({ host, path: "user", operation: "source.verify" })
        .pipe(Effect.mapError(() => new SourceReadError({ reason: "credential" })));
      const parsed = yield* Effect.try({
        try: () => userSchema.parse(parseJson(response.body)),
        catch: () => new SourceReadError({ reason: "credential" }),
      });
      if (
        (account && parsed.login.toLowerCase() !== account.toLowerCase()) ||
        (id && String(parsed.id) !== id)
      )
        return yield* new SourceReadError({ reason: "account_changed" });
      return yield* use();
    }).pipe(
      Effect.provideService(PinnedGitHubCredential, {
        host,
        token: credential.token,
        credentialFingerprint: credential.fingerprint,
      }),
    );
  });
  const verify = (host: string, account?: string) =>
    authenticated(host, account, undefined, () =>
      api.rest({ host, path: "user", operation: "source.account" }).pipe(
        Effect.flatMap((response) =>
          Effect.try({
            try: () => {
              const value = userSchema.parse(parseJson(response.body));
              return { login: value.login, id: String(value.id) };
            },
            catch: () => new SourceReadError({ reason: "credential" }),
          }),
        ),
        Effect.mapError(() => new SourceReadError({ reason: "credential" })),
      ),
    );
  const readRepository = Effect.fn("GitHubSourceAdapter.readRepository")(function* (
    host: string,
    name: string,
  ) {
    const response = yield* api
      .rest({ host, path: `repos/${name}`, operation: "source.repository" })
      .pipe(Effect.mapError(() => new SourceReadError({ reason: "repository" })));
    if (response.truncated || response.invalidUtf8)
      return yield* new SourceReadError({ reason: "repository" });
    return yield* Effect.try({
      try: () =>
        z
          .object({ id: z.number().int().positive(), full_name: z.string() })
          .parse(parseJson(response.body)),
      catch: () => new SourceReadError({ reason: "repository" }),
    });
  });
  const repository = (host: string, name: string, account: string) =>
    authenticated(host, account, undefined, () =>
      readRepository(host, name).pipe(
        Effect.map((value) => ({ id: String(value.id), name: value.full_name, enabled: true })),
      ),
    );
  const verifyThread = Effect.fn("GitHubSourceAdapter.verifyThread")(function* (
    source: Source,
    value: string,
  ) {
    const url = yield* Effect.try({
      try: () => new URL(value),
      catch: () => new SourceReadError({ reason: "thread_url" }),
    });
    const match = /^\/([^/]+\/[^/]+)\/(issues|pull)\/([1-9][0-9]*)\/?$/.exec(url.pathname);
    const repo = source.config.repositories.find(
      (r) => r.enabled && r.name.toLowerCase() === match?.[1]?.toLowerCase(),
    );
    if (
      !source.enabled ||
      url.protocol !== "https:" ||
      url.hostname !== source.config.host ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      !repo ||
      !match
    )
      return yield* new SourceReadError({ reason: "thread_url" });
    const number = Number(match[3]);
    const kind = match[2] === "pull" ? "pull_request" : "issue";
    return yield* authenticated(
      source.config.host,
      source.config.account_login,
      source.config.account_id,
      () =>
        Effect.gen(function* () {
          const repository = yield* readRepository(source.config.host, repo.name);
          if (
            String(repository.id) !== repo.id ||
            repository.full_name.toLowerCase() !== repo.name.toLowerCase()
          )
            return yield* new SourceReadError({ reason: "repository_changed" });
          const response = yield* api
            .rest({
              host: source.config.host,
              path: `repos/${repo.name}/${kind === "pull_request" ? "pulls" : "issues"}/${number}`,
              operation: "source.thread.verify",
            })
            .pipe(Effect.mapError(() => new SourceReadError({ reason: "thread_unavailable" })));
          const raw = yield* Effect.try({
            try: () => threadSchema.parse(parseJson(response.body)),
            catch: () => new SourceReadError({ reason: "thread_unavailable" }),
          });
          const canonical = `https://${source.config.host}/${repo.name}/${kind === "pull_request" ? "pull" : "issues"}/${number}`;
          if (
            raw.number !== number ||
            raw.html_url.toLowerCase() !== canonical.toLowerCase() ||
            (kind === "issue" && raw.pull_request)
          )
            return yield* new SourceReadError({ reason: "thread_identity" });
          return {
            id: `github:${source.config.host}:${repo.id}:${number}`,
            host: source.config.host,
            repository_id: repo.id,
            repository: repo.name,
            number,
            kind,
            url: canonical,
            title: raw.title,
            state: raw.merged_at ? "merged" : raw.state,
            draft: raw.draft ?? false,
            head:
              raw.head?.repo && raw.head.ref
                ? {
                    repository_id: String(raw.head.repo.id),
                    repository: raw.head.repo.full_name,
                    branch: raw.head.ref,
                    sha: raw.head.sha,
                  }
                : null,
            observation_revision: 0,
            observations: {},
          } satisfies ExternalThread;
        }),
    );
  });
  const poll = Effect.fn("GitHubSourceAdapter.poll")(function* (input: PollInput) {
    const { source, repository, position, nowMs } = input;
    let delayMs = 60000;
    return yield* authenticated(
      source.config.host,
      source.config.account_login,
      source.config.account_id,
      () =>
        Effect.gen(function* () {
          const remote = yield* readRepository(source.config.host, repository.name);
          if (
            String(remote.id) !== repository.id ||
            remote.full_name.toLowerCase() !== repository.name.toLowerCase()
          )
            return yield* new SourceReadError({ reason: "repository_changed" });
          const old = position.cursor;
          const validators: Record<string, string> = {};
          const savedThreads = new Map(input.known.map((thread) => [thread.number, thread]));
          const observations = new Map<number, Record<string, Model["SourceObservation"]>>(
            input.known.map((thread) => [thread.number, { ...thread.observations }]),
          );
          const threadObservations = (number: number) => {
            let values = observations.get(number);
            if (!values) {
              values = {};
              observations.set(number, values);
            }
            return values;
          };
          const threads = new Map<string, ExternalThread>();
          const triggers: Trigger[] = [];
          const quarantine: unknown[] = [];
          const prefix = `github:${source.config.host}:${repository.id}:`;
          const boundary = old.baseline_at_ms;
          const since = overlapStart(old.watermark_ms, boundary);
          const quarantineItem = (path: string, item: unknown) => {
            const raw = jsonString(item);
            quarantine.push({ path, hash: digest(raw), item: raw.slice(0, 8000) });
          };
          const request = Effect.fn("GitHubSourceAdapter.request")(function* (
            path: string,
            snapshot = false,
          ) {
            const response = yield* api
              .rest({
                host: source.config.host,
                path,
                operation: "source.poll",
                ...(old.validators[`etag:${path}`]
                  ? { ifNoneMatch: old.validators[`etag:${path}`] }
                  : {}),
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new SourceReadError({
                      reason:
                        error._tag === "GitHubApiAuthenticationError"
                          ? "credential"
                          : "github_read",
                      ...("retryAt" in error && typeof error.retryAt === "number"
                        ? { retryAtMs: error.retryAt }
                        : {}),
                    }),
                ),
              );
            delayMs = Math.max(delayMs, responseDelay(response.headers, nowMs));
            if (response.truncated || response.invalidUtf8)
              return yield* new SourceReadError({ reason: "response_incomplete" });
            const etag = response.headers.etag ?? old.validators[`etag:${path}`];
            if (etag) validators[`etag:${path}`] = etag;
            const next = yield* Effect.try({
              try: () =>
                response.status === 304
                  ? old.validators[`next:${path}`]
                  : nextPage(response.headers.link, source.config.host),
              catch: () => new SourceReadError({ reason: "invalid_pagination" }),
            });
            if (next) validators[`next:${path}`] = next;
            const body =
              response.status === 304
                ? snapshot
                  ? old.validators[`body:${path}`]
                  : undefined
                : response.body;
            if (snapshot && body) validators[`body:${path}`] = body;
            if (response.status === 304 && !snapshot) return { body: null, next };
            if (!body)
              return yield* new SourceReadError({ reason: "conditional_snapshot_missing" });
            return yield* Effect.try({
              try: () => ({ body: parseJson(body) as unknown, next }),
              catch: () => new SourceReadError({ reason: "malformed_response" }),
            });
          });
          const list = Effect.fn("GitHubSourceAdapter.pages")(function* (
            start: string,
            field?: string,
          ) {
            const values: unknown[] = [];
            let path: string | undefined = start;
            const visited = new Set<string>();
            while (path) {
              if (visited.has(path))
                return yield* new SourceReadError({ reason: "pagination_cycle" });
              visited.add(path);
              const response: { body: unknown; next: string | undefined } = yield* request(path);
              if (response.body !== null) {
                const parsed = z
                  .array(z.unknown())
                  .safeParse(
                    field && typeof response.body === "object"
                      ? Reflect.get(response.body, field)
                      : response.body,
                  );
                if (!parsed.success)
                  return yield* new SourceReadError({ reason: "malformed_collection" });
                values.push(...parsed.data);
              }
              path = response.next;
            }
            return values;
          });
          const changed = (number: number, key: string, fingerprint: string) => {
            const values = threadObservations(number);
            const prior = values[key];
            if (prior?.fingerprint === fingerprint) return null;
            const revision = (prior?.revision ?? 0) + 1;
            values[key] = { fingerprint, revision };
            return { revision, initial: !prior };
          };
          const emit = (thread: ExternalThread, event: Omit<Trigger, "thread_id">) => {
            if (event.occurred_at_ms >= boundary) triggers.push({ ...event, thread_id: thread.id });
          };
          const external = (
            raw: z.infer<typeof threadSchema>,
            kind: ExternalThread["kind"],
          ): ExternalThread => ({
            id: `${prefix}${raw.number}`,
            host: source.config.host,
            repository_id: repository.id,
            repository: repository.name,
            number: raw.number,
            kind,
            url: `https://${source.config.host}/${repository.name}/${kind === "issue" ? "issues" : "pull"}/${raw.number}`,
            title: raw.title,
            state: raw.merged_at ? "merged" : raw.state,
            draft: raw.draft ?? false,
            head:
              raw.head?.repo && raw.head.ref
                ? {
                    repository_id: String(raw.head.repo.id),
                    repository: raw.head.repo.full_name,
                    branch: raw.head.ref,
                    sha: raw.head.sha,
                  }
                : null,
            observation_revision: savedThreads.get(raw.number)?.observation_revision ?? 0,
            observations: threadObservations(raw.number),
          });
          const numbers = new Map<number, ExternalThread["kind"]>(
            input.known.map((t) => [t.number, t.kind]),
          );
          for (const number of input.pullRequestNumbers) numbers.set(number, "pull_request");
          for (const branch of input.workspaceBranches ?? []) {
            const candidates = yield* list(
              `repos/${repository.name}/pulls?state=all&head=${encodeURIComponent(`${repository.name.split("/")[0]}:${branch}`)}&per_page=100`,
            );
            for (const item of candidates) {
              const raw = threadSchema.safeParse(item);
              if (!raw.success) {
                quarantineItem("workspace_pull_requests", item);
                continue;
              }
              if (
                raw.data.head?.repo &&
                String(raw.data.head.repo.id) === repository.id &&
                raw.data.head.ref === branch
              )
                numbers.set(raw.data.number, "pull_request");
            }
          }
          const discoveries: [string, boolean, string][] = [
            [
              "assigned",
              source.config.discovery.assigned,
              `assignee:${source.config.account_login}`,
            ],
            [
              "review_requests",
              source.config.discovery.review_requests,
              `is:pr review-requested:${source.config.account_login}`,
            ],
            [
              "mentions",
              source.config.discovery.mentions,
              `mentions:${source.config.account_login}`,
            ],
          ];
          const search = Effect.fn("GitHubSourceAdapter.search")(function* (
            qualifier: string,
            from: number,
            to: number,
          ): Effect.fn.Return<unknown[], SourceReadError> {
            const q = `repo:${repository.name} ${qualifier} updated:${DateTime.formatIso(DateTime.makeUnsafe(from))}..${DateTime.formatIso(DateTime.makeUnsafe(to))}`;
            const path = `search/issues?q=${encodeURIComponent(q)}&sort=updated&order=asc&per_page=100`;
            const first = yield* request(path, true);
            if (first.body === null) return [];
            const parsed = z
              .object({
                total_count: z.number(),
                incomplete_results: z.boolean(),
                items: z.array(z.unknown()),
              })
              .safeParse(first.body);
            if (!parsed.success || parsed.data.incomplete_results)
              return yield* new SourceReadError({ reason: "discovery_incomplete" });
            if (parsed.data.total_count >= 1000) {
              if (to - from < 2000)
                return yield* new SourceReadError({ reason: "discovery_window_overflow" });
              const middle = Math.floor((from + to) / 2000) * 1000;
              return [
                ...(yield* search(qualifier, from, middle)),
                ...(yield* search(qualifier, middle, to)),
              ];
            }
            const values = [...parsed.data.items];
            let next = first.next;
            while (next) {
              const page = yield* request(next);
              if (page.body !== null) {
                const items = z
                  .object({ items: z.array(z.unknown()), incomplete_results: z.boolean() })
                  .safeParse(page.body);
                if (!items.success || items.data.incomplete_results)
                  return yield* new SourceReadError({ reason: "discovery_incomplete" });
                values.push(...items.data.items);
              }
              next = page.next;
            }
            return values;
          });
          for (const [reason, enabled, qualifier] of discoveries) {
            if (!enabled) continue;
            const items = yield* search(qualifier, position.baseline ? since : 0, nowMs);
            for (const item of items) {
              const parsed = threadSchema.safeParse(item);
              if (!parsed.success) {
                quarantineItem(`discovery:${reason}`, item);
                continue;
              }
              const raw = parsed.data;
              const kind = raw.pull_request ? "pull_request" : "issue";
              numbers.set(raw.number, kind);
              const thread = external(raw, kind);
              threads.set(thread.id, thread);
              const date = timestamp(raw.updated_at);
              if (!Number.isFinite(date)) {
                quarantineItem(`discovery:${reason}`, item);
                continue;
              }
              emit(thread, {
                semantic_key: `${prefix}discovery:${reason}:${raw.number}:${raw.updated_at}`,
                kind: `discovery_${reason}`,
                occurred_at_ms: date,
                actor_login: raw.user.login,
                actor_class: raw.user.type === "Bot" ? "bot" : "person",
                text: raw.body ?? null,
                metadata: { reason, actor_id: raw.user.id },
                url: thread.url,
              });
            }
          }
          const observeEvents = Effect.fn("GitHubSourceAdapter.events")(function* (
            thread: ExternalThread,
            path: string,
            kind: string,
            head?: string,
            field?: string,
          ) {
            const items = yield* list(path, field);
            const latestReview = new Map<string, number>();
            if (kind === "review")
              for (const item of items) {
                const parsed = eventSchema.safeParse(item);
                if (
                  parsed.success &&
                  parsed.data.user &&
                  ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(parsed.data.state ?? "")
                )
                  latestReview.set(parsed.data.user.login, parsed.data.id);
              }
            for (const item of items) {
              if (kind === "lifecycle") {
                const discriminator = z.object({ event: z.string() }).safeParse(item);
                if (!discriminator.success) {
                  quarantineItem(path, item);
                  continue;
                }
                if (!lifecycle.has(discriminator.data.event)) continue;
              }
              const parsed = eventSchema.safeParse(item);
              if (!parsed.success) {
                quarantineItem(path, item);
                continue;
              }
              const raw = parsed.data;
              if (kind === "review" && raw.state === "PENDING") continue;
              if (kind === "lifecycle" && (!raw.event || !lifecycle.has(raw.event))) continue;
              const remoteTime = timestamp(
                raw.updated_at ??
                  raw.submitted_at ??
                  raw.completed_at ??
                  raw.created_at ??
                  raw.started_at,
              );
              const time =
                (kind === "check" || kind === "status") && !Number.isFinite(remoteTime)
                  ? position.baseline
                    ? nowMs
                    : boundary - 1
                  : remoteTime;
              if (!Number.isFinite(time)) {
                quarantineItem(path, item);
                continue;
              }
              const actor = raw.user ?? raw.actor;
              const state = raw.conclusion ?? raw.state ?? raw.status ?? raw.event ?? "";
              const text = raw.body ?? null;
              const fingerprint = digest(
                jsonString([state, text, raw.updated_at, raw.completed_at]),
              );
              const observation =
                kind === "comment" || kind === "review_comment"
                  ? { revision: 1, initial: true }
                  : changed(thread.number, `${kind}:${raw.id}:${head ?? ""}`, fingerprint);
              if (!observation) continue;
              const key =
                kind === "check" || kind === "status"
                  ? `check:${kind}:${raw.id}:${head}:${state}:${observation.revision}`
                  : kind === "lifecycle"
                    ? `lifecycle:timeline:${raw.id}:${raw.event}`
                    : `${kind}:${raw.id}:${state}:${raw.updated_at ?? raw.submitted_at ?? raw.created_at}:${digest(text ?? "")}`;
              emit(thread, {
                semantic_key: prefix + key,
                kind: kind === "lifecycle" ? raw.event! : kind,
                occurred_at_ms:
                  (kind === "check" || kind === "status" || kind === "review") &&
                  !observation.initial &&
                  position.baseline
                    ? nowMs
                    : time,
                actor_login: actor?.login ?? "GitHub",
                actor_class:
                  kind === "check" || kind === "status"
                    ? "ci"
                    : actor?.type === "Bot"
                      ? "bot"
                      : "person",
                text,
                metadata: {
                  comment_id: kind === "comment" ? String(raw.id) : null,
                  state,
                  effective:
                    kind === "review" && actor ? latestReview.get(actor.login) === raw.id : false,
                  actor_id: actor?.id ?? null,
                  thread_state: thread.state,
                  head_sha: head ?? null,
                  name: raw.name ?? raw.context ?? null,
                  observed_revision: observation.revision,
                },
                url: raw.html_url ?? raw.details_url ?? raw.target_url ?? thread.url,
              });
            }
          });
          for (const [number, kind] of numbers) {
            const base = `repos/${repository.name}`;
            const path = `${base}/${kind === "pull_request" ? "pulls" : "issues"}/${number}`;
            const response = yield* request(path, true);
            const parsed = threadSchema.safeParse(response.body);
            if (!parsed.success) {
              quarantineItem(path, response.body);
              continue;
            }
            const raw = parsed.data;
            if (
              raw.number !== number ||
              raw.html_url.toLowerCase() !==
                `https://${source.config.host}/${repository.name}/${kind === "issue" ? "issues" : "pull"}/${number}`.toLowerCase()
            ) {
              quarantineItem(path, response.body);
              continue;
            }
            const thread = external(raw, kind);
            threads.set(thread.id, thread);
            const snapshot = [raw.state, raw.draft ?? false, Boolean(raw.merged_at)];
            const change = changed(number, `thread:${number}`, jsonString(snapshot));
            yield* observeEvents(
              thread,
              `${base}/issues/${number}/comments?since=${encodeURIComponent(DateTime.formatIso(DateTime.makeUnsafe(since)))}&per_page=100`,
              "comment",
            );
            yield* observeEvents(
              thread,
              `${base}/issues/${number}/timeline?per_page=100`,
              "lifecycle",
            );
            if (change) {
              const previous =
                savedThreads.get(number)?.observations[`thread:${number}`]?.fingerprint;
              const previousState = previous
                ? (parseJson(previous) as [string, boolean, boolean])
                : null;
              const event = raw.merged_at
                ? "merged"
                : raw.state === "closed"
                  ? "closed"
                  : raw.draft
                    ? "convert_to_draft"
                    : previousState?.[1]
                      ? "ready_for_review"
                      : previousState?.[0] === "closed"
                        ? "reopened"
                        : "opened";
              if (
                ((position.baseline && !change.initial) || timestamp(raw.created_at) >= boundary) &&
                !triggers.some(
                  (trigger) => trigger.thread_id === thread.id && trigger.kind === event,
                )
              )
                emit(thread, {
                  semantic_key: `${prefix}lifecycle:observed:${number}:${change.revision}:${event}`,
                  kind: event,
                  occurred_at_ms: change.initial ? timestamp(raw.created_at) : nowMs,
                  actor_login: raw.user.login,
                  actor_class: raw.user.type === "Bot" ? "bot" : "person",
                  url: thread.url,
                });
            }
            if (kind !== "pull_request") continue;
            yield* observeEvents(thread, `${base}/pulls/${number}/reviews?per_page=100`, "review");
            yield* observeEvents(
              thread,
              `${base}/pulls/${number}/comments?since=${encodeURIComponent(DateTime.formatIso(DateTime.makeUnsafe(since)))}&per_page=100`,
              "review_comment",
            );
            if (!raw.head?.sha)
              return yield* new SourceReadError({ reason: "pull_request_head_missing" });
            yield* observeEvents(
              thread,
              `${base}/commits/${raw.head.sha}/check-runs?per_page=100`,
              "check",
              raw.head.sha,
              "check_runs",
            );
            yield* observeEvents(
              thread,
              `${base}/commits/${raw.head.sha}/statuses?per_page=100`,
              "status",
              raw.head.sha,
            );
          }
          return {
            threads: [...threads.values()],
            triggers,
            cursor: {
              baseline_at_ms: old.baseline_at_ms,
              watermark_ms: nowMs,
              validators,
              continuation: null,
            },
            delayMs,
            quarantine,
          };
        }),
    ).pipe(
      Effect.mapError(
        (error) =>
          new SourceReadError({
            reason: error.reason,
            retryAtMs: Math.max(nowMs + delayMs, error.retryAtMs ?? 0),
          }),
      ),
    );
  });
  return { verify, repository, verifyThread, poll };
};
/** Follow only same-host API pagination; a Link header cannot redirect a pinned credential. */
export function nextPage(link: string | undefined, host: string): string | undefined {
  const next = link
    ?.split(",")
    .find((part) => /;\s*rel="next"/.test(part))
    ?.match(/<([^>]+)>/)?.[1];
  if (!next) return undefined;
  const url = new URL(next);
  const apiHost = host === "github.com" ? "api.github.com" : host;
  const root = host === "github.com" ? "/" : "/api/v3/";
  if (
    url.protocol !== "https:" ||
    url.host !== apiHost ||
    url.username ||
    url.password ||
    !url.pathname.startsWith(root)
  )
    throw new Error("Invalid GitHub pagination target");
  return url.pathname.slice(root.length) + url.search;
}
export const live = Layer.effect(
  GitHubSourceAdapter,
  Effect.gen(function* () {
    return makeGitHubSourceAdapter(yield* GitHubApi);
  }),
);
