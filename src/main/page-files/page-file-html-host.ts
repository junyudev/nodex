import { randomBytes } from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type { Session, WebContents, WebPreferences } from "electron";
import {
  PAGE_FILE_HTML_PARTITION_PREFIX,
  PAGE_FILE_HTML_SCHEME,
  type PageFileHtmlAdmission,
  type PageFileHtmlAdmissionInput,
  type PageFileHtmlAdmissionResult,
} from "../../shared/page-file-html";
import { requireCredentialFreeHttpUrl } from "../../shared/external-navigation-url";
import {
  denyGuestPermissionsAndDownloads,
  forceIsolatedGuestPreferences,
  lockGuestNavigation,
  trackGuestUserGesture,
} from "../guests/isolated-guest-policy";
import { WebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";
import {
  encodePageFileHtmlPath,
  isAllowedPageFileHtmlRequest,
  isHtmlMimeType,
  PAGE_FILE_HTML_LIMITS,
  pageFileHtmlMimeType,
  pageFileHtmlRequestPath,
  pageFileHtmlResponse,
} from "./page-file-html-policy";
import type { PageFileHtmlResolver, ResolvedPageFileHtml } from "./page-file-html-resolver";

import { configurePageFileHtmlNetwork } from "./page-file-html-network";

interface GuestParams {
  partition?: string;
  src?: string;
  nodeintegration?: string;
  preload?: string;
  webpreferences?: string;
}
export interface PageFileHtmlOwnerHost {
  readonly handlesPartition: (partition: string | null | undefined) => boolean;
  readonly handleWillAttach: (
    event: Electron.Event,
    preferences: WebPreferences,
    params: GuestParams,
  ) => void;
  readonly handleDidAttach: (guest: WebContents) => boolean;
}
export interface PageFileHtmlHost {
  readonly createHost: (owner: WebContents) => PageFileHtmlOwnerHost;
  readonly admit: (
    owner: WebContents,
    input: PageFileHtmlAdmissionInput,
  ) => Effect.Effect<PageFileHtmlAdmissionResult>;
  readonly release: (owner: WebContents, grant: string) => boolean;
}
interface Owner {
  readonly contents: WebContents;
  generation: number;
  readonly release: () => void;
}
interface Admission {
  readonly claim: PageFileHtmlAdmission;
  readonly input: PageFileHtmlAdmissionInput;
  readonly document: ResolvedPageFileHtml;
  readonly origin: string;
  readonly owner: Owner;
  readonly generation: number;
  readonly session: Session;
  readonly retired: Deferred.Deferred<void>;
  claimed: boolean;
  guest?: WebContents;
  releaseGuest?: () => void;
  requests: number;
  bytes: number;
  reservedBytes: number;
  inFlight: number;
}

/** Electron callback adapter. Main Scope owns requests; retirement interrupts Core work. */
export const makePageFileHtmlHost = (options: {
  readonly resolver: PageFileHtmlResolver;
  readonly fromPartition: (partition: string) => Session;
  readonly openExternal: (url: string) => Promise<void>;
}) =>
  Effect.gen(function* () {
    const destruction = yield* WebContentsDestructionSubscriptions;
    const run = yield* FiberSet.makeRuntimePromise();
    const admissions = new Map<string, Admission>();
    const sessions = new WeakSet<Session>();
    const owners = new Map<WebContents, Owner>();
    let closed = false;
    const isLive = (entry: Admission): boolean =>
      !closed &&
      admissions.get(entry.claim.grant) === entry &&
      !entry.owner.contents.isDestroyed() &&
      entry.owner.generation === entry.generation;

    const revoke = (entry: Admission): void => {
      if (!admissions.delete(entry.claim.grant)) return;
      Deferred.doneUnsafe(entry.retired, Effect.void);
      entry.releaseGuest?.();
      if (entry.guest && !entry.guest.isDestroyed()) entry.guest.close();
      // Keep the denying request/permission policy installed on the retired Session.
      entry.session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
      entry.session.webRequest.onBeforeSendHeaders(null);
      entry.session.protocol.unhandle(PAGE_FILE_HTML_SCHEME);
      void run(Effect.promise(() => entry.session.clearData()).pipe(Effect.ignore)).catch(() => {});
    };
    const revokeOwner = (owner: Owner): void => {
      owner.generation++;
      for (const entry of admissions.values()) if (entry.owner === owner) revoke(entry);
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const entry of admissions.values()) revoke(entry);
        closed = true;
        for (const owner of owners.values()) owner.release();
        owners.clear();
      }),
    );

    const serve = (entry: Admission, request: Request) =>
      Effect.suspend(() => {
        if (!isLive(entry)) return Effect.succeed(pageFileHtmlResponse(410));
        if (++entry.requests > PAGE_FILE_HTML_LIMITS.requests)
          return Effect.succeed(pageFileHtmlResponse(429));
        if (request.method !== "GET" && request.method !== "HEAD")
          return Effect.succeed(pageFileHtmlResponse(405));
        const path = pageFileHtmlRequestPath(request.url, entry.origin);
        if (!path) return Effect.succeed(pageFileHtmlResponse(404));
        if (entry.inFlight >= PAGE_FILE_HTML_LIMITS.concurrency)
          return Effect.succeed(pageFileHtmlResponse(429));
        const document = path === entry.document.path;
        if (!document && entry.input.logicalPath === null)
          return Effect.succeed(pageFileHtmlResponse(404));
        entry.inFlight++;
        const resolve = () => options.resolver.resolve(entry.input, document ? undefined : path);
        return Effect.gen(function* () {
          // Every resource also checks that the admitted document is still related to this Page.
          const currentDocument = yield* options.resolver.resolve(entry.input);
          if (
            currentDocument.storeEpoch !== entry.document.storeEpoch ||
            currentDocument.path !== entry.document.path
          )
            return pageFileHtmlResponse(404);
          const resolved = document ? currentDocument : yield* resolve();
          if (!isLive(entry) || resolved.storeEpoch !== entry.document.storeEpoch)
            return pageFileHtmlResponse(404);
          const maxBytes =
            document || isHtmlMimeType(resolved.presentation.mime_type)
              ? PAGE_FILE_HTML_LIMITS.documentBytes
              : PAGE_FILE_HTML_LIMITS.resourceBytes;
          const size = resolved.presentation.byte_length;
          if (
            !Number.isSafeInteger(size) ||
            size < 0 ||
            size > maxBytes ||
            size + entry.bytes + entry.reservedBytes > PAGE_FILE_HTML_LIMITS.totalBytes
          )
            return pageFileHtmlResponse(413);
          entry.reservedBytes += size;
          return yield* Effect.gen(function* () {
            const bytes = yield* options.resolver.read(entry.input, resolved);
            if (bytes.byteLength !== size) return pageFileHtmlResponse(413);
            // Pin the version while reading; reject an entry replaced or retired during IO.
            const after = yield* resolve();
            const afterDocument = document ? after : yield* options.resolver.resolve(entry.input);
            if (
              afterDocument.storeEpoch !== entry.document.storeEpoch ||
              afterDocument.path !== entry.document.path ||
              !isLive(entry) ||
              after.storeEpoch !== resolved.storeEpoch ||
              after.presentation.file_id !== resolved.presentation.file_id ||
              after.presentation.version !== resolved.presentation.version ||
              after.presentation.blob_etag !== resolved.presentation.blob_etag
            )
              return pageFileHtmlResponse(404);
            entry.bytes += size;
            return pageFileHtmlResponse(
              200,
              bytes,
              pageFileHtmlMimeType(resolved.presentation.mime_type),
              request.method === "HEAD",
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.reservedBytes -= size;
              }),
            ),
          );
        }).pipe(
          Effect.catch(() => Effect.succeed(pageFileHtmlResponse(404))),
          Effect.raceFirst(
            Deferred.await(entry.retired).pipe(Effect.as(pageFileHtmlResponse(410))),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              entry.inFlight--;
            }),
          ),
        );
      });

    const createHost = (contents: WebContents): PageFileHtmlOwnerHost => {
      let owner = owners.get(contents);
      if (!owner) {
        const onNavigation = (
          _event: Electron.Event,
          _url: string,
          inPlace: boolean,
          main: boolean,
        ): void => {
          if (main && !inPlace) revokeOwner(created);
        };
        const onGone = (): void => revokeOwner(created);
        const created: Owner = {
          contents,
          generation: 0,
          release: () => {
            releaseDestruction();
            contents.removeListener("did-start-navigation", onNavigation);
            contents.removeListener("render-process-gone", onGone);
          },
        };
        const releaseDestruction = destruction.subscribe(contents, () => {
          revokeOwner(created);
          created.release();
          owners.delete(contents);
        });
        contents.on("did-start-navigation", onNavigation);
        contents.on("render-process-gone", onGone);
        owners.set(contents, created);
        owner = created;
      }
      const boundOwner = owner;
      return {
        handlesPartition: (partition) =>
          partition?.startsWith(PAGE_FILE_HTML_PARTITION_PREFIX) ?? false,
        handleWillAttach: (event, preferences, params) => {
          const grant = params.partition?.slice(PAGE_FILE_HTML_PARTITION_PREFIX.length) ?? "";
          const entry = admissions.get(grant);
          if (
            !entry ||
            !isLive(entry) ||
            entry.owner !== boundOwner ||
            entry.claimed ||
            params.partition !== entry.claim.partition ||
            params.src !== entry.claim.url
          ) {
            event.preventDefault();
            return;
          }
          entry.claimed = true;
          forceIsolatedGuestPreferences(preferences, params, entry.session);
          preferences.partition = entry.claim.partition;
        },
        handleDidAttach: (guest) => {
          if (!sessions.has(guest.session)) return false;
          const entry = [...admissions.values()].find(
            (value) =>
              value.session === guest.session &&
              value.owner === boundOwner &&
              value.claimed &&
              !value.guest &&
              isLive(value),
          );
          if (!entry) {
            guest.close();
            return true;
          }
          entry.guest = guest;
          // Force ICE/TURN through the Session's unreachable proxy; direct UDP is forbidden.
          guest.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
          // Reports follow the app's theme, as Browser pages do, through Main-only emulation.
          try {
            guest.debugger.attach("1.3");
            void guest.debugger
              .sendCommand("Emulation.setEmulatedMedia", {
                features: [{ name: "prefers-color-scheme", value: entry.input.colorScheme }],
              })
              .catch(() => {});
          } catch {
            /* A report keeps its default scheme if emulation is unavailable. */
          }
          const gesture = trackGuestUserGesture(guest, () => isLive(entry) && !guest.isDestroyed());
          lockGuestNavigation({
            guest,
            documentUrl: entry.claim.url,
            allowSubframe: () => false,
            onExternalAttempt: (url) => {
              try {
                const href = requireCredentialFreeHttpUrl(url);
                if (!gesture.consume()) return;
                void options.openExternal(href).catch(() => {});
              } catch {
                /* Invalid or ungestured navigation is silently denied. */
              }
            },
          });
          const releaseDestruction = destruction.subscribe(guest, () => revoke(entry));
          entry.releaseGuest = () => {
            gesture.release();
            releaseDestruction();
          };
          guest.on("render-process-gone", () => revoke(entry));
          return true;
        },
      };
    };

    const admit = (
      contents: WebContents,
      input: PageFileHtmlAdmissionInput,
    ): Effect.Effect<PageFileHtmlAdmissionResult> =>
      Effect.gen(function* () {
        const owner = owners.get(contents);
        if (closed || !owner || contents.isDestroyed())
          return { status: "refused", message: "Page File preview is unavailable" } as const;
        const generation = owner.generation;
        const document = yield* options.resolver.resolve(input);
        if (closed || contents.isDestroyed() || owner.generation !== generation)
          return { status: "refused", message: "Page File preview is unavailable" } as const;
        if (
          (!isHtmlMimeType(document.presentation.mime_type) && !/\.html?$/iu.test(document.path)) ||
          document.presentation.byte_length > PAGE_FILE_HTML_LIMITS.documentBytes
        )
          return { status: "refused", message: "This File cannot be previewed as HTML" } as const;
        const grant = randomBytes(32).toString("hex");
        const origin = `${PAGE_FILE_HTML_SCHEME}://${grant}`;
        const claim: PageFileHtmlAdmission = {
          grant,
          url: `${origin}/${encodePageFileHtmlPath(document.path)}`,
          partition: `${PAGE_FILE_HTML_PARTITION_PREFIX}${grant}`,
        };
        const session = options.fromPartition(claim.partition);
        yield* configurePageFileHtmlNetwork(session);
        if (closed || contents.isDestroyed() || owner.generation !== generation)
          return { status: "refused", message: "Page File preview is unavailable" } as const;
        const entry: Admission = {
          claim,
          input,
          document,
          origin,
          owner,
          generation,
          session,
          retired: Deferred.makeUnsafe<void>(),
          claimed: false,
          requests: 0,
          bytes: 0,
          reservedBytes: 0,
          inFlight: 0,
        };
        admissions.set(grant, entry);
        sessions.add(session);
        denyGuestPermissionsAndDownloads(session);
        session.webRequest.onBeforeRequest((details, callback) =>
          callback({
            cancel: !isLive(entry) || !isAllowedPageFileHtmlRequest(details.url, origin),
          }),
        );
        session.webRequest.onBeforeSendHeaders((details, callback) =>
          callback({
            requestHeaders: Object.fromEntries(
              Object.entries(details.requestHeaders).filter(
                ([key]) =>
                  !["cookie", "authorization", "proxy-authorization", "referer"].includes(
                    key.toLowerCase(),
                  ),
              ),
            ),
          }),
        );
        session.protocol.handle(PAGE_FILE_HTML_SCHEME, (request) =>
          run(serve(entry, request)).catch(() => pageFileHtmlResponse(410)),
        );
        return { status: "admitted", admission: claim } as const;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Page File preview admission failed").pipe(
            Effect.annotateLogs({ error: String(error) }),
            Effect.as({ status: "refused", message: "The Page File is unavailable" } as const),
          ),
        ),
      );
    return {
      createHost,
      admit,
      release: (contents, grant) => {
        const entry = admissions.get(grant);
        if (!entry || entry.owner.contents !== contents) return false;
        revoke(entry);
        return true;
      },
    } satisfies PageFileHtmlHost;
  });
