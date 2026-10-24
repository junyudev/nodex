import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as AcpClient from "effect-acp/client";
import { makeInMemoryStdio } from "../../vendor/effect-acp/src/_internal/stdio.ts";
import { makeAcpClientTerminals } from "../../vendor/provider-acp/src/server/clientTerminals.ts";

it.live("returns real file and managed terminal results through negotiated v1 callbacks", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-v1-callbacks-" });
    const { stdio, input, output } = yield* makeInMemoryStdio();
    const client = yield* AcpClient.make(stdio);
    const terminals = yield* makeAcpClientTerminals({ defaultCwd: cwd });
    yield* Effect.addFinalizer(() => terminals.disposeAll);
    yield* client.handleReadTextFile((request) =>
      fs.readFileString(request.path).pipe(
        Effect.orDie,
        Effect.map((content) => ({ content })),
      ),
    );
    yield* client.handleWriteTextFile((request) =>
      fs.writeFileString(request.path, request.content).pipe(Effect.orDie, Effect.as({})),
    );
    yield* client.handleCreateTerminal(terminals.create);
    yield* client.handleTerminalOutput(terminals.output);
    yield* client.handleTerminalWaitForExit(terminals.waitForExit);
    yield* client.handleTerminalRelease(terminals.release);
    const send = (frame: unknown) =>
      Queue.offer(input, new TextEncoder().encode(JSON.stringify(frame) + "\n"));
    const initialized = yield* client.agent
      .initialize({
        protocolVersion: 2,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      })
      .pipe(Effect.forkScoped);
    const initialization = JSON.parse(yield* Queue.take(output)) as { id: string };
    yield* send({
      jsonrpc: "2.0",
      id: initialization.id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    yield* Fiber.join(initialized);
    expect(yield* client.protocolGeneration).toBe(1);
    let serial = 0;
    const request = Effect.fnUntraced(function* (method: string, params: unknown) {
      const id = `native-${++serial}`;
      yield* send({ jsonrpc: "2.0", id, method, params });
      const response = JSON.parse(yield* Queue.take(output)) as {
        id: string;
        result?: Record<string, unknown>;
        error?: unknown;
      };
      expect(response.id).toBe(id);
      expect(response.error).toBeUndefined();
      return response.result!;
    });
    const file = path.join(cwd, "callback.txt");
    const content = "ACP callback café\nsecond line\n";
    expect(
      yield* request("fs/write_text_file", { sessionId: "original", path: file, content }),
    ).toEqual({});
    expect(yield* fs.readFileString(file)).toBe(content);
    expect(yield* request("fs/read_text_file", { sessionId: "original", path: file })).toEqual({
      content,
    });
    const created = yield* request("terminal/create", {
      sessionId: "original",
      command: process.execPath,
      args: ["-e", "process.stdout.write('callback terminal'); process.exitCode = 3"],
    });
    expect(typeof created.terminalId).toBe("string");
    const terminal = { sessionId: "original", terminalId: created.terminalId };
    expect(yield* request("terminal/wait_for_exit", terminal)).toMatchObject({ exitCode: 3 });
    expect(yield* request("terminal/output", terminal)).toMatchObject({
      output: "callback terminal",
      truncated: false,
      exitStatus: { exitCode: 3 },
    });
    expect(yield* request("terminal/release", terminal)).toEqual({});
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
