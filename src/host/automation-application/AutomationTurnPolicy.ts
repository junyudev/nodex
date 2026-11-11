import * as Effect from "effect/Effect";
import { CoreApplicationAgent } from "../../main/core-runtime/CoreApplicationAgent";
import type { CoreModules } from "../../main/core-runtime/CoreModules";

/** The preference frozen for this exact submitted message. */
export const readAutomationTurnPolicy = (core: CoreModules["Service"], messageId: string) =>
  core.automation
    .read(
      { kind: "automation_notification_policy", message_id: messageId },
      { class: "background" },
    )
    .pipe(
      Effect.provideService(CoreApplicationAgent, null),
      Effect.map((snapshot) =>
        snapshot.value.kind === "automation_notification_policy"
          ? (snapshot.value.policy ?? null)
          : null,
      ),
    );
