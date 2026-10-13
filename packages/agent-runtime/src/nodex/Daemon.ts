import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import { HostBridge } from "./HostBridge.ts";
import type { AgentRuntimeConfiguration, AgentRuntimeNotification } from "./Interface.ts";

export async function runAgentRuntimeProcess(): Promise<void> {
  const MAX_ACTIVE_REQUESTS = 32;
  const MAX_WAITING_REQUESTS = 128;
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const home = argument("--home");
  if (home === undefined || !NodePath.isAbsolute(home)) {
    process.stderr.write("An absolute --home is required for Agent Runtime.\n");
    process.exitCode = 1;
  } else {
    const providerBootstrap = process.env.NODEX_AGENT_RUNTIME_PROVIDER_INSTANCES;
    const hostToolBootstrap = process.env.NODEX_AGENT_RUNTIME_HOST_TOOLS;
    delete process.env.NODEX_AGENT_RUNTIME_PROVIDER_INSTANCES;
    delete process.env.NODEX_AGENT_RUNTIME_HOST_TOOLS;
    const configuration: AgentRuntimeConfiguration = {
      home,
      cwd: argument("--cwd") ?? process.cwd(),
      providers: JSON.parse(providerBootstrap ?? "{}"),
      ...(hostToolBootstrap === undefined
        ? {}
        : {
            host: { tools: JSON.parse(hostToolBootstrap) },
          }),
    };
    const write = (value: unknown): Promise<void> =>
      new Promise((resolve, reject) => {
        process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    const notify = (notification: AgentRuntimeNotification) =>
      Effect.tryPromise(() => write(notification)).pipe(Effect.orDie);
    const runtime = ManagedRuntime.make(
      Application.layer(configuration, notify).pipe(
        Layer.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])),
      ),
    );
    const input = NodeReadline.createInterface({ input: process.stdin, terminal: false });
    let closing = false;
    let disposal: Promise<void> | undefined;
    const dispose = () => {
      closing = true;
      input.close();
      disposal ??= runtime.dispose();
      return disposal;
    };
    process.once("SIGTERM", () => {
      void dispose();
    });
    process.once("SIGINT", () => {
      void dispose();
    });
    const active = new Set<Promise<void>>();
    const waiting: unknown[] = [];
    try {
      const service = await runtime.runPromise(AgentRuntime);
      const bridge = await runtime.runPromise(HostBridge);
      await write({ type: "ready", identity: service.identity });
      const execute = async (request: unknown) => {
        const envelope = request as { readonly id?: string; readonly method?: string };
        try {
          const output = await runtime.runPromise(service.handle(request));
          await write({ id: envelope?.id ?? "", success: true, output });
          if (envelope?.method === "shutdown") await dispose();
        } catch (error) {
          await write({
            id: envelope?.id ?? "",
            success: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        }
      };
      const launch = (request: unknown) => {
        const task = execute(request)
          .catch((error) => {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            return dispose();
          })
          .finally(() => {
            active.delete(task);
            const next = closing ? undefined : waiting.shift();
            if (next !== undefined) launch(next);
          });
        active.add(task);
      };
      for await (const line of input) {
        let request: { readonly id?: string; readonly type?: string; readonly method?: string };
        try {
          request = JSON.parse(line);
        } catch (error) {
          await write({ id: "", success: false, error: { message: String(error) } });
          continue;
        }
        // Replies bypass the bounded command queue; commands may be waiting for these replies.
        if (request?.type === "host.result") {
          try {
            await runtime.runPromise(bridge.accept(request));
          } catch (error) {
            process.stderr.write(
              `Invalid host reply: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
          continue;
        }
        if (request?.method === "shutdown") {
          closing = true;
          launch(request);
          continue;
        }
        if (active.size < MAX_ACTIVE_REQUESTS) {
          launch(request);
          continue;
        }
        if (waiting.length < MAX_WAITING_REQUESTS) {
          waiting.push(request);
          continue;
        }
        await write({
          id: request?.id ?? "",
          success: false,
          error: { message: "Agent Runtime command queue is full." },
        });
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    } finally {
      await dispose();
      await Promise.allSettled(active);
    }
  }
}
