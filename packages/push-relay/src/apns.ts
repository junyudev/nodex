import { createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";
import type { Device } from "./validation.js";

export interface ApnsCredentials {
  readonly privateKey: string;
  readonly keyId: string;
  readonly teamId: string;
}

export const apnsOrigin = (environment: Device["environment"]): string =>
  environment === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";

export const createProviderToken = (credentials: ApnsCredentials, now = Date.now) => {
  const key = createPrivateKey(credentials.privateKey);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Invalid APNS_KEY_P8");
  }
  if (!/^[A-Z0-9]{10}$/u.test(credentials.keyId) || !/^[A-Z0-9]{10}$/u.test(credentials.teamId)) {
    throw new Error("Invalid APNs credentials");
  }
  let cached: { jwt: string; issuedAt: number } | undefined;
  return (): string => {
    const issuedAt = Math.floor(now() / 1000);
    if (cached && issuedAt >= cached.issuedAt && issuedAt - cached.issuedAt < 45 * 60) {
      return cached.jwt;
    }
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: credentials.keyId })).toString(
      "base64url",
    );
    const claims = Buffer.from(JSON.stringify({ iss: credentials.teamId, iat: issuedAt })).toString(
      "base64url",
    );
    const unsigned = `${header}.${claims}`;
    const signature = sign("sha256", Buffer.from(unsigned), {
      key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const jwt = `${unsigned}.${signature}`;
    cached = { jwt, issuedAt };
    return jwt;
  };
};

export interface ApnsResponse {
  readonly status: number;
  readonly reason: string | null;
}

// Only Apple's documented reason codes may leave this boundary or enter logs.
const reasons = new Set([
  "BadCollapseId",
  "BadDeviceToken",
  "BadExpirationDate",
  "BadMessageId",
  "BadPriority",
  "BadTopic",
  "DeviceTokenNotForTopic",
  "DuplicateHeaders",
  "IdleTimeout",
  "InvalidPushType",
  "MissingDeviceToken",
  "MissingTopic",
  "PayloadEmpty",
  "TopicDisallowed",
  "BadCertificate",
  "BadCertificateEnvironment",
  "ExpiredProviderToken",
  "Forbidden",
  "InvalidProviderToken",
  "MissingProviderToken",
  "UnrelatedKeyIdInToken",
  "BadPath",
  "MethodNotAllowed",
  "ExpiredToken",
  "Unregistered",
  "PayloadTooLarge",
  "TooManyProviderTokenUpdates",
  "TooManyRequests",
  "InternalServerError",
  "ServiceUnavailable",
  "Shutdown",
]);

const responseReason = (body: string): string | null => {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null || !("reason" in value)) return null;
    return typeof value.reason === "string" && reasons.has(value.reason) ? value.reason : null;
  } catch {
    return null;
  }
};

/** One bounded HTTP/2 attempt; the desktop owns retries, so this never resends a notification. */
export const createApnsClient = (
  credentials: ApnsCredentials,
  options: {
    readonly origin?: typeof apnsOrigin;
    readonly now?: () => number;
    readonly timeoutMs?: number;
  } = {},
) => {
  const token = createProviderToken(credentials, options.now);
  return (device: Device, body: string): Promise<ApnsResponse> => {
    const jwt = token();
    return new Promise((resolve, reject) => {
      const session = connect((options.origin ?? apnsOrigin)(device.environment));
      let settled = false;
      const finish = (response?: ApnsResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.destroy();
        if (response) resolve(response);
        else reject(new Error("ApnsTransportFailure"));
      };
      const timer = setTimeout(() => finish(), options.timeoutMs ?? 10_000);
      session.on("error", () => finish());
      session.on("close", () => finish());
      session.on("goaway", () => finish());
      try {
        const request = session.request({
          ":method": "POST",
          ":path": `/3/device/${device.token}`,
          authorization: `bearer ${jwt}`,
          "apns-topic": device.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        });
        let status = 0;
        const chunks: Buffer[] = [];
        let size = 0;
        request.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) {
            finish();
            return;
          }
          chunks.push(chunk);
        });
        request.on("error", () => finish());
        request.on("aborted", () => finish());
        request.on("close", () => finish());
        request.on("end", () => {
          if (!Number.isInteger(status) || status < 200 || status > 599) {
            finish();
            return;
          }
          finish({ status, reason: responseReason(Buffer.concat(chunks).toString("utf8")) });
        });
        request.end(body);
      } catch {
        finish();
      }
    });
  };
};
