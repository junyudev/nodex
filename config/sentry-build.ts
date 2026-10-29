import { sentryVitePlugin } from "@sentry/vite-plugin";

function hasSentrySourceMapUploadConfig(): boolean {
  return Boolean(
    process.env.SENTRY_AUTH_TOKEN?.trim() &&
    process.env.SENTRY_ORG?.trim() &&
    process.env.SENTRY_PROJECT?.trim(),
  );
}

export function shouldEmitSentrySourceMaps(): boolean {
  return Boolean(process.env.SENTRY_RELEASE?.trim() || hasSentrySourceMapUploadConfig());
}

export function createSentryPlugins() {
  if (!hasSentrySourceMapUploadConfig()) return [];

  return sentryVitePlugin({
    release: {
      name: process.env.SENTRY_RELEASE?.trim() || undefined,
    },
    sourcemaps: {
      filesToDeleteAfterUpload: "out/**/*.map",
    },
    errorHandler: (error) => {
      throw error;
    },
    telemetry: false,
  });
}
