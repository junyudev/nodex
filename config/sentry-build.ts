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
  const upload = hasSentrySourceMapUploadConfig();
  const release = process.env.SENTRY_RELEASE?.trim() || undefined;
  if (!release && !upload) return [];

  return sentryVitePlugin({
    // Rehearse the same runtime instrumentation without contacting Sentry.
    authToken: upload ? undefined : "",
    release: {
      name: release,
      create: upload,
      finalize: upload,
    },
    sourcemaps: upload
      ? { filesToDeleteAfterUpload: "out/**/*.map" }
      : { disable: "disable-upload" },
    errorHandler: (error) => {
      throw error;
    },
    telemetry: false,
  });
}
