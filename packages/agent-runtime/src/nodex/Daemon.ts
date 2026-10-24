import { acpFailure } from "./AcpFailures.ts";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import { HostBridge } from "./HostBridge.ts";
import { readAgentRuntimeBootstrap } from "./Bootstrap.ts";
import type { AgentRuntimeConfiguration, AgentRuntimeNotification } from "./Interface.ts";

/** The failure's own tag, so the host can tell engine errors apart without parsing text. */
const errorTag = (error: unknown): string | undefined => {
  for (const candidate of [error, error instanceof Error ? error.cause : undefined])
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "_tag" in candidate &&
      typeof candidate._tag === "string"
    )
      return candidate._tag;
  return undefined;
};

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
    const input = NodeReadline.createInterface({ input: process.stdin, terminal: false });
    const lines = input[Symbol.asyncIterator]();
    let bootstrap: Awaited<ReturnType<typeof readAgentRuntimeBootstrap>>;
    try {
      bootstrap = await readAgentRuntimeBootstrap(lines);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      input.close();
      return;
    }
    const configuration: AgentRuntimeConfiguration = {
      home,
      cwd: argument("--cwd") ?? process.cwd(),
      ...bootstrap,
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
        Layer.provideMerge(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])),
      ),
    );
    let closing = false;
    let disposal: Promise<void> | undefined;
    const dispose = () => {
      closing = true;
      input.close();
      process.stdin.destroy();
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
          const tag = errorTag(error);
          const acp = envelope?.method?.startsWith("acp.") ? acpFailure(error) : undefined;
          await write({
            id: envelope?.id ?? "",
            success: false,
            error: {
              message: acp?.message ?? (error instanceof Error ? error.message : String(error)),
              ...(acp ? { acp } : {}),
              ...(tag === undefined ? {} : { tag }),
            },
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
      for await (const line of { [Symbol.asyncIterator]: () => lines }) {
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
        if (request?.method === "storage.snapshot.release") {
          launch(request);
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
