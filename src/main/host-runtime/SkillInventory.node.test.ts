import type { SkillsListResponse } from "@nodex/codex-app-server-protocol/v2/SkillsListResponse";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SkillResult } from "../../shared/skill-inventory";
import { makeSkillInventory, type ClaudeSkillSettings } from "./SkillInventory";
import { SkillFileError } from "../platform/node/SkillFilesNode";

const personal = { hostId: "local", projectId: null };
const project = { hostId: "local", projectId: "project" };
const manifest =
  "\uFEFF---\r\nname: 'original' # preserve\r\ndescription: A skill\r\nunknown: [a, b]\r\n---\r\n\r\n# Exact body\r\n";

const value = <T>(result: SkillResult<T>): T => {
  if (result.status !== "ok") throw new Error(`${result.code}: ${result.message}`);
  return result.value;
};

describe("SkillInventory", () => {
  let temp: string;
  let home: string;
  let cwd: string;
  let config: string;
  let codexHome: string;
  let userSkills: string;
  let refreshed: number;
  let trash: string[];

  beforeEach(async () => {
    temp = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "nodex-skill-inventory-")));
    home = path.join(temp, "home");
    cwd = path.join(temp, "project");
    config = path.join(home, ".agents");
    codexHome = path.join(home, ".codex");
    userSkills = path.join(config, "skills");
    await Promise.all([fs.mkdir(home), fs.mkdir(cwd)]);
    refreshed = 0;
    trash = [];
  });
  afterEach(async () => fs.rm(temp, { recursive: true, force: true }));

  const fixture = (native: SkillsListResponse = { data: [] }) =>
    makeSkillInventory({
      hostId: "local",
      home,
      codexHome,
      codexSharedHome: codexHome,
      resolve: (context) =>
        Effect.succeed({
          binding: context.projectId ?? "personal",
          projectRoots: context.projectId ? [cwd] : [],
          claude: [
            {
              instanceId: "claude-one",
              home: config,
              configuration: () =>
                Effect.tryPromise(async (): Promise<ClaudeSkillSettings> => {
                  const user = path.join(config, "settings.json");
                  const local = path.join(cwd, ".claude", "settings.local.json");
                  const read = (file: string) =>
                    fs.readFile(file, "utf8").then(
                      (text) =>
                        JSON.parse(text).skillOverrides as Record<string, string> | undefined,
                      () => undefined,
                    );
                  const userOverrides = await read(user);
                  const localOverrides = await read(local);
                  return {
                    skillOverrides: { ...userOverrides, ...localOverrides },
                    skillOverrideSources: [
                      ...(userOverrides
                        ? [
                            {
                              source: "user" as const,
                              path: user,
                              skillOverrides: userOverrides,
                              hasPolicyHelper: false,
                            },
                          ]
                        : []),
                      ...(localOverrides
                        ? [
                            {
                              source: "local" as const,
                              path: local,
                              skillOverrides: localOverrides,
                              hasPolicyHelper: false,
                            },
                          ]
                        : []),
                    ],
                  };
                }),
            },
          ],
        }),
      codexList: () => Effect.succeed(native),
      codexSetEnabled: () => Effect.void,
      trashDirectory: (directory) =>
        Effect.tryPromise({
          try: async () => {
            trash.push(directory);
            await fs.rename(directory, path.join(temp, `trashed-${trash.length}`));
          },
          catch: () => new SkillFileError("io", "Fake trash failed."),
        }),
      changes: Stream.empty,
      refreshComposers: Effect.sync(() => {
        refreshed += 1;
      }),
    });

  async function seed(root: string, slug = "original", text = manifest) {
    const directory = path.join(root, slug);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), text, { mode: 0o640 });
    return directory;
  }

  it.live(
    "merges physical roots, preserves same-name copies, and lists absent destinations only in scope",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seed(userSkills));
        yield* Effect.promise(() => seed(path.join(cwd, ".claude", "skills")));
        const skills = yield* fixture();
        const inventory = value(yield* skills.list(project));
        const shared = inventory.locations.find((row) => row.directory === userSkills);
        expect(shared?.readers.map((reader) => reader.agent)).toEqual(["codex", "claude"]);
        expect(inventory.locations.flatMap((row) => row.skills).map((row) => row.name)).toEqual([
          "original",
          "original",
        ]);
        expect(
          inventory.locations.find((row) => row.directory === path.join(cwd, ".claude", "skills"))
            ?.skills[0].agents[0].discovery,
        ).toBe("shadowed");
        expect(
          inventory.locations.find((row) => row.directory === path.join(cwd, ".agents", "skills")),
        ).toMatchObject({ exists: false, writable: true, skills: [] });
        expect(
          value(yield* skills.list(personal)).locations.every((row) => row.scope === "user"),
        ).toBe(true);
        expect(yield* skills.list({ ...project, hostId: "remote" })).toMatchObject({
          status: "failed",
          code: "unavailable",
        });
      }),
  );

  it.live(
    "saves exact UTF-8, detects stale revisions, renames only the name, and never recreates a deleted manifest",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() => seed(userSkills));
        const originalMode = (yield* Effect.promise(() =>
          fs.stat(path.join(directory, "SKILL.md")),
        )).mode;
        const edited = manifest.replace("Exact body", "Edited body");
        const skills = yield* fixture();
        const skillId = value(yield* skills.list(personal)).locations[0].skills[0].id;
        const input = { ...personal, skillId };
        const original = value(yield* skills.readDocument(input));
        expect(original.markdown).toBe(manifest);
        const saved = yield* skills.writeDocument({
          ...input,
          baseRevision: original.revision,
          markdown: edited,
        });
        expect(saved).toMatchObject({ status: "ok", value: { markdown: edited } });
        expect(
          yield* skills.writeDocument({
            ...input,
            baseRevision: original.revision,
            markdown: "stale",
          }),
        ).toMatchObject({ status: "conflict", document: { markdown: edited } });
        const updated = value(yield* skills.readDocument(input));
        const renamed = yield* skills.rename({
          ...input,
          baseRevision: updated.revision,
          slug: "renamed",
        });
        expect(renamed).toMatchObject({
          status: "ok",
          value: { markdown: edited.replace("'original'", "'renamed'") },
        });
        if (renamed.status !== "ok") throw new Error("Rename failed");
        const renamedFile = path.join(userSkills, "renamed", "SKILL.md");
        expect(yield* Effect.promise(() => fs.readFile(renamedFile, "utf8"))).toBe(
          renamed.value.markdown,
        );
        expect((yield* Effect.promise(() => fs.stat(renamedFile))).mode).toBe(originalMode);
        yield* Effect.promise(() => fs.unlink(renamedFile));
        expect(
          yield* skills.writeDocument({
            ...personal,
            skillId: renamed.value.skillId,
            baseRevision: renamed.value.revision,
            markdown: "stale",
          }),
        ).toMatchObject({ status: "failed", code: "unavailable" });
        expect(
          yield* Effect.promise(() =>
            fs.stat(directory).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        expect(
          yield* Effect.promise(() =>
            fs.stat(renamedFile).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
  );

  it.live(
    "publishes empty destinations, copies supporting files, refuses collisions and moves through trash",
    () =>
      Effect.gen(function* () {
        const source = yield* Effect.promise(() => seed(userSkills));
        yield* Effect.promise(() =>
          fs.writeFile(path.join(source, "script.sh"), "#!/bin/sh\n", { mode: 0o751 }),
        );
        const skills = yield* fixture();
        const inventory = value(yield* skills.list(project));
        const skillId = inventory.locations.find((row) => row.directory === userSkills)!.skills[0]
          .id;
        const locationId = inventory.locations.find(
          (row) => row.directory === path.join(cwd, ".agents", "skills"),
        )!.id;
        expect(
          yield* skills.createBlank({ ...project, locationId, slug: "../escape" }),
        ).toMatchObject({ status: "failed", code: "invalid_input" });
        const blank = value(yield* skills.createBlank({ ...project, locationId, slug: "blank" }));
        expect(blank.files).toEqual(["SKILL.md"]);
        const copied = value(
          yield* skills.transfer({
            ...project,
            skillId,
            locationId,
            slug: "copied",
            mode: "copy",
          }),
        );
        expect(copied.sourceRetained).toBe(true);
        const copy = value(yield* skills.readDocument({ ...project, skillId: copied.skillId }));
        expect(copy.files).toEqual(["SKILL.md", "script.sh"]);
        expect(copy.markdown).toBe(manifest.replace("'original'", "'copied'"));
        const scriptMode = (yield* Effect.promise(() => fs.stat(path.join(source, "script.sh"))))
          .mode;
        const copiedScript = path.join(cwd, ".agents", "skills", "copied", "script.sh");
        expect((yield* Effect.promise(() => fs.stat(copiedScript))).mode).toBe(scriptMode);
        expect(
          yield* skills.transfer({
            ...project,
            skillId,
            locationId,
            slug: "copied",
            mode: "move",
          }),
        ).toMatchObject({ status: "failed", code: "collision" });
        const moved = value(
          yield* skills.transfer({
            ...project,
            skillId,
            locationId,
            slug: "moved",
            mode: "move",
          }),
        );
        expect(moved.sourceRetained).toBe(false);
        expect(trash).toEqual([source]);
        value(yield* skills.trash({ ...project, skillId: moved.skillId }));
        expect(trash).toHaveLength(2);
        expect(refreshed).toBeGreaterThan(0);
      }),
  );

  it.live("refuses symlinked roots, manifests, and supporting files", () =>
    Effect.gen(function* () {
      const outside = yield* Effect.promise(() => seed(path.join(temp, "outside")));
      const source = yield* Effect.promise(() => seed(userSkills));
      yield* Effect.promise(() =>
        fs.symlink(path.join(outside, "SKILL.md"), path.join(source, "escape")),
      );
      yield* Effect.promise(() => fs.mkdir(path.join(cwd, ".agents")));
      yield* Effect.promise(() =>
        fs.symlink(path.dirname(outside), path.join(cwd, ".agents", "skills")),
      );
      const invalid = path.join(userSkills, "redirected");
      yield* Effect.promise(() => fs.mkdir(invalid));
      yield* Effect.promise(() =>
        fs.symlink(path.join(outside, "SKILL.md"), path.join(invalid, "SKILL.md")),
      );
      const skills = yield* fixture();
      const inventory = value(yield* skills.list(project));
      expect(
        inventory.locations.some((row) => row.directory === path.join(cwd, ".agents", "skills")),
      ).toBe(false);
      const local = inventory.locations.find((row) => row.directory === userSkills)!;
      const original = local.skills.find((row) => row.directory === source)!;
      const redirected = local.skills.find((row) => row.directory === invalid)!;
      expect(redirected.writable).toBe(false);
      expect(
        yield* skills.transfer({
          ...project,
          locationId: local.id,
          skillId: original.id,
          slug: "copy",
          mode: "copy",
        }),
      ).toMatchObject({ status: "failed", code: "unsafe" });
      expect(yield* skills.trash({ ...project, skillId: redirected.id })).toMatchObject({
        status: "failed",
        code: "read_only",
      });
    }),
  );

  it.live("writes and clears a Claude override without changing unrelated settings", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seed(userSkills));
      yield* Effect.promise(() =>
        seed(
          path.join(cwd, ".claude", "skills"),
          "project-skill",
          manifest.replaceAll("original", "project-skill"),
        ),
      );
      const settings = path.join(config, "settings.json");
      const local = path.join(cwd, ".claude", "settings.local.json");
      yield* Effect.promise(() =>
        fs.writeFile(
          settings,
          JSON.stringify({ hooks: { Stop: [] }, skillOverrides: { other: "name-only" } }),
        ),
      );
      const reader = { agent: "claude", instanceId: "claude-one" } as const;
      const skills = yield* fixture();
      const skillId = value(yield* skills.list(personal)).locations[0].skills[0].id;
      const input = { ...personal, skillId, reader, scope: "user" as const };
      value(yield* skills.setEnabled({ ...input, enabled: false }));
      const read = (file: string) =>
        Effect.promise(() => fs.readFile(file, "utf8").then((text) => JSON.parse(text) as unknown));
      expect(yield* read(settings)).toEqual({
        hooks: { Stop: [] },
        skillOverrides: { other: "name-only", original: "off" },
      });
      value(yield* skills.setEnabled({ ...input, enabled: true }));
      expect(yield* read(settings)).toEqual({
        hooks: { Stop: [] },
        skillOverrides: { other: "name-only" },
      });
      const projectSkill = value(yield* skills.list(project)).locations.find(
        (row) => row.directory === path.join(cwd, ".claude", "skills"),
      )!.skills[0];
      value(
        yield* skills.setEnabled({
          ...project,
          skillId: projectSkill.id,
          reader,
          scope: "project",
          enabled: false,
        }),
      );
      expect(yield* read(local)).toEqual({ skillOverrides: { "project-skill": "off" } });
    }),
  );

  it.live(
    "copies file-backed native skills without exposing Project plugins in personal scope",
    () =>
      Effect.gen(function* () {
        const system = yield* Effect.promise(() => seed(path.join(temp, "bundled")));
        const plugin = yield* Effect.promise(() => seed(path.join(temp, "project-plugin")));
        const skills = yield* fixture({
          data: [
            {
              cwd,
              errors: [],
              skills: [
                {
                  name: "original",
                  description: "Bundled",
                  scope: "system",
                  enabled: true,
                  path: path.join(system, "SKILL.md"),
                  pluginId: null,
                },
                {
                  name: "original",
                  description: "Project plugin",
                  scope: "repo",
                  enabled: false,
                  path: path.join(plugin, "SKILL.md"),
                  pluginId: "project@market",
                },
              ],
            },
          ],
        });
        const locations = value(yield* skills.list(personal)).locations;
        expect(locations.some((location) => location.scope === "plugin")).toBe(false);
        const bundled = locations.find((location) => location.scope === "system")!.skills[0];
        expect(bundled).toMatchObject({
          writable: false,
          agents: [{ state: "enabled", toggle: { status: "unavailable" } }],
        });
        expect(
          value(yield* skills.list(project)).locations.find(
            (location) => location.scope === "plugin",
          )?.skills[0],
        ).toMatchObject({ writable: false, agents: [{ state: "disabled" }] });
        const target = locations.find((location) => location.directory === userSkills)!;
        const copy = value(
          yield* skills.transfer({
            ...personal,
            skillId: bundled.id,
            locationId: target.id,
            slug: "my-copy",
            mode: "copy",
          }),
        );
        expect(
          value(yield* skills.readDocument({ ...personal, skillId: copy.skillId })),
        ).toMatchObject({ writable: true, markdown: manifest.replace("'original'", "'my-copy'") });
        expect(yield* skills.trash({ ...personal, skillId: bundled.id })).toMatchObject({
          status: "failed",
          code: "read_only",
        });
      }),
  );

  it.live("watches a missing root after readiness and invalidates when it appears", () =>
    Effect.gen(function* () {
      const skills = yield* fixture();
      const ready = yield* Deferred.make<void>();
      const changed = yield* Deferred.make<void>();
      yield* skills.watch(project).pipe(
        Stream.runForEach((event) =>
          Deferred.succeed(event === "ready" ? ready : changed, undefined),
        ),
        Effect.forkScoped(),
      );
      yield* Deferred.await(ready).pipe(Effect.timeout("3 seconds"));
      yield* Effect.promise(() => seed(path.join(cwd, ".agents", "skills")));
      yield* Deferred.await(changed).pipe(Effect.timeout("3 seconds"));
      expect(refreshed).toBe(1);
      const location = value(yield* skills.list(project)).locations.find(
        (row) => row.directory === path.join(cwd, ".agents", "skills"),
      );
      expect(location).toMatchObject({ exists: true, skills: [{ name: "original" }] });
    }),
  );
});
