import { z } from "zod";
import { parseAssetSource } from "../assets";
import type {
  WorkbenchImageAssetLocator,
  WorkbenchImageEditorSurfaceConfig,
} from "../workbench-image-editor";

const idSchema = z.string().trim().min(1).max(4_096);
const textSchema = z.string().max(2_000);

export const WorkbenchImageAssetLocatorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("managed"),
      source: z
        .string()
        .trim()
        .min(1)
        .max(16_384)
        .refine(
          (source) => parseAssetSource(source) !== null,
          "Managed image locator must use nodex://assets/",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("local"),
      hostId: idSchema,
      path: z
        .string()
        .trim()
        .min(1)
        .max(32_768)
        .refine(
          (path) =>
            path.startsWith("/") ||
            /^[a-zA-Z]:[\\/]/u.test(path) ||
            /^\\\\[^\\]+\\[^\\]+/u.test(path),
          "Local image locator must use an absolute path",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pointer"),
      pointer: z
        .string()
        .trim()
        .min(1)
        .max(32_768)
        .refine(
          (pointer) => /^(?:file-service|sediment):\/\//u.test(pointer),
          "Image pointer locator is invalid",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote"),
      url: z
        .url()
        .max(32_768)
        .refine((url) => /^https?:\/\//iu.test(url), "Remote image locator must use HTTP(S)"),
    })
    .strict(),
]) satisfies z.ZodType<WorkbenchImageAssetLocator>;

const WorkbenchImageEditorImageConfigSchema = z
  .object({
    id: idSchema,
    alt: textSchema,
    source: z.enum(["uploaded", "generated"]),
    locator: WorkbenchImageAssetLocatorSchema,
    attachmentId: idSchema.optional(),
    generatedOrdinal: z.number().int().positive().optional(),
    groupId: idSchema.optional(),
    height: z.number().finite().positive().optional(),
    referrerPolicy: z
      .enum([
        "",
        "no-referrer",
        "no-referrer-when-downgrade",
        "origin",
        "origin-when-cross-origin",
        "same-origin",
        "strict-origin",
        "strict-origin-when-cross-origin",
        "unsafe-url",
      ])
      .optional(),
    tabTitle: textSchema.optional(),
    turnId: idSchema.optional(),
    turnStartedAtMs: z.number().finite().nonnegative().optional(),
    width: z.number().finite().positive().optional(),
  })
  .strict();

export const WorkbenchImageEditorSurfaceConfigSchema = z
  .object({
    readOnly: z.boolean().optional(),
    availableImageCount: z.number().int().positive().max(10_000),
    composerTarget: z
      .object({
        channelId: idSchema,
        placement: z.enum(["root", "side"]),
      })
      .strict()
      .nullable(),
    entrypoint: z.enum([
      "canvas_button",
      "gallery_edit_button",
      "image_click",
      "lightbox_edit_button",
      "view_toggle",
    ]),
    imageSource: z.enum(["uploaded", "generated"]),
    images: z.array(WorkbenchImageEditorImageConfigSchema).min(1).max(10_000),
    initialImageId: idSchema,
    initialPlaygroundTool: z.enum(["navigate", "comment", "select"]),
    initialView: z.enum(["single", "playground"]),
    projectId: idSchema.nullable(),
    threadId: idSchema.nullable(),
    tooltip: textSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (!config.images.some((image) => image.id === config.initialImageId)) {
      context.addIssue({
        code: "custom",
        path: ["initialImageId"],
        message: "Initial image must exist in the durable image collection",
      });
    }
    if (
      config.imageSource === "generated" &&
      config.images.some((image) => image.source !== "generated")
    ) {
      context.addIssue({
        code: "custom",
        path: ["images"],
        message: "Generated image editor collections cannot contain uploaded images",
      });
    }
  }) satisfies z.ZodType<WorkbenchImageEditorSurfaceConfig>;
