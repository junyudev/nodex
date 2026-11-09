import { beforeEach, describe, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
const serialized = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const mock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", () => {
  const execFile = () => undefined;
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => mock.run(...args),
  });
  return { execFile };
});
import { readGitHubSourceToken } from "./GitHubSourcePlatform";
describe("GitHub Source CLI credentials", () => {
  beforeEach(() => {
    mock.run.mockReset();
  });
  it.effect("selects the exact host and account and removes token environment overrides", () =>
    Effect.gen(function* () {
      mock.run.mockImplementation((command, args, options) => {
        expect(command).toBe("gh");
        expect(args).toEqual(["auth", "token", "--hostname", "github.com", "--user", "alice"]);
        expect(options.env).toMatchObject({
          PATH: "/bin",
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          GH_ENTERPRISE_TOKEN: undefined,
          GITHUB_ENTERPRISE_TOKEN: undefined,
          GH_DEBUG: "",
          GH_PROMPT_DISABLED: "1",
        });
        return Promise.resolve({ stdout: "private-token\n", stderr: "" });
      });
      const token = yield* readGitHubSourceToken({
        PATH: "/bin",
        GH_TOKEN: "wrong",
        GH_DEBUG: "api",
      })("github.com", "alice");
      expect(Redacted.value(token.token)).toBe("private-token");
      expect(serialized(token)).not.toContain("private-token");
    }),
  );
  it.effect("never falls back to another account and drops raw process evidence", () =>
    Effect.gen(function* () {
      mock.run.mockRejectedValue(new Error("private-token"));
      const error = yield* readGitHubSourceToken({})("github.com", "missing").pipe(Effect.flip);
      expect(error._tag).toBe("GitHubNotSignedInError");
      expect(error.account).toBe("missing");
      expect(serialized(error)).not.toContain("private-token");
      expect(mock.run).toHaveBeenCalledOnce();
    }),
  );
});
