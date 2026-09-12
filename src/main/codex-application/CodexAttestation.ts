import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface CodexAttestationSignals {
  readonly schemaVersion: number;
  readonly preferredLanguages: readonly string[];
  readonly locale: string;
  readonly timezone: string;
  readonly screenSizeSum: number;
  readonly screenScale: number;
  readonly appSessionId: string;
}

export interface CodexDeviceCheckResult {
  readonly supported: boolean;
  readonly tokenBase64?: string;
  readonly latencyMs?: number;
}

export interface CodexAttestationOptions {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly bundleIdentifier: string;
  readonly getSignals: () => CodexAttestationSignals;
  readonly generateDeviceCheckToken?: () => Promise<CodexDeviceCheckResult>;
}

export class CodexAttestation extends Context.Service<
  CodexAttestation,
  {
    readonly generate: Effect.Effect<{ readonly token: string }>;
  }
>()("nodex/main/codex-application/CodexAttestation") {}

const DEVICE_ATTESTATION_ERROR = {
  unsupportedPlatform: 1,
  unsupportedArchitecture: 2,
  unsupportedDevice: 3,
  generationFailed: 4,
} as const;

const MAX_PREFERRED_LANGUAGES = 16;
const MAX_LANGUAGE_LENGTH = 64;
const MAX_LOCALE_LENGTH = 64;
const MAX_TIMEZONE_LENGTH = 64;
const MAX_APP_SESSION_ID_LENGTH = 128;

/** Desktop app-server clients opt into attestation on the two supported desktop families. */
export const supportsCodexAttestationRequests = (platform: string): boolean =>
  platform === "darwin" || platform === "win32";

export const buildCodexAttestationSignals = (input: {
  readonly appSessionId: string;
  readonly displayHeight: number;
  readonly displayWidth: number;
  readonly locale: string;
  readonly preferredLanguages: readonly string[];
  readonly screenScale: number;
  readonly timezone: string;
}): CodexAttestationSignals => {
  const locale = (input.locale || "unknown").slice(0, MAX_LOCALE_LENGTH);
  const languages = input.preferredLanguages.length > 0 ? input.preferredLanguages : [locale];
  return {
    schemaVersion: 1,
    preferredLanguages: languages
      .slice(0, MAX_PREFERRED_LANGUAGES)
      .map((language) => language.slice(0, MAX_LANGUAGE_LENGTH)),
    locale,
    timezone: (input.timezone || "unknown").slice(0, MAX_TIMEZONE_LENGTH),
    screenSizeSum: Math.max(0, Math.round(input.displayWidth + input.displayHeight)),
    screenScale: input.screenScale,
    appSessionId: input.appSessionId.slice(0, MAX_APP_SESSION_ID_LENGTH),
  };
};

const encodeCborLength = (majorType: number, value: number): Buffer => {
  if (value < 24) return Buffer.from([majorType | value]);
  if (value <= 0xff) return Buffer.from([majorType | 24, value]);
  if (value <= 0xffff) {
    const output = Buffer.allocUnsafe(3);
    output[0] = majorType | 25;
    output.writeUInt16BE(value, 1);
    return output;
  }
  if (value <= 0xffffffff) {
    const output = Buffer.allocUnsafe(5);
    output[0] = majorType | 26;
    output.writeUInt32BE(value, 1);
    return output;
  }
  throw new Error(`CBOR length too large: ${value}`);
};

const encodeCborUnsigned = (value: number): Buffer => encodeCborLength(0, value);

const encodeCborString = (value: string): Buffer => {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeCborLength(0x60, bytes.length), bytes]);
};

const encodeCborNumber = (value: number): Buffer => {
  if (Number.isSafeInteger(value) && value >= 0) return encodeCborUnsigned(value);
  return encodeCborFloat64(value);
};

const encodeCborFloat64 = (value: number): Buffer => {
  const output = Buffer.allocUnsafe(9);
  output[0] = 0xfb;
  output.writeDoubleBE(value, 1);
  return output;
};

const encodeCborArray = (values: readonly Buffer[]): Buffer =>
  Buffer.concat([encodeCborLength(0x80, values.length), ...values]);

const encodeCborMap = (entries: readonly (readonly [Buffer, Buffer])[]): Buffer =>
  Buffer.concat([
    encodeCborLength(0xa0, entries.length),
    ...entries.flatMap(([key, value]) => [key, value]),
  ]);

const encodeSignals = (signals: CodexAttestationSignals): Buffer =>
  encodeCborMap([
    [encodeCborUnsigned(0), encodeCborUnsigned(signals.schemaVersion)],
    [
      encodeCborUnsigned(1),
      encodeCborArray(signals.preferredLanguages.map((language) => encodeCborString(language))),
    ],
    [encodeCborUnsigned(2), encodeCborString(signals.locale)],
    [encodeCborUnsigned(3), encodeCborString(signals.timezone)],
    [encodeCborUnsigned(4), encodeCborUnsigned(signals.screenSizeSum)],
    [encodeCborUnsigned(5), encodeCborNumber(signals.screenScale)],
    [encodeCborUnsigned(6), encodeCborString(signals.appSessionId)],
  ]);

export const encodeCodexAttestationToken = (input: {
  readonly bundleIdentifier: string;
  readonly tokenBase64?: string;
  readonly errorCode?: number;
  readonly signals?: CodexAttestationSignals;
  readonly latencyMs?: number;
}): string => {
  const entries: Array<readonly [Buffer, Buffer]> = [];
  if (input.tokenBase64 !== undefined) {
    entries.push([encodeCborString("token"), encodeCborString(input.tokenBase64)]);
  } else if (input.errorCode !== undefined) {
    entries.push([encodeCborString("error_code"), encodeCborUnsigned(input.errorCode)]);
  } else {
    throw new Error("Attestation token requires a device token or an error code");
  }
  entries.push([encodeCborString("bundle_id"), encodeCborString(input.bundleIdentifier)]);
  if (input.signals !== undefined) {
    const encodedSignals = encodeSignals(input.signals);
    entries.push([
      encodeCborString("f"),
      Buffer.concat([encodeCborLength(0x40, encodedSignals.length), encodedSignals]),
    ]);
  }
  if (input.latencyMs !== undefined) {
    entries.push([encodeCborString("t"), encodeCborFloat64(input.latencyMs)]);
  }
  return `v1.${encodeCborMap(entries).toString("base64url")}`;
};

const errorResponse = (
  options: CodexAttestationOptions,
  errorCode: number,
  signals?: CodexAttestationSignals,
  latencyMs?: number,
): { readonly token: string } => ({
  token: encodeCodexAttestationToken({
    bundleIdentifier: options.bundleIdentifier,
    errorCode,
    signals,
    latencyMs,
  }),
});

export const makeCodexAttestation = (
  options: CodexAttestationOptions,
): CodexAttestation["Service"] =>
  CodexAttestation.of({
    generate: Effect.promise(async () => {
      if (!supportsCodexAttestationRequests(options.platform)) {
        return errorResponse(
          options,
          DEVICE_ATTESTATION_ERROR.unsupportedPlatform,
          undefined,
          undefined,
        );
      }

      const signals = options.getSignals();
      if (options.platform !== "darwin") {
        return errorResponse(options, DEVICE_ATTESTATION_ERROR.unsupportedPlatform, signals);
      }
      if (options.architecture !== "arm64") {
        return errorResponse(options, DEVICE_ATTESTATION_ERROR.unsupportedArchitecture, signals);
      }

      let result: CodexDeviceCheckResult;
      try {
        if (!options.generateDeviceCheckToken) throw new Error("DeviceCheck bridge is unavailable");
        result = await options.generateDeviceCheckToken();
      } catch {
        return errorResponse(options, DEVICE_ATTESTATION_ERROR.generationFailed, signals);
      }

      if (!result.supported) {
        return errorResponse(
          options,
          DEVICE_ATTESTATION_ERROR.unsupportedDevice,
          signals,
          result.latencyMs,
        );
      }
      if (result.tokenBase64 === undefined) {
        return errorResponse(
          options,
          DEVICE_ATTESTATION_ERROR.generationFailed,
          signals,
          result.latencyMs,
        );
      }
      return {
        token: encodeCodexAttestationToken({
          bundleIdentifier: options.bundleIdentifier,
          tokenBase64: result.tokenBase64,
          signals,
          latencyMs: result.latencyMs,
        }),
      };
    }),
  });
