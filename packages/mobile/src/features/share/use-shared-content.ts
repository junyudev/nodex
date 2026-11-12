import { StackActions } from "@react-navigation/native";
import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import * as Sharing from "expo-sharing";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import { navigationRef } from "../../navigation/types";
import { useHosts, type LocalImage } from "../../runtime";
import { showSnack } from "../../ui/snackbar";
import { composerDraftKey, useHomeState } from "../home/home-state";
import {
  appendSharedText,
  readSharedContent,
  type SharedImage,
  type SharedItem,
} from "./shared-content";

/** Takes what another app shared, once: a second look must not add it to a draft again. */
function takeSharedItems(): readonly SharedItem[] {
  try {
    const items = Sharing.getSharedPayloads();
    if (items.length > 0) Sharing.clearSharedPayloads();
    return items;
  } catch {
    // A build without share targets has nothing to read.
    return [];
  }
}

/**
 * Reads a shared picture's size and keeps a copy of its own, so the draft outlives the sharing
 * app's permission and the handover area does not fill up. Null when it is not a picture.
 */
async function importImage(image: SharedImage): Promise<LocalImage | null> {
  let size: { width: number; height: number };
  try {
    const loaded = await Image.loadAsync(image.uri);
    size = { width: loaded.width, height: loaded.height };
    loaded.release();
  } catch {
    return null;
  }
  let uri = image.uri;
  try {
    const directory = new Directory(Paths.cache, "nodex-mobile-shared");
    directory.create({ idempotent: true, intermediates: true });
    const extension = /\.[a-z0-9]{1,10}$/iu.exec(image.name)?.[0] ?? "";
    const copy = new File(directory, `${randomUUID()}${extension}`);
    const source = new File(image.uri);
    source.copySync(copy);
    uri = copy.uri;
    // On iPhone the original is a file the share extension left for this app alone.
    if (Platform.OS === "ios") source.delete();
  } catch {
    /* The original stays readable while the app runs, which is as long as a draft lives. */
  }
  return { ...image, ...size, uri };
}

async function addToInboxDraft(hostId: string, items: readonly SharedItem[]) {
  const shared = readSharedContent(items);
  const imported = await Promise.all(shared.images.map(importImage));
  const images = imported.filter((image) => image !== null);
  const left = shared.unsupported + imported.length - images.length;
  if (shared.text || images.length > 0) {
    const state = useHomeState.getState();
    const key = composerDraftKey(hostId, "inbox");
    const draft = state.drafts[key];
    state.setDraft(key, {
      text: appendSharedText(draft?.text ?? "", shared.text),
      images: [...(draft?.images ?? []), ...images],
    });
    // The Inbox Composer is where a capture is written; a reply in progress would hide it.
    state.setReplyTo(null);
    state.setMode("inbox");
    if (navigationRef.isReady() && navigationRef.canGoBack())
      navigationRef.dispatch(StackActions.popToTop());
  }
  if (left > 0)
    showSnack({
      text:
        left === items.length
          ? "Nodex can add text, links and photos to the Inbox."
          : "Some of what you shared was left out. The Inbox takes text, links and photos.",
    });
}

/**
 * What another app shares with Nodex lands in the current Space's Inbox Composer, to be sent like
 * anything written there. Sharing may be what launched the app, and nothing is taken before a
 * Space is linked, so it waits for one rather than being dropped.
 */
export const useSharedContent = (ready: boolean) => {
  const { activeHostId } = useHosts();
  useEffect(() => {
    if (!ready || !activeHostId) return undefined;
    const take = () => {
      const items = takeSharedItems();
      if (items.length > 0) void addToInboxDraft(activeHostId, items);
    };
    take();
    // Sharing brings the app forward, whether or not it was already running.
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") take();
    });
    return () => subscription.remove();
  }, [activeHostId, ready]);
};
