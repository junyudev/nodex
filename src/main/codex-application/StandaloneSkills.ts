import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import { load, JSON_SCHEMA } from "js-yaml";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import type { RecommendedSkillsView, SkillContentsView } from "../../shared/codex-plugin-settings";
import { GitCommandPlatform } from "../git-worker/git-command-platform";
import { pluginError, pluginFailure, type PluginManagementError } from "./PluginManagementError";

const Skill = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  shortDescription: Schema.NullOr(Schema.String),
  repoPath: Schema.String,
});
const Cache = Schema.Struct({ fetchedAt: Schema.Number, skills: Schema.Array(Skill) });
const Frontmatter = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  interface: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const safeId = (id: string) => /^[a-z0-9][a-z0-9-]*$/u.test(id);
export class StandaloneSkills extends Context.Service<
  StandaloneSkills,
  {
    readonly list: (refresh: boolean) => Effect.Effect<RecommendedSkillsView>;
    readonly install: (
      id: string,
      projectRoot: string | null,
      beforeWrite: Effect.Effect<void, PluginManagementError>,
    ) => Effect.Effect<{ readonly path: string }, PluginManagementError>;
    readonly uninstall: (
      skill: SkillMetadata,
      roots: readonly string[],
      beforeWrite: Effect.Effect<void, PluginManagementError>,
    ) => Effect.Effect<void, PluginManagementError>;
    readonly contents: (
      skillFile: string,
    ) => Effect.Effect<SkillContentsView, PluginManagementError>;
  }
>()("nodex/main/codex-application/StandaloneSkills") {}

export const live = (options: {
  codexHome: string;
  environment: Readonly<Record<string, string | undefined>>;
  bundledRepoRoot?: string;
}) =>
  Layer.effect(
    StandaloneSkills,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitCommandPlatform;
      const lane = yield* Semaphore.make(1);
      const vendorRoot = path.join(options.codexHome, "vendor_imports");
      const repo = path.join(vendorRoot, "skills");
      const cacheFile = path.join(vendorRoot, "skills-curated-cache.json");
      const failure = () =>
        pluginError("service_unavailable", "Recommended skills could not be refreshed.", true);
      const exists = (file: string) => fs.exists(file).pipe(Effect.mapError(failure));
      const contained = (root: string, target: string) => {
        const relative = path.relative(root, target);
        return (
          relative !== "" &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      };
      const canonical = (file: string) =>
        fs
          .realPath(file)
          .pipe(Effect.mapError(() => pluginError("not_found", "The skill file is unavailable.")));
      const noLink = Effect.fn("StandaloneSkills.noLink")(function* (file: string) {
        const link = yield* fs.readLink(file).pipe(Effect.result);
        if (Result.isSuccess(link))
          return yield* pluginError("protected", "Skill files must not contain symbolic links.");
      });
      const files = Effect.fn("StandaloneSkills.files")(function* (root: string) {
        const canonicalRoot = yield* canonical(root);
        const pending = [root];
        const result: string[] = [];
        while (pending.length) {
          const directory = pending.pop()!;
          const children = yield* fs.readDirectory(directory).pipe(Effect.mapError(failure));
          for (const name of children) {
            const file = path.join(directory, name);
            yield* noLink(file);
            if (!contained(canonicalRoot, yield* canonical(file)))
              return yield* pluginError(
                "protected",
                "The skill contains files outside its directory.",
              );
            const info = yield* fs.stat(file).pipe(Effect.mapError(failure));
            if (info.type === "Directory") pending.push(file);
            else if (info.type === "File")
              result.push(path.relative(root, file).replaceAll("\\", "/"));
            else
              return yield* pluginError(
                "protected",
                "The skill contains an unsupported file type.",
              );
          }
        }
        return result.toSorted();
      });
      const contents = Effect.fn("StandaloneSkills.contents")(function* (skillFile: string) {
        const root = path.dirname(skillFile);
        const realRoot = yield* canonical(root);
        const realFile = yield* canonical(skillFile);
        if (!contained(realRoot, realFile))
          return yield* pluginError("protected", "The skill contents are outside its directory.");
        const included = yield* files(root);
        const contents = yield* fs
          .readFileString(realFile)
          .pipe(
            Effect.mapError(() => pluginError("not_found", "The skill contents are unavailable.")),
          );
        return { contents, files: included };
      });
      const readCache = fs.readFileString(cacheFile).pipe(
        Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(Cache))(text)),
        Effect.orElseSucceed(() => null),
      );
      const writeCache = (value: typeof Cache.Type) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* ownedRoot(options.codexHome, ["vendor_imports"], true);
            const temp = yield* fs.makeTempFileScoped({
              directory: vendorRoot,
              prefix: ".skills-cache-",
            });
            yield* fs.writeFileString(
              temp,
              yield* Schema.encodeEffect(Schema.fromJsonString(Cache))(value),
            );
            yield* fs.rename(temp, cacheFile);
          }),
        ).pipe(Effect.ignore);
      const run = (args: readonly string[], cwd: string) =>
        git
          .run({
            args: [
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "core.fsmonitor=false",
              ...(cwd === repo
                ? [`--git-dir=${path.join(repo, ".git")}`, `--work-tree=${repo}`]
                : []),
              ...args,
            ],
            cwd,
            environment: {
              ...Object.fromEntries(
                Object.entries(options.environment).filter(
                  ([name]) => !name.toUpperCase().startsWith("GIT_"),
                ),
              ),
              GIT_TERMINAL_PROMPT: "0",
            },
            timeoutMs: 30_000,
            outputBytesCap: 256_000,
          })
          .pipe(
            Effect.flatMap((result) =>
              result.code === 0 && result.failureReason === null
                ? Effect.void
                : Effect.fail(failure()),
            ),
          );
      const refreshRepo = Effect.gen(function* () {
        const ownedVendor = yield* ownedRoot(options.codexHome, ["vendor_imports"], true);
        if (yield* exists(repo)) {
          yield* noLink(repo);
          if ((yield* canonical(repo)) !== path.join(ownedVendor, "skills"))
            return yield* pluginError(
              "protected",
              "The recommended repository is outside the Codex home.",
            );
          if (yield* exists(path.join(repo, ".git"))) {
            yield* noLink(path.join(repo, ".git"));
            const info = yield* fs.stat(path.join(repo, ".git")).pipe(Effect.mapError(failure));
            if (info.type !== "Directory")
              return yield* pluginError(
                "protected",
                "The recommended repository must own its Git directory.",
              );
          }
        }
        if (!(yield* exists(path.join(repo, ".git")))) {
          yield* run(
            [
              "clone",
              "--depth",
              "1",
              "--filter=blob:none",
              "--sparse",
              "--branch",
              "main",
              "https://github.com/openai/skills.git",
              repo,
            ],
            vendorRoot,
          );
        } else {
          yield* run(
            ["fetch", "--depth", "1", "https://github.com/openai/skills.git", "main"],
            repo,
          );
          yield* run(["reset", "--hard", "FETCH_HEAD"], repo);
        }
        yield* run(["sparse-checkout", "set", "skills/.curated", "skills/.experimental"], repo);
      });
      const scan = Effect.fn("StandaloneSkills.scan")(function* (root: string) {
        const found = new Map<string, typeof Skill.Type>();
        for (const group of [".curated", ".experimental"]) {
          const directory = path.join(root, "skills", group);
          if (!(yield* exists(directory))) continue;
          const ids = yield* fs.readDirectory(directory).pipe(Effect.mapError(failure));
          for (const id of ids.toSorted()) {
            if (!safeId(id) || found.has(id)) continue;
            const skillFile = path.join(directory, id, "SKILL.md");
            if (!(yield* exists(skillFile))) continue;
            const realRoot = yield* canonical(root);
            const realFile = yield* canonical(skillFile);
            if (!contained(realRoot, realFile))
              return yield* pluginError(
                "protected",
                "A recommended skill is outside its repository.",
              );
            const text = yield* fs.readFileString(skillFile).pipe(Effect.mapError(failure));
            const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
            const decoded = frontmatter
              ? yield* Effect.try({
                  try: () => load(frontmatter, { schema: JSON_SCHEMA }),
                  catch: failure,
                }).pipe(
                  Effect.flatMap((value) =>
                    Schema.decodeUnknownEffect(Frontmatter)(value).pipe(Effect.mapError(failure)),
                  ),
                )
              : {};
            const short =
              decoded.interface?.short_description ??
              decoded.metadata?.["short-description"] ??
              decoded.metadata?.short_description;
            found.set(id, {
              id,
              name: decoded.name ?? id,
              description: decoded.description ?? id,
              shortDescription: typeof short === "string" ? short : null,
              repoPath: `skills/${group}/${id}`,
            });
          }
        }
        return [...found.values()].toSorted((a, b) => a.name.localeCompare(b.name));
      });
      const catalog = Effect.fn("StandaloneSkills.catalog")(function* (refresh: boolean) {
        const cache = yield* readCache;
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const gitExists = yield* exists(path.join(repo, ".git"));
        const localExists = yield* exists(path.join(repo, "skills", ".curated"));
        const bundled =
          options.bundledRepoRoot &&
          (yield* exists(path.join(options.bundledRepoRoot, "skills", ".curated")))
            ? options.bundledRepoRoot
            : null;
        const root = !refresh && !gitExists && !localExists && bundled ? bundled : repo;
        const attempt = Effect.gen(function* () {
          let source: RecommendedSkillsView["source"] = root === bundled ? "bundled" : "cache";
          if (
            root === repo &&
            (refresh || !cache || !localExists || now - cache.fetchedAt >= 600_000)
          ) {
            yield* refreshRepo;
            source = "git";
          }
          const skills = yield* scan(root);
          yield* writeCache({
            fetchedAt: source === "cache" ? (cache?.fetchedAt ?? now) : now,
            skills,
          });
          return { skills, root, error: null, source };
        });
        return yield* attempt.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (!cache && bundled) {
                const skills = yield* scan(bundled).pipe(Effect.orElseSucceed(() => []));
                return {
                  skills,
                  root: bundled,
                  error: pluginFailure(error),
                  source: "bundled" as const,
                };
              }
              return {
                skills: cache?.skills ?? [],
                root,
                error: pluginFailure(error),
                source: "cache" as const,
              };
            }),
          ),
        );
      });
      const ownedRoot = Effect.fn("StandaloneSkills.ownedRoot")(function* (
        base: string,
        segments: string[],
        create: boolean,
      ) {
        const realBase = yield* canonical(base);
        let root = realBase;
        for (const segment of segments) {
          root = path.join(root, segment);
          if (create && !(yield* exists(root)))
            yield* fs.makeDirectory(root).pipe(Effect.mapError(failure));
          if ((yield* canonical(root)) !== root)
            return yield* pluginError(
              "protected",
              "The skill directory must stay inside its installation scope.",
            );
        }
        return root;
      });
      return StandaloneSkills.of({
        list: (refresh) =>
          lane
            .withPermits(1)(catalog(refresh))
            .pipe(
              Effect.map(({ skills, error, source }) => ({
                skills: skills.map((skill) => ({
                  id: skill.id,
                  name: skill.name,
                  description: skill.description,
                  shortDescription: skill.shortDescription,
                })),
                error,
                source,
              })),
              Effect.orElseSucceed((error) => ({
                skills: [],
                error: pluginFailure(error),
                source: "cache" as const,
              })),
            ),
        contents,
        install: (id, projectRoot, beforeWrite) =>
          lane.withPermits(1)(
            Effect.scoped(
              Effect.gen(function* () {
                if (!safeId(id))
                  return yield* pluginError("invalid_input", "Select a recommended skill.");
                const catalogResult = yield* catalog(false);
                const skill = catalogResult.skills.find((skill) => skill.id === id);
                if (!skill)
                  return yield* pluginError("not_found", "The recommended skill was not found.");
                if (
                  !/^skills\/\.(?:curated|experimental)\/[a-z0-9][a-z0-9-]*$/u.test(
                    skill.repoPath,
                  ) ||
                  path.basename(skill.repoPath) !== id
                )
                  return yield* pluginError("protected", "The recommended skill path is invalid.");
                const source = path.join(catalogResult.root, skill.repoPath);
                if (!contained(yield* canonical(catalogResult.root), yield* canonical(source)))
                  return yield* pluginError(
                    "protected",
                    "The recommended skill is outside its repository.",
                  );
                yield* files(source);
                yield* beforeWrite;
                const root = yield* ownedRoot(
                  projectRoot ?? options.codexHome,
                  projectRoot === null ? ["skills"] : [".agents", "skills"],
                  true,
                );
                const destination = path.join(root, id);
                if (yield* exists(destination))
                  return yield* pluginError(
                    "invalid_input",
                    "A skill with this ID is already installed in this scope.",
                  );
                const stage = yield* fs
                  .makeTempDirectoryScoped({ directory: root, prefix: ".install-" })
                  .pipe(Effect.mapError(failure));
                const staged = path.join(stage, id);
                yield* fs.copy(source, staged, { overwrite: false }).pipe(Effect.mapError(failure));
                yield* beforeWrite;
                if ((yield* canonical(root)) !== root || (yield* exists(destination)))
                  return yield* pluginError(
                    "config_conflict",
                    "The skill installation directory changed.",
                  );
                yield* fs.rename(staged, destination).pipe(Effect.mapError(failure));
                return { path: path.join(destination, "SKILL.md") };
              }),
            ),
          ),
        uninstall: (skill, roots, beforeWrite) =>
          lane.withPermits(1)(
            Effect.gen(function* () {
              if (skill.pluginId !== null || (skill.scope !== "user" && skill.scope !== "repo"))
                return yield* pluginError(
                  "protected",
                  "Only standalone user or Project skills can be uninstalled.",
                );
              const directory = path.dirname(skill.path);
              if (
                path.basename(skill.path) !== "SKILL.md" ||
                path.basename(directory).startsWith(".")
              )
                return yield* pluginError("protected", "This skill is managed by the application.");
              const candidates =
                skill.scope === "user"
                  ? [yield* ownedRoot(options.codexHome, ["skills"], false)]
                  : yield* Effect.forEach(roots, (root) =>
                      ownedRoot(root, [".agents", "skills"], false).pipe(
                        Effect.orElseSucceed(() => ""),
                      ),
                    );
              const realDirectory = yield* canonical(directory);
              const realParent = yield* canonical(path.dirname(directory));
              const realFile = yield* canonical(skill.path);
              const root = candidates.find((root) => root && realParent === root);
              if (
                !root ||
                realDirectory !== path.join(root, path.basename(directory)) ||
                realFile !== path.join(realDirectory, "SKILL.md")
              )
                return yield* pluginError(
                  "protected",
                  "The skill is outside a standalone installation directory.",
                );
              yield* noLink(directory);
              yield* noLink(skill.path);
              yield* beforeWrite;
              if ((yield* canonical(root)) !== root)
                return yield* pluginError("protected", "The skill installation directory changed.");
              yield* fs.remove(realDirectory, { recursive: true }).pipe(Effect.mapError(failure));
            }),
          ),
      });
    }),
  );
