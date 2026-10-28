import type { Page } from "@playwright/test";

/** Preserve nested renderer failures, including Jotai's AggregateError callbacks. */
export function captureRendererErrors(page: Page): () => Promise<string> {
  const errors: string[] = [];
  const pending: Promise<unknown>[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    errors.push(message.text());
    pending.push(
      Promise.all(
        message.args().map(async (argument) => {
          const detail = await argument
            .evaluate((value) =>
              JSON.stringify(value, (_key, entry: unknown) => {
                if (!(entry instanceof Error)) return entry;
                return {
                  name: entry.name,
                  message: entry.message,
                  stack: entry.stack,
                  ...(entry instanceof AggregateError ? { errors: entry.errors } : {}),
                };
              }),
            )
            .catch(() => null);
          if (detail) errors.push(detail);
        }),
      ),
    );
  });
  return async () => {
    await Promise.allSettled(pending);
    return errors.join("\n");
  };
}
