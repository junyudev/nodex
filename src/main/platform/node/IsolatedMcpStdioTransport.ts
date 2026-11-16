import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { observeChildStdioErrors } from "./child-stdio-errors";

export interface IsolatedMcpStdioCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The complete child environment; nothing is inherited from this process. */
  readonly env: Record<string, string | undefined>;
}

/**
 * MCP stdio client Transport for one child process. The SDK's stdio client merges ambient
 * variables even when passed an explicit env, so this owns the spawn and its pipe lifecycle.
 */
export class IsolatedMcpStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly buffer = new ReadBuffer({ maxBufferSize: 4 * 1024 * 1024 });
  private child?: ChildProcess;
  private exited?: Promise<unknown>;
  private closed = false;

  constructor(private readonly target: IsolatedMcpStdioCommand) {}

  async start() {
    if (this.closed) throw new Error("MCP transport is closed");
    const child = spawn(this.target.command, this.target.args, {
      cwd: this.target.cwd,
      env: this.target.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    this.exited = once(child, "exit").catch(() => undefined);
    child.once("exit", () => {
      this.finish();
      child.stdin.destroy();
      child.stdout.destroy();
    });
    const fail = (error: Error) => {
      if (this.closed) return;
      this.onerror?.(error);
      this.finish();
      void this.close();
    };
    child.on("error", fail);
    observeChildStdioErrors(child, fail);
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage())
          this.onmessage?.(message);
      } catch {
        this.onerror?.(new Error("Invalid MCP stdio message"));
        void this.close();
      }
    });
    await once(child, "spawn");
  }

  /** Settles when the child accepts the message, or rejects with the pipe's failure. */
  async send(message: JSONRPCMessage) {
    const input = this.child?.stdin;
    if (!input || this.closed) throw new Error("MCP child disconnected");
    await new Promise<void>((resolve, reject) => {
      input.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
    });
  }

  async close() {
    this.child?.kill("SIGKILL");
    await this.exited;
    this.child?.stdin?.destroy();
    this.child?.stdout?.destroy();
    this.finish();
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}
