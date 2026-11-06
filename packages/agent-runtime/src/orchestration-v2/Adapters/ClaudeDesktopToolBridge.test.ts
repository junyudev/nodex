// @effect-diagnostics nodeBuiltinImport:off -- fixture exercises the real stdio and process lifecycle
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import {
  makeClaudeDesktopToolBridge,
  type ClaudeDesktopToolBridgeOptions,
} from "./ClaudeDesktopToolBridge.ts";
const require = createRequire(import.meta.url);
const sdkImport = (file: string) =>
  JSON.stringify(pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${file}`)).href);
const fixture = `
import { Server } from ${sdkImport("server/index.js")};
import { StdioServerTransport } from ${sdkImport("server/stdio.js")};
import { CallToolRequestSchema, ListToolsRequestSchema, ElicitResultSchema } from ${sdkImport("types.js")};
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const log = (event, value = {}) => appendFileSync(process.env.BRIDGE_LOG, JSON.stringify({event, ...value})+'\\n');
log('start', { pid: process.pid, cwd: process.cwd(), env: process.env });
const server = new Server({name:'real-fixture', version:'7'}, {instructions:'Persistent fixture REPL instructions', capabilities:{tools:{listChanged:false}}});
server.setRequestHandler(ListToolsRequestSchema, async (req) => ({
  tools: ['js','helper','turn_ended'].map(name => ({name, inputSchema:{type:'object'}, annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true}, _meta: name==='turn_ended' ? {ui:{visibility:[]}} : {keep:true,'anthropic/alwaysLoad':false}})),
  ...(req.params?.cursor ? {nextCursor:'next'} : {})
}));
let memory;
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  log('call', {params:req.params});
  const args = req.params.arguments ?? {};
  if (args.op === 'crash') process.exit(17);
  if (req.params.name === 'turn_ended' && args.hook_event_name === 'hang') {
    await new Promise(resolve => extra.signal.addEventListener('abort', resolve, {once:true}));
    log('lifecycle-cancelled');
  }
  if (args.op === 'remember') memory = args.value;
  if (args.op === 'notify') await server.notification({method:'notifications/tools/list_changed'});
  if (args.op === 'elicit') {
    const result = await server.request({method:'elicitation/create', params:{mode:'form',message:'Approve?',requestedSchema:{type:'object',properties:{}},_meta:{persist:['session'],'codex_approval_kind':'mcp_tool_call'}}}, ElicitResultSchema, {signal:extra.signal});
    return {content:[{type:'text',text:'elicited'}], structuredContent:result};
  }
  if (args.op === 'wait') {
    await extra.sendNotification({method:'notifications/progress',params:{progressToken:req.params._meta.progressToken,progress:1,total:2,message:'waiting'}});
    log('waiting');
    await new Promise(resolve => extra.signal.addEventListener('abort', resolve, {once:true}));
    log('cancelled');
    return {content:[{type:'text',text:'cancelled'}],isError:true};
  }
  if (args.op === 'descendant') {
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
    await new Promise(resolve=>child.once('spawn',resolve));
    log('descendant',{pid:child.pid});
  }
  return {
    content:[{type:'text',text:'ok'},{type:'image',mimeType:'image/png',data:'aW1hZ2U='}],
    structuredContent:{pid:process.pid,memory,meta:req.params._meta,capabilities:server.getClientCapabilities()},
    isError: args.error === true,
    _meta:{'codex/toolSurface':{surfaces:['browser']},keep:['nested', {value:true}]}
  };
});
await server.connect(new StdioServerTransport());
`;
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
describe("ClaudeDesktopToolBridge", () => {
  let directory: string;
  let scope: Scope.Closeable;
  let turn: ReturnType<ClaudeDesktopToolBridgeOptions["currentTurn"]>;
  let bridge: Effect.Success<ReturnType<typeof makeClaudeDesktopToolBridge>>;
  let options: ClaudeDesktopToolBridgeOptions;
  const clients: Client[] = [];
  const elicit = vi.fn<ClaudeDesktopToolBridgeOptions["elicit"]>();
  const events = async () =>
    (await readFile(join(directory, "events.jsonl"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const waitEvent = async (event: string, count = 1) => {
    await vi.waitFor(
      async () =>
        expect((await events()).filter((entry) => entry.event === event)).toHaveLength(count),
      {
        interval: 10,
      },
    );
    return (await events()).filter((entry) => entry.event === event).at(-1);
  };
  const connect = Effect.fnUntraced(function* () {
    const config = yield* bridge.mcpServer;
    const [local, remote] = InMemoryTransport.createLinkedPair();
    yield* Effect.promise(() => config.instance.connect(remote));
    const client = new Client({
      name: "claude-fixture",
      version: "1",
    });
    clients.push(client);
    yield* Effect.promise(() => client.connect(local));
    return {
      client,
      config,
    };
  });
  const call = (client: Client, args: Record<string, unknown> = {}, signal?: AbortSignal) =>
    client.request(
      {
        method: "tools/call",
        params: {
          name: "js",
          arguments: args,
          _meta: {
            "claudecode/toolUseId": "toolu_1",
            unrelated: true,
          },
        },
      },
      CallToolResultSchema,
      signal
        ? {
            signal,
          }
        : {},
    );
  beforeEach(() =>
    Effect.gen(function* () {
      directory = yield* Effect.promise(async () =>
        realpath(await mkdtemp(join(tmpdir(), "claude-desktop-bridge-"))),
      );
      yield* Effect.promise(() => writeFile(join(directory, "server.mjs"), fixture));
      scope = yield* Scope.make();
      turn = {
        sessionId: "session-1",
        turnId: "turn-1",
      };
      elicit.mockReset();
      elicit.mockResolvedValue({
        action: "accept",
        content: {},
        _meta: {
          persist: "session",
        },
      });
      options = {
        server: {
          command: process.execPath,
          args: [join(directory, "server.mjs")],
          env: {
            BRIDGE_LOG: join(directory, "events.jsonl"),
            EXPLICIT: "server",
          },
        },
        environment: {
          BRIDGE_ONLY: "provided",
          EXPLICIT: "environment",
        },
        cwd: directory,
        currentTurn: () => turn,
        elicit,
      };
      bridge = yield* makeClaudeDesktopToolBridge(options).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
    }),
  );
  afterEach(() =>
    Effect.gen(function* () {
      yield* Scope.close(scope, Exit.void);
      yield* Effect.promise(() => Promise.all(clients.splice(0).map((client) => client.close())));
      yield* Effect.promise(() =>
        rm(directory, {
          recursive: true,
          force: true,
        }),
      );
    }),
  );
  it.effect(
    "preserves initialization and the caller's launch environment, hiding lifecycle tools and unsafe hints",
    () =>
      Effect.gen(function* () {
        const { client, config } = yield* connect();
        expect(config).toMatchObject({
          type: "sdk",
          name: "node_repl",
          timeout: 65 * 60_000,
        });
        expect(client.getInstructions()).toBe("Persistent fixture REPL instructions");
        expect(client.getServerCapabilities()?.tools).toEqual({
          listChanged: false,
        });
        const listing = yield* Effect.promise(() =>
          client.listTools({
            cursor: "page",
          }),
        );
        expect(listing.nextCursor).toBe("next");
        expect(listing.tools.map((tool) => tool.name)).toEqual(["js", "helper"]);
        for (const tool of listing.tools) {
          expect(tool.annotations).toBeUndefined();
          expect(tool._meta).toEqual({
            keep: true,
            "anthropic/alwaysLoad": true,
          });
        }
        const start = yield* Effect.promise(() => waitEvent("start"));
        expect(start.cwd).toBe(directory);
        // macOS injects __CF_USER_TEXT_ENCODING into every child independently of spawn env.
        const { __CF_USER_TEXT_ENCODING: _osEncoding, ...environment } = start.env;
        expect(environment).toEqual({
          BRIDGE_ONLY: "provided",
          EXPLICIT: "server",
          BRIDGE_LOG: join(directory, "events.jsonl"),
        });
        expect((yield* Effect.promise(() => call(client))).structuredContent).toMatchObject({
          capabilities: {
            elicitation: {
              form: {},
            },
          },
        });
      }),
  );
  it.effect(
    "stamps the current identity as an object and preserves images, structured results, errors and result metadata",
    () =>
      Effect.gen(function* () {
        const { client } = yield* connect();
        turn = {
          sessionId: "session-2",
          turnId: "turn-2",
        };
        const result = yield* Effect.promise(() =>
          call(client, {
            error: true,
          }),
        );
        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: "ok",
            },
            {
              type: "image",
              mimeType: "image/png",
              data: "aW1hZ2U=",
            },
          ],
          structuredContent: {
            pid: expect.any(Number),
            meta: {
              "claudecode/toolUseId": "toolu_1",
              unrelated: true,
              callId: "toolu_1",
              "x-codex-turn-metadata": {
                session_id: "session-2",
                thread_id: "session-2",
                turn_id: "turn-2",
              },
            },
            capabilities: {
              elicitation: {
                form: {},
              },
            },
          },
          isError: true,
          _meta: {
            "codex/toolSurface": {
              surfaces: ["browser"],
            },
            keep: [
              "nested",
              {
                value: true,
              },
            ],
          },
        });
      }),
  );
  it.effect("rejects calls without an active turn and prevents direct lifecycle calls", () =>
    Effect.gen(function* () {
      const { client } = yield* connect();
      turn = undefined;
      expect(yield* Effect.promise(() => call(client))).toMatchObject({
        isError: true,
      });
      turn = {
        sessionId: "s",
        turnId: "t",
      };
      expect(
        yield* Effect.promise(() =>
          client.callTool({
            name: "turn_ended",
          }),
        ),
      ).toMatchObject({
        isError: true,
      });
      expect(
        (yield* Effect.promise(() => events())).filter((entry) => entry.event === "call"),
      ).toEqual([]);
    }),
  );
  it.effect("round-trips elicitation metadata and persistence responses", () =>
    Effect.gen(function* () {
      const { client } = yield* connect();
      const result = yield* Effect.promise(() =>
        call(client, {
          op: "elicit",
        }),
      );
      expect(elicit).toHaveBeenCalledWith(
        {
          mode: "form",
          message: "Approve?",
          requestedSchema: {
            type: "object",
            properties: {},
          },
          _meta: {
            persist: ["session"],
            codex_approval_kind: "mcp_tool_call",
          },
        },
        {
          signal: expect.any(AbortSignal),
          requestId: 0,
        },
      );
      expect(result.structuredContent).toEqual({
        action: "accept",
        content: {},
        _meta: {
          persist: "session",
        },
      } satisfies ElicitResult);
    }),
  );
  it.effect("forwards tool-list changes", () =>
    Effect.gen(function* () {
      const { client } = yield* connect();
      const notified = vi.fn();
      client.setNotificationHandler(ToolListChangedNotificationSchema, notified);
      yield* Effect.promise(() =>
        call(client, {
          op: "notify",
        }),
      );
      yield* Effect.promise(() => vi.waitFor(() => expect(notified).toHaveBeenCalledOnce()));
    }),
  );
  it.effect.each(["cancel", "transport-close"])(
    "propagates %s through MCP cancellation and keeps progress correlation",
    (mode) =>
      Effect.gen(function* () {
        const { client } = yield* connect();
        const controller = new AbortController();
        const progress = vi.fn();
        const pending = client.callTool(
          {
            name: "js",
            arguments: {
              op: "wait",
            },
          },
          undefined,
          {
            signal: controller.signal,
            onprogress: progress,
          },
        );
        const rejected = expect(pending).rejects.toBeDefined();
        yield* Effect.promise(() => waitEvent("waiting"));
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(progress).toHaveBeenCalledWith({
              progress: 1,
              total: 2,
              message: "waiting",
            }),
          ),
        );
        if (mode === "cancel") controller.abort();
        else yield* Effect.promise(() => client.close());
        yield* Effect.promise(() => rejected);
        yield* Effect.promise(() => waitEvent("cancelled"));
      }),
  );
  it.effect(
    "reuses one child and its memory across fresh facades and single-flights concurrent starts",
    () =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.all([connect(), connect()], {
          concurrency: "unbounded",
        });
        expect(first.config.instance).not.toBe(second.config.instance);
        const remembered = yield* Effect.promise(() =>
          call(first.client, {
            op: "remember",
            value: 42,
          }),
        );
        yield* Effect.promise(() => first.client.close());
        const third = yield* connect();
        expect((yield* Effect.promise(() => call(third.client))).structuredContent).toMatchObject({
          pid: remembered.structuredContent?.pid,
          memory: 42,
        });
        expect(
          (yield* Effect.promise(() => events())).filter((entry) => entry.event === "start"),
        ).toHaveLength(1);
      }),
  );
  it.effect("fails in-flight calls on child death and restarts on the next use", () =>
    Effect.gen(function* () {
      const { client } = yield* connect();
      const before = yield* Effect.promise(() =>
        call(client, {
          op: "remember",
          value: 42,
        }),
      );
      expect(
        yield* Effect.promise(() =>
          call(client, {
            op: "crash",
          }),
        ),
      ).toMatchObject({
        isError: true,
      });
      const after = yield* Effect.promise(() => call(client));
      expect(after.isError).toBe(false);
      expect(after.structuredContent?.pid).not.toBe(before.structuredContent?.pid);
      expect(after.structuredContent?.memory).toBeUndefined();
      yield* Effect.promise(() => waitEvent("start", 2));
    }),
  );
  it.effect("delivers bounded host lifecycle calls without starting an unused child", () =>
    Effect.gen(function* () {
      yield* bridge.turnEnded({
        sessionId: "s",
        turnId: "t",
        hookEventName: "Stop",
      });
      expect(yield* Effect.promise(() => events())).toEqual([]);
      yield* connect();
      yield* bridge.turnEnded({
        sessionId: "s",
        turnId: "t",
        hookEventName: "Interrupt",
      });
      expect((yield* Effect.promise(() => waitEvent("call"))).params).toEqual({
        name: "turn_ended",
        arguments: {
          hook_event_name: "Interrupt",
          session_id: "s",
          turn_id: "t",
        },
      });
    }),
  );
  it.effect("cancels an elicitation when its CLI call is cancelled", () =>
    Effect.gen(function* () {
      let elicitationSignal: AbortSignal | undefined;
      elicit.mockImplementation((_params, { signal }) => {
        elicitationSignal = signal;
        return new Promise((resolve) =>
          signal.addEventListener(
            "abort",
            () => resolve({ action: "cancel", _meta: { persist: null } }),
            { once: true },
          ),
        );
      });
      const { client } = yield* connect();
      const controller = new AbortController();
      const pending = call(client, { op: "elicit" }, controller.signal).catch(() => undefined);
      yield* Effect.promise(() => vi.waitFor(() => expect(elicit).toHaveBeenCalledOnce()));
      controller.abort();
      yield* Effect.promise(() => pending);
      yield* Effect.promise(() => vi.waitFor(() => expect(elicitationSignal?.aborted).toBe(true)));
    }),
  );

  it.effect("reports a sanitized startup failure and closes safely", () =>
    Effect.gen(function* () {
      bridge = yield* makeClaudeDesktopToolBridge({
        ...options,
        server: { ...options.server, command: join(directory, "missing-executable") },
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const error = yield* Effect.flip(bridge.mcpServer);
      expect(error.message).toBe("Desktop Tool runtime unavailable");
      yield* bridge.close;
      expect(yield* Effect.promise(() => events())).toEqual([]);
    }),
  );

  it.effect("enforces the configured upstream call budget", () =>
    Effect.gen(function* () {
      bridge = yield* makeClaudeDesktopToolBridge({ ...options, callTimeoutMs: 50 }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const { client, config } = yield* connect();
      expect(config.timeout).toBe(50);
      const result = yield* Effect.promise(() => call(client, { op: "wait" }));
      expect(result.isError).toBe(true);
      yield* Effect.promise(() => waitEvent("cancelled"));
    }),
  );

  it.effect("bounds an unresponsive lifecycle hook", () =>
    Effect.gen(function* () {
      yield* connect();
      yield* bridge.turnEnded({ sessionId: "s", turnId: "t", hookEventName: "hang" });
      yield* Effect.promise(() => waitEvent("lifecycle-cancelled"));
    }),
  );

  it.effect.each([false, true])(
    "closes the child and descendants, with an active call: %s",
    (active) =>
      Effect.gen(function* () {
        const { client } = yield* connect();
        const result = yield* Effect.promise(() =>
          call(client, {
            op: "descendant",
          }),
        );
        const descendant = yield* Effect.promise(() => waitEvent("descendant"));
        const pending = active
          ? call(client, {
              op: "wait",
            }).catch(() => undefined)
          : undefined;
        if (active) yield* Effect.promise(() => waitEvent("waiting"));
        yield* bridge.close;
        if (pending) yield* Effect.promise(() => pending);
        if (active) yield* Effect.promise(() => waitEvent("cancelled"));
        yield* Effect.promise(() =>
          vi.waitFor(
            () => {
              expect(isAlive(result.structuredContent!.pid as number)).toBe(false);
              expect(isAlive(descendant.pid)).toBe(false);
            },
            {
              timeout: 3000,
              interval: 20,
            },
          ),
        );
        yield* bridge.close;
        expect(Exit.isFailure(yield* Effect.exit(bridge.mcpServer))).toBe(true);
      }),
  );
});
