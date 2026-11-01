import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createSocket } from "node:dgram";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { build } from "esbuild";
import type { ElectronApplication, Page } from "playwright";
import { launchTestElectron } from "../../../scripts/testing/launch-electron";
import type { PageFileHtmlAdmission } from "../../shared/page-file-html";
import type { PageFileHtmlFixture } from "../../../tests/fixtures/page-file-html/electron-main";
import { PAGE_FILE_HTML_CSP } from "./page-file-html-policy";

let outputDirectory: string;
beforeAll(async () => {
  outputDirectory = mkdtempSync(path.join(tmpdir(), "nodex-page-file-integration-"));
  await build({
    bundle: true,
    entryPoints: [path.resolve("tests/fixtures/page-file-html/electron-main.ts")],
    external: ["electron"],
    format: "cjs",
    outfile: path.join(outputDirectory, "main.js"),
    platform: "node",
    target: "node24",
  });
});
afterAll(() => {
  rmSync(outputDirectory, { recursive: true, force: true });
});

async function attach(page: Page, claim: PageFileHtmlAdmission): Promise<number> {
  return page.evaluate(
    (claim) =>
      new Promise<number>((resolve, reject) => {
        const guest = document.createElement("webview");
        guest.setAttribute("partition", claim.partition);
        guest.setAttribute("allowpopups", "");
        // Hostile preference claims must be overwritten by Main.
        guest.setAttribute(
          "webpreferences",
          "nodeIntegration=yes,nodeIntegrationInWorker=yes,contextIsolation=no,sandbox=no,webSecurity=no,webviewTag=yes",
        );
        guest.setAttribute("preload", "file:///untrusted-preload.js");
        guest.setAttribute("src", claim.url);
        guest.addEventListener("did-finish-load", () =>
          resolve((guest as unknown as { getWebContentsId(): number }).getWebContentsId()),
        );
        guest.addEventListener("did-fail-load", (event) =>
          reject(
            new Error(String((event as unknown as { errorDescription: string }).errorDescription)),
          ),
        );
        document.body.append(guest);
      }),
    claim,
  );
}
async function withGuest(
  run: (fixture: {
    application: ElectronApplication;
    page: Page;
    claim: PageFileHtmlAdmission;
    id: number;
    execute: <T>(script: string) => Promise<T>;
  }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(path.join(outputDirectory, "home-"));
  mkdirSync(path.join(home, "user-data"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  const application = await launchTestElectron({
    args: [path.join(outputDirectory, "main.js"), "--home", home],
    env,
  });
  try {
    const page = await application.firstWindow();
    const admission: Awaited<ReturnType<PageFileHtmlFixture["admit"]>> = await application.evaluate(
      () => globalThis.pageFileFixture.admit(),
    );
    if (admission.status !== "admitted") throw new Error(admission.message);
    const id = await attach(page, admission.admission);
    const execute = <T>(script: string) =>
      application.evaluate(
        async ({ webContents }, { id, script }) => {
          const guest = webContents.fromId(id);
          if (!guest) throw new Error("Missing Page File guest");
          return guest.executeJavaScript(script, false) as Promise<T>;
        },
        { id, script },
      );
    await run({ application, page, claim: admission.admission, id, execute });
  } finally {
    await application.close();
  }
}

test(
  "renders original HTML and sibling assets in a sandbox with no preload or native globals",
  () =>
    withGuest(async ({ application, execute, id, claim }) => {
      await expect.poll(() => execute("window.trace")).toEqual({ samples: 42 });
      expect(
        await execute(
          "({inline:window.inlineRan,script:window.siblingScriptRan,image:document.querySelector('#image').naturalWidth,background:getComputedStyle(document.body).backgroundColor})",
        ),
      ).toEqual({ inline: true, script: true, image: 1, background: "rgb(12, 34, 56)" });
      expect(
        await execute(
          "({process:typeof process,require:typeof require,ipcRenderer:typeof ipcRenderer,api:typeof window.api,electron:typeof window.electron,openai:typeof window.openai})",
        ),
      ).toEqual({
        process: "undefined",
        require: "undefined",
        ipcRenderer: "undefined",
        api: "undefined",
        electron: "undefined",
        openai: "undefined",
      });
      const facts = await application.evaluate(({ webContents }, id) => {
        const guest = webContents.fromId(id)!;
        return {
          preferences: (
            guest as unknown as { getLastWebPreferences(): Electron.WebPreferences }
          ).getLastWebPreferences(),
          storage: guest.session.getStoragePath(),
        };
      }, id);
      expect(facts.storage).toBeNull();
      expect(facts.preferences).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        allowRunningInsecureContent: false,
        webSecurity: true,
        disableDialogs: true,
      });
      expect(facts.preferences.preload || "").toBe("");
      expect(facts.preferences.plugins ?? false).toBe(false);
      const headers = await execute<{
        csp: string;
        nosniff: string;
        cors: string | null;
        cache: string;
      }>(
        "fetch('trace.json').then(r=>({csp:r.headers.get('content-security-policy'),nosniff:r.headers.get('x-content-type-options'),cors:r.headers.get('access-control-allow-origin'),cache:r.headers.get('cache-control')}))",
      );
      expect(headers).toEqual({
        csp: PAGE_FILE_HTML_CSP,
        nosniff: "nosniff",
        cors: null,
        cache: "no-store",
      });
      expect(await execute("fetch('trace.json',{method:'POST'}).then(r=>r.status)")).toBe(405);
      expect(
        await execute(
          "fetch('trace.json',{method:'HEAD'}).then(async r=>({status:r.status,body:await r.text()}))",
        ),
      ).toEqual({ status: 200, body: "" });
      expect(await execute("fetch('huge.json').then(r=>r.status)")).toBe(413);
      expect(
        await application.evaluate(() => globalThis.pageFileFixture.facts().reads),
      ).not.toContain("huge");
      await execute("location.hash='chart'");
      expect(
        await application.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), id),
      ).toBe(claim.url + "#chart");
    }),
  60_000,
);

test(
  "answers prefers-color-scheme with the theme the app asked for",
  () =>
    withGuest(async ({ application, page, execute }) => {
      const prefersDark = "matchMedia('(prefers-color-scheme: dark)').matches";
      await expect.poll(() => execute<boolean>(prefersDark)).toBe(false);
      const dark = await application.evaluate(() =>
        globalThis.pageFileFixture.admit({ colorScheme: "dark" }),
      );
      if (dark.status !== "admitted") throw new Error(dark.message);
      const id = await attach(page, dark.admission);
      await expect
        .poll(() =>
          application.evaluate(
            ({ webContents }, { id, script }) =>
              webContents.fromId(id)!.executeJavaScript(script, false) as Promise<boolean>,
            { id, script: prefersDark },
          ),
        )
        .toBe(true);
    }),
  60_000,
);

test(
  "serves only the admitted Page entries and denies grants from other sessions or owners",
  () =>
    withGuest(async ({ application, execute, claim, id }) => {
      const other = await application.evaluate(() => globalThis.pageFileFixture.admit());
      if (other.status !== "admitted") throw new Error(other.message);
      expect(
        await application.evaluate(
          (_electron, claim) =>
            globalThis.pageFileFixture.attachToWrongOwner(claim.partition, claim.url),
          other.admission,
        ),
      ).toBe(true);
      for (const url of [
        "/other-page/secret.json",
        "/arbitrary-file-id",
        "/body-only.json",
        "/standalone.html",
        "app://renderer/index.html",
        "file:///etc/passwd",
        "nodex://files/arbitrary-file-id",
        other.admission.url,
      ]) {
        const result = await execute<{ ok: boolean; text: string }>(
          `fetch(${JSON.stringify(url)}).then(async r=>({ok:r.ok,text:await r.text()})).catch(()=>({ok:false,text:''}))`,
        );
        expect(result).toEqual({ ok: false, text: "" });
      }
      expect(
        await application.evaluate(() => globalThis.pageFileFixture.admit({ fileId: "missing" })),
      ).toMatchObject({ status: "refused" });
      await application.evaluate(() => globalThis.pageFileFixture.setAvailable(false));
      expect(
        await execute("fetch('trace.json').then(async r=>({status:r.status,text:await r.text()}))"),
      ).toEqual({ status: 404, text: "" });
      await application.evaluate(() => globalThis.pageFileFixture.setAvailable(true));
      await application.evaluate(
        (_electron, grant) => globalThis.pageFileFixture.release(grant),
        other.admission.grant,
      );
      expect(
        await execute(
          `fetch(${JSON.stringify(other.admission.url)}).then(r=>r.ok).catch(()=>false)`,
        ),
      ).toBe(false);
      await application.evaluate(
        (_electron, grant) => globalThis.pageFileFixture.release(grant),
        claim.grant,
      );
      expect(await application.evaluate(({ webContents }, id) => !webContents.fromId(id), id)).toBe(
        true,
      );
      const expired = await application.evaluate(
        async ({ session }, { partition, url }) =>
          session
            .fromPartition(partition)
            .fetch(url)
            .then(async (r) => ({ ok: r.ok, bytes: (await r.arrayBuffer()).byteLength }))
            .catch(() => ({ ok: false, bytes: 0 })),
        claim,
      );
      expect(expired).toEqual({ ok: false, bytes: 0 });
    }),
  60_000,
);

test("keeps HTTP and WebSocket sentinels untouched across every report egress mechanism", async () => {
  let requests = 0;
  let sockets = 0;
  let tcpConnections = 0;
  let datagrams = 0;
  const udp = createSocket("udp4");
  udp.on("message", () => {
    datagrams++;
  });
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const udpPort = udp.address().port;
  const server = createServer((_request, response) => {
    requests++;
    response.end("sentinel");
  });
  server.on("connection", () => {
    tcpConnections++;
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", () => {
    sockets++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing sentinel address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await withGuest(async ({ application, execute, id, claim }) => {
      const windows = await application.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      );
      await execute(`(async()=>{
        const base=${JSON.stringify(origin)};window.attempts=[];
        const attempt=(name,fn)=>{window.attempts.push(name);try{fn()}catch{}};
        attempt('image',()=>{const v=new Image();v.src=base+'/image';document.body.append(v)});
        attempt('script',()=>{const v=document.createElement('script');v.src=base+'/script';document.body.append(v)});
        attempt('css',()=>{const v=document.createElement('style');v.textContent='@import url('+base+'/import); body{background-image:url('+base+'/css)}';document.head.append(v)});
        attempt('fetch',()=>fetch(base+'/fetch').catch(()=>{}));
        attempt('xhr',()=>{const v=new XMLHttpRequest();v.open('GET',base+'/xhr');v.send()});
        attempt('websocket',()=>new WebSocket(base.replace('http:','ws:')+'/socket'));
        attempt('beacon',()=>navigator.sendBeacon(base+'/beacon','secret'));
        attempt('form',()=>{const v=document.createElement('form');v.action=base+'/form';v.method='POST';document.body.append(v);v.submit()});
        attempt('refresh',()=>{const v=document.createElement('meta');v.httpEquiv='refresh';v.content='0;url='+base+'/refresh';document.head.append(v)});
        attempt('popup',()=>window.open(base+'/popup'));
        attempt('location',()=>{setTimeout(()=>{location.href=base+'/location'},50)});
        attempt('preconnect',()=>{const v=document.createElement('link');v.rel='preconnect';v.href=base;document.head.append(v)});
        attempt('webrtc',()=>{window.peers=[];for(const urls of ['stun:127.0.0.1:${udpPort}','turn:127.0.0.1:${address.port}?transport=tcp']){const v=new RTCPeerConnection({iceServers:[{urls,username:'probe',credential:'probe'}]});window.peers.push(v);v.createDataChannel('x');v.createOffer().then((offer)=>v.setLocalDescription(offer)).catch(()=>{})}});
      })()`);
      expect(await execute("window.attempts")).toEqual([
        "image",
        "script",
        "css",
        "fetch",
        "xhr",
        "websocket",
        "beacon",
        "form",
        "refresh",
        "popup",
        "location",
        "preconnect",
        "webrtc",
      ]);
      // Exercise the Session request gate independently of document CSP.
      expect(
        await application.evaluate(
          async ({ webContents }, { id, origin }) =>
            webContents
              .fromId(id)!
              .session.fetch(origin + "/session-gate")
              .then(() => true)
              .catch(() => false),
          { id, origin },
        ),
      ).toBe(false);
      // Leave time for ICE gathering to send STUN requests if UDP were reachable.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(
        await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      ).toBe(windows);
      expect(
        await application.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), id),
      ).toBe(claim.url);
      expect(await application.evaluate(() => globalThis.pageFileFixture.facts().opened)).toEqual(
        [],
      );
    });
    expect({ requests, sockets, datagrams, tcpConnections }).toEqual({
      requests: 0,
      sockets: 0,
      datagrams: 0,
      tcpConnections: 0,
    });
  } finally {
    udp.close();
    await new Promise<void>((resolve) => websocket.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 60_000);

test(
  "denies permissions and downloads, opens links only after native input, and never reuses storage",
  () =>
    withGuest(async ({ application, page, execute, claim, id }) => {
      expect(await execute("Notification.requestPermission()")).toBe("denied");
      expect(
        await execute("navigator.permissions.query({name:'geolocation'}).then(v=>v.state)"),
      ).toBe("denied");
      await execute(
        "localStorage.setItem('secret','yes');new Promise((resolve,reject)=>{const r=indexedDB.open('private');r.onsuccess=()=>{r.result.close();resolve(true)};r.onerror=()=>reject(r.error)})",
      );
      await execute(
        "{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['secret'],{type:'application/octet-stream'}));a.download='report.bin';document.body.append(a);a.click()}",
      );
      await expect
        .poll(() =>
          application.evaluate(() => globalThis.pageFileFixture.facts().cancelledDownloads),
        )
        .toBe(1);
      await execute("document.getElementById('external').click()");
      expect(await application.evaluate(() => globalThis.pageFileFixture.facts().opened)).toEqual(
        [],
      );
      await application.evaluate(async ({ webContents }, id) => {
        const guest = webContents.fromId(id)!;
        const point = await guest.executeJavaScript(
          "(()=>{const r=document.getElementById('external').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
        );
        guest.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
        guest.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
      }, id);
      await expect
        .poll(() => application.evaluate(() => globalThis.pageFileFixture.facts().opened))
        .toEqual(["https://example.com/report"]);
      await application.evaluate(
        (_electron, grant) => globalThis.pageFileFixture.release(grant),
        claim.grant,
      );
      const next = await application.evaluate(() => globalThis.pageFileFixture.admit());
      if (next.status !== "admitted") throw new Error(next.message);
      expect(next.admission.partition).not.toBe(claim.partition);
      const nextId = await attach(page, next.admission);
      expect(
        await application.evaluate(
          async ({ webContents }, id) =>
            webContents
              .fromId(id)!
              .executeJavaScript(
                "Promise.all([Promise.resolve(localStorage.getItem('secret')),indexedDB.databases().then(v=>v.map(x=>x.name))])",
              ),
          nextId,
        ),
      ).toEqual([null, []]);
    }),
  60_000,
);

test(
  "revokes in-flight reads on release, renderer reload, and Store replacement",
  () =>
    withGuest(async ({ application, page, execute, claim, id }) => {
      await execute("window.pendingRead=fetch('slow.json').then(r=>r.text()).catch(()=>null);true");
      await expect
        .poll(() => application.evaluate(() => globalThis.pageFileFixture.facts().pending))
        .toBe(1);
      await application.evaluate(
        (_electron, grant) => globalThis.pageFileFixture.release(grant),
        claim.grant,
      );
      await expect
        .poll(() => application.evaluate(() => globalThis.pageFileFixture.facts().interrupted))
        .toBe(1);
      expect(await application.evaluate(({ webContents }, id) => !webContents.fromId(id), id)).toBe(
        true,
      );
      const next = await application.evaluate(() => globalThis.pageFileFixture.admit());
      if (next.status !== "admitted") throw new Error(next.message);
      const nextId = await attach(page, next.admission);
      await application.evaluate(() => globalThis.pageFileFixture.replaceStore());
      expect(
        await application.evaluate(
          async ({ webContents }, id) =>
            webContents
              .fromId(id)!
              .executeJavaScript(
                "fetch('trace.json').then(async r=>({status:r.status,body:await r.text()}))",
              ),
          nextId,
        ),
      ).toEqual({ status: 404, body: "" });
      await page.reload();
      await expect
        .poll(() => application.evaluate(({ webContents }, id) => !webContents.fromId(id), nextId))
        .toBe(true);
      expect(
        await application.evaluate(
          (_electron, grant) => globalThis.pageFileFixture.release(grant),
          next.admission.grant,
        ),
      ).toBe(false);
    }),
  60_000,
);
