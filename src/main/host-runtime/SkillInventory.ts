import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import path from "node:path";
import type { SkillsListResponse } from "@nodex/codex-app-server-protocol/v2/SkillsListResponse";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import type {
  SkillAgentAvailability,
  SkillDocument,
  SkillInput,
  SkillInventoryContext,
  SkillInventoryEntry,
  SkillInventorySnapshot,
  SkillLocation,
  SkillReader,
  SkillResult,
  SkillSaveResult,
  SkillScope,
  SkillToggle,
  SkillTransferResult,
} from "../../shared/skill-inventory";
import * as files from "../platform/node/SkillFilesNode";
import { localFileWatchHost, type FileWatchHost } from "../file-watch-host";
import { observeSkillRoots } from "./SkillRootWatch";

export type ClaudeSkillSettings = {
  readonly skillOverrides?: Readonly<Record<string, string>>;
  readonly skillOverrideSources?: readonly {
    readonly source: "user" | "project" | "local" | "managed" | "flag";
    readonly path?: string;
    readonly skillOverrides?: Readonly<Record<string, string>>;
    readonly hasPolicyHelper: boolean;
  }[];
};

export interface SkillInventoryScope {
  readonly binding: string;
  readonly projectRoots: readonly string[];
  readonly claude: readonly {
    readonly instanceId: string;
    readonly home: string | null;
    readonly configuration: (cwd: string | null) => Effect.Effect<ClaudeSkillSettings, unknown>;
  }[];
}

interface SkillInventoryPorts {
  readonly hostId: string;
  readonly home: string;
  readonly codexHome: string;
  readonly codexSharedHome: string;
  readonly resolve: (
    context: SkillInventoryContext,
  ) => Effect.Effect<SkillInventoryScope, files.SkillFileError>;
  readonly codexList: (context: SkillInput<"list">) => Effect.Effect<SkillsListResponse, unknown>;
  readonly codexSetEnabled: (
    context: SkillInventoryContext,
    path: string,
    enabled: boolean,
  ) => Effect.Effect<void, files.SkillFileError>;
  readonly trashDirectory: (directory: string) => Effect.Effect<void, files.SkillFileError>;
  readonly refreshComposers: Effect.Effect<void>;
  readonly changes: Stream.Stream<unknown>;
  readonly watchHost?: FileWatchHost;
  readonly fileLane?: Semaphore.Semaphore;
  readonly runInProject?: <A, E>(
    projectId: string | null,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
}

interface RootReader {
  readonly reader: SkillReader;
  readonly cwd?: string;
  readonly claudeHome?: string;
}

type Location = Omit<SkillLocation, "skills" | "readers"> & {
  readers: RootReader[];
  writable: boolean;
};

interface Candidate {
  readonly location: Location;
  readonly directory: string;
  readonly observations: Map<string, RootReader>;
  readonly native: SkillMetadata[];
  protected: boolean;
}

interface Target {
  readonly row: SkillInventoryEntry;
  readonly location: Location;
  readonly codexPath: string | undefined;
  readonly claudeSettings: ReadonlyMap<
    string,
    {
      readonly file: string;
      readonly policy: string;
      readonly expectedOverride: string | undefined;
    }
  >;
}

const codex = { agent: "codex", instanceId: "codex" } as const satisfies SkillReader;
const readerKey = ({ agent, instanceId }: SkillReader) => `${agent}:${instanceId}`;
const unavailable = (reason: string): SkillToggle => ({ status: "unavailable", reason });
const ok = <T>(value: T) => ({ status: "ok" as const, value });
const error = (code: files.SkillFileError["code"], message: string) =>
  new files.SkillFileError(code, message);
const io = <T>(operation: () => Promise<T>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof files.SkillFileError
        ? cause
        : error("io", "The skill files could not be accessed."),
  });
const skillId = (host: string, directory: string) => files.skillIdentity("skill", host, directory);
const overrideFor = (overrides: Readonly<Record<string, string>> | undefined, name: string) =>
  overrides && Object.hasOwn(overrides, name) ? overrides[name] : undefined;

function summarizeCodex(candidate: Candidate, invocationName: string): SkillAgentAvailability {
  const first = candidate.native[0];
  const state =
    !first || !candidate.native.every((skill) => skill.enabled === first.enabled)
      ? "unknown"
      : first.enabled
        ? "enabled"
        : "disabled";
  return {
    ...codex,
    invocationName: first?.name ?? invocationName,
    state,
    discovery: first ? "available" : "unverified",
    toggle:
      first && state !== "unknown" && !candidate.protected
        ? { status: "available", scope: "user" }
        : unavailable(
            candidate.protected
              ? "This skill is managed by its source."
              : "Codex has not confirmed this skill.",
          ),
  };
}

function summarizeClaude(
  candidate: Candidate,
  observation: RootReader,
  name: string,
  settings: ClaudeSkillSettings | undefined,
  shadowed: boolean,
  ambiguous: boolean,
  valid: boolean,
): { availability: SkillAgentAvailability; settingsFile?: string } {
  const { reader, cwd, claudeHome } = observation;
  const userFile = claudeHome ? path.join(claudeHome, "settings.json") : null;
  const localFile = cwd ? path.join(cwd, ".claude", "settings.local.json") : null;
  const file = localFile ?? userFile;
  const sourceKind = localFile ? "local" : "user";
  const sources = settings?.skillOverrideSources;
  const effective = overrideFor(settings?.skillOverrides, name);
  const sourceMatches = sources?.filter((source) => source.source === sourceKind) ?? [];
  const known = sources && sourceMatches.every((source) => source.path === file);
  const covered =
    effective !== undefined &&
    sources?.some((source) => overrideFor(source.skillOverrides, name) !== undefined);
  const blocked = sources?.some(
    (source) =>
      source.hasPolicyHelper ||
      source.source === "managed" ||
      source.source === "flag" ||
      (source.source !== sourceKind && overrideFor(source.skillOverrides, name) !== undefined),
  );
  const allowed =
    valid &&
    !shadowed &&
    !ambiguous &&
    !candidate.protected &&
    file &&
    known &&
    !blocked &&
    (effective === undefined || covered);
  return {
    availability: {
      ...reader,
      invocationName: name,
      state: settings && valid ? (effective === "off" ? "disabled" : "enabled") : "unknown",
      discovery: shadowed ? "shadowed" : valid ? "available" : "unverified",
      toggle: allowed
        ? { status: "available", scope: localFile ? "project" : "user" }
        : unavailable(
            shadowed || ambiguous
              ? "Claude settings apply to every skill with this name."
              : "The effective Claude settings cannot be changed safely here.",
          ),
    },
    ...(allowed ? { settingsFile: file } : {}),
  };
}

export const makeSkillInventory = (ports: SkillInventoryPorts) =>
  Effect.gen(function* () {
    // One lane covers all aliases and both ends of a move, including concurrent windows.
    const mutations = ports.fileLane ?? (yield* Semaphore.make(1));
    const settingsMutations = yield* Semaphore.make(1);
    const changes = yield* PubSub.sliding<string>(32);
    const composerChanges = yield* PubSub.sliding<string>(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
    yield* Effect.addFinalizer(() => PubSub.shutdown(composerChanges));
    const refreshComposers = ports.refreshComposers.pipe(
      Effect.andThen(PubSub.publish(composerChanges, ports.hostId)),
      Effect.asVoid,
    );

    const inventory = Effect.fn("SkillInventory.inventory")(function* (input: SkillInput<"list">) {
      if (input.hostId !== ports.hostId)
        return yield* Effect.fail(error("unavailable", "Skills are available on the local host."));
      const scope = yield* ports.resolve(input);
      const locations = new Map<string, Location>();
      const candidates = new Map<string, Candidate>();
      const health = new Map<string, SkillInventorySnapshot["sources"][number]>();
      const report = (reader: SkillReader, error: string | null) => {
        if (!health.has(readerKey(reader)) || error)
          health.set(readerKey(reader), { ...reader, error });
      };
      const locationFor = (
        directory: string,
        scope: SkillScope,
        exists: boolean,
        writable: boolean,
      ) => {
        const previous = locations.get(directory);
        if (previous) {
          if (scope === "plugin" || scope === "system") previous.writable = false;
          return previous;
        }
        const value: Location = {
          id: files.skillIdentity("location", input.hostId, directory),
          directory,
          scope,
          exists,
          writable,
          readers: [],
        };
        locations.set(directory, value);
        return value;
      };
      const add = (
        location: Location,
        directory: string,
        observation: RootReader,
        native?: SkillMetadata,
      ) => {
        let candidate = candidates.get(directory);
        if (!candidate) {
          candidate = {
            location,
            directory,
            observations: new Map(),
            native: [],
            protected: false,
          };
          candidates.set(directory, candidate);
        }
        const key = readerKey(observation.reader);
        const previous = candidate.observations.get(key);
        if (!previous || previous.cwd !== undefined) candidate.observations.set(key, observation);
        if (native) candidate.native.push(native);
        if (location.scope === "system" || location.scope === "plugin") candidate.protected = true;
      };
      const scan = Effect.fn("SkillInventory.scan")(function* (
        directory: string,
        kind: "user" | "project",
        observation: RootReader,
      ) {
        const exists = yield* io(() => files.checkDirectory(directory));
        const writable = yield* io(() => files.canWrite(directory));
        const location = locationFor(directory, kind, exists, writable);
        location.readers.push(observation);
        const directories = yield* io(() =>
          files.scanSkillDirectories(directory, observation.reader.agent === "codex"),
        );
        for (const skill of directories) add(location, skill, observation);
      });
      const scanRoot = (
        base: string,
        segments: string[],
        kind: "user" | "project",
        reader: RootReader,
      ) =>
        io(() => files.containedRoot(base, segments)).pipe(
          Effect.flatMap((directory) => scan(directory, kind, reader)),
          Effect.catch(() =>
            Effect.sync(() => report(reader.reader, "A skill location could not be read safely.")),
          ),
        );

      report(codex, null);
      yield* scanRoot(ports.home, [".agents", "skills"], "user", { reader: codex });
      // Codex account overlays bind this exact shared skills root. Reject other link targets.
      yield* io(async () => {
        const active = path.join(await files.canonicalBase(ports.codexHome), "skills");
        const shared = await files.containedRoot(ports.codexSharedHome, ["skills"]);
        const physical = await files.canonicalBase(active);
        if (physical !== active && physical !== shared)
          throw error("unsafe", "The Codex skills directory is redirected.");
        return physical;
      }).pipe(
        Effect.flatMap((directory) => scan(directory, "user", { reader: codex })),
        Effect.catch(() =>
          Effect.sync(() => report(codex, "The Codex skills directory could not be read safely.")),
        ),
      );

      const projectRoots = yield* Effect.forEach(scope.projectRoots, (root) =>
        io(() => files.canonicalBase(root)).pipe(Effect.orElseSucceed(() => null)),
      );
      for (const cwd of projectRoots) {
        if (cwd) yield* scanRoot(cwd, [".agents", "skills"], "project", { reader: codex, cwd });
      }

      const configurations = new Map<string, ClaudeSkillSettings>();
      const claudeProbes: Effect.Effect<void>[] = [];
      for (const profile of scope.claude) {
        const reader = { agent: "claude", instanceId: profile.instanceId } as const;
        report(reader, profile.home ? null : "The Claude Profile directory could not be resolved.");
        if (profile.home)
          yield* scanRoot(profile.home, ["skills"], "user", { reader, claudeHome: profile.home });
        const cwds = [...new Set(projectRoots.filter((cwd) => cwd !== null))];
        for (const cwd of cwds) {
          yield* scanRoot(cwd, [".claude", "skills"], "project", {
            reader,
            cwd,
            ...(profile.home ? { claudeHome: profile.home } : {}),
          });
        }
        if (!profile.home) continue;
        const probeCwds = cwds.length ? cwds : [null];
        for (const cwd of probeCwds) {
          claudeProbes.push(
            profile.configuration(cwd).pipe(
              Effect.match({
                onFailure: () =>
                  report(reader, "Claude's effective skill settings are unavailable."),
                onSuccess: (configuration) => {
                  configurations.set(JSON.stringify([reader.instanceId, cwd]), configuration);
                },
              }),
            ),
          );
        }
      }

      const codexProbe = ports.codexList(input).pipe(
        Effect.match({
          onFailure: () => {
            report(codex, "Codex skill availability is unavailable.");
            return [] as SkillMetadata[];
          },
          onSuccess: ({ data }) => {
            if (data.some((entry) => entry.errors.length))
              report(codex, "Codex reported incomplete skill discovery.");
            return data.flatMap((entry) => entry.skills);
          },
        }),
      );
      const [native] = yield* Effect.all(
        [codexProbe, Effect.all(claudeProbes, { concurrency: 3 })],
        { concurrency: 2 },
      );
      for (const skill of native) {
        if (skill.scope === "repo" && !scope.projectRoots.length) continue;
        if (!path.isAbsolute(skill.path) || path.basename(skill.path) !== "SKILL.md") continue;
        const directory = yield* io(async () => {
          const raw = path.dirname(skill.path);
          const real = await files.canonicalBase(raw);
          if (real !== path.join(await files.canonicalBase(path.dirname(raw)), path.basename(raw)))
            return null;
          return (await files.checkDirectory(real)) ? real : null;
        }).pipe(Effect.orElseSucceed(() => null));
        if (!directory) continue;
        const candidate = candidates.get(directory);
        const protectedScope = skill.pluginId
          ? "plugin"
          : skill.scope === "admin" || skill.scope === "system"
            ? "system"
            : null;
        if (protectedScope) {
          const location = locationFor(path.dirname(directory), protectedScope, true, false);
          location.readers.push({ reader: codex });
          add(location, directory, { reader: codex }, skill);
        } else if (candidate?.observations.has(readerKey(codex))) {
          candidate.native.push(skill);
        }
      }

      const groups = new Map<string, Candidate[]>();
      for (const candidate of candidates.values()) {
        for (const [reader, observation] of candidate.observations) {
          if (observation.reader.agent !== "claude") continue;
          const key = JSON.stringify([reader, path.basename(candidate.directory)]);
          const list = groups.get(key) ?? [];
          list.push(candidate);
          groups.set(key, list);
        }
      }
      const targets = new Map<string, Target>();
      const rows = new Map<Location, SkillInventoryEntry[]>();
      for (const candidate of candidates.values()) {
        const { directory, location } = candidate;
        const name = path.basename(directory);
        const manifest = yield* io(() => files.readManifest(directory)).pipe(Effect.result);
        const metadata =
          manifest._tag === "Success"
            ? files.manifestMetadata(manifest.success.markdown, name)
            : { name, description: "", parseError: manifest.failure.message };
        const writable =
          manifest._tag === "Success" &&
          location.writable &&
          !candidate.protected &&
          path.dirname(directory) === location.directory &&
          (yield* io(() => files.canWrite(directory)));
        const claudeSettings = new Map<
          string,
          { file: string; policy: string; expectedOverride: string | undefined }
        >();
        const agents = [...candidate.observations.entries()].map(([key, observation]) => {
          if (observation.reader.agent === "codex") return summarizeCodex(candidate, metadata.name);
          const group = groups.get(JSON.stringify([key, name])) ?? [];
          const shadowed =
            observation.cwd !== undefined &&
            group.some((other) => other.observations.get(key)?.cwd === undefined);
          const cwds = observation.cwd
            ? [observation.cwd]
            : projectRoots.filter((cwd) => cwd !== null);
          const effectiveCwds = cwds.length ? cwds : [null];
          const policies = effectiveCwds.map((cwd) =>
            configurations.get(JSON.stringify([observation.reader.instanceId, cwd])),
          );
          const summaries = policies.map((settings) =>
            summarizeClaude(
              candidate,
              observation,
              name,
              settings,
              shadowed,
              group.length > 1,
              metadata.parseError === null,
            ),
          );
          const primary = summaries[0];
          const sameState = summaries.every(
            ({ availability }) => availability.state === primary.availability.state,
          );
          const sameFile =
            primary.settingsFile &&
            summaries.every(({ settingsFile }) => settingsFile === primary.settingsFile);
          if (sameFile && primary.settingsFile)
            claudeSettings.set(key, {
              file: primary.settingsFile,
              policy: JSON.stringify(policies),
              expectedOverride: overrideFor(
                policies[0]?.skillOverrideSources?.find(({ path }) => path === primary.settingsFile)
                  ?.skillOverrides,
                name,
              ),
            });
          return {
            ...primary.availability,
            state: sameState ? primary.availability.state : ("unknown" as const),
            toggle: sameFile
              ? primary.availability.toggle
              : primary.availability.toggle.status === "available"
                ? unavailable("Claude settings differ across the Project's source directories.")
                : primary.availability.toggle,
          };
        });
        const id = skillId(input.hostId, directory);
        const row = {
          id,
          directory,
          manifestPath: path.join(directory, "SKILL.md"),
          writable,
          agents,
          ...metadata,
        };
        const entries = rows.get(location) ?? [];
        entries.push(row);
        rows.set(location, entries);
        targets.set(id, { row, location, codexPath: candidate.native[0]?.path, claudeSettings });
      }
      const snapshot: SkillInventorySnapshot = {
        generation: scope.binding,
        locations: [...locations.values()].map((location) => ({
          ...location,
          readers: [
            ...new Map(location.readers.map(({ reader }) => [readerKey(reader), reader])).values(),
          ],
          skills: (rows.get(location) ?? []).toSorted((a, b) =>
            a.directory.localeCompare(b.directory),
          ),
        })),
        sources: [...health.values()],
      };
      return {
        snapshot,
        targets,
        locations: new Map([...locations.values()].map((root) => [root.id, root])),
        scope,
      };
    });

    const target = (
      current: Effect.Success<ReturnType<typeof inventory>>,
      id: string,
      write = false,
    ) => {
      const value = current.targets.get(id);
      if (!value)
        return Effect.fail(error("unavailable", "The skill is no longer in this inventory."));
      if (write && !value.row.writable)
        return Effect.fail(error("read_only", "The skill is read-only."));
      return Effect.succeed(value);
    };
    const destination = (current: Effect.Success<ReturnType<typeof inventory>>, id: string) => {
      const value = current.locations.get(id);
      if (!value?.writable)
        return Effect.fail(error("read_only", "The skill location is unavailable or read-only."));
      return Effect.succeed(value);
    };
    const document = ({
      directory,
      id,
      writable,
    }: Pick<SkillInventoryEntry, "directory" | "id" | "writable">) =>
      io(async (): Promise<SkillDocument> => {
        const manifest = await files.readManifest(directory);
        const listed = await files.listSkillFiles(directory);
        return {
          skillId: id,
          markdown: manifest.markdown,
          revision: manifest.revision,
          writable,
          files: listed,
        };
      });
    const asResult = <T>(
      effect: Effect.Effect<T, files.SkillFileError>,
    ): Effect.Effect<SkillResult<T>> =>
      effect.pipe(Effect.match({ onSuccess: ok, onFailure: files.skillFailure }));
    const mutate = <A>(
      input: SkillInventoryContext,
      operation: Effect.Effect<A, files.SkillFileError>,
      lane = mutations,
    ) => {
      const serialized = lane.withPermits(1)(Effect.uninterruptible(operation));
      return (ports.runInProject?.(input.projectId, serialized) ?? serialized).pipe(
        Effect.ensuring(
          PubSub.publish(changes, input.hostId).pipe(Effect.andThen(refreshComposers)),
        ),
        Effect.catch((cause) => Effect.succeed(files.skillFailure(cause))),
      );
    };
    const recheck = (input: SkillInventoryContext, binding: string) =>
      ports
        .resolve(input)
        .pipe(
          Effect.flatMap((latest) =>
            latest.binding === binding
              ? Effect.void
              : Effect.fail(error("unavailable", "The skill inventory scope changed.")),
          ),
        );
    const staged = <A>(
      root: Location,
      slug: string,
      operation: (stage: files.StagedSkill) => Effect.Effect<A, files.SkillFileError>,
    ) =>
      Effect.acquireUseRelease(
        io(() => files.stageSkill(root.directory, slug)),
        operation,
        (stage) => io(() => files.discardSkillStage(stage)).pipe(Effect.ignore),
      );
    const conflict = (entry: SkillInventoryEntry) =>
      document(entry).pipe(Effect.map((document) => ({ status: "conflict" as const, document })));

    return {
      composerChanges: Stream.fromPubSub(composerChanges),
      list: (input: SkillInput<"list">) =>
        asResult(inventory(input).pipe(Effect.map(({ snapshot }) => snapshot))),
      readDocument: (input: SkillInput<"readDocument">) =>
        asResult(
          Effect.gen(function* () {
            const entry = yield* target(yield* inventory(input), input.skillId);
            return yield* document(entry.row);
          }),
        ),
      writeDocument: (input: SkillInput<"writeDocument">): Effect.Effect<SkillSaveResult> =>
        mutate(
          input,
          Effect.gen(function* () {
            const current = yield* inventory(input);
            const { row } = yield* target(current, input.skillId, true);
            const before = yield* io(() => files.readManifest(row.directory));
            if (before.revision !== input.baseRevision) return yield* conflict(row);
            yield* recheck(input, current.scope.binding);
            const saved = yield* io(() =>
              files.replaceFile(
                row.manifestPath,
                files.manifestBytes(input.markdown),
                before.mode,
                async () =>
                  (await files.readManifest(row.directory)).revision === input.baseRevision,
              ),
            );
            return saved ? ok(yield* document(row)) : yield* conflict(row);
          }),
        ),
      createBlank: (input: SkillInput<"createBlank">) =>
        mutate(
          input,
          Effect.gen(function* () {
            const current = yield* inventory(input);
            const root = yield* destination(current, input.locationId);
            yield* recheck(input, current.scope.binding);
            const directory = yield* staged(root, input.slug, (stage) =>
              io(() => files.blankSkill(stage.directory, input.slug)).pipe(
                Effect.andThen(recheck(input, current.scope.binding)),
                Effect.andThen(io(() => files.publishSkill(stage))),
              ),
            );
            const id = skillId(input.hostId, directory);
            return ok(
              yield* document({
                id,
                directory,
                writable: true,
              }),
            );
          }),
        ),
      rename: (input: SkillInput<"rename">): Effect.Effect<SkillSaveResult> =>
        mutate(
          input,
          Effect.gen(function* () {
            const current = yield* inventory(input);
            const { row } = yield* target(current, input.skillId, true);
            yield* recheck(input, current.scope.binding);
            const directory = yield* io(() =>
              files.renameSkillDirectory(row.directory, input.slug, input.baseRevision),
            );
            if (!directory) return yield* conflict(row);
            return ok(yield* document({ ...row, directory, id: skillId(input.hostId, directory) }));
          }),
        ),
      transfer: (input: SkillInput<"transfer">): Effect.Effect<SkillTransferResult> =>
        mutate(
          input,
          Effect.gen(function* () {
            const current = yield* inventory(input);
            const { row } = yield* target(current, input.skillId, input.mode === "move");
            const root = yield* destination(current, input.locationId);
            yield* recheck(input, current.scope.binding);
            if (
              root.directory === row.directory ||
              files.isContained(row.directory, root.directory)
            )
              return yield* Effect.fail(
                error("unsafe", "A skill cannot be transferred inside itself."),
              );
            const copied = yield* staged(root, input.slug, (stage) =>
              Effect.gen(function* () {
                const original = yield* io(() => files.readManifest(row.directory));
                const verify = yield* io(async () => {
                  const replacement =
                    input.slug === path.basename(row.directory)
                      ? undefined
                      : files.manifestBytes(files.renameManifest(original.markdown, input.slug));
                  return files.copySkillTree(row.directory, stage.directory, replacement);
                });
                yield* recheck(input, current.scope.binding);
                if (!(yield* io(verify)))
                  return yield* Effect.fail(
                    error("io", "The source changed while the skill was being copied."),
                  );
                const directory = yield* io(() => files.publishSkill(stage));
                return { directory, verify };
              }),
            );
            const id = skillId(input.hostId, copied.directory);
            if (input.mode === "copy") return ok({ skillId: id, sourceRetained: true });
            const removal = yield* recheck(input, current.scope.binding).pipe(
              Effect.andThen(io(() => files.readManifest(copied.directory))),
              Effect.andThen(io(copied.verify)),
              Effect.flatMap((same) =>
                same
                  ? ports.trashDirectory(row.directory)
                  : Effect.fail(error("io", "The source changed during the move.")),
              ),
              Effect.result,
            );
            return removal._tag === "Success"
              ? ok({ skillId: id, sourceRetained: false })
              : ok({ skillId: id, sourceRetained: true, warning: removal.failure.message });
          }),
        ),
      trash: (input: SkillInput<"trash">) =>
        mutate(
          input,
          Effect.gen(function* () {
            const current = yield* inventory(input);
            const { row } = yield* target(current, input.skillId, true);
            yield* recheck(input, current.scope.binding);
            yield* io(() => files.readManifest(row.directory));
            yield* ports.trashDirectory(row.directory);
            return ok(undefined);
          }),
        ),
      setEnabled: (input: SkillInput<"setEnabled">) =>
        mutate(
          input,
          Effect.gen(function* () {
            const current = yield* inventory({ ...input, forceRefresh: true });
            const entry = yield* target(current, input.skillId);
            const key = readerKey(input.reader);
            const agent = entry.row.agents.find((agent) => readerKey(agent) === key);
            if (agent?.toggle.status !== "available" || input.scope !== agent.toggle.scope)
              return yield* Effect.fail(
                error("read_only", "The skill cannot be toggled in this Agent's settings."),
              );
            if (agent.state === (input.enabled ? "enabled" : "disabled")) return ok(undefined);
            yield* recheck(input, current.scope.binding);
            if (input.reader.agent === "codex" && entry.codexPath) {
              yield* ports.codexSetEnabled(input, entry.codexPath, input.enabled);
              return ok(undefined);
            }
            const settings = entry.claudeSettings.get(key);
            if (!settings)
              return yield* Effect.fail(
                error("read_only", "The Claude settings file is unavailable."),
              );
            const latest = yield* inventory({ ...input, forceRefresh: true });
            const latestEntry = yield* target(latest, input.skillId);
            const verified = latestEntry.claudeSettings.get(key);
            if (verified?.file !== settings.file || verified.policy !== settings.policy)
              return yield* Effect.fail(error("unavailable", "The Claude settings changed."));
            yield* recheck(input, current.scope.binding);
            yield* io(() =>
              files.writeClaudeSkillOverride(
                settings.file,
                agent.invocationName,
                input.enabled,
                settings.expectedOverride,
              ),
            );
            return ok(undefined);
          }),
          settingsMutations,
        ),
      watch: (input: SkillInput<"watchStart">) =>
        observeSkillRoots(
          inventory(input).pipe(
            Effect.map(({ locations, targets }) => {
              const watched = new Map<string, boolean>();
              for (const location of locations.values()) {
                watched.set(location.directory, true);
                for (const { reader, cwd, claudeHome } of location.readers) {
                  if (reader.agent !== "claude") continue;
                  if (claudeHome) watched.set(path.join(claudeHome, "settings.json"), false);
                  if (cwd) {
                    watched.set(path.join(cwd, ".claude", "settings.json"), false);
                    watched.set(path.join(cwd, ".claude", "settings.local.json"), false);
                  }
                }
              }
              const open = input.skillId ? targets.get(input.skillId) : undefined;
              if (open) watched.set(open.row.directory, true);
              return [...watched].map(([path, recursive]) => ({ path, recursive }));
            }),
          ),
          Stream.merge(
            ports.changes,
            Stream.fromPubSub(changes).pipe(Stream.filter((hostId) => hostId === input.hostId)),
          ),
          ports.watchHost ?? localFileWatchHost,
          refreshComposers,
        ),
    };
  });

export class SkillInventory extends Context.Service<
  SkillInventory,
  Effect.Success<ReturnType<typeof makeSkillInventory>>
>()("nodex/main/host-runtime/SkillInventory") {}
