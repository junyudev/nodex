import { z } from "zod";

export const VISUALIZATION_ANNOTATION_TOOL = "__codex_visualization_annotations__";
const id = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => !/\p{Surrogate}/u.test(value));
const safeText = z
  .string()
  .max(512)
  .refine(
    (value) =>
      !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value),
  );
const label = safeText.trim().min(1).max(80);
const value = z.union([z.number().finite(), z.string(), z.boolean()]);
const base = {
  callback: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  label,
  reference: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9_./:@$#-]+$/)
    .optional(),
};
const number = z.number().finite().min(-10_000).max(10_000);
const color = z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i);
export const VisualizationAnnotationControlSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("range"),
      currentValue: number.optional(),
      defaultValue: number.optional(),
      min: number,
      max: number,
      step: z.number().min(0.001).max(10_000),
    })
    .refine(
      (control) =>
        control.min < control.max &&
        control.step <= control.max - control.min &&
        (control.currentValue === undefined ||
          (control.currentValue >= control.min && control.currentValue <= control.max)) &&
        (control.defaultValue === undefined ||
          (control.defaultValue >= control.min && control.defaultValue <= control.max)),
    ),
  z.object({
    ...base,
    type: z.literal("color"),
    currentValue: color.optional(),
    defaultValue: color.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("toggle"),
    currentValue: z.boolean().optional(),
    defaultValue: z.boolean().optional(),
  }),
  z
    .object({
      ...base,
      type: z.literal("select"),
      currentValue: safeText.optional(),
      defaultValue: safeText.optional(),
      options: z
        .array(z.object({ label, value: safeText }))
        .min(1)
        .max(12),
    })
    .refine(
      (control) =>
        new Set(control.options.map((option) => option.value)).size === control.options.length &&
        (control.currentValue === undefined ||
          control.options.some((option) => option.value === control.currentValue)) &&
        (control.defaultValue === undefined ||
          control.options.some((option) => option.value === control.defaultValue)),
    ),
]);
export type VisualizationAnnotationControl = z.infer<typeof VisualizationAnnotationControlSchema>;
export type VisualizationAnnotationValue = z.infer<typeof value>;
export const VisualizationAnnotationControlsSchema = z
  .object({
    controls: z.array(VisualizationAnnotationControlSchema).max(12),
    controlsHeading: label.optional(),
    controlsMode: z.enum(["extend", "replace"]).optional(),
  })
  .refine(
    (controls) =>
      new Set(controls.controls.map((control) => control.callback)).size ===
        controls.controls.length && JSON.stringify(controls).length <= 16_384,
  );
export type VisualizationAnnotationControls = z.infer<typeof VisualizationAnnotationControlsSchema>;
const target = z.object({
  id,
  label,
  selector: z.string().min(1).max(1024),
  tagName: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  visible: z.boolean().optional(),
  rect: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  }),
});
const registration = {
  registrationId: id,
  annotationControls: VisualizationAnnotationControlsSchema,
  targets: z
    .array(target)
    .min(1)
    .max(128)
    .refine((targets) => new Set(targets.map((target) => target.id)).size === targets.length),
};
export const VisualizationSelectedVariantsSchema = z
  .array(
    z.object({
      carousel: z.number().int().min(0).max(31),
      label: z.string().max(256).optional(),
      variant: z.string().min(1).max(256),
    }),
  )
  .max(32);
export const VisualizationAnnotationMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("register"), ...registration }),
  z.object({ type: z.literal("update"), ...registration }),
  z.object({ type: z.literal("dispose"), registrationId: id }),
  z.object({ type: z.literal("select"), registrationId: id, targetId: id }),
  z.object({ type: z.literal("escape") }),
  z.object({ type: z.literal("variants"), selectedVariants: VisualizationSelectedVariantsSchema }),
]);
export type VisualizationAnnotationMessage = z.infer<typeof VisualizationAnnotationMessageSchema>;
export type VisualizationAnnotationRegistration = Extract<
  VisualizationAnnotationMessage,
  { type: "register" | "update" }
>;
export interface VisualizationAnnotationChange {
  readonly callback: string;
  readonly previousValue?: VisualizationAnnotationValue;
  readonly value: VisualizationAnnotationValue;
}
export interface VisualizationAnnotationDraft {
  readonly registrationId: string;
  readonly targetId: string;
  readonly annotationControlChanges: readonly VisualizationAnnotationChange[];
}
export interface VisualizationAnnotationCommand {
  readonly active: boolean;
  readonly selection: { readonly registrationId: string; readonly targetId: string } | null;
  readonly changes: readonly VisualizationAnnotationDraft[];
}

export function annotationValueIsValid(
  control: VisualizationAnnotationControl,
  value: unknown,
): value is VisualizationAnnotationValue {
  return VisualizationAnnotationControlSchema.safeParse({ ...control, currentValue: value })
    .success;
}
export function annotationDefaultValue(
  control: VisualizationAnnotationControl,
): VisualizationAnnotationValue {
  const supplied = control.defaultValue ?? control.currentValue;
  if (supplied !== undefined) return supplied;
  if (control.type === "range") return control.min;
  if (control.type === "color") return "#ffffff";
  if (control.type === "select") return control.options[0]!.value;
  return false;
}
