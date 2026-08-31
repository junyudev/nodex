import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";
import { AcpWorkspaceFileOwner, live } from "./AcpWorkspaceFileOwner";

const withOwner = <A, E>(
  use: (input: {
    readonly owner: AcpWorkspaceFileOwner["Service"];
    readonly root: string;
    readonly outside: string;
  }) => Effect.Effect<A, E>,
): Effect.Effect<A, E | import("./AcpRuntimeError").AcpRuntimeError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "nodex-acp-fs-"));
      const outside = await mkdtemp(join(tmpdir(), "nodex-acp-outside-"));
      return { root, outside };
    }),
    ({ root, outside }) =>
      Effect.promise(() =>
        Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(outside, { recursive: true, force: true }),
        ]),
      ),
  ).pipe(
    Effect.flatMap(({ root, outside }) =>
      Layer.build(live({ workspaceRoot: root, maximumFileBytes: 1_024 })).pipe(
        Effect.flatMap((context) =>
          use({ owner: Context.get(context, AcpWorkspaceFileOwner), root, outside }),
        ),
      ),
    ),
  );

it.effect("reads line ranges and writes regular files inside the canonical workspace", () =>
  Effect.scoped(
    withOwner(({ owner, root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(join(root, "notes.txt"), "one\ntwo\nthree\n", "utf8"),
        );
        const result = yield* owner.readTextFile({
          sessionId: "root",
          path: join(root, "notes.txt"),
          line: 2,
          limit: 2,
        });
        expect(result.content).toBe("two\nthree");

        yield* owner.writeTextFile({
          sessionId: "root",
          path: join(root, "created.txt"),
          content: "created",
        });
        expect(yield* Effect.promise(() => readFile(join(root, "created.txt"), "utf8"))).toBe(
          "created",
        );
      }),
    ),
  ),
);

it.effect("rejects lexical, directory-symlink, and final-symlink workspace escapes", () =>
  Effect.scoped(
    withOwner(({ owner, root, outside }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(join(root, "inside"));
          await writeFile(join(outside, "secret.txt"), "secret", "utf8");
          await symlink(outside, join(root, "escape"), "dir");
          await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));
        });

        for (const target of [
          join(outside, "secret.txt"),
          join(root, "escape", "secret.txt"),
          join(root, "secret-link.txt"),
        ]) {
          const error = yield* owner
            .readTextFile({ sessionId: "root", path: target })
            .pipe(Effect.flip);
          expect(error).toMatchObject({ reason: "authorization" });
        }

        const writeError = yield* owner
          .writeTextFile({
            sessionId: "root",
            path: join(root, "escape", "created.txt"),
            content: "unsafe",
          })
          .pipe(Effect.flip);
        expect(writeError).toMatchObject({ reason: "authorization" });
        yield* Effect.promise(() =>
          expect(readFile(join(outside, "created.txt"), "utf8")).rejects.toThrow(),
        );
      }),
    ),
  ),
);
