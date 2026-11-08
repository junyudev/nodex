import { execFileSync } from "node:child_process";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { TESTFLIGHT_DIRECTORY, parseReleaseBundleManifest } from "./bundle";
import {
  APP_STORE_CONNECT_APP_ID,
  MOBILE_APP_ID,
  MOBILE_BUILD_MANIFEST,
  TESTFLIGHT_PUBLIC_GROUP,
  parseMobileBuildManifest,
  readMobileBuildDirectory,
  type MobileApp,
} from "./mobile";
import { sha256File, type ReleaseIdentity } from "./model";

const API = "https://api.appstoreconnect.apple.com";
const SECOND = 1000;

interface Resource {
  readonly id: string;
  readonly type: string;
  readonly attributes?: Record<string, unknown>;
  readonly relationships?: Record<string, { readonly data?: unknown }>;
}

interface Document {
  readonly data?: Resource | readonly Resource[] | null;
  readonly included?: readonly Resource[];
}

export interface AppStoreConnectCredentials {
  readonly keyId: string;
  readonly issuerId: string;
  readonly privateKey: KeyObject;
  /** The `.p8` text, which altool reads from a file named after the key. */
  readonly privateKeyPem: string;
}

export function credentialsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AppStoreConnectCredentials {
  const { APPLE_API_KEY_B64, APPLE_API_KEY_ID, APPLE_API_ISSUER } = env;
  if (!APPLE_API_KEY_B64 || !APPLE_API_KEY_ID || !APPLE_API_ISSUER)
    throw new Error("TestFlight publishing needs the App Store Connect key.");
  const privateKeyPem = Buffer.from(APPLE_API_KEY_B64, "base64").toString("utf8");
  return {
    keyId: APPLE_API_KEY_ID,
    issuerId: APPLE_API_ISSUER,
    privateKey: createPrivateKey(privateKeyPem),
    privateKeyPem,
  };
}

const base64Url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

/** A short-lived App Store Connect token, signed as ES256 over the raw P-1363 signature. */
const token = ({ keyId, issuerId, privateKey }: AppStoreConnectCredentials): string => {
  const now = Math.floor(Date.now() / SECOND);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const body = base64Url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 900, aud: "appstoreconnect-v1" }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${body}.${base64Url(signature)}`;
};

export interface AppStoreConnect {
  request(method: string, path: string, body?: unknown): Promise<Document | null>;
}

export function appStoreConnect(credentials: AppStoreConnectCredentials): AppStoreConnect {
  return {
    async request(method, path, body) {
      for (let attempt = 1; ; attempt += 1) {
        const retry = () => new Promise((settle) => setTimeout(settle, attempt * 5 * SECOND));
        let response: Response;
        try {
          response = await fetch(`${API}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${token(credentials)}`,
              "Content-Type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch (error) {
          // A dropped connection says nothing about the request; reads and these idempotent
          // writes are safe to repeat.
          if (attempt >= 4) throw error;
          await retry();
          continue;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 4) {
          await retry();
          continue;
        }
        const text = await response.text();
        if (!response.ok) {
          // Apple's error details name the field at fault and never echo credentials.
          throw new Error(
            `App Store Connect ${method} ${path} failed (${response.status}): ${text}`,
          );
        }
        return text ? (JSON.parse(text) as Document) : null;
      }
    },
  };
}

const list = (document: Document | null): readonly Resource[] =>
  Array.isArray(document?.data) ? document.data : [];

export interface TestFlightBuild {
  readonly id: string;
  readonly processingState: string;
  readonly externalState: string | null;
}

/** The build App Store Connect holds for exactly this version and build, if it has one yet. */
export async function findBuild(
  client: AppStoreConnect,
  app: MobileApp,
): Promise<TestFlightBuild | null> {
  const document = await client.request(
    "GET",
    `/v1/builds?filter[app]=${APP_STORE_CONNECT_APP_ID}&filter[version]=${encodeURIComponent(app.build)}` +
      `&filter[preReleaseVersion.version]=${encodeURIComponent(app.version)}` +
      "&include=buildBetaDetail&fields[builds]=version,processingState,buildBetaDetail" +
      "&fields[buildBetaDetails]=externalBuildState&limit=2",
  );
  const builds = list(document);
  if (builds.length > 1) throw new Error(`App Store Connect holds two builds ${app.build}.`);
  const build = builds[0];
  if (!build) return null;
  const detail = document?.included?.find((resource) => resource.type === "buildBetaDetails");
  return {
    id: build.id,
    processingState: String(build.attributes?.processingState ?? ""),
    externalState:
      typeof detail?.attributes?.externalBuildState === "string"
        ? detail.attributes.externalBuildState
        : null,
  };
}

const PROCESSING_TIMEOUT = 90 * 60 * SECOND;
/** How long a refused duplicate upload may take to appear as the build Apple already has. */
const REDUNDANT_UPLOAD_GRACE = 20 * 60 * SECOND;

/**
 * Waits until Apple has processed the upload; a build that fails processing never ships. App Store
 * Connect lists a build only once processing ends, so an absent build may simply be on its way.
 */
export async function waitForProcessedBuild(
  client: AppStoreConnect,
  app: MobileApp,
  options: { readonly interval?: number; readonly timeout?: number } = {},
): Promise<TestFlightBuild> {
  const deadline = Date.now() + (options.timeout ?? PROCESSING_TIMEOUT);
  for (;;) {
    const build = await findBuild(client, app);
    if (build?.processingState === "VALID") return build;
    if (build && build.processingState !== "PROCESSING")
      throw new Error(`TestFlight build ${app.build} is ${build.processingState}.`);
    if (Date.now() > deadline)
      throw new Error(`TestFlight build ${app.build} was not processed in time.`);
    await new Promise((settle) => setTimeout(settle, options.interval ?? 30 * SECOND));
  }
}

/** Uploads through altool, which reads the key from a private directory named for it. */
const upload = (ipa: string, app: MobileApp, credentials: AppStoreConnectCredentials): void => {
  const keys = mkdtempSync(join(tmpdir(), "nodex-testflight-key-"));
  try {
    writeFileSync(join(keys, `AuthKey_${credentials.keyId}.p8`), credentials.privateKeyPem, {
      mode: 0o600,
    });
    execFileSync(
      "xcrun",
      [
        "altool",
        "--upload-package",
        ipa,
        "--type",
        "ios",
        "--apple-id",
        APP_STORE_CONNECT_APP_ID,
        "--bundle-id",
        app.id,
        "--bundle-version",
        app.build,
        "--bundle-short-version-string",
        app.version,
        "--apiKey",
        credentials.keyId,
        "--apiIssuer",
        credentials.issuerId,
      ],
      { env: { ...process.env, API_PRIVATE_KEYS_DIR: keys }, stdio: "inherit" },
    );
  } finally {
    rmSync(keys, { force: true, recursive: true });
  }
};

const findGroup = async (client: AppStoreConnect, name: string): Promise<string> => {
  const groups = list(
    await client.request(
      "GET",
      `/v1/apps/${APP_STORE_CONNECT_APP_ID}/betaGroups?fields[betaGroups]=name,isInternalGroup&limit=200`,
    ),
  ).filter(
    (group) => group.attributes?.name === name && group.attributes?.isInternalGroup === false,
  );
  if (groups.length !== 1) throw new Error(`Expected one external TestFlight group named ${name}.`);
  return groups[0].id;
};

/** What testers read in TestFlight: which desktop release this build belongs with. */
export const testerNotes = (version: string): string =>
  `Nodex ${version}. Use it with Nodex ${version} on your computer.\n` +
  `What's new: https://nodex.jyu.app/changelog/#v${version}`;

const setTesterNotes = async (client: AppStoreConnect, buildId: string, text: string) => {
  const existing = list(
    await client.request("GET", `/v1/builds/${buildId}/betaBuildLocalizations`),
  ).find((localization) => localization.attributes?.locale === "en-US");
  if (existing?.attributes?.whatsNew === text) return;
  await (existing
    ? client.request("PATCH", `/v1/betaBuildLocalizations/${existing.id}`, {
        data: { type: "betaBuildLocalizations", id: existing.id, attributes: { whatsNew: text } },
      })
    : client.request("POST", "/v1/betaBuildLocalizations", {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: "en-US", whatsNew: text },
          relationships: { build: { data: { type: "builds", id: buildId } } },
        },
      }));
};

/** States from which external testers get the build without another submission. */
const SUBMITTED_STATES = new Set([
  "WAITING_FOR_BETA_REVIEW",
  "IN_BETA_REVIEW",
  "BETA_APPROVED",
  "IN_BETA_TESTING",
]);

/** The iOS build to publish, proven against its Release Bundle when there is one. */
function certifiedBuild(options: {
  readonly bundlePath?: string;
  readonly buildDirectory?: string;
}): { app: MobileApp; identity: ReleaseIdentity; artifactPath: string | null } {
  if (options.buildDirectory) {
    const root = resolve(options.buildDirectory);
    const { releaseIdentity } = parseMobileBuildManifest(
      JSON.parse(readFileSync(join(root, MOBILE_BUILD_MANIFEST), "utf8")),
    );
    const build = readMobileBuildDirectory(root, "ios", releaseIdentity);
    return { app: build.manifest.app, identity: releaseIdentity, artifactPath: build.artifactPath };
  }
  const bundlePath = resolve(options.bundlePath ?? "");
  const bundle = parseReleaseBundleManifest(JSON.parse(readFileSync(bundlePath, "utf8")));
  const root = join(dirname(bundlePath), TESTFLIGHT_DIRECTORY);
  if (!existsSync(root))
    return { app: bundle.mobile.ios.app, identity: bundle.releaseIdentity, artifactPath: null };
  const build = readMobileBuildDirectory(root, "ios", bundle.releaseIdentity);
  if (
    sha256File(build.manifestPath) !== bundle.mobile.ios.manifestSha256 ||
    build.manifest.artifact.sha256 !== bundle.mobile.ios.artifact.sha256
  )
    throw new Error("The iOS build is not the one its Release Bundle certified.");
  return {
    app: build.manifest.app,
    identity: bundle.releaseIdentity,
    artifactPath: build.artifactPath,
  };
}

export interface TestFlightReceipt {
  readonly buildId: string;
  readonly app: MobileApp;
  readonly uploaded: boolean;
  readonly publicBeta: boolean;
  readonly externalState: string | null;
}

/**
 * Puts one certified iOS build on TestFlight. Every step is idempotent, so Recovery can repeat
 * it: an existing build is reused rather than uploaded again, and a stable release joins the
 * public group and Beta App Review once. Nightly and local builds reach internal testers only.
 * A release publishes from its Release Bundle, which binds the exact IPA; once that private copy
 * has expired, publishing can still finish a build Apple already holds, but never uploads another.
 */
export async function publishTestFlight(
  options: (
    | { readonly bundlePath: string; readonly buildDirectory?: undefined }
    | { readonly buildDirectory: string; readonly bundlePath?: undefined }
  ) & {
    readonly client?: AppStoreConnect;
    readonly credentials?: AppStoreConnectCredentials;
    readonly uploadPackage?: typeof upload;
    readonly poll?: { readonly interval?: number; readonly timeout?: number };
  },
): Promise<TestFlightReceipt> {
  const { app, identity, artifactPath } = certifiedBuild(options);
  if (app.id !== MOBILE_APP_ID) throw new Error("The iOS build is not Nodex Mobile.");
  const credentials = options.credentials ?? credentialsFromEnvironment();
  const client = options.client ?? appStoreConnect(credentials);

  let uploaded = false;
  if (!(await findBuild(client, app))) {
    if (!artifactPath)
      throw new Error(
        `The certified IPA for ${app.version} (${app.build}) is no longer available to upload.`,
      );
    try {
      (options.uploadPackage ?? upload)(artifactPath, app, credentials);
      uploaded = true;
    } catch (error) {
      // An earlier attempt may have delivered it already. Apple refuses the duplicate, but lists
      // a build only once it has processed it, so give that delivery time to appear.
      const delivered = await waitForProcessedBuild(client, app, {
        interval: options.poll?.interval,
        timeout: options.poll?.timeout ?? REDUNDANT_UPLOAD_GRACE,
      }).catch(() => null);
      if (!delivered) throw error;
    }
  }
  let build = await waitForProcessedBuild(client, app, options.poll);

  const publicBeta = identity.channel === "stable";
  if (publicBeta) {
    await setTesterNotes(client, build.id, testerNotes(app.version));
    const group = await findGroup(client, TESTFLIGHT_PUBLIC_GROUP);
    await client.request("POST", `/v1/betaGroups/${group}/relationships/builds`, {
      data: [{ type: "builds", id: build.id }],
    });
    build = (await findBuild(client, app)) ?? build;
    if (!SUBMITTED_STATES.has(build.externalState ?? "")) {
      await client.request("POST", "/v1/betaAppReviewSubmissions", {
        data: {
          type: "betaAppReviewSubmissions",
          relationships: { build: { data: { type: "builds", id: build.id } } },
        },
      });
      build = (await findBuild(client, app)) ?? build;
    }
  }
  return { buildId: build.id, app, uploaded, publicBeta, externalState: build.externalState };
}
