import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  planPublication,
  planTag,
  readGitHubRelease,
  verifyReleaseAttestation,
} from "./github-release";
import { resolveNightlyRelease } from "./nightly";
import { evaluateNightlySourceCi, inspectNightlySourceCi } from "./source-ci";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const expected = new Map([
  ["Nodex-latest-arm64.dmg", { bytes: 10, sha256: "a".repeat(64) }],
  ["release-bundle.json", { bytes: 20, sha256: "b".repeat(64) }],
]);

test("planPublication creates when no release exists", () => {
  expect(planPublication(null, expected, false)).toEqual({ kind: "create" });
});

test("planPublication resumes only missing draft assets", () => {
  expect(
    planPublication(
      {
        assets: [{ digest: `sha256:${"a".repeat(64)}`, name: "Nodex-latest-arm64.dmg", size: 10 }],
        draft: true,
        prerelease: false,
        tag_name: "v0.2.0",
      },
      expected,
      false,
    ),
  ).toEqual({ kind: "resume-draft", missingAssetNames: ["release-bundle.json"] });
});

test("planPublication rejects mismatched assets instead of clobbering", () => {
  expect(() =>
    planPublication(
      {
        assets: [{ digest: `sha256:${"c".repeat(64)}`, name: "Nodex-latest-arm64.dmg", size: 10 }],
        draft: true,
        prerelease: false,
        tag_name: "v0.2.0",
      },
      expected,
      false,
    ),
  ).toThrow("does not match");
});

test("release tag planning never moves an existing tag", () => {
  const sourceSha = "a".repeat(40);
  expect(planTag(null, sourceSha)).toBe("create");
  expect(planTag(sourceSha, sourceSha)).toBe("reuse");
  expect(() => planTag("b".repeat(40), sourceSha)).toThrow("never move");
});

const repo = "junyudev/nodex";
const stableTag = "v0.5.2";
const asset = { digest: `sha256:${"a".repeat(64)}`, name: "Nodex-latest-arm64.dmg", size: 10 };
const stableRelease = {
  tag_name: stableTag,
  draft: false,
  immutable: true,
  prerelease: false,
  assets: [asset],
};
const missingPublishedRelease = () =>
  Object.assign(new Error("Not Found"), {
    status: 1,
    stderr: "gh: Not Found (HTTP 404)\n",
    stdout: JSON.stringify({ message: "Not Found", status: "404" }),
  });

test("reads only the exact tag for a published release", () => {
  vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify(stableRelease));

  expect(readGitHubRelease(repo, stableTag)).toEqual(stableRelease);
  expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
    "gh",
    ["api", `repos/${repo}/releases/tags/${stableTag}`],
    expect.objectContaining({ timeout: 30_000 }),
  );
});

test("finds an unpublished draft by pending tag and verifies its asset digests", () => {
  vi.mocked(execFileSync)
    .mockImplementationOnce(() => {
      throw missingPublishedRelease();
    })
    .mockReturnValueOnce(JSON.stringify({ data: { repository: { release: { databaseId: 73 } } } }))
    .mockReturnValueOnce(JSON.stringify({ ...stableRelease, draft: true, immutable: false }));

  expect(planPublication(readGitHubRelease(repo, stableTag), expected, false)).toEqual({
    kind: "resume-draft",
    missingAssetNames: ["release-bundle.json"],
  });
  expect(execFileSync).toHaveBeenNthCalledWith(
    2,
    "gh",
    expect.arrayContaining(["graphql", "owner=junyudev", "name=nodex", `tag=${stableTag}`]),
    expect.objectContaining({ timeout: 30_000 }),
  );
  expect(execFileSync).toHaveBeenLastCalledWith(
    "gh",
    ["api", `repos/${repo}/releases/73`],
    expect.objectContaining({ timeout: 30_000 }),
  );
});

test("distinguishes a missing draft from an unavailable repository", () => {
  const lookup = vi.mocked(execFileSync);
  lookup
    .mockImplementationOnce(() => {
      throw missingPublishedRelease();
    })
    .mockReturnValueOnce(JSON.stringify({ data: { repository: { release: null } } }));
  expect(readGitHubRelease(repo, stableTag)).toBeNull();

  lookup
    .mockImplementationOnce(() => {
      throw missingPublishedRelease();
    })
    .mockReturnValueOnce(JSON.stringify({ data: { repository: null } }));
  expect(() => readGitHubRelease(repo, stableTag)).toThrow("could not resolve the repository");
});

test("a permission or network failure does not authorize creating a release", () => {
  const failure = Object.assign(new Error("GitHub lookup failed"), {
    status: 1,
    stderr: "gh: Resource not accessible by integration (HTTP 403)",
  });
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    throw failure;
  });

  expect(() => readGitHubRelease(repo, stableTag)).toThrow(failure);
  expect(execFileSync).toHaveBeenCalledTimes(1);
});

const tag = "v0.4.1-nightly.20261022.1679";
const missingAttestation = (stderr: string | Buffer) =>
  Object.assign(new Error("gh release verify failed"), { status: 1, stderr });
const missingMessage = `no attestations for tag ${tag} (sha1:${"a".repeat(40)})\n`;
const tagReference = JSON.stringify({ ref: `refs/tags/${tag}`, object: { sha: "a".repeat(40) } });
const emptyAttestations = JSON.stringify({ attestations: [] });
const mockVerificationWithProbe = (
  verify: () => string,
  probe: () => string = () => emptyAttestations,
) => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args?.[0] === "release") return verify();
    if (args?.[3]?.includes("/git/ref/tags/")) return tagReference;
    return probe();
  });
};
const verificationCalls = () =>
  vi.mocked(execFileSync).mock.calls.filter(([, args]) => args?.[0] === "release");

test("release verification waits for a missing attestation and still requires cryptographic success", async () => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  let attempt = 0;
  mockVerificationWithProbe(() => {
    attempt += 1;
    if (attempt === 1) throw missingAttestation(missingMessage);
    if (attempt === 2) throw missingAttestation(Buffer.from(missingMessage));
    return "Release verified";
  });
  const verification = verifyReleaseAttestation("junyudev/nodex", tag);

  expect(verificationCalls()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(verificationCalls()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10_001);
  await verification;

  expect(verificationCalls()).toHaveLength(3);
  expect(execFileSync).toHaveBeenLastCalledWith(
    "gh",
    ["release", "verify", tag, "--repo", "junyudev/nodex"],
    expect.objectContaining({ timeout: 30_000 }),
  );
  expect(vi.getTimerCount()).toBe(0);
});

test("release verification fails closed when the attestation never appears", async () => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const missing = missingAttestation(missingMessage);
  mockVerificationWithProbe(() => {
    throw missing;
  });
  const verification = verifyReleaseAttestation("junyudev/nodex", tag);
  const rejected = expect(verification).rejects.toMatchObject({
    message: expect.stringContaining("after 12 verification attempts"),
    cause: missing,
  });
  await vi.runAllTimersAsync();
  await rejected;

  expect(verificationCalls()).toHaveLength(12);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  "release asset digest mismatch",
  "invalid attestation signature",
  "HTTP 403: Resource not accessible by integration",
  "no attestations for tag v0.0.0 (sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)",
  `${missingMessage}invalid signature`,
])("release verification never retries a different failure: %s", async (stderr) => {
  vi.useFakeTimers();
  const failure = missingAttestation(stderr);
  vi.mocked(execFileSync).mockImplementation(() => {
    throw failure;
  });

  await expect(verifyReleaseAttestation("junyudev/nodex", tag)).rejects.toBe(failure);
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("release verification stops immediately if a retry exposes invalid signed bytes", async () => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const invalid = missingAttestation("invalid release attestation: digest mismatch");
  let attempt = 0;
  mockVerificationWithProbe(() => {
    attempt += 1;
    if (attempt === 1) throw missingAttestation(missingMessage);
    throw invalid;
  });
  const verification = verifyReleaseAttestation("junyudev/nodex", tag);
  const rejected = expect(verification).rejects.toBe(invalid);
  await vi.runAllTimersAsync();
  await rejected;

  expect(verificationCalls()).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["401", "403", "429", "500"])(
  "release verification exposes raw HTTP %s hidden by the CLI without retrying",
  async (status) => {
    vi.useFakeTimers();
    const denied = missingAttestation(`gh: API request failed (HTTP ${status})`);
    mockVerificationWithProbe(
      () => {
        throw missingAttestation(missingMessage);
      },
      () => {
        throw denied;
      },
    );

    await expect(verifyReleaseAttestation("junyudev/nodex", tag)).rejects.toBe(denied);
    expect(verificationCalls()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("release verification retries a missing digest only after reading the same tag", async () => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const absent = Object.assign(missingAttestation("gh: Not Found (HTTP 404)"), {
    stdout: JSON.stringify({ message: "Not Found", status: "404" }),
  });
  let attempt = 0;
  mockVerificationWithProbe(
    () => {
      attempt += 1;
      if (attempt === 1) throw missingAttestation(missingMessage);
      return "Release verified";
    },
    () => {
      throw absent;
    },
  );
  const verification = verifyReleaseAttestation("junyudev/nodex", tag);
  await vi.runAllTimersAsync();
  await verification;

  expect(verificationCalls()).toHaveLength(2);
  expect(execFileSync).toHaveBeenCalledWith(
    "gh",
    ["api", "--method", "GET", `repos/junyudev/nodex/git/ref/tags/${tag}`],
    expect.objectContaining({ timeout: 30_000 }),
  );
  expect(execFileSync).toHaveBeenCalledWith(
    "gh",
    [
      "api",
      "--method",
      "GET",
      `repos/junyudev/nodex/attestations/sha1:${"a".repeat(40)}`,
      "-f",
      "predicate_type=release",
      "-F",
      "per_page=100",
    ],
    expect.objectContaining({ timeout: 30_000 }),
  );
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  { ref: `refs/tags/${tag}`, object: { sha: "b".repeat(40) } },
  { ref: "refs/tags/unrelated", object: { sha: "a".repeat(40) } },
  {},
])("release verification rejects an unreadable or changed tag: %j", async (reference) => {
  vi.useFakeTimers();
  vi.mocked(execFileSync)
    .mockImplementationOnce(() => {
      throw missingAttestation(missingMessage);
    })
    .mockReturnValueOnce(JSON.stringify(reference));

  await expect(verifyReleaseAttestation("junyudev/nodex", tag)).rejects.toThrow(
    "readable release tag",
  );
  expect(execFileSync).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("release verification preserves a hidden repository or tag HTTP failure", async () => {
  vi.useFakeTimers();
  const denied = Object.assign(missingAttestation("gh: Not Found (HTTP 404)"), {
    stdout: JSON.stringify({ message: "Not Found", status: "404" }),
  });
  vi.mocked(execFileSync)
    .mockImplementationOnce(() => {
      throw missingAttestation(missingMessage);
    })
    .mockImplementationOnce(() => {
      throw denied;
    });

  await expect(verifyReleaseAttestation("junyudev/nodex", tag)).rejects.toBe(denied);
  expect(execFileSync).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("release verification never retries an ambiguous error when the attestation exists", async () => {
  vi.useFakeTimers();
  const failure = missingAttestation(missingMessage);
  mockVerificationWithProbe(
    () => {
      throw failure;
    },
    () => JSON.stringify({ attestations: [{ initiator: "github" }] }),
  );

  await expect(verifyReleaseAttestation("junyudev/nodex", tag)).rejects.toBe(failure);
  expect(verificationCalls()).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([{}, { attestations: null }, { attestations: [null] }, { attestations: [{}] }])(
  "release verification rejects malformed raw attestation responses: %j",
  async (response) => {
    vi.useFakeTimers();
    mockVerificationWithProbe(
      () => {
        throw missingAttestation(missingMessage);
      },
      () => JSON.stringify(response),
    );

    await expect(verifyReleaseAttestation("junyudev/nodex", tag)).rejects.toThrow(
      "invalid release-attestation response",
    );
    expect(verificationCalls()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("release verification preserves raw lookup timeouts without retrying", async () => {
  vi.useFakeTimers();
  const timedOut = Object.assign(new Error("Timed out"), { status: null, signal: "SIGTERM" });
  mockVerificationWithProbe(
    () => {
      throw missingAttestation(missingMessage);
    },
    () => {
      throw timedOut;
    },
  );

  await expect(verifyReleaseAttestation("junyudev/nodex", tag)).rejects.toBe(timedOut);
  expect(verificationCalls()).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("release verification never retries timeouts or process failures", async () => {
  vi.useFakeTimers();
  const failure = Object.assign(new Error("Timed out"), {
    status: null,
    stderr: missingMessage,
    signal: "SIGTERM",
  });
  vi.mocked(execFileSync).mockImplementation(() => {
    throw failure;
  });

  await expect(verifyReleaseAttestation("junyudev/nodex", tag)).rejects.toBe(failure);
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

describe("verified Nightly source", () => {
  const headSha = "a".repeat(40);
  const olderSha = "b".repeat(40);
  const newestGreenSha = "c".repeat(40);
  const failedSha = "d".repeat(40);
  const removedSha = "e".repeat(40);
  const runUrl = (id: number) => `https://github.com/junyudev/nodex/actions/runs/${id}`;
  const run = (id: number, sourceSha: string, overrides: Record<string, unknown> = {}) => ({
    run_number: id,
    head_sha: sourceSha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    html_url: runUrl(id),
    ...overrides,
  });
  const evaluate = (runs: unknown[]) =>
    evaluateNightlySourceCi(headSha, runs, (sha) => {
      const distances = { [headSha]: 0, [olderSha]: 8, [newestGreenSha]: 5, [failedSha]: 2 };
      return distances[sha] ?? null;
    });

  test("selects the most recent successful Main CI push reachable from main HEAD", () => {
    expect(evaluate([run(8, olderSha), run(9, newestGreenSha)])).toEqual({
      headSha,
      verified: { sourceSha: newestGreenSha, runUrl: runUrl(9), commitsBehindHead: 5 },
      newerFailure: null,
    });
    expect(evaluate([run(9, newestGreenSha), run(10, headSha)]).verified).toMatchObject({
      sourceSha: headSha,
      commitsBehindHead: 0,
    });
  });

  test("skips a queued HEAD and superseded pushes without reporting them as failures", () => {
    expect(
      evaluate([
        run(12, headSha, { status: "queued", conclusion: null }),
        run(11, failedSha, { conclusion: "cancelled" }),
        run(9, newestGreenSha),
      ]),
    ).toEqual({
      headSha,
      verified: { sourceSha: newestGreenSha, runUrl: runUrl(9), commitsBehindHead: 5 },
      newerFailure: null,
    });
  });

  test("rejects unreachable success and tries the next most recent reachable success", () => {
    expect(evaluate([run(10, removedSha), run(9, newestGreenSha)]).verified?.sourceSha).toBe(
      newestGreenSha,
    );
    expect(evaluate([run(10, removedSha)]).verified).toBeNull();
  });

  test("returns no verified source if Main CI has never passed for current main", () => {
    expect(evaluate([])).toEqual({ headSha, verified: null, newerFailure: null });
    expect(evaluate([run(10, failedSha, { conclusion: "failure" })])).toEqual({
      headSha,
      verified: null,
      newerFailure: { sourceSha: failedSha, runUrl: runUrl(10) },
    });
  });

  test("reports the newest failure ahead of a verified source without blocking that source", () => {
    expect(
      evaluate([
        run(13, headSha, { conclusion: "cancelled" }),
        run(12, failedSha, { conclusion: "failure" }),
        run(11, failedSha, { conclusion: "failure" }),
        run(9, newestGreenSha),
        run(8, olderSha, { conclusion: "failure" }),
      ]),
    ).toEqual({
      headSha,
      verified: { sourceSha: newestGreenSha, runUrl: runUrl(9), commitsBehindHead: 5 },
      newerFailure: { sourceSha: failedSha, runUrl: runUrl(12) },
    });
    expect(
      evaluate([run(9, newestGreenSha), run(8, olderSha, { conclusion: "failure" })]).newerFailure,
    ).toBeNull();
  });

  test.each([
    { head_sha: "main" },
    { head_branch: "feature" },
    { event: "workflow_dispatch" },
    { status: undefined },
    { conclusion: undefined },
    { run_number: undefined },
  ])("rejects invalid protected-main push evidence: %j", (overrides) => {
    expect(() => evaluate([run(10, headSha, overrides)])).toThrow(
      "protected-main Main CI push evidence",
    );
  });

  test("queries all pages of green and failed Main CI pushes on main", () => {
    vi.mocked(execFileSync).mockReturnValue("[]\n[]\n");
    expect(resolveNightlyRelease({ repo: "junyudev/nodex", cwd: ".", headSha })).toEqual({
      decision: "no-verified-commit",
      headSha,
      verified: null,
      newerFailure: null,
    });
    for (const conclusion of ["success", "failure"]) {
      expect(execFileSync).toHaveBeenCalledWith(
        "gh",
        [
          "api",
          "--method",
          "GET",
          "repos/junyudev/nodex/actions/workflows/ci-main.yml/runs",
          "-f",
          "branch=main",
          "-f",
          "event=push",
          "-f",
          `status=${conclusion}`,
          "-F",
          "per_page=100",
          "--paginate",
          "--jq",
          expect.any(String),
        ],
        expect.any(Object),
      );
    }
  });

  test("fails closed if GitHub did not return a run page", () => {
    vi.mocked(execFileSync).mockReturnValue("{}\n");
    expect(() => inspectNightlySourceCi({ repo: "junyudev/nodex", cwd: ".", headSha })).toThrow(
      "invalid Main CI run page",
    );
  });

  test("requires an immutable lowercase main HEAD before querying GitHub", () => {
    expect(() =>
      inspectNightlySourceCi({ repo: "junyudev/nodex", cwd: ".", headSha: "main" }),
    ).toThrow("full lowercase main HEAD SHA");
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
