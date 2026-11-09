import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { components } from "@nodex/core-protocol";
import type { SourcesSettingsSnapshot, UpdateSourceSettingsInput } from "../../shared/sources";
import {
  GitHubSourceAdapter,
  SourceReadError,
  type Source,
  type Repository,
  type Position,
  type ExternalThread,
} from "./GitHubSourceAdapter";
type Model = components["schemas"];
export class SourceSupervisorError extends Schema.TaggedError<SourceSupervisorError>()(
  "SourceSupervisorError",
  { message: Schema.String },
) {}
export class SourceSupervisor extends Context.Service<
  SourceSupervisor,
  {
    snapshot: Effect.Effect<SourcesSettingsSnapshot, SourceSupervisorError>;
    automationOptions: Effect.Effect<
      readonly import("../../shared/sources").SourceOption[],
      SourceSupervisorError
    >;
    connect: Effect.Effect<ProjectWorkspaceApplyResult, SourceSupervisorError>;
    update: (
      input: UpdateSourceSettingsInput,
    ) => Effect.Effect<ProjectWorkspaceApplyResult, SourceSupervisorError>;
    retry: (sourceId: string) => Effect.Effect<void, SourceSupervisorError>;
    sweep: Effect.Effect<void, SourceSupervisorError>;
  }
>()("nodex/SourceSupervisor") {}
export const sourceBackoff = (failures: number, jitter: number) =>
  Math.min(3600000, 60000 * 2 ** Math.min(Math.max(0, failures - 1), 6)) * (1 + jitter * 0.2);
const unavailable = () =>
  new SourceSupervisorError({ message: "Sources are unavailable. Retry shortly." });
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const github = yield* GitHubSourceAdapter;
  const git = yield* CodexGitProbe;
  const gate = yield* Semaphore.make(1);
  const read = (read: Model["SourceRead"]) =>
    core.workspace.read({ kind: "sources", read }, undefined, null).pipe(
      Effect.flatMap((snapshot) =>
        snapshot.value.kind === "sources"
          ? Effect.succeed(snapshot.value.value)
          : Effect.fail(unavailable()),
      ),
      Effect.mapError(unavailable),
    );
  const apply = (command: Model["SourceCommand"]) =>
    Effect.suspend(() =>
      core.workspace
        .apply(
          { operationId: createOperationId("source"), intent: { kind: "source", command } },
          undefined,
          null,
        )
        .pipe(Effect.mapError(unavailable)),
    );
  const allSources = Effect.gen(function* () {
    const sources: Source[] = [];
    let after: string | null = null;
    while (true) {
      const value: Model["SourceReadValue"] = yield* read({
        kind: "sources",
        after_id: after,
        limit: 100,
      });
      if (value.kind !== "sources") return yield* unavailable();
      sources.push(...value.sources);
      if (value.sources.length < 100) return sources;
      after = value.sources.at(-1)!.id;
    }
  });
  const positions = Effect.fn("Sources.positions")(function* (sourceId: string) {
    const positions: Position[] = [];
    let after: string | null = null;
    while (true) {
      const value: Model["SourceReadValue"] = yield* read({
        kind: "positions",
        source_id: sourceId,
        after_partition: after,
        limit: 100,
      });
      if (value.kind !== "positions") return yield* unavailable();
      positions.push(...value.positions);
      if (value.positions.length < 100) return positions;
      after = value.positions.at(-1)!.partition;
    }
  });
  const problems = Effect.fn("Sources.problems")(function* (sourceId: string) {
    const problems: Model["SourceProblem"][] = [];
    let after: string | null = null;
    while (true) {
      const value: Model["SourceReadValue"] = yield* read({
        kind: "open_problems",
        source_id: sourceId,
        after_id: after,
        limit: 100,
      });
      if (value.kind !== "open_problems") return yield* unavailable();
      problems.push(...value.problems);
      if (value.problems.length < 100) return problems;
      after = value.problems.at(-1)!.id;
    }
  });
  const defaultRepositories = Effect.fn("Sources.defaults")(function* (
    host: string,
    account: string,
  ) {
    const names = new Set<string>();
    let cursor: string | null = null;
    while (true) {
        yield* core.workspace
          .read(
            {
              kind: "project_window",
              include_archived: false,
              window: { after: cursor, first: 100 },
            },
            undefined,
            null,
          )
          .pipe(Effect.mapError(unavailable));
      if (value.value.kind !== "project_window") return yield* unavailable();
      for (const project of value.value.projects.items) {
        for (const source of project.sources) {
            const canonical = canonicalRepositoryUrl(remote);
            if (!canonical) continue;
            const url = new URL(canonical);
            if (url.hostname === host && /^\/[^/]+\/[^/]+$/.test(url.pathname))
              names.add(url.pathname.slice(1));
          }
        }
      }
      cursor = value.value.projects.next_cursor ?? null;
      if (!cursor) break;
    }
    return yield* Effect.forEach(
      [...names].sort(),
      (name) => github.repository(host, name, account),
      { concurrency: 1 },
    );
  });
  const knownThreads = Effect.fn("Sources.knownThreads")(function* (
    source: Source,
    repo: Repository,
  ) {
    const threads: ExternalThread[] = [];
    let after: string | null = null;
    while (true) {
      const value: Model["SourceReadValue"] = yield* read({
        kind: "threads",
        host: source.config.host,
        repository_id: repo.id,
        after_id: after,
        limit: 100,
      });
      if (value.kind !== "threads") return yield* unavailable();
      threads.push(...value.threads);
      if (value.threads.length < 100) return threads;
      after = value.threads.at(-1)!.id;
    }
  });
  const ownPrNumbers = Effect.fn("Sources.ownPrNumbers")(function* (
    source: Source,
    repo: Repository,
  ) {
    const numbers: number[] = [];
    let after: string | null = null;
    while (true) {
      const value: Model["SourceReadValue"] = yield* read({
        kind: "known_pull_requests",
        after_page_id: after,
        limit: 100,
      });
      if (value.kind !== "known_pull_requests") return yield* unavailable();
      for (const pr of value.pull_requests) {
        if (
          canonicalRepositoryUrl(pr.repository)?.toLowerCase() ===
          `https://${source.config.host}/${repo.name}`.toLowerCase()
        )
          numbers.push(pr.number);
      }
      if (value.pull_requests.length < 100) return numbers;
      after = value.pull_requests.at(-1)!.page_id;
    }
  });
  const workspaceBranches = Effect.fn("Sources.workspaceBranches")(function* (
    source: Source,
    repo: Repository,
  ) {
    const branches: string[] = [];
    let after: string | null = null;
    while (true) {
        yield* core.workspace
          .read(
            { kind: "page_workspace_window", after_workspace_id: after, limit: 100 },
            undefined,
            null,
          )
          .pipe(Effect.mapError(unavailable));
      if (result.value.kind !== "page_workspace_window") return yield* unavailable();
      for (const workspace of result.value.workspaces)
        if (
          workspace.repository_url?.toLowerCase() ===
          `https://${source.config.host}/${repo.name}`.toLowerCase()
        )
          branches.push(workspace.branch_name);
      if (result.value.workspaces.length < 100) return [...new Set(branches)];
      after = result.value.workspaces.at(-1)!.workspace_id;
    }
  });
  const pollPartition = Effect.fn("Sources.pollPartition")(function* (
    source: Source,
    repo: Repository,
    previous: Position | undefined,
  ) {
    const partition = `repo:${repo.id}`;
    const token = createOperationId("source-lease");
    const claim = apply({
      kind: "claim_source_partition",
      source_id: source.id,
      config_revision: source.revision,
      partition,
      lease_token: token,
      lease_duration_ms: 120000,
    });
    const acquired = yield* claim.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!acquired) return;
    const position = (yield* positions(source.id)).find((p) => p.partition === partition);
    if (!position) return yield* unavailable();
    const process = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* github.poll({
        source,
        repository: repo,
        position,
        known: yield* knownThreads(source, repo),
        pullRequestNumbers: yield* ownPrNumbers(source, repo),
        workspaceBranches: yield* workspaceBranches(source, repo),
        watchRepositoryEvents: yield* read({
          kind: "event_automation_watching",
          source_id: source.id,
          repository: repo.name,
        }).pipe(Effect.map((v) => v.kind === "event_automation_watching" && v.enabled)),
        nowMs: now,
      });
      yield* apply({
        kind: "ingest_source_batch",
        source_id: source.id,
        config_revision: source.revision,
        partition,
        expected_position: position.revision,
        lease_token: token,
        threads: result.threads,
        triggers: result.triggers,
        next_position: result.cursor,
        next_poll_at_ms: (yield* Clock.currentTimeMillis) + result.delayMs,
        quarantine: result.quarantine,
      });
      yield* apply({
        kind: "record_source_success",
        source_id: source.id,
        config_revision: source.revision,
        partition,
        lease_token: token,
      });
    });
    // A failed renewal interrupts the read before it can commit under a retired lease.
    const renew = Effect.sleep("30 seconds").pipe(
      Effect.andThen(claim),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.andThen(Effect.never),
    );
    yield* Effect.raceFirst(process, renew).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const count = position.consecutive_failures + 1;
          const now = yield* Clock.currentTimeMillis;
          const jitter = yield* Random.next;
          const retry = Math.max(
            now + sourceBackoff(count, jitter),
            Schema.is(SourceReadError)(error) ? (error.retryAtMs ?? 0) : 0,
            previous?.next_poll_at_ms ?? 0,
          );
          yield* apply({
            kind: "record_source_failure",
            source_id: source.id,
            config_revision: source.revision,
            partition,
            lease_token: token,
            problem_kind: Schema.is(SourceReadError)(error) ? error.reason : "poll_failed",
            evidence: { reason: Schema.is(SourceReadError)(error) ? error.reason : "poll_failed" },
            retry_at_ms: retry,
          }).pipe(Effect.ignore);
        }),
      ),
    );
  });
  const sweep = gate
    .withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const source of yield* allSources) {
          if (!source.enabled) continue;
          const saved = yield* positions(source.id);
          for (const repo of source.config.repositories) {
            if (!repo.enabled) continue;
            const position = saved.find((p) => p.partition === `repo:${repo.id}`);
            if (position && position.next_poll_at_ms > now) continue;
            yield* pollPartition(source, repo, position);
          }
        }
      }),
    )
    .pipe(Effect.mapError(unavailable));
  const connect = Effect.gen(function* () {
    const current = (yield* allSources).find((s) => s.config.host === "github.com");
    const account = yield* github.verify("github.com", current?.config.account_login);
    const defaults = yield* defaultRepositories("github.com", account.login);
    const repos = new Map((current?.config.repositories ?? []).map((r) => [r.id, r]));
    for (const repo of defaults)
      repos.set(repo.id, { ...repo, enabled: repos.get(repo.id)?.enabled ?? true });
    return yield* apply({
      kind: "configure_source",
      source_id: current?.id ?? `github:github.com:${account.id}`,
      expected_revision: current?.revision ?? 0,
      enabled: true,
      config: {
        host: "github.com",
        account_login: account.login,
        account_id: account.id,
        credential_ref: `gh:github.com:${account.login}`,
        repositories: [...repos.values()],
        discovery: current?.config.discovery ?? {
          assigned: true,
          review_requests: true,
          mentions: true,
        },
      },
    });
  }).pipe(
    Effect.mapError(
      (error) =>
        new SourceSupervisorError({
          message: Schema.is(SourceReadError)(error)
            ? "Install GitHub CLI and run gh auth login, then reconnect."
            : "GitHub could not be connected. Retry shortly.",
        }),
    ),
  );
  const update = (input: UpdateSourceSettingsInput) =>
    Effect.gen(function* () {
      const current = (yield* allSources).find((s) => s.id === input.sourceId);
      if (!current || current.revision !== input.expectedRevision)
        return yield* new SourceSupervisorError({
          message: "Source settings changed. Reload and try again.",
        });
      const repos = new Map(current.config.repositories.map((r) => [r.id, r]));
      if (input.repositories.some((choice) => !repos.has(choice.id)))
        for (const repo of yield* defaultRepositories(
          current.config.host,
          current.config.account_login,
        ).pipe(Effect.orElseSucceed(() => [])))
          repos.set(repo.id, { ...repo, enabled: repos.get(repo.id)?.enabled ?? true });
      const selected = input.repositories.map((choice) => {
        const repo = repos.get(choice.id);
        return repo ? { ...repo, enabled: choice.enabled } : null;
      });
      if (selected.some((r) => !r))
        return yield* new SourceSupervisorError({
          message: "Choose an available Project repository.",
        });
      return yield* apply({
        kind: "configure_source",
        source_id: current.id,
        expected_revision: input.expectedRevision,
        enabled: input.enabled,
        config: {
          ...current.config,
          repositories: selected.filter((r): r is Repository => r !== null),
          discovery: input.discovery,
        },
      });
    }).pipe(
      Effect.mapError((error) => (Schema.is(SourceSupervisorError)(error) ? error : unavailable())),
    );
  const snapshot = Effect.gen(function* (): Effect.fn.Return<
    SourcesSettingsSnapshot,
    SourceSupervisorError
  > {
    const source = (yield* allSources).find((s) => s.config.host === "github.com") ?? null;
    if (!source) {
      const account = yield* github.verify("github.com").pipe(Effect.orElseSucceed(() => null));
      return {
        source: null,
        account,
        connection: account ? "connected" : "reconnect",
        repositories: [],
        problems: [],
        lastSuccessAtMs: null,
        nextPollAtMs: null,
      };
    }
    const connected = yield* github.verify(source.config.host, source.config.account_login).pipe(
      Effect.map((a) => a.id === source.config.account_id),
      Effect.orElseSucceed(() => false),
    );
    const saved = yield* positions(source.id);
    const defaults = connected
      ? yield* defaultRepositories(source.config.host, source.config.account_login).pipe(
          Effect.orElseSucceed(() => []),
        )
      : [];
    const repos = new Map(source.config.repositories.map((r) => [r.id, r]));
    for (const repo of defaults)
      if (!repos.has(repo.id)) repos.set(repo.id, { ...repo, enabled: false });
    const successes = saved.flatMap((p) => (p.last_success_at_ms ? [p.last_success_at_ms] : []));
    const next = saved.map((p) => p.next_poll_at_ms).filter((t) => t > 0);
    return {
      source,
      account: connected
        ? { login: source.config.account_login, id: source.config.account_id }
        : null,
      connection: connected ? "connected" : "reconnect",
      repositories: [...repos.values()],
      problems: yield* problems(source.id),
      lastSuccessAtMs: successes.length ? Math.max(...successes) : null,
      nextPollAtMs: next.length ? Math.min(...next) : null,
    };
  });
  return SourceSupervisor.of({
    snapshot,
    automationOptions: allSources.pipe(
      Effect.map((sources) =>
        sources.map((s) => ({
          id: s.id,
          label: `GitHub · ${s.config.account_login} · ${s.config.host}`,
        })),
      ),
    ),
    connect,
    update,
    retry: (sourceId) =>
      Effect.gen(function* () {
        if (!(yield* allSources).some((s) => s.id === sourceId)) return yield* unavailable();
        yield* sweep;
      }),
    sweep,
  });
});
export const live = Layer.effect(
  SourceSupervisor,
  Effect.gen(function* () {
    const supervisor = yield* make;
    yield* supervisor.sweep.pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.forkScoped,
    );
    return supervisor;
  }),
);
