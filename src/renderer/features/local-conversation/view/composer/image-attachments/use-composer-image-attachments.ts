import { useEffect, useRef } from "react";
import type { ComposerPickedFile } from "../../../../../../shared/ipc-api";
import { DEFAULT_CODEX_HOST_ID } from "../../../../../../shared/codex-host";
import { uploadImageAsset } from "@/lib/assets";
import { resolveComposerImageMimeType } from "../../../../../../shared/composer-image-input";
import { isSupportedComposerImageFile } from "./composer-image-data-transfer";
import {
  createResolvedComposerImageAttachment,
  type ComposerImageAttachment,
  type ComposerImageAttachmentMaterialization,
  type ResolvedComposerImageInput,
} from "./composer-image-attachment-model";

type SetComposerImageAttachments = (
  update: (current: readonly ComposerImageAttachment[]) => readonly ComposerImageAttachment[],
) => void;

export const COMPOSER_IMAGE_INPUT_UNSUPPORTED_MESSAGE =
  "This model does not support image inputs. Try a different model.";

export interface ComposerImageAttachmentAdapters {
  readonly createId: () => string;
  readonly readFileAsDataUrl: (file: File) => Promise<string>;
  readonly materializeFile: (
    file: File,
    origin: "paste" | "drop",
  ) => Promise<ComposerImageAttachmentMaterialization>;
}

export interface ComposerImageAttachmentController {
  addFiles(files: readonly File[], origin: "paste" | "drop"): Promise<void>;
  addPickedFiles(files: readonly ComposerPickedFile[]): void;
  addResolvedImages(images: readonly ResolvedComposerImageInput[]): void;
  syncResolvedImages(
    origin: Extract<ResolvedComposerImageInput["origin"], "image-editor">,
    images: readonly ResolvedComposerImageInput[],
  ): void;
  remove(id: string): void;
  clear(): void;
}

export function readComposerImageFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const mimeType = resolveComposerImageMimeType({
      filename: file.name,
      mimeType: file.type,
    });
    if (!mimeType) {
      reject(new Error("Image type is unsupported"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.onload = () => {
      if (typeof reader.result === "string" && reader.result.startsWith("data:")) {
        resolve(reader.result.replace(/^data:[^;,]*/u, `data:${mimeType}`));
        return;
      }
      reject(new Error("Image reader returned an invalid result"));
    };
    reader.readAsDataURL(file);
  });
}

async function materializeFile(
  file: File,
  origin: "paste" | "drop",
): Promise<ComposerImageAttachmentMaterialization> {
  if (origin === "drop") {
    const droppedPath = window.api?.getPathForFile?.(file).trim() ?? "";
    if (droppedPath) {
      return {
        hostId: DEFAULT_CODEX_HOST_ID,
        managedSource: null,
        localPath: droppedPath,
      };
    }
  }

  const managedSource = await uploadImageAsset(file);
  const localPath = window.api?.resolveManagedAssetPath?.(managedSource)?.trim() ?? "";
  if (!localPath) throw new Error("Image was saved but its local path is unavailable");
  return { hostId: DEFAULT_CODEX_HOST_ID, managedSource, localPath };
}

const DEFAULT_ADAPTERS: ComposerImageAttachmentAdapters = {
  createId: () => `image_${crypto.randomUUID()}`,
  readFileAsDataUrl: readComposerImageFileAsDataUrl,
  materializeFile,
};

function getPickedFilename(file: ComposerPickedFile): string {
  return file.label.trim() || file.path.split(/[\\/]/u).filter(Boolean).at(-1) || "Image";
}

function inferPickedMimeType(file: ComposerPickedFile): string {
  if (file.mimeType?.trim()) return file.mimeType;
  const dataMime = file.imageDataUrl?.match(/^data:([^;,]+)/iu)?.[1];
  return dataMime ?? "image/png";
}

function resolveFileAttachmentName(file: File, id: string, origin: "paste" | "drop"): string {
  const filename = file.name.trim();
  if (filename) return filename;
  const mimeType =
    resolveComposerImageMimeType({
      filename,
      mimeType: file.type,
    }) ?? "image/png";
  const extension =
    mimeType === "image/jpeg" || mimeType === "image/jpg"
      ? "jpg"
      : mimeType === "image/x-png"
        ? "png"
        : mimeType.slice("image/".length);
  const idSuffix =
    id
      .replace(/^image[_-]?/iu, "")
      .replace(/[^a-z0-9]/giu, "")
      .slice(0, 8) || "image";
  return `${origin === "paste" ? "pasted-image" : "image"}-${idSuffix}.${extension}`;
}

export function useComposerImageAttachments(input: {
  readonly attachments: readonly ComposerImageAttachment[];
  readonly setAttachments: SetComposerImageAttachments;
  readonly scopeKey?: string;
  readonly enabled: boolean;
  readonly onError: (message: string) => void;
  readonly onRemove?: (id: string) => void;
  readonly adapters?: Partial<ComposerImageAttachmentAdapters>;
}): ComposerImageAttachmentController {
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const latestRef = useRef(input);
  latestRef.current = input;
  const adaptersRef = useRef<ComposerImageAttachmentAdapters>({
    ...DEFAULT_ADAPTERS,
    ...input.adapters,
  });
  adaptersRef.current = { ...DEFAULT_ADAPTERS, ...input.adapters };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);
  useEffect(() => {
    generationRef.current += 1;
  }, [input.scopeKey]);

  const isCurrent = (generation: number, scopeKey: string | undefined): boolean =>
    mountedRef.current &&
    generationRef.current === generation &&
    latestRef.current.scopeKey === scopeKey;

  const patchMaterialization = (
    id: string,
    generation: number,
    scopeKey: string | undefined,
    result: ComposerImageAttachmentMaterialization | null,
  ) => {
    if (!isCurrent(generation, scopeKey)) return;
    latestRef.current.setAttachments((current) =>
      current.map((attachment) => {
        if (attachment.id !== id || attachment.generation !== generation) return attachment;
        return {
          ...attachment,
          materialization: result,
          materializationStatus: result ? "ready" : "failed",
        };
      }),
    );
  };

  const addFiles = async (files: readonly File[], origin: "paste" | "drop"): Promise<void> => {
    const supportedFiles = files.filter(isSupportedComposerImageFile);
    if (supportedFiles.length === 0) return;
    if (!latestRef.current.enabled) {
      latestRef.current.onError(COMPOSER_IMAGE_INPUT_UNSUPPORTED_MESSAGE);
      return;
    }

    const generation = generationRef.current;
    const scopeKey = latestRef.current.scopeKey;
    const operations = supportedFiles.map((file) => {
      const id = adaptersRef.current.createId();
      const filename = resolveFileAttachmentName(file, id, origin);
      const mimeType =
        resolveComposerImageMimeType({
          filename,
          mimeType: file.type,
        }) ?? "image/png";
      let materialization: ComposerImageAttachmentMaterialization | null = null;
      let materializationStatus: ComposerImageAttachment["materializationStatus"] = "pending";
      const materializationPromise = adaptersRef.current
        .materializeFile(file, origin)
        .then((result) => {
          materialization = result;
          materializationStatus = "ready";
          patchMaterialization(id, generation, scopeKey, result);
        })
        .catch(() => {
          materializationStatus = "failed";
          patchMaterialization(id, generation, scopeKey, null);
        });
      const readPromise = adaptersRef.current
        .readFileAsDataUrl(file)
        .then((src) => ({ filename, id, mimeType, src }))
        .catch((error: unknown) => {
          latestRef.current.onError(
            error instanceof Error ? error.message : `Could not read ${filename}`,
          );
          return null;
        });
      return {
        readPromise,
        materializationPromise,
        readMaterialization: () => ({ materialization, materializationStatus }),
      };
    });

    const readResults = await Promise.all(operations.map((operation) => operation.readPromise));
    if (isCurrent(generation, scopeKey)) {
      const next = readResults.flatMap((result, index): ComposerImageAttachment[] => {
        if (!result) return [];
        const state = operations[index]?.readMaterialization();
        return [
          {
            id: result.id,
            filename: result.filename,
            mimeType: result.mimeType,
            src: result.src,
            origin,
            materialization: state?.materialization ?? null,
            materializationStatus: state?.materializationStatus ?? "pending",
            uploadStatus: "idle",
            generation,
          },
        ];
      });
      if (next.length > 0) {
        latestRef.current.setAttachments((current) => [...current, ...next]);
      }
    }

    await Promise.all(operations.map((operation) => operation.materializationPromise));
  };

  const addResolvedImages = (images: readonly ResolvedComposerImageInput[]) => {
    if (images.length === 0) return;
    if (!latestRef.current.enabled) {
      latestRef.current.onError(COMPOSER_IMAGE_INPUT_UNSUPPORTED_MESSAGE);
      return;
    }
    const generation = generationRef.current;
    const next = images.flatMap((value): ComposerImageAttachment[] => {
      const attachment = createResolvedComposerImageAttachment({
        value,
        id: adaptersRef.current.createId(),
        generation,
      });
      return attachment ? [attachment] : [];
    });
    latestRef.current.setAttachments((current) => {
      const byId = new Map(current.map((attachment) => [attachment.id, attachment]));
      for (const attachment of next) byId.set(attachment.id, attachment);
      return [...byId.values()];
    });
  };

  const addPickedFiles = (files: readonly ComposerPickedFile[]) => {
    const images = files.flatMap((file): ResolvedComposerImageInput[] => {
      if (!file.imageDataUrl) return [];
      return [
        {
          filename: getPickedFilename(file),
          mimeType: inferPickedMimeType(file),
          src: file.imageDataUrl,
          origin: "picker",
          localPath: file.path,
          hostId: DEFAULT_CODEX_HOST_ID,
        },
      ];
    });
    addResolvedImages(images);
  };

  const syncResolvedImages = (
    origin: "image-editor",
    images: readonly ResolvedComposerImageInput[],
  ) => {
    if (images.length > 0 && !latestRef.current.enabled) {
      latestRef.current.onError(COMPOSER_IMAGE_INPUT_UNSUPPORTED_MESSAGE);
      return;
    }
    const generation = generationRef.current;
    const next = images.flatMap((value): ComposerImageAttachment[] => {
      const attachment = createResolvedComposerImageAttachment({
        value: { ...value, origin },
        id: adaptersRef.current.createId(),
        generation,
      });
      return attachment ? [attachment] : [];
    });
    latestRef.current.setAttachments((current) => [
      ...current.filter((attachment) => attachment.origin !== origin),
      ...next.filter(
        (attachment) =>
          !current.some((existing) => existing.origin !== origin && existing.id === attachment.id),
      ),
    ]);
  };

  const implementationRef = useRef({
    addFiles,
    addPickedFiles,
    addResolvedImages,
    syncResolvedImages,
    remove: (id: string) => {
      latestRef.current.setAttachments((current) =>
        current.filter((attachment) => attachment.id !== id),
      );
      latestRef.current.onRemove?.(id);
    },
    clear: () => {
      generationRef.current += 1;
      latestRef.current.setAttachments(() => []);
    },
  });
  implementationRef.current = {
    addFiles,
    addPickedFiles,
    addResolvedImages,
    syncResolvedImages,
    remove: implementationRef.current.remove,
    clear: implementationRef.current.clear,
  };
  const controllerRef = useRef<ComposerImageAttachmentController | null>(null);
  controllerRef.current ??= {
    addFiles: (...args) => implementationRef.current.addFiles(...args),
    addPickedFiles: (...args) => implementationRef.current.addPickedFiles(...args),
    addResolvedImages: (...args) => implementationRef.current.addResolvedImages(...args),
    syncResolvedImages: (...args) => implementationRef.current.syncResolvedImages(...args),
    remove: (...args) => implementationRef.current.remove(...args),
    clear: () => implementationRef.current.clear(),
  };
  return controllerRef.current;
}
