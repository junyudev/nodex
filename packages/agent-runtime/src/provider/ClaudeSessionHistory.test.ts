import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { available } from "./ClaudeSessionHistory.ts";

it.live(
  "distinguishes absent and metadata-only native history from resumable or unreadable history",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-claude-native-history-" });
      const input = { sessionId: "native-session", configDirectory: home, cwd: home };
      expect(yield* available(input)).toBe(false);
      const project = path.join(home, "projects", "workspace");
      yield* fs.makeDirectory(project, { recursive: true });
      yield* fs.writeFileString(path.join(home, "projects", "stray-file"), "metadata");
      const transcript = path.join(project, "native-session.jsonl");
      yield* fs.writeFileString(transcript, '{"type":"file-history-snapshot"}\n');
      expect(yield* available(input)).toBe(false);
      yield* fs.writeFileString(
        transcript,
        '{"type":"user","message":{"content":"retained context"}}\n',
      );
      expect(yield* available(input)).toBe(true);
      yield* fs.writeFileString(transcript, "incomplete JSON");
      expect(yield* available(input).pipe(Effect.isFailure)).toBe(true);
      expect(yield* available({ ...input, sessionId: "../other" }).pipe(Effect.isFailure)).toBe(
        true,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
