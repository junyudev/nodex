import type { RelayDeviceRequest } from "@nodex/mobile-protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export type LocalImage = {
  uri: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
};

export interface MobileSocketEvents {
  open(): void;
  frame(bytes: Uint8Array): void;
  closed(code: number): void;
  failed(): void;
}

export interface MobileSocket {
  listen(events: MobileSocketEvents): () => void;
  send(bytes: Uint8Array): void;
  close(): void;
}

export type PushPermission = "granted" | "denied" | "undetermined";

/** The system's notifications, on a phone that can receive them from a desktop. */
export interface MobilePush {
  bundleId: string;
  permission(): Promise<PushPermission>;
  requestPermission(): Promise<PushPermission>;
  /** Where the system delivers to this phone; null where it cannot, such as a simulator. */
  address(): Promise<{ token: string; environment: "sandbox" | "production" } | null>;
  /** The key that opens notifications, kept where the phone's notification extension can read it. */
  readKey(): string | null;
  writeKey(key: string): Promise<void>;
  /** Exchanges an address for the relay's opaque handle. */
  registerAddress(request: RelayDeviceRequest): Promise<string>;
  /** The chats behind notifications still in Notification Center, with the desktop that sent each. */
  delivered(): Promise<readonly DeliveredChat[]>;
  /** Takes one chat's notifications out of Notification Center. */
  clearDelivered(sessionId: string): Promise<void>;
}

export interface DeliveredChat {
  readonly sessionId: string;
  readonly hostId: string | null;
}

export interface MobilePlatform {
  deviceName: string;
  platform: "ios" | "android";
  appVersion: string;
  storage: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  secrets: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
  files: {
    uri(area: "documents" | "cache", name: string): string;
    copy(source: string, destination: string): void;
    remove(uri: string): void;
    size(uri: string): number | null;
    read(uri: string, offset: number, length: number): Promise<Uint8Array>;
    append(uri: string, bytes: Uint8Array): Promise<void>;
  };
  /** Returns an app-owned temporary image, or the original URI if no copy was needed. */
  compressImage(image: LocalImage, longestSide: number, quality: number): Promise<LocalImage>;
  randomBytes(length: number): Uint8Array;
  push: MobilePush | null;
  now(): number;
  schedule(callback: () => void, milliseconds: number): () => void;
  socket(route: string): MobileSocket;
  isForeground(): boolean;
  onForegroundChange(callback: (foreground: boolean) => void): () => void;
}

export class PlatformFailure extends Data.TaggedError("PlatformFailure")<{
  readonly cause: unknown;
}> {}

/** Converts native Promises and foreground callbacks once, at the capability boundary. */
export function adaptPlatform(platform: MobilePlatform) {
  const promise = <T>(run: () => Promise<T>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new PlatformFailure({ cause }),
    });
  return {
    ...platform,
    socket: (route: string) => platform.socket(route),
    // Native handles close when the operation settles, so interruption must await that release.
    readFile: (uri: string, offset: number, length: number) =>
      promise(() => platform.files.read(uri, offset, length)).pipe(Effect.uninterruptible),
    appendFile: (uri: string, bytes: Uint8Array) =>
      promise(() => platform.files.append(uri, bytes)).pipe(Effect.uninterruptible),
    compress: (image: LocalImage) => promise(() => platform.compressImage(image, 2560, 0.8)),
    foregroundChanges: Stream.callback<boolean>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            platform.onForegroundChange((value) => {
              Queue.offerUnsafe(queue, value);
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      { bufferSize: 1, strategy: "sliding" },
    ),
  };
}

export class Platform extends Context.Service<Platform, ReturnType<typeof adaptPlatform>>()(
  "nodex/mobile/Platform",
) {}

/** Effect owns every sleep; this Adapter makes the native scheduler replaceable in tests. */
export function platformClock(platform: MobilePlatform): Clock.Clock {
  const nanos = () => BigInt(Math.trunc(platform.now())) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: platform.now,
    currentTimeMillis: Effect.sync(platform.now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) => {
      const milliseconds = Duration.toMillis(duration);
      if (milliseconds <= 0) return Effect.yieldNow;
      if (!Number.isFinite(milliseconds)) return Effect.never;
      return Effect.callback((resume) => {
        const cancel = platform.schedule(() => resume(Effect.void), milliseconds);
        return Effect.sync(cancel);
      });
    },
  };
}
