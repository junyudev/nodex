// @effect-diagnostics processEnv:off - This boundary test proves worker reads do not mutate the ambient native account.
// @effect-diagnostics strictEffectProvide:off
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
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
      const fork = yield* sdk.fork(first, assistant);
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
