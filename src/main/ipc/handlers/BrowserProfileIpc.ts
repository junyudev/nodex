import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import {
  BrowserApplication,
  type BrowserGuestHost,
} from "../../browser-application/BrowserApplication";
import { BrowserProfileRuntime } from "../../host-runtime/BrowserProfileRuntime";
import { safeBroadcastToWindows, safeSendToWebContents } from "../../ipc-safe-send";
import { MainConfig } from "../../app/MainConfig";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { ElectronWindowHost } from "../../platform/electron/ElectronWindowHost";
import { WindowSessionCatalog } from "../../window-runtime/WindowSessionCatalog";
import {
  BrowserAnnotationAnchorUpdateEventSchema,
  BrowserAnnotationSelectionEventSchema,
} from "../../../shared/browser-annotation";
import { BrowserDownloadActionRequestSchema } from "../../../shared/browser/browser-download-schemas";
import {
  BrowserGuestImageDragStartedSchema,
  BrowserLocalServerPreferencesUpdateSchema,
} from "../../../shared/browser/browser-schemas";
import {
  BrowserContactInfoFillInputSchema,
  BrowserContactInfoRemoveInputSchema,
  BrowserContactInfoUpsertInputSchema,
  BrowserCredentialCandidateActionInputSchema,
  BrowserCredentialFillInputSchema,
  BrowserCredentialGenerateInputSchema,
  BrowserCredentialGuestCandidateSchema,
  BrowserCredentialListInputSchema,
  BrowserExtensionRemoveInputSchema,
  BrowserHistoryDeleteInputSchema,
  BrowserProfileImportInputSchema,
  BrowserSiteInfoInputSchema,
} from "../../../shared/browser-profile";
import {
  BrowserUseOriginRuleUpdateSchema,
  BrowserUsePolicyModesUpdateSchema,
} from "../../../shared/browser-use-policy";

export class BrowserProfileIpcError extends Schema.TaggedError<BrowserProfileIpcError>()(
  "BrowserProfileIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const attempt = <A>(
  operation: string,
  run: () => A | PromiseLike<A>,
): Effect.Effect<A, BrowserProfileIpcError> =>
  Effect.tryPromise({
    try: async () => await run(),
    catch: (cause) => new BrowserProfileIpcError({ operation, cause }),
  });

const ownerForGuest = (guest: BrowserGuestHost, event: IpcMainEvent): WebContents | null => {
  if (!guest.isAuthorized(event.sender.id)) return null;
  const owner = event.sender.hostWebContents;
  if (!owner) return null;
  if (guest.getOwnerWebContentsId(event.sender.id) !== owner.id) return null;
  return owner;
};

export const live: Layer.Layer<
  never,
  never,
  | BrowserProfileRuntime
  | BrowserApplication
  | ElectronDesktop
  | ElectronIpc
  | ElectronWindowHost
  | MainConfig
  | WindowSessionCatalog
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const browserProfile = yield* BrowserProfileRuntime;
    const browser = yield* BrowserApplication;
    const { guest } = browser;
    const desktop = yield* ElectronDesktop;
    const ipc = yield* ElectronIpc;
    const windows = yield* ElectronWindowHost;
    const config = yield* MainConfig;
    const windowSessions = yield* WindowSessionCatalog;
    const {
      credentials,
      download,
      extensions,
      localServerPreferences,
      policy,
      profileImport,
      siteInfo,
    } = browserProfile;

    const trusted = (event: IpcMainInvokeEvent, capabilityName: string) =>
      attempt("authorize-renderer", () =>
        requireTrustedAppRendererSender(event, capabilityName, config.rendererUrl),
      );
    const requireViewScope = (senderId: number, browserViewScopeId: string) =>
      windowSessions.resolveForWebContents(senderId).pipe(
        Effect.flatMap((expectedScopeId) =>
          expectedScopeId === browserViewScopeId
            ? Effect.void
            : Effect.fail(
                new BrowserProfileIpcError({
                  operation: "authorize-browser-view-scope",
                  cause: new Error("Browser view scope does not belong to the requesting window"),
                }),
              ),
        ),
      );
    const parse = <A>(operation: string, run: () => A) => attempt(operation, run);
    const credential = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError((cause) => new BrowserProfileIpcError({ operation, cause })));

    yield* ipc.handleQuery("browser-downloads-list", (event) =>
      trusted(event, "Browser download history").pipe(
        Effect.andThen(attempt("read-download-history", () => download.snapshot())),
      ),
    );
    yield* ipc.handlePlainCommand("browser-download-action", (event, rawRequest: unknown) =>
      trusted(event, "Browser download action").pipe(
        Effect.andThen(
          parse("parse-download-action", () =>
            BrowserDownloadActionRequestSchema.parse(rawRequest),
          ),
        ),
        Effect.flatMap((request) =>
          download
            .handleAction(request)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserProfileIpcError({ operation: "apply-download-action", cause }),
              ),
            ),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("browser-download-history-clear", (event) =>
      trusted(event, "Browser download history clearing").pipe(
        Effect.andThen(
          download.clearHistory.pipe(
            Effect.mapError(
              (cause) => new BrowserProfileIpcError({ operation: "clear-download-history", cause }),
            ),
          ),
        ),
        Effect.as({ ok: true as const }),
      ),
    );
    yield* ipc.handleQuery("browser-profile-capabilities", (event) =>
      trusted(event, "Browser Profile capabilities").pipe(
        Effect.andThen(
          attempt("read-browser-profile-capabilities", () => ({
            credentialVault: credentials.capability(),
            contactInfo: credentials.capability(),
            profileImport: profileImport.capability(),
            siteInfo: { available: true as const, provider: "electron-public-api" as const },
            history: { available: true as const, provider: "electron-public-api" as const },
            extensions: extensions.capability(),
          })),
        ),
      ),
    );
    yield* ipc.handleQuery("browser-profile-import-profiles", (event) =>
      trusted(event, "Browser Profile discovery").pipe(
        Effect.andThen(
          profileImport.listProfiles.pipe(
            Effect.mapError(
              (cause) =>
                new BrowserProfileIpcError({ operation: "list-importable-profiles", cause }),
            ),
          ),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("browser-profile-import", (event, rawInput: unknown) =>
      trusted(event, "Browser Profile import").pipe(
        Effect.andThen(
          parse("parse-profile-import", () => BrowserProfileImportInputSchema.parse(rawInput)),
        ),
        Effect.flatMap((input) =>
          profileImport
            .importProfile(input)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserProfileIpcError({ operation: "import-browser-profile", cause }),
              ),
            ),
        ),
      ),
    );
    yield* ipc.handleQuery("browser-credentials-list", (event, rawInput: unknown) =>
      trusted(event, "Browser credential listing").pipe(
        Effect.andThen(
          parse("parse-credential-list", () => BrowserCredentialListInputSchema.parse(rawInput)),
        ),
        Effect.tap((input) => requireViewScope(event.sender.id, input.browserViewScopeId)),
        Effect.flatMap((input) =>
          credential("list-browser-credentials", credentials.listForTab(input)),
        ),
      ),
    );
    yield* ipc.handleQuery("browser-credentials-list-all", (event) =>
      trusted(event, "Browser credential listing").pipe(
        Effect.andThen(credential("list-all-browser-credentials", credentials.listAll)),
      ),
    );
    yield* ipc.handlePlainCommand("browser-credential-fill", (event, rawInput: unknown) =>
      trusted(event, "Browser credential fill").pipe(
        Effect.andThen(
          parse("parse-credential-fill", () => BrowserCredentialFillInputSchema.parse(rawInput)),
        ),
        Effect.tap((input) => requireViewScope(event.sender.id, input.browserViewScopeId)),
        Effect.flatMap((input) => credential("fill-browser-credential", credentials.fill(input))),
      ),
    );
    yield* ipc.handlePlainCommand("browser-credential-generate-fill", (event, rawInput: unknown) =>
      trusted(event, "Browser password generation").pipe(
        Effect.andThen(
          parse("parse-credential-generation", () =>
            BrowserCredentialGenerateInputSchema.parse(rawInput),
          ),
        ),
        Effect.tap((input) => requireViewScope(event.sender.id, input.browserViewScopeId)),
        Effect.flatMap((input) =>
          credential("generate-browser-credential", credentials.generateAndFill(input)),
        ),
      ),
    );
    yield* ipc.handlePlainCommand(
      "browser-credential-candidate-action",
      (event, rawInput: unknown) =>
        trusted(event, "Browser credential save").pipe(
          Effect.andThen(
            parse("parse-credential-candidate-action", () =>
              BrowserCredentialCandidateActionInputSchema.parse(rawInput),
            ),
          ),
          Effect.flatMap((input) =>
            credential(
              "apply-credential-candidate-action",
              credentials.actOnCandidate(event.sender.id, input),
            ),
          ),
        ),
    );
    yield* ipc.handlePlainCommand("browser-credential-remove", (event, credentialId: unknown) =>
      trusted(event, "Browser credential removal").pipe(
        Effect.andThen(
          parse("parse-credential-removal", () =>
            BrowserHistoryDeleteInputSchema.parse({ id: credentialId }),
          ),
        ),
        Effect.flatMap(({ id }) => credential("remove-browser-credential", credentials.remove(id))),
      ),
    );
    yield* ipc.handleQuery("browser-contact-info-list", (event) =>
      trusted(event, "Browser contact info listing").pipe(
        Effect.andThen(credential("list-browser-contact-info", credentials.listContactInfo)),
      ),
    );
    yield* ipc.handlePlainCommand("browser-contact-info-upsert", (event, rawInput: unknown) =>
      trusted(event, "Browser contact info save").pipe(
        Effect.andThen(
          parse("parse-contact-info", () => BrowserContactInfoUpsertInputSchema.parse(rawInput)),
        ),
        Effect.flatMap((input) =>
          credential("save-browser-contact-info", credentials.saveContactInfo(input)),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("browser-contact-info-remove", (event, contactInfoId: unknown) =>
      trusted(event, "Browser contact info removal").pipe(
        Effect.andThen(
          parse("parse-contact-info-removal", () =>
            BrowserContactInfoRemoveInputSchema.parse({ contactInfoId }),
          ),
        ),
        Effect.flatMap((input) =>
          credential(
            "remove-browser-contact-info",
            credentials.removeContactInfo(input.contactInfoId),
          ),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("browser-contact-info-fill", (event, rawInput: unknown) =>
      trusted(event, "Browser contact info fill").pipe(
        Effect.andThen(
          parse("parse-contact-info-fill", () => BrowserContactInfoFillInputSchema.parse(rawInput)),
        ),
        Effect.tap((input) => requireViewScope(event.sender.id, input.browserViewScopeId)),
        Effect.flatMap((input) =>
          credential("fill-browser-contact-info", credentials.fillContactInfo(input)),
        ),
      ),
    );
    yield* ipc.handleQuery("browser-site-info", (event, rawInput: unknown) =>
      trusted(event, "Browser site information").pipe(
        Effect.andThen(parse("parse-site-info", () => BrowserSiteInfoInputSchema.parse(rawInput))),
        Effect.tap((input) => requireViewScope(event.sender.id, input.browserViewScopeId)),
        Effect.flatMap((input) =>
          siteInfo
            .get(input)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserProfileIpcError({ operation: "read-browser-site-info", cause }),
              ),
            ),
        ),
      ),
    );
    yield* ipc.handleQuery("browser-extensions-list", (event) =>
      trusted(event, "Browser extensions").pipe(
        Effect.andThen(
          extensions.snapshot.pipe(
            Effect.mapError(
              (cause) =>
                new BrowserProfileIpcError({ operation: "list-browser-extensions", cause }),
            ),
          ),
        ),
      ),
    );
    yield* ipc.handlePlainCommand("browser-extension-load", (event) =>
      Effect.gen(function* () {
        yield* trusted(event, "Browser extension loading");
        const window = yield* windows.fromWebContents(event.sender);
        const result = yield* attempt("pick-browser-extension", () =>
          window
            ? desktop.dialog.showOpenDialog(window, {
                title: "Load unpacked Browser extension",
                properties: ["openDirectory"],
              })
            : desktop.dialog.showOpenDialog({
                title: "Load unpacked Browser extension",
                properties: ["openDirectory"],
              }),
        );
        const extensionPath = result.canceled ? undefined : result.filePaths[0];
        if (!extensionPath) return null;
        return yield* extensions
          .load(extensionPath)
          .pipe(
            Effect.mapError(
              (cause) => new BrowserProfileIpcError({ operation: "load-browser-extension", cause }),
            ),
          );
      }),
    );
    yield* ipc.handlePlainCommand("browser-extension-remove", (event, extensionId: unknown) =>
      trusted(event, "Browser extension removal").pipe(
        Effect.andThen(
          parse("parse-extension-removal", () =>
            BrowserExtensionRemoveInputSchema.parse({ extensionId }),
          ),
        ),
        Effect.flatMap((input) =>
          extensions.remove(input.extensionId).pipe(
            Effect.mapError(
              (cause) =>
                new BrowserProfileIpcError({ operation: "remove-browser-extension", cause }),
            ),
            Effect.as({ ok: true as const }),
            Effect.catch((error) =>
              Effect.succeed({
                ok: false as const,
                message:
                  error.cause instanceof Error
                    ? error.cause.message
                    : "Browser extension removal failed",
              }),
            ),
          ),
        ),
      ),
    );
    yield* ipc.handleQuery("browser-use-policy-get", (event) =>
      trusted(event, "Browser Use policy").pipe(Effect.andThen(Effect.sync(policy.snapshot))),
    );
    yield* ipc.handlePlainCommand("browser-use-policy-update-modes", (event, rawInput: unknown) =>
      trusted(event, "Browser Use policy update").pipe(
        Effect.andThen(
          parse("parse-browser-use-policy-modes", () =>
            BrowserUsePolicyModesUpdateSchema.parse(rawInput),
          ),
        ),
        Effect.flatMap((input) =>
          policy.updateModes(input).pipe(
            Effect.mapError(
              (cause) =>
                new BrowserProfileIpcError({
                  operation: "update-browser-use-policy-modes",
                  cause,
                }),
            ),
          ),
        ),
      ),
    );
    yield* ipc.handlePlainCommand(
      "browser-use-policy-update-origin-rule",
      (event, rawInput: unknown) =>
        trusted(event, "Browser Use origin policy update").pipe(
          Effect.andThen(
            parse("parse-browser-use-origin-rule", () =>
              BrowserUseOriginRuleUpdateSchema.parse(rawInput),
            ),
          ),
          Effect.flatMap((input) =>
            policy.updateOriginRule(input).pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserProfileIpcError({
                    operation: "update-browser-use-origin-rule",
                    cause,
                  }),
              ),
            ),
          ),
        ),
    );
    yield* ipc.handleQuery("browser-local-server-preferences-get", (event) =>
      trusted(event, "Local server preferences").pipe(
        Effect.andThen(localServerPreferences.snapshot),
      ),
    );
    yield* ipc.handlePlainCommand(
      "browser-local-server-preferences-update",
      (event, rawInput: unknown) =>
        trusted(event, "Local server preferences update").pipe(
          Effect.andThen(
            parse("parse-local-server-preferences", () =>
              BrowserLocalServerPreferencesUpdateSchema.parse(rawInput),
            ),
          ),
          Effect.flatMap((input) =>
            localServerPreferences.update(input).pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserProfileIpcError({
                    operation: "update-local-server-preferences",
                    cause,
                  }),
              ),
            ),
          ),
          Effect.tap((preferences) =>
            windows.all.pipe(
              Effect.tap((all) =>
                Effect.sync(() =>
                  safeBroadcastToWindows(all, "browser-local-server-preferences-changed", [
                    preferences,
                  ]),
                ),
              ),
            ),
          ),
        ),
    );

    yield* ipc.on("browser-image-drag-started", (event, rawInput: unknown) =>
      Effect.sync(() => {
        if (!ownerForGuest(guest, event)) return;
        const input = BrowserGuestImageDragStartedSchema.safeParse(rawInput);
        if (!input.success) return;
        guest.startImageDrag(event.sender.id, input.data.sourceUrl);
      }),
    );
    yield* ipc.on("browser-image-drag-ended", (event) =>
      Effect.sync(() => {
        if (!guest.isAuthorized(event.sender.id)) return;
        guest.endImageDrag(event.sender.id);
      }),
    );
    yield* ipc.on("browser-credential-save-candidate", (event, rawInput: unknown) => {
      const owner = ownerForGuest(guest, event);
      if (!owner) return Effect.void;
      const input = BrowserCredentialGuestCandidateSchema.safeParse(rawInput);
      if (!input.success) return Effect.void;
      return credential(
        "capture-guest-credential-candidate",
        credentials.captureGuestCandidate(event.sender.id, input.data),
      ).pipe(
        Effect.tap((candidate) =>
          candidate
            ? Effect.sync(() =>
                safeSendToWebContents(owner, "browser-credential-save-candidate", [candidate]),
              )
            : Effect.void,
        ),
        Effect.catch(() => Effect.void),
        Effect.asVoid,
      );
    });
    yield* ipc.on("browser-annotation-selection", (event, rawInput: unknown) =>
      Effect.sync(() => {
        const owner = ownerForGuest(guest, event);
        if (!owner) return;
        const selection = BrowserAnnotationSelectionEventSchema.safeParse(rawInput);
        if (!selection.success || selection.data.anchor.pageUrl !== event.sender.getURL()) return;
        const identity = guest.getIdentity(event.sender.id);
        if (!identity) return;
        safeSendToWebContents(owner, "browser-annotation-selection", [
          { ...identity, selection: selection.data },
        ]);
      }),
    );
    yield* ipc.on("browser-annotation-anchor-update", (event, rawInput: unknown) =>
      Effect.sync(() => {
        const owner = ownerForGuest(guest, event);
        if (!owner) return;
        const update = BrowserAnnotationAnchorUpdateEventSchema.safeParse(rawInput);
        if (!update.success || update.data.anchor.pageUrl !== event.sender.getURL()) return;
        const identity = guest.getIdentity(event.sender.id);
        if (!identity) return;
        safeSendToWebContents(owner, "browser-annotation-anchor-update", [
          { ...identity, update: update.data },
        ]);
      }),
    );
    yield* ipc.on("browser-navigation-button", (event, rawDirection: unknown) => {
      const owner = ownerForGuest(guest, event);
      const identity = guest.getIdentity(event.sender.id);
      const direction =
        rawDirection === "back" ? "go-back" : rawDirection === "forward" ? "go-forward" : null;
      if (!owner || !identity || !direction) return Effect.void;
      return browser
        .applyCommand({ type: direction, ...identity }, { ownerWebContentsId: owner.id })
        .pipe(
          Effect.mapError(
            (cause) => new BrowserProfileIpcError({ operation: "apply-guest-navigation", cause }),
          ),
          Effect.catch(() => Effect.void),
          Effect.asVoid,
        );
    });
  }),
);
