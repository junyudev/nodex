import {
  describe,
  expect as expectNativePromptImages,
  it as itNativePromptImages,
  vi,
} from "vite-plus/test";
import { tmpdir } from "node:os";
import path from "node:path";
import { join, resolve, sep } from "node:path";
import { describe as describeprojectdiscovery, expect, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { GitRepositoryIdentity } from "../platform/node/GitRepositoryProbe";
import {
  discoverProjects,
  isOfferedProjectFolder,
  projectCandidatesFromConversations,
  projectDiscoveryPlaces,
  repositoryFromRemoteUrl,
  type ProjectDiscoveryConversation,
  type ProjectDiscoveryPage,
} from "./project-discovery";
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
import { HostWorkspace } from "../../host/HostWorkspace";
import { testLayer as configLayer, type MainConfigValue } from "../app/MainConfig";
import { CoreModules } from "../core-runtime/CoreModules";
import type {
  ProjectWorkspaceApplyResult,
  ProjectWorkspaceReadSnapshot,
} from "../core-client/types";
import { make, type SessionFolders } from "./SessionFolders";
import { fitWithImageCodec, type EncodableImage, type FitPromptImage } from "./AgentImageFitting";
import { prepareNativePromptImages } from "./NativePromptImages";

describe("project-discovery", () => {
  const describe = describeprojectdiscovery;
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_000 * DAY;

  const conversation = (
    id: string,
    cwd: string,
    updatedAt: number,
    overrides: { readonly imported?: boolean } = {},
  ): ProjectDiscoveryConversation => ({
    backendKind: "codex",
    nativeHome: "/home/.codex",
    nativeSessionId: id,
    title: id,
    cwd,
    updatedAt,
    imported: false,
    ...overrides,
  });

  const repository = (root: string, remoteUrl: string | null = null): GitRepositoryIdentity => ({
    root,
    remoteUrl,
  });

  describe("repositoryFromRemoteUrl", () => {
    it.each([
      ["git@github.com:acme/widgets.git", "acme/widgets"],
      ["https://github.com/acme/widgets.git", "acme/widgets"],
      ["https://github.com/acme/widgets/", "acme/widgets"],
      ["ssh://git@example.com/group/sub/widgets", "sub/widgets"],
    ])("reads %s", (url, expected) => {
      expect(repositoryFromRemoteUrl(url)).toBe(expected);
    });

    it("has no answer without a recognizable path", () => {
      expect(repositoryFromRemoteUrl(null)).toBeNull();
      expect(repositoryFromRemoteUrl("https://example.com/widgets")).toBeNull();
    });
  });

  describe("isOfferedProjectFolder", () => {
    const home = resolve("/Users/me");
    const places = {
      home,
      nodexHome: join(home, ".nodex"),
      temporary: [tmpdir()],
    };

    it("offers ordinary work folders", () => {
      expect(isOfferedProjectFolder(join(home, "code", "widgets"), places)).toBe(true);
      expect(isOfferedProjectFolder(join(home, "Downloads-archive"), places)).toBe(true);
    });

    it.each([
      home,
      join(home, "Downloads", "thing"),
      join(home, ".codex", "worktrees", "abc"),
      join(home, ".claude", "projects"),
      join(home, ".nodex", "generated", "one"),
      join(home, "Documents", "Codex", "scratch"),
      join(tmpdir(), "experiment"),
    ])("does not offer %s", (folder) => {
      expect(isOfferedProjectFolder(folder, places)).toBe(false);
    });
  });

  describe("projectCandidatesFromConversations", () => {
    it("merges a repository's folders and linked worktrees into one candidate", () => {
      const main = repository("/code/widgets", "git@github.com:acme/widgets.git");
      const [candidate] = projectCandidatesFromConversations(
        [
          conversation("a", "/code/widgets", NOW - DAY),
          conversation("b", "/code/widgets/packages/ui", NOW - 2 * DAY),
          conversation("c", "/worktrees/widgets-fix", NOW - 3 * DAY),
        ],
        new Map([
          ["/code/widgets", main],
          ["/code/widgets/packages/ui", main],
          ["/worktrees/widgets-fix", main],
        ]),
        NOW,
      );
      expect(candidate).toMatchObject({
        path: "/code/widgets",
        name: "widgets",
        repository: "acme/widgets",
        chatCount: 3,
        lastActiveAt: NOW - DAY,
        suggested: true,
      });
      expect(candidate?.recentChats.map((chat) => chat.nativeSessionId)).toEqual(["a", "b", "c"]);
    });

    it("suggests only actively used Git repositories", () => {
      const identities = new Map([
        ["/code/few", repository("/code/few")],
        ["/code/old", repository("/code/old")],
        ["/notes", null],
      ]);
      const conversations = [
        conversation("few", "/code/few", NOW - DAY),
        ...["1", "2", "3"].map((id) => conversation(`old${id}`, "/code/old", NOW - 90 * DAY)),
        ...["1", "2", "3"].map((id) => conversation(`note${id}`, "/notes", NOW - DAY)),
      ];
      const byPath = new Map(
        projectCandidatesFromConversations(conversations, identities, NOW).map((candidate) => [
          candidate.path,
          candidate,
        ]),
      );
      expect(byPath.get("/code/few")?.suggested).toBe(false);
      expect(byPath.get("/code/old")?.suggested).toBe(false);
      expect(byPath.get("/notes")?.suggested).toBe(false);
    });

    it("shortens a path under the home directory", () => {
      const home = resolve("/home/me");
      const folder = join(home, "code", "a");
      const [candidate] = projectCandidatesFromConversations(
        [conversation("a", folder, NOW)],
        new Map(),
        NOW,
        home,
      );
      expect(candidate?.path).toBe(folder);
      expect(candidate?.displayPath).toBe(`~${sep}code${sep}a`);
    });

    it("lists Git repositories first, newest activity on top", () => {
      const candidates = projectCandidatesFromConversations(
        [
          conversation("folder", "/notes", NOW),
          conversation("older", "/code/older", NOW - 5 * DAY),
          conversation("newer", "/code/newer", NOW - DAY),
        ],
        new Map([
          ["/code/older", repository("/code/older")],
          ["/code/newer", repository("/code/newer")],
        ]),
        NOW,
      );
      expect(candidates.map((candidate) => candidate.path)).toEqual([
        "/code/newer",
        "/code/older",
        "/notes",
      ]);
    });

    it("leaves old and already-copied chats out of what can be brought in", () => {
      const [candidate] = projectCandidatesFromConversations(
        [
          conversation("recent", "/code/a", NOW - DAY),
          conversation("copied", "/code/a", NOW - DAY, { imported: true }),
          conversation("old", "/code/a", NOW - 60 * DAY),
        ],
        new Map([["/code/a", repository("/code/a")]]),
        NOW,
      );
      expect(candidate?.chatCount).toBe(3);
      expect(candidate?.recentChats.map((chat) => chat.nativeSessionId)).toEqual(["recent"]);
    });
  });

  describe("discoverProjects", () => {
    const page = (
      entries: ProjectDiscoveryPage["entries"],
      nextCursor: string | null = null,
    ): ProjectDiscoveryPage => ({ nativeHome: "/home/.codex", nextCursor, entries });
    const entry = (id: string, cwd: string, cwdAvailable = true) => ({
      nativeSessionId: id,
      title: id,
      cwd,
      cwdAvailable,
      updatedAt: NOW - DAY,
    });

    it.effect("reads every page, skipping folders that are gone or not Projects", () =>
      Effect.gen(function* () {
        const result = yield* discoverProjects({
          sources: [{ backendKind: "codex" }],
          places: projectDiscoveryPlaces("/home/.nodex", "/home"),
          now: NOW,
          readPage: (_source, cursor) =>
            Effect.succeed(
              cursor === null
                ? page([entry("a", "/code/a"), entry("gone", "/code/gone", false)], "next")
                : page([entry("b", "/code/b"), entry("scratch", join(tmpdir(), "scratch"))]),
            ),
          probe: (cwd) => Effect.succeed(repository(cwd)),
        });
        expect(result.truncated).toBe(false);
        expect(result.candidates.map((candidate) => candidate.path).toSorted()).toEqual([
          "/code/a",
          "/code/b",
        ]);
      }),
    );

    it.effect("keeps what other histories found when one can't be read", () =>
      Effect.gen(function* () {
        const result = yield* discoverProjects({
          sources: [
            { backendKind: "codex" },
            { backendKind: "claude", instanceConfigId: "c" },
            { backendKind: "antigravity", instanceConfigId: "a" },
          ],
          places: projectDiscoveryPlaces("/home/.nodex", "/home"),
          now: NOW,
          readPage: (source) =>
            source.backendKind === "codex"
              ? Effect.fail("unreadable" as const)
              : source.backendKind === "claude"
                ? Effect.succeed(page([entry("a", "/code/a")]))
                : Effect.succeed(page([entry("b", "/code/b"), entry("no-folder", "")])),
          probe: () => Effect.succeed(null),
        });
        expect(result.candidates.map((candidate) => candidate.path)).toEqual([
          "/code/a",
          "/code/b",
        ]);
      }),
    );

    it.effect("stops at its bound and says so", () =>
      Effect.gen(function* () {
        let reads = 0;
        const result = yield* discoverProjects({
          sources: [{ backendKind: "codex" }],
          places: projectDiscoveryPlaces("/home/.nodex", "/home"),
          now: NOW,
          readPage: () => {
            reads += 1;
            return Effect.succeed(
              page(
                Array.from({ length: 50 }, (_, index) => entry(`${reads}-${index}`, "/code/a")),
                "more",
              ),
            );
          },
          probe: (cwd) => Effect.succeed(repository(cwd)),
        });
        expect(result.truncated).toBe(true);
        expect(reads).toBe(10);
      }),
    );
  });
});

describe("SessionFolders", () => {
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
      apply: ({ intent, operationId }) =>
        Effect.sync(() => {
          if (intent.kind !== "bind_chat_folder" && intent.kind !== "reset_chat_folder")
            throw new Error("Expected a Chat folder mutation");
          const previous = folders.get(intent.session_id);
          const next =
            intent.kind === "reset_chat_folder"
              ? undefined
              : intent.folder.origin === "generated" && previous
                ? previous
                : intent.folder;
          if (intent.kind === "bind_chat_folder") candidates += 1;
          if (next) folders.set(intent.session_id, next);
          else folders.delete(intent.session_id);
          return {
            status: "no_op",
            observed: { commit_head: 0, store_epoch: "epoch" },
            receipt: {
              duplicate: false,
              operation_id: operationId,
              affected_project_ids: [],
              affected_session_ids: [intent.session_id],
            },
            outcome: {
              affected_project_ids: [],
              affected_session_ids: [intent.session_id],
              affected_thread_ids: [],
              chat_folder: next,
              deleted_chat_folders:
                previous?.origin === "generated" && previous.path !== next?.path ? [previous] : [],
            },
          } satisfies ProjectWorkspaceApplyResult;
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
          service.ensure("draft", { nameHint: "Plan the launch" }),
          service.ensure("draft", { nameHint: "另一个名称" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(f.candidates(), 2);
      assert.deepEqual(first, second);
      assert.deepEqual(yield* service.ensure("draft"), first);
      assert.equal(path.dirname(path.dirname(first.path)), path.join(root, "Chats"));
      assert.include(["plan-the-launch", "new-chat"], path.basename(first.path));
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
      const service = yield* fixture({ nodexHome: root, isolatedRunId: "chat-folder-test" })
        .service;
      const folder = yield* service.ensure("draft");
      assert.equal(path.dirname(path.dirname(folder.path)), path.join(root, "workspace", "Chats"));
    }),
  );

  it.effect("changing and resetting a draft folder removes only empty generated directories", () =>
    Effect.gen(function* () {
      const root = yield* tempDirectory;
      const chosen = path.join(root, "chosen");
      yield* Effect.promise(() => mkdir(chosen));
      const service = yield* fixture({ projectsDirectory: root }).service;
      const generated = yield* service.ensure("draft");
      const picked = yield* service.choose("draft", chosen);
      assert.equal(picked.path, chosen);
      assert.isFalse(yield* exists(generated.path));
      yield* service.reset("draft");
      assert.isNull(yield* service.existing("draft"));
      assert.isTrue(yield* exists(chosen));
      const second = yield* service.ensure("draft");
      const file = path.join(second.path, "outputs", "report.txt");
      yield* Effect.promise(() => writeFile(file, "keep"));
      yield* service.reset("draft");
      assert.isNull(yield* service.existing("draft"));
      assert.isTrue(yield* exists(file));
    }),
  );
});

describe("NativePromptImages", () => {
  const expect = expectNativePromptImages;
  const it = itNativePromptImages;
  const MB = 1024 * 1024;
  const unused: FitPromptImage = () => {
    throw new Error("not called");
  };

  it("prepares explicitly attached owned media and local files without network reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nodex-native-images-"));
    try {
      const file = path.join(root, "image.png");
      await writeFile(file, Buffer.from([137, 80, 78, 71]));
      const result = await prepareNativePromptImages(
        [{ source: file }, { source: "nodex://assets/owned.jpg" }],
        () => ({ mimeType: "image/jpeg", bytes: Uint8Array.from([255, 216, 255]) }),
        unused,
      );
      expect(result).toEqual([
        { mediaType: "image/png", data: "iVBORw==" },
        { mediaType: "image/jpeg", data: "/9j/" },
      ]);
      await expect(
        prepareNativePromptImages(
          [{ source: "https://example.com/image.png" }],
          () => {
            throw new Error("not called");
          },
          unused,
        ),
      ).rejects.toThrow("local image");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fits only the images over their share of what one message carries", async () => {
    const read = () => ({ mimeType: "image/png", bytes: new Uint8Array(5 * MB) });
    const fit = vi.fn<FitPromptImage>(async () => ({
      mediaType: "image/jpeg",
      bytes: new Uint8Array(3 * MB),
    }));
    // Five full-size screenshots share 20 MB, so each one is fitted to 4 MB.
    const shared = await prepareNativePromptImages(
      Array.from({ length: 5 }, () => ({ source: "nodex://assets/image.png" })),
      read,
      fit,
    );
    expect(shared.map((image) => image.mediaType)).toEqual(Array(5).fill("image/jpeg"));
    expect(fit.mock.calls.map(([, budget]) => budget)).toEqual(Array(5).fill(4 * MB));

    fit.mockClear();
    // One screenshot within its own share is sent as it is.
    const single = await prepareNativePromptImages(
      [{ source: "nodex://assets/image.png" }],
      () => ({ mimeType: "image/png", bytes: new Uint8Array(4 * MB) }),
      fit,
    );
    expect(single[0]?.mediaType).toBe("image/png");
    expect(fit).not.toHaveBeenCalled();
  });

  it("says an image can't be read in words a person can act on, keeping the system's error", async () => {
    const missing = path.join(tmpdir(), "nodex-native-images-missing", "gone.png");
    const fromFile = prepareNativePromptImages(
      [{ source: missing }],
      () => {
        throw new Error("not called");
      },
      unused,
    );
    await expect(fromFile).rejects.toThrow("An image can’t be read");
    await expect(fromFile).rejects.not.toThrow(missing);
    await expect(fromFile).rejects.toMatchObject({ cause: { code: "ENOENT" } });
    await expect(
      prepareNativePromptImages(
        [{ source: "nodex://assets/gone.png" }],
        () => {
          throw new Error("ENOENT: cache/media/gone.png");
        },
        unused,
      ),
    ).rejects.toThrow("An image can’t be read");
  });

  it("rejects what cannot be sent as an image at all", async () => {
    const read = () => ({ mimeType: "image/png", bytes: new Uint8Array(6 * MB) });
    await expect(
      prepareNativePromptImages([{ source: "data:image/svg+xml;base64,PHN2Zz4=" }], read, unused),
    ).rejects.toThrow("valid PNG");
    await expect(
      prepareNativePromptImages(
        Array.from({ length: 21 }, () => ({ source: "nodex://assets/image.png" })),
        read,
        unused,
      ),
    ).rejects.toThrow("at most 20 images");
    await expect(
      prepareNativePromptImages(
        [{ source: "nodex://assets/image.png" }],
        read,
        async (image) => image,
      ),
    ).rejects.toThrow("too large to send");
  });

  /** A decoded image whose encodings grow with its pixel count, as real ones roughly do. */
  const image = (width: number, height: number, bytesPerPixel: { png: number; jpeg: number }) => {
    const encoded = (perPixel: number) => new Uint8Array(Math.round(width * height * perPixel));
    const decoded: EncodableImage = {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      resize: (size) => image(size.width, size.height, bytesPerPixel),
      toPNG: () => encoded(bytesPerPixel.png),
      toJPEG: (quality) => encoded((bytesPerPixel.jpeg * quality) / 85),
    };
    return decoded;
  };

  it("keeps a screenshot PNG while it fits, and steps its size down before giving up", async () => {
    const source = { mediaType: "image/png" as const, bytes: new Uint8Array(6 * MB) };
    // A Retina screenshot: too large as it is, a sharp PNG once its longest edge is 2048px.
    const screenshot = await fitWithImageCodec(() => image(5120, 2880, { png: 0.5, jpeg: 0.3 }))(
      source,
      5 * MB,
    );
    expect(screenshot.mediaType).toBe("image/png");
    expect(screenshot.bytes.byteLength).toBeLessThanOrEqual(5 * MB);

    // A photo that never fits as PNG becomes JPEG.
    const photo = await fitWithImageCodec(() => image(4000, 3000, { png: 3, jpeg: 0.5 }))(
      source,
      4 * MB,
    );
    expect(photo.mediaType).toBe("image/jpeg");
    expect(photo.bytes.byteLength).toBeLessThanOrEqual(4 * MB);

    await expect(
      fitWithImageCodec(() => image(4000, 3000, { png: 30, jpeg: 30 }))(source, 1 * MB),
    ).rejects.toThrow("too large to send");
    await expect(
      fitWithImageCodec(() => ({ ...image(1, 1, { png: 1, jpeg: 1 }), isEmpty: () => true }))(
        source,
        MB,
      ),
    ).rejects.toThrow("could not be read");
  });
});
