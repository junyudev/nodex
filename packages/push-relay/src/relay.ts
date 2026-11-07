import { createApnsClient, type ApnsResponse } from "./apns.js";
import { createHandles } from "./handles.js";
import {
  allowedBundle,
  MAX_APNS_BYTES,
  MAX_BODY_BYTES,
  pushBody,
  validateDevice,
  validatePush,
} from "./validation.js";

const json = (status: number, body: object): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(status === 429 || status === 503 ? { "retry-after": "60" } : {}),
    },
  });

const mapApns = ({ status, reason }: ApnsResponse): Response => {
  if (status === 200) return json(200, { ok: true });
  if (
    status === 410 ||
    (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"))
  ) {
    return json(410, { gone: true });
  }
  if (status === 429) return json(429, { reason: reason ?? "ApnsThrottled" });
  if (status >= 500) return json(503, { reason: reason ?? "ApnsUnavailable" });
  return json(status >= 400 && status < 500 ? status : 400, { reason: reason ?? "ApnsRejected" });
};

export const createRelay = (
  env: Readonly<Record<string, string | undefined>>,
  options: Parameters<typeof createApnsClient>[1] & {
    readonly log?: (entry: ApnsResponse) => void;
  } = {},
) => {
  const handles = createHandles(env.PUSH_RELAY_SEAL_KEY ?? "");
  let apns: ReturnType<typeof createApnsClient> | undefined;
  const getApns = () =>
    (apns ??= createApnsClient(
      {
        privateKey: env.APNS_KEY_P8 ?? "",
        keyId: env.APNS_KEY_ID ?? "",
        teamId: env.APNS_TEAM_ID ?? "",
      },
      options,
    ));
  const log = options.log ?? ((entry: ApnsResponse) => console.info(entry));
  return {
    devices(value: unknown): Response {
      const device = validateDevice(value);
      if (!device) return json(400, { reason: "InvalidDevice" });
      if (!allowedBundle(device.bundleId)) return json(400, { reason: "BundleNotAllowed" });
      return json(200, { handle: handles.seal(device) });
    },
    async push(value: unknown): Promise<Response> {
      const push = validatePush(value);
      if (!push) return json(400, { reason: "InvalidPush" });
      const device = handles.open(push.handle);
      if (!device) return json(400, { reason: "InvalidHandle" });
      const body = pushBody(push);
      if (Buffer.byteLength(body) > MAX_APNS_BYTES) return json(413, { reason: "PayloadTooLarge" });
      const send = getApns();
      let response: ApnsResponse;
      try {
        response = await send(device, body);
      } catch {
        log({ status: 503, reason: null });
        return json(503, { reason: "ApnsTransportFailure" });
      }
      log(response);
      return mapApns(response);
    },
  };
};

class BodyError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

// Read the original stream, never Vercel's parsed body helper, to bound raw bytes.
const readBody = async (request: Request): Promise<unknown> => {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    await request.body?.cancel();
    throw new BodyError(413, "BodyTooLarge");
  }
  if (!request.body) throw new BodyError(400, "InvalidJson");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new BodyError(413, "BodyTooLarge");
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof BodyError) throw error;
    throw new BodyError(400, "InvalidJson");
  } finally {
    reader.releaseLock();
  }
};

export const createHandler =
  (endpoint: "devices" | "push", relay: () => ReturnType<typeof createRelay>) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      const response = json(405, { reason: "MethodNotAllowed" });
      response.headers.set("allow", "POST");
      return response;
    }
    try {
      const value = await readBody(request);
      return await relay()[endpoint](value);
    } catch (error) {
      if (error instanceof BodyError) return json(error.status, { reason: error.reason });
      return json(503, { reason: "RelayUnavailable" });
    }
  };
