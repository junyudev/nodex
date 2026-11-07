import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";

import { MainConfig } from "../../app/MainConfig";
import { Insights } from "../../insights/Insights";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

const PNG_PREFIX = "data:image/png;base64,";
/** A 2160×2700 card is a few megabytes; anything far larger was not produced by the share dialog. */
const MAX_CARD_BYTES = 64 * 1024 * 1024;

export class InsightsIpcError extends Schema.TaggedError<InsightsIpcError>()("InsightsIpcError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const UsageInput = z.strictObject({
  timeZone: z.string().min(1).max(128),
  origin: z.enum(["all", "nodex"]),
});
const ContentInput = z.strictObject({ timeZone: z.string().min(1).max(128) });
const AccessInput = z.strictObject({ granted: z.boolean() });
const SaveInput = z.strictObject({
  pngDataUrl: z.string().startsWith(PNG_PREFIX).max(MAX_CARD_BYTES),
  // A display name for the dialog only; the person chooses the real destination.
  suggestedName: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^/\\]+\.png$/),
});

/** Insights reads and card saves enter through the trusted renderer boundary. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const insights = yield* Insights;
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const windows = yield* WindowRuntime;
    const desktop = yield* ElectronDesktop;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Insights", config.rendererUrl);
          if (!windows.has(event.sender.id) || event.sender.isDestroyed())
            throw new Error("Insights requires an active Nodex window");
        },
        catch: (cause) =>
          new InsightsIpcError({ message: "Insights is unavailable in this window", cause }),
      });
    const parse = <A>(read: () => A) =>
      Effect.try({
        try: read,
        catch: (cause) => new InsightsIpcError({ message: "Invalid Insights request", cause }),
      });

    yield* ipc.handleQuery("insights:usage", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(parse(() => UsageInput.parse(input))),
        Effect.flatMap(insights.readUsage),
      ),
    );
    yield* ipc.handleQuery("insights:content", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(parse(() => ContentInput.parse(input))),
        Effect.flatMap(insights.readContent),
      ),
    );
    yield* ipc.handlePlainCommand("insights:access", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(parse(() => AccessInput.parse(input))),
        Effect.flatMap(({ granted }) => insights.setAccess(granted)),
      ),
    );
    yield* ipc.handlePlainCommand("insights:card:save", (event, input) =>
      authorize(event).pipe(
        Effect.andThen(parse(() => SaveInput.parse(input))),
        Effect.flatMap(({ pngDataUrl, suggestedName }) =>
          Effect.tryPromise({
            try: async () => {
              const window = windows.get(event.sender.id);
              const options = {
                title: "Save card",
                defaultPath: suggestedName,
                filters: [{ name: "PNG image", extensions: ["png"] }],
              };
              const choice = window
                ? await desktop.dialog.showSaveDialog(window, options)
                : await desktop.dialog.showSaveDialog(options);
              if (choice.canceled || !choice.filePath) return { status: "cancelled" as const };
              await NodeFSP.writeFile(
                choice.filePath,
                Buffer.from(pngDataUrl.slice(PNG_PREFIX.length), "base64"),
              );
              return { status: "saved" as const };
            },
            catch: (cause) => new InsightsIpcError({ message: "Could not save the card", cause }),
          }),
        ),
      ),
    );
  }),
);
