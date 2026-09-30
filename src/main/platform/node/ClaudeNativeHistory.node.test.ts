// @effect-diagnostics processEnv:off - This boundary test proves worker reads do not mutate the ambient native account.
// @effect-diagnostics strictEffectProvide:off
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  ClaudeSdk,
  live,
  claudeHistoryWindow,
  claudeForkMessageIds,
  claudeHistoryImage,
  claudeHistoryToolOutput,
} from "./ClaudeSdk";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
const ambientNativeConfiguration = () => process.env.CLAUDE_CONFIG_DIR;
const id = "01991e60-b800-7000-8000-000000000012";
const user = "01991e60-b800-7000-8000-000000000014";
const assistant = "01991e60-b800-7000-8000-000000000016";

it.effect("native home identity survives creating its missing directory under a symlink", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-native-home-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const physicalParent = join(root, "physical");
    const alias = join(root, "alias");
    yield* Effect.promise(() => mkdir(physicalParent));
    yield* Effect.promise(() => symlink(physicalParent, alias, "dir"));
    const configDirectory = join(alias, "nested", "claude");
    const input = {
      instance: { ...defaultClaudeInstance(), configDirectory },
      environment: { HOME: root },
    };
    const sdk = yield* ClaudeSdk;
    const before = yield* sdk.nativeHome(input);
    yield* Effect.promise(() => mkdir(configDirectory, { recursive: true }));
    const after = yield* sdk.nativeHome(input);
    const expected = join(
      yield* Effect.promise(() => realpath(physicalParent)),
      "nested",
      "claude",
    );
    expect(before).toBe(expected);
    expect(after).toBe(before);
  }).pipe(Effect.scoped, Effect.provide(live)),
);

it.effect("native home rejects relative paths and non-directory ancestors", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-native-home-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    const file = join(root, "file");
    yield* Effect.promise(() => writeFile(file, "Not a directory"));
    const sdk = yield* ClaudeSdk;
    for (const configDirectory of [file, join(file, "claude")]) {
      const result = yield* Effect.result(
        sdk.nativeHome({
          instance: { ...defaultClaudeInstance(), configDirectory },
          environment: { HOME: root },
        }),
      );
      expect(result._tag).toBe("Failure");
    }
    const relative = yield* Effect.result(
      sdk.nativeHome({
        instance: defaultClaudeInstance(),
        environment: { HOME: root, CLAUDE_CONFIG_DIR: "relative/claude" },
      }),
    );
    expect(relative._tag).toBe("Failure");
  }).pipe(Effect.scoped, Effect.provide(live)),
);

it.effect(
  "native history workers isolate account environments and remap forks without a Claude query",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-native-history-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const workspace = join(root, "workspace");
      yield* Effect.promise(() => mkdir(workspace));
      const cwd = yield* Effect.promise(() => realpath(workspace));
      const prepare = (account: string, text: string) =>
        Effect.gen(function* () {
          const configDirectory = join(root, account);
          const projects = join(configDirectory, "projects", cwd.replace(/[^a-zA-Z0-9]/gu, "-"));
          yield* Effect.promise(() => mkdir(projects, { recursive: true }));
          const entries = [
            {
              type: "user",
              uuid: user,
              parentUuid: null,
              sessionId: id,
              cwd,
              timestamp: "2026-09-01T00:00:00.000Z",
              message: {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "AA==" },
                  },
                  { type: "text", text },
                ],
              },
            },
            {
              type: "assistant",
              uuid: assistant,
              parentUuid: user,
              sessionId: id,
              cwd,
              timestamp: "2026-09-01T00:00:01.000Z",
              message: {
                id: "reply",
                role: "assistant",
                model: "gateway-private",
                content: [{ type: "text", text: "Acknowledged" }],
              },
            },
            {
              type: "user",
              uuid: "01991e60-b800-7000-8000-000000000018",
              parentUuid: assistant,
              sessionId: id,
              cwd,
              timestamp: "2026-09-01T00:00:02.000Z",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "native-tool",
                    content: "Complete native output",
                  },
                ],
              },
            },
          ];
          yield* Effect.promise(() =>
            writeFile(
              join(projects, `${id}.jsonl`),
              `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
            ),
          );
          return {
            instance: { ...defaultClaudeInstance(), configDirectory },
            environment: { HOME: root },
            cwd,
            sessionId: id,
            resume: true,
          };
        });
      const first = yield* prepare("account-a", "Account A");
      const second = yield* prepare("account-b", "Account B");
      const sdk = yield* ClaudeSdk;
      const ambient = ambientNativeConfiguration();
      expect(yield* sdk.nativeHome(first)).toBe(
        yield* Effect.promise(() => realpath(first.instance.configDirectory!)),
      );
      const catalogA = yield* sdk.listSessions(first, 0);
      const catalogB = yield* sdk.listSessions(second, 0);
      expect(catalogA.map(({ sessionId }) => sessionId)).toEqual([id]);
      expect(catalogA[0]?.summary).toBe("Account A");
      expect(catalogB[0]?.summary).toBe("Account B");
      expect(yield* sdk.listSessions(first, 1)).toEqual([]);
      expect(yield* sdk.sessionInfo(first, id)).toMatchObject({
        sessionId: id,
        cwd,
        summary: "Account A",
      });
      expect(yield* sdk.sessionInfo(first, "01991e60-b800-7000-8000-000000000020")).toBeNull();

      expect(yield* sdk.hasSession(first)).toBe(true);
      expect(
        yield* sdk.hasSession({ ...first, sessionId: "01991e60-b800-7000-8000-000000000020" }),
      ).toBe(false);
      const a = yield* sdk.historyPage(first, { limit: 1 });
      const b = yield* sdk.historyPage(second, { limit: 1 });
      expect(a.messages).toHaveLength(3);
      expect(a.messages[0]?.message).toMatchObject({
        content: [{ type: "image" }, { type: "text", text: "Account A" }],
      });
      expect(yield* sdk.historyImage(first, user, 0)).toEqual({
        mediaType: "image/png",
        data: "AA==",
      });
      expect(
        yield* sdk.historyToolOutput(first, "01991e60-b800-7000-8000-000000000018", "native-tool"),
      ).toEqual({ text: "Complete native output", truncated: false, originalBytes: 22 });
      expect(
        (yield* Effect.result(
          sdk.historyToolOutput(first, "01991e60-b800-7000-8000-000000000018", "other-tool"),
        ))._tag,
      ).toBe("Failure");
      expect(b.messages[0]?.message).toMatchObject({
        content: [{ type: "image" }, { type: "text", text: "Account B" }],
      });
      const relocated = { ...first, cwd: join(root, "destination-worktree") };
      expect(yield* sdk.hasSession(relocated)).toBe(true);
      expect((yield* sdk.historyPage(relocated)).messages).toEqual(a.messages);
      expect(yield* sdk.historyImage(relocated, user, 0)).toEqual({
        mediaType: "image/png",
        data: "AA==",
      });
      const fork = yield* sdk.fork(relocated, assistant);
      expect(fork.sessionId).not.toBe(id);
      expect(fork.messageIdMap?.[user]).toBeTruthy();
      expect(fork.messageIdMap?.[user]).not.toBe(user);
      const copied = yield* sdk.historyPage({ ...first, sessionId: fork.sessionId });
      expect(copied.messages[0]?.message).toMatchObject({
        content: [{ type: "image" }, { type: "text", text: "Account A" }],
      });
      expect(copied.messages[0]?.uuid).toBe(fork.messageIdMap?.[user]);
      expect((yield* sdk.historyPage(first)).messages[0]?.uuid).toBe(user);
      expect(ambientNativeConfiguration()).toBe(ambient);
      expect(
        yield* sdk
          .historyPage({ ...first, sessionId: "01991e60-b800-7000-8000-000000000020" })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "resource-not-found" });
    }).pipe(Effect.scoped, Effect.provide(live)),
);

const entry = (
  uuid: string,
  content: unknown,
  extra: Partial<SessionMessage> = {},
): SessionMessage => ({
  type: "user",
  uuid,
  session_id: id,
  parent_tool_use_id: null,
  parent_agent_id: null,
  message: { content },
  ...extra,
});
it.effect(
  "lazy native image reads reject tool results, unsupported sources and oversized data",
  () =>
    Effect.sync(() => {
      const image = {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AA==" },
      };
      expect(claudeHistoryImage([entry(user, [image])], user, 0)).toEqual({
        mediaType: "image/png",
        data: "AA==",
      });
      expect(() =>
        claudeHistoryImage([entry(user, [image], { parent_agent_id: "child" })], user, 0),
      ).toThrow("native prompt history");
      expect(() =>
        claudeHistoryImage([entry(user, [{ type: "tool_result", content: [image] }])], user, 0),
      ).toThrow("native prompt history");
      expect(() =>
        claudeHistoryImage(
          [entry(user, [{ ...image, source: { type: "url", url: "https://example.test/image" } }])],
          user,
          0,
        ),
      ).toThrow("invalid");
      expect(() => claudeHistoryImage([entry(user, [image])], user, 1)).toThrow("invalid");
      expect(() =>
        claudeHistoryImage(
          [
            entry(user, [
              { ...image, source: { ...image.source, data: "A".repeat(7 * 1024 * 1024) } },
            ]),
          ],
          user,
          0,
        ),
      ).toThrow("image limit");
    }),
);
it.effect("page boundaries exclude tool results and sidechain prompts", () =>
  Effect.sync(() => {
    const messages = [
      entry(user, "first"),
      entry(assistant, [{ type: "tool_result", content: "output" }]),
      entry(id, "child", { parent_agent_id: "agent" }),
      entry("later", "second"),
      entry("end", [], { type: "assistant" }),
    ];
    expect(claudeHistoryWindow(messages, { limit: 1 })).toMatchObject({
      messages: messages.slice(3),
      before: "later",
      hasMore: true,
    });
    expect(claudeHistoryWindow(messages, { before: "later", limit: 1 })).toMatchObject({
      messages: messages.slice(0, 3),
      before: null,
      hasMore: false,
    });
    expect(() => claudeHistoryWindow(messages, { before: "missing" })).toThrow("cursor");
  }),
);

it.effect("fork UUID maps require matching content and actor", () =>
  Effect.sync(() => {
    const source = [entry(user, "same"), entry(assistant, "different")];
    const forked = [entry("new-user", "same"), entry("new-assistant", "wrong")];
    expect(claudeForkMessageIds(source, forked)).toEqual({ [user]: "new-user" });
    expect(
      claudeForkMessageIds(source, [entry("child", "same", { parent_agent_id: "other" })]),
    ).toEqual({});
  }),
);

it.effect(
  "lazy tool output checks exact native UUID and tool identity and excludes binary payloads",
  () =>
    Effect.sync(() => {
      const output = entry(
        "result",
        [
          {
            type: "tool_result",
            tool_use_id: "tool",
            content: [
              { type: "text", text: "native output" },
              { type: "image", source: { type: "base64", data: "private binary" } },
              { type: "document", source: { type: "base64", data: "private document" } },
              { type: "resource", result: { status: "success", data: "private binary" } },
            ],
          },
        ],
        { parent_agent_id: "child" },
      );
      const expected = 'native output\n{"type":"resource","result":{"status":"success"}}';
      expect(claudeHistoryToolOutput([output], "result", "tool")).toEqual({
        text: expected,
        truncated: false,
        originalBytes: Buffer.byteLength(expected),
      });
      expect(() => claudeHistoryToolOutput([output], "wrong", "tool")).toThrow(
        "selected native result",
      );
      expect(() => claudeHistoryToolOutput([output], "result", "wrong")).toThrow(
        "selected native result",
      );
      const large = entry("result", [
        { type: "tool_result", tool_use_id: "tool", content: "🙂".repeat(150_000) },
      ]);
      const clipped = claudeHistoryToolOutput([large], "result", "tool");
      expect(clipped.truncated).toBe(true);
      expect(clipped.originalBytes).toBe(600_000);
      expect(Buffer.byteLength(clipped.text)).toBeLessThanOrEqual(512 * 1024);
      expect(clipped.text).not.toContain("�");
    }),
);
