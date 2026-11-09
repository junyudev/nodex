import { PUSH_RELAY_ORIGIN, type RelayDeviceRequest } from "@nodex/mobile-protocol";
import { requireNativeModule } from "expo";
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
import { subjectOfNotificationRequest } from "./notification-payload";
import { makePinnedTls, type NativePinnedTls, type TlsEvent } from "./pinned-tls";
import type { DeliveredNotification, MobilePlatform, MobilePush, PushPermission } from "./platform";

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

const delivered = async (): Promise<readonly DeliveredNotification[]> =>
  (await Notifications.getPresentedNotificationsAsync()).flatMap(({ request }) => {
    const subject = subjectOfNotificationRequest(request);
    return subject ? [{ ...subject, id: request.identifier }] : [];
  });

const dismiss = async (ids: readonly string[]): Promise<void> => {
  await Promise.all(ids.map((id) => Notifications.dismissNotificationAsync(id)));
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
    delivered,
    dismiss,
  };
};

const platform: Omit<MobilePlatform, "pinnedTls"> = {
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
  // `inactive` is a system dialog or a passing gesture over a running app, not leaving it.
  isForeground: () => AppState.currentState !== "background",
  onForegroundChange(callback) {
    const listener = AppState.addEventListener("change", (state) =>
      callback(state !== "background"),
    );
    return () => listener.remove();
  },
};

// Exact leaf pinning is the only network capability used by enrollment and content.
const nativeTls = requireNativeModule<
  NativePinnedTls & {
    addListener(
      name: "event",
      callback: (event: TlsEvent & { id: string }) => void,
    ): { remove(): void };
  }
>("NodexPinnedTls");
export const pinnedTls = makePinnedTls({
  startRequest: (id, options) => nativeTls.startRequest(id, options),
  openSocket: (id, options) => nativeTls.openSocket(id, options),
  send: (id, body, binary) => nativeTls.send(id, body, binary),
  cancel: (id) => nativeTls.cancel(id),
  listen(id, callback) {
    const listener = nativeTls.addListener("event", (event) => {
      if (event.id === id) callback(event);
    });
    return () => listener.remove();
  },
});

export const mobilePlatform: MobilePlatform = { ...platform, pinnedTls };
