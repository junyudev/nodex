import { execFileSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { planPublication, planTag, verifyReleaseAttestation } from "./github-release";

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

const tag = "v0.4.1-nightly.20261022.1679";
const missingAttestation = (stderr: string | Buffer) =>
  Object.assign(new Error("gh release verify failed"), { status: 1, stderr });
const missingMessage = `no attestations for tag ${tag} (sha1:${"a".repeat(40)})\n`;

test("release verification waits for a missing attestation and still requires cryptographic success", async () => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.mocked(execFileSync)
    .mockImplementationOnce(() => {
      throw missingAttestation(missingMessage);
    })
    .mockImplementationOnce(() => {
      throw missingAttestation(Buffer.from(missingMessage));
    })
    .mockReturnValue("Release verified");
  const verification = verifyReleaseAttestation("junyudev/nodex", tag);

  expect(execFileSync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(execFileSync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_001);
  await verification;

  expect(execFileSync).toHaveBeenCalledTimes(3);
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
  vi.mocked(execFileSync).mockImplementation(() => {
    throw missing;
  });
  const verification = verifyReleaseAttestation("junyudev/nodex", tag);
  const rejected = expect(verification).rejects.toMatchObject({
    message: expect.stringContaining("after 12 verification attempts"),
    cause: missing,
  });
  await vi.runAllTimersAsync();
  await rejected;

  expect(execFileSync).toHaveBeenCalledTimes(12);
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
  vi.mocked(execFileSync)
    .mockImplementationOnce(() => {
      throw missingAttestation(missingMessage);
    })
    .mockImplementation(() => {
      throw invalid;
    });
  const verification = verifyReleaseAttestation("junyudev/nodex", tag);
  const rejected = expect(verification).rejects.toBe(invalid);
  await vi.runAllTimersAsync();
  await rejected;

  expect(execFileSync).toHaveBeenCalledTimes(2);
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
