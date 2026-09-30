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
import { ClaudeSdk, live } from "./ClaudeSdk";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import { makeClaudeDiscoveryRequests } from "../../ipc/handlers/ClaudeDiscoveryRequests";

it.effect(
  "installed SDK serializes isolated launch, atomic intelligence and native image steering",
  () =>
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
      const executable = join(root, "fake-claude");
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
      const decode=(flag)=>{const value=args[args.indexOf(flag)+1];if(!args.includes(flag))return undefined;try{return JSON.parse(existsSync(value)?readFileSync(value,"utf8"):value);}catch{return value;}};
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
          const session = yield* sdk.open({
            instance: {
              ...defaultClaudeInstance(),
              binaryPath: executable,
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
            sessionId: "01991e60-b800-7000-8000-000000000012",
            resume: false,
            purpose: "discovery",
            permissionMode: "dontAsk",
            canUseTool: () => Effect.succeed({ behavior: "deny", message: "No tools" }),
          });
          expect(session.intelligence).toEqual({
            model: "claude-opus-5",
            effort: "medium",
            fast: false,
            thinking: true,
          });
          expect((yield* Effect.result(session.setMode("bypassPermissions")))._tag).toBe("Failure");
          yield* session.setIntelligence({ model: "default", effort: "default", context: "1m" });
          expect((yield* session.inspectIntelligence).model).toBe("claude-opus-5[1m]");
          yield* session.setIntelligence({ model: "default", effort: "default", context: "200k" });
          expect((yield* session.inspectIntelligence).model).toBe("claude-opus-5[200k]");
          expect(
            (yield* Effect.result(session.setIntelligence({ model: "default", effort: "default" })))
              ._tag,
          ).toBe("Failure");
          yield* session.setIntelligence({
            model: "gateway/private",
            effort: "high",
            fast: true,
            thinking: true,
            context: "1m",
          });
          expect(yield* session.inspectIntelligence).toEqual({
            model: "gateway/private[1m]",
            effort: "high",
            fast: true,
            thinking: true,
          });
          yield* session.setIntelligence({
            model: "gateway/private",
            effort: "high",
            fast: false,
            thinking: false,
            context: "1m",
          });
          expect(yield* session.inspectIntelligence).toMatchObject({
            fast: false,
            thinking: false,
          });
          yield* session.setIntelligence({
            model: "gateway/private",
            effort: "high",
            context: "1m",
          });
          expect(yield* session.inspectIntelligence).toMatchObject({ fast: false, thinking: true });
          yield* session.send("", "01991e60-b800-7000-8000-000000000014", undefined, "now", [
            { mediaType: "image/png", data: "AA==" },
          ]);
          yield* session.inspectRuntime;
          expect(
            (yield* Effect.result(session.setIntelligence({ model: "default", effort: "default" })))
              ._tag,
          ).toBe("Failure");
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
          const session = yield* sdk.open({
            instance: { ...defaultClaudeInstance(), binaryPath: executable },
            environment: {
              HOME: root,
              PATH: "/usr/bin:/bin",
              NODEX_TEST_NODE: process.execPath,
              NODEX_TEST_CLI: script,
              NODEX_TEST_INVOCATION: invocation,
              NODEX_TEST_MESSAGES: messages,
            },
            cwd,
            sessionId: "01991e60-b800-7000-8000-000000000016",
            resume: false,
            permissionMode: "default",
            canUseTool: () => Effect.succeed({ behavior: "deny", message: "No tools" }),
          });
          yield* session.setMode("bypassPermissions");
          yield* session.setMode("plan");
          yield* session.setMode("default");
        }),
      );
      const normal = (yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* Effect.promise(() => readFile(invocation, "utf8")),
      )) as { args: string[] };
      expect(normal.args).toContain("--allow-dangerously-skip-permissions");
      expect(normal.args[normal.args.indexOf("--permission-mode") + 1]).toBe("default");
      expect(normal.args).not.toContain("--dangerously-skip-permissions");
      const records = yield* Effect.forEach(
        (yield* Effect.promise(() => readFile(messages, "utf8"))).trim().split("\n"),
        (line) =>
          Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
            line,
          ),
      );
      const controls = records
        .filter((message) => message.type === "control_request")
        .map((message) => message.request);
      expect(
        controls.filter(
          (request) => (request as { subtype: string }).subtype === "set_permission_mode",
        ),
      ).toEqual([
        { subtype: "set_permission_mode", mode: "bypassPermissions" },
        { subtype: "set_permission_mode", mode: "bypassPermissions" },
        { subtype: "set_permission_mode", mode: "plan" },
        { subtype: "set_permission_mode", mode: "default" },
      ]);
      expect(
        controls.filter(
          (request) => (request as { subtype: string }).subtype === "apply_flag_settings",
        ),
      ).toEqual([
        { subtype: "apply_flag_settings", settings: { model: "claude-opus-5[1m]" } },
        { subtype: "apply_flag_settings", settings: { model: "claude-opus-5[200k]" } },
        {
          subtype: "apply_flag_settings",
          settings: {
            model: "gateway/private[1m]",
            effortLevel: "high",
            fastMode: true,
            alwaysThinkingEnabled: true,
          },
        },
        {
          subtype: "apply_flag_settings",
          settings: {
            model: "gateway/private[1m]",
            effortLevel: "high",
            fastMode: false,
            alwaysThinkingEnabled: false,
          },
        },
        {
          subtype: "apply_flag_settings",
          settings: {
            model: "gateway/private[1m]",
            effortLevel: "high",
            fastMode: null,
            alwaysThinkingEnabled: null,
          },
        },
      ]);
      expect(records.find((message) => message.type === "user")).toMatchObject({
        priority: "now",
        uuid: "01991e60-b800-7000-8000-000000000014",
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
          ],
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sdk = yield* ClaudeSdk;
          const session = yield* sdk.open({
            instance: { ...defaultClaudeInstance(), binaryPath: executable },
            environment: {
              HOME: root,
              PATH: "/usr/bin:/bin",
              NODEX_TEST_NODE: process.execPath,
              NODEX_TEST_CLI: script,
              NODEX_TEST_INVOCATION: invocation,
              NODEX_TEST_MESSAGES: messages,
              NODEX_TEST_NATIVE_MODEL: "",
            },
            cwd,
            sessionId: "01991e60-b800-7000-8000-000000000020",
            resume: true,
            permissionMode: "default",
            canUseTool: () => Effect.succeed({ behavior: "deny", message: "No tools" }),
          });
          expect(session.intelligence.model).toBeNull();
          expect(
            (yield* Effect.result(
              session.setIntelligence({ model: "default", effort: "default", context: "1m" }),
            ))._tag,
          ).toBe("Failure");
        }),
      );
      const afterUnresolved = (yield* Effect.promise(() => readFile(messages, "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; request?: { subtype: string } });
      expect(
        afterUnresolved.filter((entry) => entry.request?.subtype === "apply_flag_settings"),
      ).toHaveLength(5);
    }).pipe(Effect.scoped, Effect.provide(live)),
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
    const requests = yield* makeClaudeDiscoveryRequests;
    const request = yield* Effect.forkChild(
      requests.run(
        1,
        "fixture",
        sdk.open({
          instance: { ...defaultClaudeInstance(), binaryPath: executable },
          environment: {
            HOME: root,
            PATH: "/usr/bin:/bin",
            NODEX_TEST_NODE: process.execPath,
            NODEX_TEST_CLI: script,
            NODEX_TEST_PID: invocation,
          },
          cwd: root,
          sessionId: "01991e60-b800-7000-8000-000000000012",
          resume: false,
          purpose: "discovery",
          permissionMode: "dontAsk",
          canUseTool: () => Effect.succeed({ behavior: "deny", message: "No tools" }),
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
  }).pipe(Effect.scoped, Effect.provide(live)),
);
