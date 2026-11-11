import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { TESTFLIGHT_DIRECTORY, assembleReleaseBundle } from "./bundle";
import {
  appStoreConnect,
  publishTestFlight,
  testerNotes,
  type AppStoreConnect,
  type AppStoreConnectCredentials,
} from "./testflight";
import { makeMobileBuild } from "./mobile-release.fixture";
import { fixtureIdentity, makeReleaseFixture } from "./windows-release.fixture";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nodex-testflight-"));
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const credentials: AppStoreConnectCredentials = {
  keyId: "KEY",
  issuerId: "ISSUER",
  privateKey,
  privateKeyPem: "",
};

/** App Store Connect as far as publishing touches it: one app, its groups and its builds. */
function fakeAppStoreConnect(initial: { processing?: number; externalState?: string } = {}) {
  const calls: string[] = [];
  let build: { processingState: string; externalState: string; polls: number } | null =
    initial.externalState
      ? { processingState: "VALID", externalState: initial.externalState, polls: 0 }
      : null;
  let notes: string | null = null;
  const client: AppStoreConnect = {
    async request(method, path, body) {
      calls.push(`${method} ${path.split("?")[0]}`);
      if (method === "GET" && path.startsWith("/v1/builds?")) {
        if (build && build.processingState === "PROCESSING") {
          build.polls += 1;
          if (build.polls >= (initial.processing ?? 0)) build.processingState = "VALID";
        }
        return build
          ? {
              data: [{ id: "build", type: "builds", attributes: build }],
              included: [
                {
                  id: "build",
                  type: "buildBetaDetails",
                  attributes: { externalBuildState: build.externalState },
                },
              ],
            }
          : { data: [] };
      }
      if (method === "GET" && path.includes("/betaGroups"))
        return {
          data: [
            {
              id: "internal",
              type: "betaGroups",
              attributes: { name: "Nodex team", isInternalGroup: true },
            },
            {
              id: "public",
              type: "betaGroups",
              attributes: { name: "Public beta", isInternalGroup: false },
            },
          ],
        };
      if (method === "GET" && path.endsWith("/betaBuildLocalizations"))
        return {
          data:
            notes === null
              ? []
              : [
                  {
                    id: "notes",
                    type: "betaBuildLocalizations",
                    attributes: { locale: "en-US", whatsNew: notes },
                  },
                ],
        };
      if (path === "/v1/betaBuildLocalizations" || path.startsWith("/v1/betaBuildLocalizations/")) {
        notes = (body as { data: { attributes: { whatsNew: string } } }).data.attributes.whatsNew;
        return null;
      }
      if (path === "/v1/betaAppReviewSubmissions") {
        if (build) build.externalState = "WAITING_FOR_BETA_REVIEW";
        return null;
      }
      if (path === "/v1/betaGroups/public/relationships/builds") return null;
      throw new Error(`Unexpected ${method} ${path}`);
    },
  };
  const uploadPackage = () => {
    build = { processingState: "PROCESSING", externalState: "READY_FOR_BETA_SUBMISSION", polls: 0 };
  };
  return { calls, client, uploadPackage, notes: () => notes };
}

function assembleTestFlightBundle(channel: "stable" | "nightly"): string {
  const output = join(root, "bundle");
  assembleReleaseBundle({ ...makeReleaseFixture(root, channel), outputDirectory: output });
  return join(output, "release-bundle.json");
}

const poll = { interval: 0, timeout: 1000 };

test("a stable release uploads once, waits for processing, and opens to the public beta", async () => {
  const inputs = makeReleaseFixture(root);
  const output = join(root, "bundle");
  assembleReleaseBundle({ ...inputs, outputDirectory: output });
  const asc = fakeAppStoreConnect({ processing: 2 });
  const receipt = await publishTestFlight({
    bundlePath: join(output, "release-bundle.json"),
    credentials,
    poll,
    ...asc,
  });

  expect(receipt).toMatchObject({
    uploaded: true,
    publicBeta: true,
    externalState: "WAITING_FOR_BETA_REVIEW",
    app: { version: "0.2.2", build: "1.0.1" },
  });
  expect(asc.notes()).toBe(testerNotes("0.2.2"));
  expect(asc.calls).toContain("POST /v1/betaGroups/public/relationships/builds");
  expect(asc.calls.filter((call) => call === "POST /v1/betaAppReviewSubmissions")).toHaveLength(1);
});

test("publishing again reuses the build and its review", async () => {
  const bundlePath = assembleTestFlightBundle("stable");
  const asc = fakeAppStoreConnect({ externalState: "IN_BETA_TESTING" });
  let uploads = 0;
  const receipt = await publishTestFlight({
    bundlePath,
    credentials,
    poll,
    client: asc.client,
    uploadPackage: () => {
      uploads += 1;
    },
  });
  expect(uploads).toBe(0);
  expect(receipt.uploaded).toBe(false);
  expect(asc.calls).not.toContain("POST /v1/betaAppReviewSubmissions");
});

test("a duplicate upload waits for the build Apple is still processing", async () => {
  const bundlePath = assembleTestFlightBundle("nightly");
  const asc = fakeAppStoreConnect({ processing: 2 });
  const receipt = await publishTestFlight({
    bundlePath,
    credentials,
    poll,
    client: asc.client,
    uploadPackage: () => {
      // An earlier delivery that Apple lists only after processing it.
      asc.uploadPackage();
      throw new Error("Redundant Binary Upload");
    },
  });
  expect(receipt).toMatchObject({ uploaded: false, publicBeta: false });
});

test("a Nightly reaches internal testers only", async () => {
  const bundlePath = assembleTestFlightBundle("nightly");
  const asc = fakeAppStoreConnect();
  const receipt = await publishTestFlight({ bundlePath, credentials, poll, ...asc });
  expect(receipt.publicBeta).toBe(false);
  expect(asc.calls.some((call) => call.includes("betaGroups") || call.includes("Review"))).toBe(
    false,
  );
});

test("a release publishes only the iOS build its Release Bundle certified", async () => {
  const inputs = makeReleaseFixture(root);
  const output = join(root, "bundle");
  assembleReleaseBundle({ ...inputs, outputDirectory: output });
  const bundlePath = join(output, "release-bundle.json");

  const certified = fakeAppStoreConnect();
  await expect(
    publishTestFlight({ bundlePath, credentials, poll, ...certified }),
  ).resolves.toMatchObject({ uploaded: true, publicBeta: true });

  // The same release rebuilt elsewhere is a different build than the one that was certified.
  const rebuilt = makeMobileBuild(join(root, "rebuilt"), "ios", fixtureIdentity("stable"), {
    runner: { image: "elsewhere" },
  });
  cpSync(
    join(rebuilt, "mobile-build.json"),
    join(output, TESTFLIGHT_DIRECTORY, "mobile-build.json"),
  );
  const swapped = fakeAppStoreConnect();
  await expect(publishTestFlight({ bundlePath, credentials, poll, ...swapped })).rejects.toThrow(
    "certified",
  );
  expect(swapped.calls).toEqual([]);
});

test("recovery finishes a build Apple holds once the private IPA has expired", async () => {
  const inputs = makeReleaseFixture(root);
  const output = join(root, "bundle");
  assembleReleaseBundle({ ...inputs, outputDirectory: output });
  rmSync(join(output, TESTFLIGHT_DIRECTORY), { recursive: true });
  const bundlePath = join(output, "release-bundle.json");

  const held = fakeAppStoreConnect({ externalState: "READY_FOR_BETA_SUBMISSION" });
  await expect(
    publishTestFlight({ bundlePath, credentials, poll, ...held }),
  ).resolves.toMatchObject({
    uploaded: false,
    externalState: "WAITING_FOR_BETA_REVIEW",
  });

  const missing = fakeAppStoreConnect();
  await expect(publishTestFlight({ bundlePath, credentials, poll, ...missing })).rejects.toThrow(
    "no longer available",
  );
});

test("App Store Connect calls survive a dropped connection", async () => {
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    await expect(appStoreConnect(credentials).request("GET", "/v1/builds")).resolves.toEqual({
      data: [],
    });
    expect(attempts).toBe(2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
