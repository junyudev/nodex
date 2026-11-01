import path from "node:path";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { app, BrowserWindow, session } from "electron";
import { makePageFileHtmlHost } from "../../../src/main/page-files/page-file-html-host";
import { PageFileHtmlResolutionError, type ResolvedPageFileHtml } from "../../../src/main/page-files/page-file-html-resolver";
import { WebContentsDestructionSubscriptions } from "../../../src/main/platform/electron/WebContentsDestructionSubscriptions";
import { registerNodexPrivilegedSchemes } from "../../../src/main/privileged-schemes";
import type { PageFileHtmlAdmissionInput, PageFileHtmlAdmissionResult } from "../../../src/shared/page-file-html";

const home = process.argv[process.argv.indexOf("--home") + 1];
if (!home || !path.isAbsolute(home)) throw new Error("An absolute fixture home is required");
app.setPath("userData", path.join(home, "user-data"));
registerNodexPrivilegedSchemes();
const report = `<!doctype html><html><head><link rel="stylesheet" href="report.css"><script src="report.js"></script></head><body><img id="image" src="flamegraph.png"><button id="external" onclick="window.open('https://example.com/report')">Link</button><script>window.inlineRan=true;fetch('trace.json').then(r=>r.json()).then(v=>window.trace=v);</script></body></html>`;
const files = new Map<string, { id: string; mime: string; bytes: Uint8Array; size?: number }>();
const put = (path: string, id: string, mime: string, text: string) => files.set(path, { id, mime, bytes: new TextEncoder().encode(text) });
put("profile/report.html", "report", "text/html", report);
put("profile/report.css", "style", "text/css", "body{background-color:rgb(12, 34, 56)}");
put("profile/report.js", "script", "text/javascript", "window.siblingScriptRan=true");
put("profile/trace.json", "trace", "application/json", '{"samples":42}');
put("profile/slow.json", "slow", "application/json", "{}");
put("profile/huge.json", "huge", "application/json", "{}");
files.get("profile/huge.json")!.size = 64 * 1024 * 1024 + 1;
put("profile/not-html.html", "plain", "text/plain", "<script>window.shouldNotRun=true</script>");
files.set("profile/flamegraph.png", { id: "image", mime: "image/png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64") });
const reads: string[] = [];
let pending = 0;
let interrupted = 0;
let available = true;
let epoch = "epoch";
let cancelledDownloads = 0;
const opened: string[] = [];
const events: unknown[] = [];

export interface PageFileHtmlFixture {
  admit(input?: Partial<PageFileHtmlAdmissionInput>): Promise<PageFileHtmlAdmissionResult>;
  release(grant: string): boolean;
  facts(): { reads: string[]; pending: number; interrupted: number; cancelledDownloads: number; opened: string[]; events: unknown[] };
  setAvailable(value: boolean): void;
  replaceStore(): void;
  attachToWrongOwner(partition: string, src: string): Promise<boolean>;
}
declare global { var pageFileFixture: PageFileHtmlFixture; }

const program = Effect.scoped(Effect.gen(function* () {
  yield* Effect.promise(() => app.whenReady());
  const run = yield* FiberSet.makeRuntimePromise();
  const window = new BrowserWindow({ width: 720, height: 520, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true } });
  const host = yield* makePageFileHtmlHost({
    fromPartition: (partition) => {
      const isolated = session.fromPartition(partition, { cache: false });
      isolated.on("will-download", (event) => { queueMicrotask(() => { if (event.defaultPrevented) cancelledDownloads++; }); });
      return isolated;
    },
    openExternal: async (url) => { opened.push(url); },
    resolver: {
      resolve: (input, resourcePath) => Effect.suspend(() => {
        if (!available || input.pageId !== "page") return Effect.fail(new PageFileHtmlResolutionError());
        const logicalPath = resourcePath ?? input.logicalPath ?? "standalone.html";
        if (input.logicalPath === null) {
          if (input.fileId !== "body-report" || resourcePath !== undefined) return Effect.fail(new PageFileHtmlResolutionError());
          return Effect.succeed({ path: logicalPath, storeEpoch: epoch, presentation: { file_id: "body-report", default_name: "standalone.html", mime_type: "text/html", version: 1, blob_etag: "body-report", byte_length: report.length } });
        }
        const file = files.get(logicalPath);
        if (!file || (resourcePath === undefined && file.id !== input.fileId)) return Effect.fail(new PageFileHtmlResolutionError());
        return Effect.succeed({ path: logicalPath, storeEpoch: epoch, presentation: { file_id: file.id, default_name: path.basename(logicalPath), mime_type: file.mime, version: 1, blob_etag: file.id, byte_length: file.size ?? file.bytes.byteLength } } satisfies ResolvedPageFileHtml);
      }),
      read: (_input, resolved) => Effect.suspend(() => {
        reads.push(resolved.presentation.file_id);
        if (resolved.presentation.file_id === "slow") {
          pending++;
          return Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted++; pending--; })));
        }
        if (resolved.presentation.file_id === "body-report") return Effect.succeed(new TextEncoder().encode(report));
        const file = files.get(resolved.path);
        return file ? Effect.succeed(file.bytes) : Effect.fail(new PageFileHtmlResolutionError());
      }),
    },
  });
  const owner = host.createHost(window.webContents);
  window.webContents.on("will-attach-webview", (event, preferences, params) => {
    if (!owner.handlesPartition(params.partition)) { event.preventDefault(); return; }
    owner.handleWillAttach(event, preferences, params);
  });
  window.webContents.on("did-attach-webview", (_event, guest) => {
    if (!owner.handleDidAttach(guest)) { guest.close(); return; }
    guest.on("will-navigate", (event, url) => events.push({event:"will-navigate",url,prevented:event.defaultPrevented}));
    guest.on("will-frame-navigate", (event) => events.push({event:"will-frame-navigate",url:event.url,main:event.isMainFrame,prevented:event.defaultPrevented}));
    guest.on("did-start-navigation", (_event,url,inPlace,main) => events.push({event:"did-start-navigation",url,inPlace,main}));
    guest.on("before-mouse-event", (_event,input) => events.push({event:"mouse",type:input.type}));
    guest.on("console-message", (event) => events.push({event:"console",message:event.message}));
  });
  globalThis.pageFileFixture = {
    admit: (input = {}) => run(host.admit(window.webContents, { routingContext: { kind: "library" }, pageId: "page", fileId: "report", logicalPath: "profile/report.html", colorScheme: "light", ...input })),
    release: (grant) => host.release(window.webContents, grant),
    facts: () => ({ reads, pending, interrupted, cancelledDownloads, opened, events }),
    setAvailable: (value) => { available = value; },
    replaceStore: () => { epoch = "replaced"; },
    attachToWrongOwner: async (partition, src) => {
      const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true } });
      const otherHost = host.createHost(other.webContents);
      let denied = false;
      other.webContents.on("will-attach-webview", (event, preferences, params) => { otherHost.handleWillAttach(event, preferences, params); denied = event.defaultPrevented; });
      await other.loadURL("data:text/html,<body></body>");
      await other.webContents.executeJavaScript(`{ const w=document.createElement('webview');w.partition=${JSON.stringify(partition)};w.src=${JSON.stringify(src)};document.body.append(w); }`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      other.destroy();
      return denied;
    },
  };
  yield* Effect.promise(() => window.loadURL(`data:text/html,${encodeURIComponent("<!doctype html><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; style-src 'unsafe-inline'; frame-src nodex-page-file:; child-src nodex-page-file:\"><style>webview{display:flex;width:640px;height:400px}</style><body></body>")}`));
  yield* Effect.callback<void>((resume) => {
    const quit = () => resume(Effect.void);
    app.once("before-quit", quit);
    return Effect.sync(() => app.removeListener("before-quit", quit));
  });
})).pipe(Effect.provide(WebContentsDestructionSubscriptions.live));
NodeRuntime.runMain(program, { disableErrorReporting: true });
