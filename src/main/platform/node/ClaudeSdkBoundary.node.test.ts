// @effect-diagnostics strictEffectProvide:off
// @effect-diagnostics asyncFunction:off - The disposable child process is an actual Node boundary.
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as waitForChild } from "node:timers/promises";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { ClaudeSdk, live } from "./ClaudeSdk";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import { makeAgentDiscoveryRequests } from "../../ipc/handlers/AgentDiscoveryRequests";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { live as shellEnvironmentLive } from "../../host-runtime/WorktreeShellEnvironmentRuntime";

const sdkLayer = live.pipe(
  Layer.provide(mainConfigLayer()),
  Layer.provide(
    shellEnvironmentLive({
      baseEnvironment: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      loadInteractiveEnvironment: async () => ({ PATH: "/usr/bin:/bin" }),
    }),
  ),
);

it.effect("installed SDK discovery reads native intelligence without sending executable work", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-sdk-boundary-"))),
      (root) =>
        Effect.promise(() =>
          rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }),
        ),
    );
    const cwd = join(root, "workspace");
    yield* Effect.promise(() => mkdir(cwd));
    const nativeBin = join(root, ".local", "bin");
    yield* Effect.promise(() => mkdir(nativeBin, { recursive: true }));
    const executable = join(nativeBin, "claude");
    const script = join(root, "fake-claude.mjs");
    const invocation = join(root, "invocation.json");
    const messages = join(root, "messages.jsonl");
    yield* Effect.promise(() =>
      writeFile(executable, '#!/bin/sh\nexec "$NODEX_TEST_NODE" "$NODEX_TEST_CLI" "$@"\n'),
    );
    yield* Effect.promise(() => chmod(executable, 0o700));
    yield* Effect.promise(() =>
      writeFile(
        script,
        `
      import {writeFileSync,appendFileSync,existsSync,readFileSync} from "node:fs";
      import {createInterface} from "node:readline";
      const args=process.argv.slice(2);
      const decode=(flag)=>{const inline=args.find((arg)=>arg.startsWith(flag+"="));const index=args.indexOf(flag);const value=inline===undefined?(index<0?undefined:args[index+1]):inline.slice(flag.length+1);if(value===undefined)return undefined;try{return JSON.parse(existsSync(value)?readFileSync(value,"utf8"):value);}catch{return value;}};
      writeFileSync(process.env.NODEX_TEST_INVOCATION,JSON.stringify({args,cwd:process.cwd(),settings:decode("--settings"),mcp:decode("--mcp-config"),connector:process.env.ENABLE_CLAUDEAI_MCP_SERVERS,ide:process.env.CLAUDE_CODE_AUTO_CONNECT_IDE,forceTerminal:process.env.FORCE_CODE_TERMINAL}));
      const lines=createInterface({input:process.stdin});
      const settings=decode("--settings")??{};
      lines.on("line",line=>{
        const message=JSON.parse(line);appendFileSync(process.env.NODEX_TEST_MESSAGES,JSON.stringify(message)+"\\n");
        if(message.type!=="control_request")return;
        if(message.request.subtype==="set_permission_mode"&&message.request.mode==="bypassPermissions"&&!args.includes("--allow-dangerously-skip-permissions")){process.stdout.write(JSON.stringify({type:"control_response",response:{subtype:"error",request_id:message.request_id,error:"bypass unavailable"}})+"\\n");return;}
        if(message.request.subtype==="apply_flag_settings")for(const[key,value]of Object.entries(message.request.settings)){if(value===null)delete settings[key];else settings[key]=value;}
        const response=message.request.subtype==="initialize"?{commands:[],agents:[],models:[{value:"default",resolvedModel:"claude-opus-5",displayName:"Opus",description:"",supportsAdaptiveThinking:true}],fast_mode_state:"off",output_style:"default",available_output_styles:["default"],account:{tokenSource:"fixture"}}:message.request.subtype==="get_settings"?{effective:{alwaysThinkingEnabled:true,fastMode:false,...settings},sources:[],applied:{model:settings.model??process.env.NODEX_TEST_NATIVE_MODEL??"claude-opus-5",effort:settings.effortLevel??"medium"}}:message.request.subtype==="mcp_status"?{mcpServers:[]}:{};
        process.stdout.write(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response}})+"\\n");
      });
    `,
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sdk = yield* ClaudeSdk;
        const session = yield* sdk.discover({
          instance: {
            ...defaultClaudeInstance(),
            customModels: [
              {
                id: "gateway/private[1m]",
                displayName: "Private",
                traits: { adaptiveThinking: true, disableThinking: true },
              },
            ],
          },
          environment: {
            HOME: root,
            PATH: "/usr/bin:/bin",
            NODEX_TEST_NODE: process.execPath,
            NODEX_TEST_CLI: script,
            NODEX_TEST_INVOCATION: invocation,
            NODEX_TEST_MESSAGES: messages,
            ENABLE_CLAUDEAI_MCP_SERVERS: "true",
            FORCE_CODE_TERMINAL: "1",
          },
          cwd,
        });
        expect(session.intelligence).toEqual({
          model: "claude-opus-5",
          effort: "medium",
          fast: false,
          thinking: true,
        });
      }),
    );
    const launch = (yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
      yield* Effect.promise(() => readFile(invocation, "utf8")),
    )) as {
      args: string[];
      cwd: string;
      settings: unknown;
      mcp: unknown;
      connector: string;
      ide: string;
      forceTerminal?: string;
    };
    expect(launch.args).toContain("--strict-mcp-config");
    expect(launch.args).toContain("--no-session-persistence");
    expect(launch.settings).toMatchObject({ disableAllHooks: true });
    expect(launch.mcp).toBeUndefined();
    expect(launch.connector).toBe("false");
    expect(launch.ide).toBe("0");
    expect(launch.forceTerminal).toBeUndefined();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sdk = yield* ClaudeSdk;
        const unavailable = yield* Effect.result(
          sdk.discover({
            instance: {
              ...defaultClaudeInstance(),
              environment: [{ name: "PATH", value: "", sensitive: false }],
            },
            environment: { HOME: root, PATH: "" },
            cwd,
          }),
        );
        expect(unavailable._tag).toBe("Failure");
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(sdkLayer)),
);

it.effect("consumer interruption kills a real SDK child still waiting for initialization", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-sdk-cancel-"))),
      (directory) =>
        Effect.promise(() =>
          rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }),
        ),
    );
    const executable = join(root, "fake-claude");
    const script = join(root, "fake-claude.mjs");
    const invocation = join(root, "pid");
    yield* Effect.promise(() =>
      writeFile(executable, '#!/bin/sh\nexec "$NODEX_TEST_NODE" "$NODEX_TEST_CLI" "$@"\n'),
    );
    yield* Effect.promise(() => chmod(executable, 0o700));
    yield* Effect.promise(() =>
      writeFile(
        script,
        `import {writeFileSync} from "node:fs"; writeFileSync(process.env.NODEX_TEST_PID,String(process.pid)); process.stdin.resume();`,
      ),
    );
    const sdk = yield* ClaudeSdk;
    const requests = yield* makeAgentDiscoveryRequests;
    const request = yield* Effect.forkChild(
      requests.run(
        1,
        "fixture",
        sdk.discover({
          instance: { ...defaultClaudeInstance(), binaryPath: executable },
          environment: {
            HOME: root,
            PATH: "/usr/bin:/bin",
            NODEX_TEST_NODE: process.execPath,
            NODEX_TEST_CLI: script,
            NODEX_TEST_PID: invocation,
          },
          cwd: root,
        }),
      ),
    );
    const pid = yield* Effect.promise(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          return Number(await readFile(invocation, "utf8"));
        } catch {
          await waitForChild(10);
        }
      }
      throw new Error("Fixture child did not start");
    });
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    yield* requests.cancel(1, "fixture");
    expect(Exit.isFailure(yield* Fiber.await(request))).toBe(true);
    yield* Effect.promise(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await waitForChild(10);
      }
      throw new Error("SDK cancellation leaked its initializing child");
    });
  }).pipe(Effect.scoped, Effect.provide(sdkLayer)),
);
