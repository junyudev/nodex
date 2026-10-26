import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { TestClock } from "effect/testing";
import { StandaloneSkills, live } from "./StandaloneSkills";
import {
  GitCommandPlatform,
  type GitCommandProcessInput,
} from "../git-worker/git-command-platform";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-skills-" });
  const home = yield* fs.realPath(temp);
  const repo = `${home}/vendor_imports/skills`;
  const project = `${home}/project`;
  yield* fs.makeDirectory(project);
  const calls: GitCommandProcessInput[] = [];
  let failGit = false;
  const git = GitCommandPlatform.of({
    run: (input) =>
      Effect.gen(function* () {
        calls.push(input);
        if (!failGit) {
          yield* fs.makeDirectory(`${repo}/.git`, { recursive: true }).pipe(Effect.orDie);
          for (const group of [".curated", ".experimental"]) {
            yield* fs
              .makeDirectory(`${repo}/skills/${group}/sample/scripts`, { recursive: true })
              .pipe(Effect.orDie);
            yield* fs
              .writeFileString(
                `${repo}/skills/${group}/sample/SKILL.md`,
                `---\nname: ${group === ".curated" ? "Curated" : "Experimental"}\ndescription: |\n  A useful skill.\nmetadata:\n  short-description: Short\n---\n# Skill`,
              )
              .pipe(Effect.orDie);
            yield* fs
              .writeFileString(`${repo}/skills/${group}/sample/scripts/run.py`, "print('hello')")
              .pipe(Effect.orDie);
          }
        }
        return {
          code: failGit ? 1 : 0,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          failureReason: null,
        };
      }),
  });
  const layer = live({
    codexHome: home,
    environment: { PATH: "/usr/bin", GIT_DIR: "/outside/.git", GIT_WORK_TREE: "/outside" },
  }).pipe(Layer.provide(Layer.succeed(GitCommandPlatform, git)));
  return {
    home,
    repo,
    project,
    calls,
    layer,
    fail: () => {
      failGit = true;
    },
  };
});
const skill = (
  path: string,
  scope: "user" | "repo" = "user",
  pluginId: string | null = null,
): SkillMetadata => ({
  path,
  scope,
  pluginId,
  name: "sample",
  description: "sample",
  enabled: true,
});

it.effect(
  "refreshes sparse recommendations after ten minutes and retains a failed-refresh cache",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* make;
        yield* Effect.gen(function* () {
          const skills = yield* StandaloneSkills;
          const initial = yield* skills.list(false);
          assert.deepEqual(
            initial.skills.map((skill) => [skill.id, skill.name, skill.shortDescription]),
            [["sample", "Curated", "Short"]],
          );
          assert.strictEqual(initial.source, "git");
          assert.strictEqual(h.calls.length, 2);
          assert.strictEqual(h.calls[0]?.environment.GIT_DIR, undefined);
          assert.strictEqual(h.calls[0]?.environment.GIT_WORK_TREE, undefined);
          assert.ok(
            h.calls.every(
              (call) => call.timeoutMs === 30_000 && call.environment.GIT_TERMINAL_PROMPT === "0",
            ),
          );
          yield* skills.list(false);
          assert.strictEqual(h.calls.length, 2);
          yield* TestClock.adjust("10 minutes");
          h.fail();
          const failed = yield* skills.list(false);
          assert.strictEqual(failed.source, "cache");
          assert.strictEqual(failed.error?.code, "service_unavailable");
          assert.deepEqual(failed.skills, initial.skills);
        }).pipe(Effect.provide(h.layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "installs a complete skill atomically in user and Project scopes and refuses replacement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* make;
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.gen(function* () {
          const skills = yield* StandaloneSkills;
          const installed = yield* skills.install("sample", null, Effect.void);
          assert.strictEqual(installed.path, `${h.home}/skills/sample/SKILL.md`);
          assert.deepEqual((yield* skills.contents(installed.path)).files, [
            "SKILL.md",
            "scripts/run.py",
          ]);
          assert.strictEqual(
            yield* fs.readFileString(`${h.home}/skills/sample/scripts/run.py`),
            "print('hello')",
          );
          const conflict = yield* skills.install("sample", null, Effect.void).pipe(Effect.flip);
          assert.strictEqual(conflict.code, "invalid_input");
          const project = yield* skills.install("sample", h.project, Effect.void);
          assert.strictEqual(project.path, `${h.project}/.agents/skills/sample/SKILL.md`);
          yield* skills.uninstall(skill(project.path, "repo"), [h.project], Effect.void);
          assert.strictEqual(yield* fs.exists(`${h.project}/.agents/skills/sample`), false);
          yield* fs.symlink(h.home, `${h.home}/native-home-alias`);
          yield* skills.uninstall(
            skill(`${h.home}/native-home-alias/skills/sample/SKILL.md`),
            [],
            Effect.void,
          );
          assert.strictEqual(yield* fs.exists(`${h.home}/skills/sample`), false);
        }).pipe(Effect.provide(h.layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects traversal, plugin removal, symlink scopes, and escaping support files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* make;
      const fs = yield* FileSystem.FileSystem;
      yield* Effect.gen(function* () {
        const skills = yield* StandaloneSkills;
        assert.strictEqual(
          (yield* skills.install("../outside", null, Effect.void).pipe(Effect.flip)).code,
          "invalid_input",
        );
        yield* skills.list(false);
        const outside = `${h.home}/outside`;
        yield* fs.makeDirectory(outside);
        yield* fs.writeFileString(`${outside}/SKILL.md`, "private");
        yield* fs.symlink(outside, `${h.home}/skills`);
        assert.strictEqual(
          (yield* skills.install("sample", null, Effect.void).pipe(Effect.flip)).code,
          "protected",
        );
        assert.strictEqual(
          (yield* skills.uninstall(skill(`${outside}/SKILL.md`), [], Effect.void).pipe(Effect.flip))
            .code,
          "protected",
        );
        assert.strictEqual(
          (yield* skills
            .uninstall(skill(`${outside}/SKILL.md`, "user", "plugin@market"), [], Effect.void)
            .pipe(Effect.flip)).code,
          "protected",
        );
        yield* fs.symlink(outside, `${h.project}/.agents`);
        assert.strictEqual(
          (yield* skills.install("sample", h.project, Effect.void).pipe(Effect.flip)).code,
          "protected",
        );
        assert.strictEqual(yield* fs.exists(`${outside}/skills`), false);
        yield* fs.symlink(`${outside}/SKILL.md`, `${h.repo}/skills/.curated/sample/leak.md`);
        assert.strictEqual(
          (yield* skills.install("sample", h.project, Effect.void).pipe(Effect.flip)).code,
          "protected",
        );
        assert.strictEqual(yield* fs.readFileString(`${outside}/SKILL.md`), "private");
      }).pipe(Effect.provide(h.layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "uses an available bundled catalog and supporting files before creating a Git checkout",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* make;
        const fs = yield* FileSystem.FileSystem;
        const bundled = `${h.home}/bundled`;
        yield* fs.makeDirectory(`${bundled}/skills/.curated/pdf`, { recursive: true });
        yield* fs.writeFileString(
          `${bundled}/skills/.curated/pdf/SKILL.md`,
          "---\nname: PDF\ndescription: Read files\n---\n# PDF",
        );
        const layer = live({ codexHome: h.home, environment: {}, bundledRepoRoot: bundled }).pipe(
          Layer.provide(
            Layer.succeed(GitCommandPlatform, {
              run: () => Effect.die("The bundled fallback must not fetch Git"),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const skills = yield* StandaloneSkills;
          const catalog = yield* skills.list(false);
          assert.strictEqual(catalog.source, "bundled");
          assert.deepEqual(
            catalog.skills.map((skill) => skill.id),
            ["pdf"],
          );
          const installed = yield* skills.install("pdf", null, Effect.void);
          assert.strictEqual(
            (yield* skills.contents(installed.path)).contents?.includes("# PDF"),
            true,
          );
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "previews recommendations before installation and authorizes only contained small icons",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const h = yield* make;
        yield* Effect.gen(function* () {
          const skills = yield* StandaloneSkills;
          const preview = yield* skills.recommendedContents("sample");
          assert.ok(preview.contents?.includes("# Skill"));
          assert.deepEqual(preview.files, ["SKILL.md", "scripts/run.py"]);
          assert.strictEqual(yield* fs.exists(`${h.home}/skills/sample`), false);
          for (const id of ["missing", "../sample", "/private"])
            assert.strictEqual(
              (yield* skills.recommendedContents(id).pipe(Effect.flip)).code,
              "not_found",
            );
          const source = `${h.repo}/skills/.curated/sample`;
          yield* fs.makeDirectory(`${source}/agents`);
          yield* fs.makeDirectory(`${source}/assets`);
          yield* fs.writeFileString(`${source}/assets/small.svg`, "<svg/>");
          yield* fs.writeFileString(
            `${source}/agents/openai.yaml`,
            'interface:\n  icon_small: "./assets/small.svg"\n',
          );
          const catalog = yield* skills.list(false);
          assert.ok(catalog.skills[0]?.iconUrl?.startsWith("app://fs/@fs/"));
          assert.ok(catalog.skills[0]?.iconUrl?.endsWith("/assets/small.svg"));
          assert.deepEqual((yield* skills.recommendedContents("sample")).files, [
            "SKILL.md",
            "agents/openai.yaml",
            "assets/small.svg",
            "scripts/run.py",
          ]);
          const outside = `${h.home}/private`;
          yield* fs.makeDirectory(outside);
          yield* fs.writeFileString(`${outside}/SKILL.md`, "private");
          yield* fs.writeFileString(
            `${source}/agents/openai.yaml`,
            `interface:\n  icon_small: "${outside}/SKILL.md"\n`,
          );
          assert.strictEqual((yield* skills.list(false)).skills[0]?.iconUrl, null);
          yield* fs.symlink(`${outside}/SKILL.md`, `${source}/leak.md`);
          assert.strictEqual(
            (yield* skills.recommendedContents("sample").pipe(Effect.flip)).code,
            "protected",
          );
        }).pipe(Effect.provide(h.layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
