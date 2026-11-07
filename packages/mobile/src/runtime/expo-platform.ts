import { PUSH_RELAY_ORIGIN, type RelayDeviceRequest } from "@nodex/mobile-protocol";
import {
  ApplicationReleaseType,
  applicationId,
  getIosApplicationReleaseTypeAsync,
  getIosPushNotificationServiceEnvironmentAsync,
  nativeApplicationVersion,
} from "expo-application";
import Constants from "expo-constants";
import { getRandomValues } from "expo-crypto";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import Storage from "expo-sqlite/kv-store";
import { AppState, Platform } from "react-native";
import type { MobilePlatform, MobilePush, MobileSocket, PushPermission } from "./platform";

function openSocket(route: string): MobileSocket {
  const socket = new WebSocket(route);
  socket.binaryType = "arraybuffer";
  return {
    send: (bytes) => socket.send(bytes),
    close: () => socket.close(),
    listen(events) {
      const message = ({ data }: MessageEvent) => {
        if (data instanceof ArrayBuffer) events.frame(new Uint8Array(data));
        else events.failed();
      };
      const close = ({ code }: CloseEvent) => events.closed(code);
      socket.addEventListener("open", events.open);
      socket.addEventListener("message", message);
      socket.addEventListener("close", close);
      socket.addEventListener("error", events.failed);
      return () => {
        socket.removeEventListener("open", events.open);
        socket.removeEventListener("message", message);
        socket.removeEventListener("close", close);
        socket.removeEventListener("error", events.failed);
      };
    },
  };
}

const permissionOf = ({ status }: { readonly status: string }): PushPermission =>
  status === "granted" || status === "denied" ? status : "undetermined";

const registerAddress = async (request: RelayDeviceRequest): Promise<string> => {
  const response = await fetch(`${PUSH_RELAY_ORIGIN}/v1/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`The relay answered ${response.status}.`);
  const { handle } = (await response.json()) as { readonly handle?: unknown };
  if (typeof handle !== "string") throw new Error("The relay gave no handle.");
  return handle;
};

const clearDelivered = async (sessionId: string): Promise<void> => {
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter(({ request }) => {
        const { trigger } = request;
        return trigger && "payload" in trigger && trigger.payload?.sessionId === sessionId;
      })
      .map(({ request }) => Notifications.dismissNotificationAsync(request.identifier)),
  );
};

/**
 * Which of Apple's services delivers to this build, or null on a simulator. TestFlight and App Store
 * builds have no provisioning profile to read, and they always use production.
 */
const pushEnvironment = async (): Promise<"sandbox" | "production" | null> => {
  const release = await getIosApplicationReleaseTypeAsync();
  if (release === ApplicationReleaseType.SIMULATOR) return null;
  if (release === ApplicationReleaseType.APP_STORE) return "production";
  return (await getIosPushNotificationServiceEnvironmentAsync()) === "development"
    ? "sandbox"
    : "production";
};

const makePush = (): MobilePush | null => {
  const group: unknown = Constants.expoConfig?.extra?.pushKeychainGroup;
  if (Platform.OS !== "ios" || typeof group !== "string" || !applicationId) return null;
  // The Notification Service Extension reads exactly this item, even while the phone is locked.
  const keychain = {
    keychainService: "nodex-push",
    accessGroup: group,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  };
  return {
    bundleId: applicationId,
    permission: () => Notifications.getPermissionsAsync().then(permissionOf),
    requestPermission: () =>
      Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      }).then(permissionOf),
    address: async () => {
      const environment = await pushEnvironment();
      if (!environment) return null;
      const { data } = await Notifications.getDevicePushTokenAsync();
      return { token: String(data), environment };
    },
    readKey: () => SecureStore.getItem("push-key", keychain),
    writeKey: (key) => SecureStore.setItemAsync("push-key", key, keychain),
    registerAddress,
    clearDelivered,
  };
};

export const mobilePlatform: MobilePlatform = {
  deviceName: Platform.OS === "ios" ? "iPhone" : "Android phone",
  push: makePush(),
  platform: Platform.OS === "ios" ? "ios" : "android",
  appVersion: nativeApplicationVersion ?? "unknown",
  storage: {
    get: (key) => Storage.getItemSync(key),
    set: (key, value) => Storage.setItemSync(key, value),
    remove: (key) => {
      Storage.removeItemSync(key);
    },
  },
  secrets: {
    get: (key) => SecureStore.getItem(key),
    set: (key, value) =>
      SecureStore.setItem(key, value, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      }),
  },
  files: {
    uri(area, name) {
      const directory = new Directory(
        area === "documents" ? Paths.document : Paths.cache,
        "nodex-mobile",
      );
      directory.create({ idempotent: true, intermediates: true });
      return new File(directory, name).uri;
    },
    copy: (source, destination) => new File(source).copySync(new File(destination)),
    remove(uri) {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
    size(uri) {
      const file = new File(uri);
      return file.exists ? file.size : null;
    },
    async read(uri, offset, length) {
      const handle = new File(uri).open(FileMode.ReadOnly);
      try {
        handle.offset = offset;
        return await handle.readBytes(length);
      } finally {
        handle.close();
      }
    },
    async append(uri, bytes) {
      const file = new File(uri);
      if (!file.exists) file.create();
      const handle = file.open(FileMode.Append);
      try {
        await handle.writeBytes(bytes);
      } finally {
        handle.close();
      }
    },
  },
  async compressImage(image, longestSide, quality) {
    const context = ImageManipulator.manipulate(image.uri);
    try {
      if (Math.max(image.width, image.height) > longestSide) {
        context.resize(
          image.width >= image.height ? { width: longestSide } : { height: longestSide },
        );
      }
      const result = await context.renderAsync();
      try {
        const { uri, width, height } = await result.saveAsync({
          format: SaveFormat.JPEG,
          compress: quality,
        });
        return {
          uri,
          width,
          height,
          name: `${image.name.replace(/\.[^./]+$/u, "")}.jpg`,
          mimeType: "image/jpeg",
        };
      } finally {
        result.release();
      }
    } finally {
      context.release();
    }
  },
  randomBytes: (length) => getRandomValues(new Uint8Array(length)),
  now: () => Date.now(),
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
  socket: openSocket,
  // `inactive` is a system dialog or a passing gesture over a running app, not leaving it.
  isForeground: () => AppState.currentState !== "background",
  onForegroundChange(callback) {
    const listener = AppState.addEventListener("change", (state) =>
      callback(state !== "background"),
    );
    return () => listener.remove();
  },
};
