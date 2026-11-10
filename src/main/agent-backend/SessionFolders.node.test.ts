import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HostWorkspace } from "../../host/HostWorkspace";
import { testLayer as configLayer, type MainConfigValue } from "../app/MainConfig";
import { CoreModules } from "../core-runtime/CoreModules";
import type {
  ProjectWorkspaceApplyResult,
  ProjectWorkspaceReadSnapshot,
} from "../core-client/types";
import { make, type SessionFolders } from "./SessionFolders";

type Folder = Effect.Success<ReturnType<SessionFolders["Service"]["ensure"]>>;

const fixture = (config: Partial<MainConfigValue>, projectlessRoot?: string) => {
  const folders = new Map<string, Folder>();
  let candidates = 0;
  const workspace = {
    read: (input) =>
      Effect.sync(() => {
        if (input.kind !== "session") throw new Error("Expected a Session read");
        return {
          value: {
            kind: "session",
            session: { id: input.session_id, folder: folders.get(input.session_id) ?? null },
          },
        } as ProjectWorkspaceReadSnapshot;
      }),
    apply: ({ intent }) =>
      Effect.sync(() => {
        if (intent.kind !== "bind_chat_folder") throw new Error("Expected a Chat folder bind");
        candidates += 1;
        const winner = folders.get(intent.session_id) ?? intent.folder;
        folders.set(intent.session_id, winner);
        return { outcome: { chat_folder: winner } } as ProjectWorkspaceApplyResult;
      }),
  } satisfies Pick<CoreModules["Service"]["workspace"], "read" | "apply">;
  const service = make.pipe(
    Effect.provideService(CoreModules, { workspace } as unknown as CoreModules["Service"]),
    Effect.provideService(HostWorkspace, {
      projectlessRoot,
      resolve: () => Effect.die("unused"),
    }),
    Effect.provide(configLayer(config)),
  );
  return { service, candidates: () => candidates };
};

const tempDirectory = Effect.acquireRelease(
  Effect.promise(async () => realpath(await mkdtemp(path.join(tmpdir(), "nodex-chat-folder-")))),
  (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
);

const exists = (directory: string) =>
  Effect.tryPromise(() => access(directory)).pipe(Effect.isSuccess);

it.effect("concurrent ensures reuse the winner and remove the losing allocation", () =>
  Effect.gen(function* () {
    const root = yield* tempDirectory;
    const f = fixture({ projectsDirectory: root });
    const service = yield* f.service;
    const [first, second] = yield* Effect.all(
      [
        service.ensure("draft", { nameHint: "你好，世界" }),
        service.ensure("draft", { nameHint: "另一个名称" }),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(f.candidates(), 2);
    assert.deepEqual(first, second);
    assert.deepEqual(yield* service.ensure("draft"), first);
    assert.equal(path.dirname(path.dirname(first.path)), path.join(root, "Chats"));
    assert.include(["你好-世界", "另一个名称"], path.basename(first.path));
    const date = path.dirname(first.path);
    assert.deepEqual(yield* Effect.promise(() => readdir(date)), [path.basename(first.path)]);
    assert.deepEqual((yield* Effect.promise(() => readdir(first.path))).sort(), [
      "outputs",
      "work",
    ]);
    yield* service.cleanDeleted([first]);
    assert.isFalse(yield* exists(date));
  }),
);

it.effect("a chosen folder creates no subdirectories and a symlink cannot be chosen", () =>
  Effect.gen(function* () {
    const root = yield* tempDirectory;
    const chosen = path.join(root, "chosen");
    const link = path.join(root, "symlink");
    yield* Effect.promise(async () => {
      await mkdir(chosen);
      await symlink(chosen, link, "junction");
    });
    const service = yield* fixture({ projectsDirectory: root }).service;
    assert.isTrue(yield* service.choose("draft", link).pipe(Effect.isFailure));
    assert.isTrue(yield* service.choose("draft", "relative").pipe(Effect.isFailure));
    const folder = yield* service.choose("draft", chosen);
    assert.deepEqual(folder, {
      execution_host_id: "local",
      origin: "chosen",
      path: chosen,
      output_directory: chosen,
    });
    assert.deepEqual(yield* service.ensure("draft"), folder);
    assert.deepEqual(yield* Effect.promise(() => readdir(chosen)), []);
    yield* service.cleanDeleted([folder]);
    assert.isTrue(yield* exists(chosen));
  }),
);

it.effect(
  "generated cleanup leaves a non-empty tree and uses the team Host root as configured",
  () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      const teamRoot = path.join(root, "tasks");
      const service = yield* fixture({ projectsDirectory: path.join(root, "projects") }, teamRoot)
        .service;
      const folder = yield* service.ensure("draft");
      const deliverable = path.join(folder.path, "outputs", "report.txt");
      yield* Effect.promise(() => writeFile(deliverable, "keep"));
      assert.equal(path.dirname(path.dirname(folder.path)), teamRoot);
      yield* service.cleanDeleted([folder]);
      assert.isTrue(yield* exists(deliverable));
      assert.isTrue(yield* exists(path.join(folder.path, "work")));
    }),
);

it.effect("an isolated run generates Chat folders in its own home", () =>
  Effect.gen(function* () {
    const root = yield* tempDirectory;
    const service = yield* fixture({ nodexHome: root, isolatedRunId: "chat-folder-test" }).service;
    const folder = yield* service.ensure("draft");
    assert.equal(path.dirname(path.dirname(folder.path)), path.join(root, "workspace", "Chats"));
  }),
);
