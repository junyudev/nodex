import { spawnSync } from "node:child_process";

/** One `notarytool` call: the parsed JSON result, or why it produced none. */
export type NotaryResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly detail: string };

export interface NotaryClient {
  /** Upload a file; succeeds only after Apple holds every byte. */
  readonly submit: (path: string) => NotaryResult;
  /** Block until Apple finishes processing, or the tool gives up. */
  readonly wait: (id: string) => NotaryResult;
  /** Apple's authoritative record of one submission. */
  readonly info: (id: string) => NotaryResult;
  readonly log: (id: string) => NotaryResult;
}

export interface NotarizationOptions {
  readonly attempts?: number;
  readonly pause?: (attempt: number) => void;
  readonly report?: (line: string) => void;
}

const DEFAULT_ATTEMPTS = 3;

const stringField = (result: NotaryResult, field: string): string | null =>
  result.ok && typeof result.value[field] === "string" ? (result.value[field] as string) : null;

/**
 * Notarize one file and return its accepted submission ID.
 *
 * Upload and status polling cross the network and can drop without Apple having decided
 * anything, so each retries on its own: a failed upload submits again, while a failed wait
 * keeps following the same submission. Apple's own verdict is final, and a rejection prints
 * Apple's log instead of retrying.
 */
export function notarize(
  client: NotaryClient,
  path: string,
  { attempts = DEFAULT_ATTEMPTS, pause = () => {}, report = console.log }: NotarizationOptions = {},
): string {
  let id: string | null = null;
  for (let attempt = 1; id === null; attempt += 1) {
    const submitted = client.submit(path);
    id = stringField(submitted, "id");
    if (id !== null) break;
    const detail = submitted.ok ? "notarytool returned no submission ID" : submitted.detail;
    if (attempt >= attempts) {
      throw new Error(`Notarization upload failed after ${attempts} attempts: ${detail}`);
    }
    report(`Notarization upload attempt ${attempt} failed; submitting again. ${detail}`);
    pause(attempt);
  }
  report(`Notarization submission ${id} uploaded.`);

  for (let attempt = 1; ; attempt += 1) {
    const waited = client.wait(id);
    const status = stringField(client.info(id), "status");
    if (status === "Accepted") return id;
    if (status === "Invalid" || status === "Rejected") {
      const log = client.log(id);
      report(
        log.ok ? JSON.stringify(log.value, null, 2) : `Apple's log is unavailable: ${log.detail}`,
      );
      throw new Error(`Apple ${status.toLowerCase()} notarization submission ${id}.`);
    }
    const detail = waited.ok ? `status ${status ?? "unknown"}` : waited.detail;
    if (attempt >= attempts) {
      throw new Error(`Notarization submission ${id} did not finish: ${detail}`);
    }
    report(`Waiting on notarization submission ${id} stopped early (${detail}); waiting again.`);
    pause(attempt);
  }
}

const OUTPUT_DETAIL_CHARS = 800;

/** The `xcrun notarytool` client, authenticated with an App Store Connect API key. */
export function createNotarytoolClient(
  cwd: string,
  credentials: { readonly key: string; readonly keyId: string; readonly issuer: string },
): NotaryClient {
  const call = (args: readonly string[]): NotaryResult => {
    const result = spawnSync(
      "xcrun",
      [
        "notarytool",
        ...args,
        "--key",
        credentials.key,
        "--key-id",
        credentials.keyId,
        "--issuer",
        credentials.issuer,
        "--output-format",
        "json",
      ],
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (result.status === 0) {
      try {
        const value: unknown = JSON.parse(result.stdout);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          return { ok: true, value: value as Record<string, unknown> };
        }
      } catch {
        // Fall through to the unparsed output below.
      }
    }
    const ending = result.error
      ? result.error.message
      : result.signal
        ? `stopped by ${result.signal}`
        : `exited with ${String(result.status)}`;
    const detail = output.slice(-OUTPUT_DETAIL_CHARS).trim();
    return { ok: false, detail: detail ? `${ending}: ${detail}` : ending };
  };
  return {
    submit: (path) => call(["submit", path, "--no-progress"]),
    wait: (id) => call(["wait", id, "--timeout", "2h"]),
    info: (id) => call(["info", id]),
    log: (id) => call(["log", id]),
  };
}

/** Back off between network attempts without leaving the synchronous release script. */
export const pauseBeforeRetry = (attempt: number): void => {
  spawnSync("/bin/sleep", [String(30 * attempt)]);
};
