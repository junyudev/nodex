import { DEFAULT_CODEX_HOST_ID } from "../../../../shared/codex-host";
import { parseAssetSource } from "../../../../shared/assets";
import type {
  WorkbenchImageAssetLocator,
  WorkbenchImageEditorImageConfig,
  WorkbenchImageEditorSurfaceConfig,
} from "../../../../shared/workbench-image-editor";
import { uploadImageAsset } from "@/lib/assets";
import { isCodexImageAssetPointer } from "@/lib/codex-conversation-image-assets";
import {
  classifyImageAssetSource,
  dataUrlToBlob,
  fetchImageSourceAsDataUrl,
} from "./resolved-image-asset";
import type {
  EditableImageDescriptor,
  GeneratedImageDescriptor,
  NormalizedUserAttachmentImageEditorOptions,
} from "../model/types";

function imageLocatorCandidates(image: EditableImageDescriptor): readonly string[] {
  return [
    image.managedSource,
    image.localPath,
    typeof image.assetPointer === "string" ? image.assetPointer : undefined,
    image.attachmentSrc,
    image.downloadSrc,
    image.src,
  ].flatMap((source) => (source?.trim() ? [source.trim()] : []));
}

export function resolveWorkbenchImageAssetLocator(
  image: EditableImageDescriptor,
): WorkbenchImageAssetLocator | null {
  for (const source of imageLocatorCandidates(image)) {
    const classified = classifyImageAssetSource(source);
    if (classified.kind === "managed") {
      return {
        kind: "managed",
        source,
      };
    }
    if (classified.kind === "local" && classified.localPath) {
      return {
        kind: "local",
        hostId: image.hostId?.trim() || DEFAULT_CODEX_HOST_ID,
        path: classified.localPath,
      };
    }
    if (classified.kind === "pointer" && isCodexImageAssetPointer(source)) {
      return {
        kind: "pointer",
        pointer: source,
      };
    }
    if (classified.kind === "remote") {
      return {
        kind: "remote",
        url: source,
      };
    }
  }
  return null;
}

function toDurableImage(
  image: EditableImageDescriptor,
  locator: WorkbenchImageAssetLocator,
): WorkbenchImageEditorImageConfig {
  const generated = image.source === "generated" ? (image as GeneratedImageDescriptor) : null;
  return {
    id: image.id,
    alt: image.alt,
    source: image.source,
    locator,
    ...(image.attachmentId ? { attachmentId: image.attachmentId } : {}),
    ...(generated?.generatedOrdinal ? { generatedOrdinal: generated.generatedOrdinal } : {}),
    ...(generated?.groupId ? { groupId: generated.groupId } : {}),
    ...(image.height ? { height: image.height } : {}),
    ...(image.referrerPolicy === undefined ? {} : { referrerPolicy: image.referrerPolicy }),
    ...(image.tabTitle ? { tabTitle: image.tabTitle } : {}),
    ...(image.turnId ? { turnId: image.turnId } : {}),
    ...(image.turnStartedAtMs === undefined ? {} : { turnStartedAtMs: image.turnStartedAtMs }),
    ...(image.width ? { width: image.width } : {}),
  };
}

function buildConfig(
  options: NormalizedUserAttachmentImageEditorOptions,
  locators: readonly WorkbenchImageAssetLocator[],
): WorkbenchImageEditorSurfaceConfig | null {
  if (locators.length !== options.images.length) return null;
  const images = options.images.flatMap((image, index) => {
    const locator = locators[index];
    return locator ? [toDurableImage(image, locator)] : [];
  });
  if (images.length !== options.images.length) return null;
  return {
    availableImageCount: options.availableImageCount,
    readOnly: options.readOnly ?? false,
    composerTarget: options.composerTarget,
    entrypoint: options.entrypoint,
    imageSource: options.imageSource,
    images,
    initialImageId: options.initialImageId,
    initialPlaygroundTool: options.initialPlaygroundTool,
    initialView: options.initialView,
    projectId: options.projectId,
    threadId: options.threadId,
    tooltip: options.tooltip,
  };
}

export function createWorkbenchImageEditorSurfaceConfig(
  options: NormalizedUserAttachmentImageEditorOptions,
): WorkbenchImageEditorSurfaceConfig | null {
  const locators = options.images.flatMap((image) => {
    const locator = resolveWorkbenchImageAssetLocator(image);
    return locator ? [locator] : [];
  });
  return buildConfig(options, locators);
}

export interface DurableImageEditorMaterializationAdapters {
  readonly materialize: (image: EditableImageDescriptor) => Promise<`nodex://assets/${string}`>;
}

async function defaultMaterialize(
  image: EditableImageDescriptor,
): Promise<`nodex://assets/${string}`> {
  const source =
    image.dataUrl?.trim() ||
    image.previewSrc?.trim() ||
    image.attachmentSrc.trim() ||
    image.src.trim();
  const dataUrl = source.startsWith("data:image/")
    ? source
    : await fetchImageSourceAsDataUrl(source);
  const blob = dataUrlToBlob(dataUrl);
  const filename = image.alt.trim() || "image.png";
  const managedSource = await uploadImageAsset(
    new File([blob], filename, { type: blob.type || "image/png" }),
  );
  if (!parseAssetSource(managedSource)) {
    throw new Error("Image materialization returned an invalid locator");
  }
  return managedSource as `nodex://assets/${string}`;
}

/** Materializes only images that do not already have a stable locator. */
export async function materializeWorkbenchImageEditorSurfaceConfig(
  options: NormalizedUserAttachmentImageEditorOptions,
  adapters: DurableImageEditorMaterializationAdapters = {
    materialize: defaultMaterialize,
  },
): Promise<WorkbenchImageEditorSurfaceConfig | null> {
  const locators: WorkbenchImageAssetLocator[] = [];
  for (const image of options.images) {
    const existing = resolveWorkbenchImageAssetLocator(image);
    if (existing) {
      locators.push(existing);
      continue;
    }
    try {
      const managedSource = await adapters.materialize(image);
      if (!parseAssetSource(managedSource)) return null;
      locators.push({
        kind: "managed",
        source: managedSource,
      });
    } catch {
      return null;
    }
  }
  return buildConfig(options, locators);
}

function sourceFromLocator(locator: WorkbenchImageAssetLocator): string {
  switch (locator.kind) {
    case "managed":
      return locator.source;
    case "local":
      return locator.path;
    case "pointer":
      return locator.pointer;
    case "remote":
      return locator.url;
  }
}

function restoreImage(
  image: WorkbenchImageEditorImageConfig,
  index: number,
): EditableImageDescriptor | GeneratedImageDescriptor {
  const source = sourceFromLocator(image.locator);
  const common: EditableImageDescriptor = {
    id: image.id,
    alt: image.alt,
    source: image.source,
    src: source,
    attachmentSrc: source,
    downloadSrc: source,
    previewSrc: source,
    ...(image.attachmentId ? { attachmentId: image.attachmentId } : {}),
    ...(image.height ? { height: image.height } : {}),
    ...(image.referrerPolicy === undefined ? {} : { referrerPolicy: image.referrerPolicy }),
    ...(image.tabTitle ? { tabTitle: image.tabTitle } : {}),
    ...(image.turnId ? { turnId: image.turnId } : {}),
    ...(image.turnStartedAtMs === undefined ? {} : { turnStartedAtMs: image.turnStartedAtMs }),
    ...(image.width ? { width: image.width } : {}),
    ...(image.locator.kind === "managed" ? { managedSource: image.locator.source } : {}),
    ...(image.locator.kind === "local"
      ? {
          hostId: image.locator.hostId,
          localPath: image.locator.path,
        }
      : {}),
    ...(image.locator.kind === "pointer" ? { assetPointer: image.locator.pointer } : {}),
  };
  if (image.source !== "generated") return common;
  return {
    ...common,
    source: "generated",
    generatedOrdinal: image.generatedOrdinal ?? index + 1,
    groupId: image.groupId ?? "restored-generated-images",
    status: "ready",
  };
}

export function restoreNormalizedImageEditorOptions(
  config: WorkbenchImageEditorSurfaceConfig,
  title: string,
): NormalizedUserAttachmentImageEditorOptions {
  const images = config.images.map(restoreImage);
  const generatedImages =
    config.imageSource === "generated" ? (images as GeneratedImageDescriptor[]) : null;
  return {
    availableImageCount: config.availableImageCount,
    readOnly: config.readOnly ?? false,
    composerTarget: config.composerTarget,
    entrypoint: config.entrypoint,
    generatedImages,
    imageSource: config.imageSource,
    images,
    initialImageId: config.initialImageId,
    initialPlaygroundTool: config.initialPlaygroundTool,
    initialView: config.initialView,
    openInEditor: true,
    policy: "edit_button",
    projectId: config.projectId,
    referrerPolicy: images.find((image) => image.id === config.initialImageId)?.referrerPolicy,
    threadId: config.threadId,
    title,
    tooltip: config.tooltip,
  };
}
