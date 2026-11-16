import {
  execFile as nodeExecFile,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptions,
  type ExecFileOptionsWithBufferEncoding,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

/** Stdio errors belong to the child owner but are not emitted by ChildProcess itself. */
export function observeChildStdioErrors(
  child: Pick<ChildProcess, "stdin" | "stdout" | "stderr">,
  onError: (error: Error) => void,
): void {
  // Keep these installed through teardown, when queued writes and reads can still fail.
  child.stdin?.on("error", onError);
  child.stdout?.on("error", onError);
  child.stderr?.on("error", onError);
}

type ExecCallback<T> = (error: ExecFileException | null, stdout: T, stderr: T) => void;
type ExecOutput<T> = { readonly stdout: T; readonly stderr: T };

/** execFile handles ChildProcess errors. Its stdio pipes still need an owner. */
function execFileOwned(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecCallback<string | Buffer>,
): ChildProcess {
  let pipeError: Error | undefined;
  const child = nodeExecFile(file, args, options, (error, stdout, stderr) =>
    callback(pipeError ?? error, stdout, stderr),
  );
  observeChildStdioErrors(child, (error) => {
    if (pipeError) return;
    pipeError = error;
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.kill(options.killSignal);
  });
  return child;
}

export function execFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecCallback<string>,
): ChildProcess {
  return execFileOwned(file, args, options, (error, stdout, stderr) =>
    callback(error, stdout.toString(), stderr.toString()),
  );
}

export function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithBufferEncoding,
): Promise<ExecOutput<Buffer>>;
export function execFileAsync(
  file: string,
  args: readonly string[],
  options?: ExecFileOptionsWithStringEncoding,
): Promise<ExecOutput<string>>;
export function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<ExecOutput<string | Buffer>> {
  return new Promise((resolve, reject) => {
    execFileOwned(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}
