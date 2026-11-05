import { nativeApplicationVersion } from "expo-application";
import { getRandomValues } from "expo-crypto";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as SecureStore from "expo-secure-store";
import Storage from "expo-sqlite/kv-store";
import { AppState, Platform } from "react-native";
import type { MobilePlatform, MobileSocket } from "./platform";

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

export const mobilePlatform: MobilePlatform = {
  deviceName: Platform.OS === "ios" ? "iPhone" : "Android phone",
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
