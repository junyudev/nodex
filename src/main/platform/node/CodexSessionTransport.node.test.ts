/* oxlint-disable effecttsgo/strict-effect-provide -- This scoped test is the physical transport entry point. */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodexSessionTransport, nodeLive } from "./CodexSessionTransport";

it.effect(
  "configured local daemon reports stdio when the physical opener falls back to a child",
  () =>
    Effect.gen(function* () {
      const transport = yield* CodexSessionTransport;
      const handle = yield* transport.open({
        hostId: "local",
        generation: 1,
        command: process.execPath,
        args: [
          "-e",
          `
        require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
          const request = JSON.parse(line);
          process.stdout.write(JSON.stringify({ id: request.id, result: { selected: "stdio" } }) + "\\n");
        });
      `,
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        localDaemon: { codexHome: "/unused", platform: "darwin", configOverrides: [] },
        forceTermination: "1 second",
      });
      assert.strictEqual(handle.transportKind, "stdio");
      assert.isAbove(handle.pid, 0);
      assert.deepEqual(yield* handle.client.raw.request("test/transport", {}), {
        selected: "stdio",
      });
    }).pipe(Effect.provide(nodeLive)),
);
