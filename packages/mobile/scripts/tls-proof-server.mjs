#!/usr/bin/env node
// Fresh keys/certificates and a loopback-only control plane; no product credentials.
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import http from "node:http";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";

const [platform, output] = process.argv.slice(2);
if (!output || !["ios", "android"].includes(platform))
  throw new Error("Usage: node tls-proof-server.mjs ios|android <artifact-dir>");
const loopback = platform === "android" ? "10.0.2.2" : "127.0.0.1";
// The emulator has no name for its host's loopback, so the DNS route is proven on iOS.
const dnsHost =
  platform === "ios" ? (process.env.NODEX_TLS_PROOF_DNS_HOST ?? "nodex-tls-proof.localhost") : null;
if (dnsHost) {
  if (isIP(dnsHost) || !dnsHost.includes(".") || dnsHost.endsWith(".local"))
    throw new Error("DNS proof needs a qualified hostname, not an address or a .local name");
  const addresses = await lookup(dnsHost, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => address !== "127.0.0.1" && address !== "::1")
  )
    throw new Error("DNS proof hostname must resolve only to loopback");
  console.log(
    `DNS proof: ${dnsHost} resolves to ${addresses.map(({ address }) => address).join(", ")}`,
  );
}
// A tailnet (CGNAT, 100.64.0.0/10) address of this host, which the device dials directly.
const tailnet = process.env.NODEX_TLS_PROOF_TAILNET ?? null;
if (tailnet) {
  const [a, b] = tailnet.split(".").map(Number);
  const local = Object.values(networkInterfaces())
    .flat()
    .some((address) => address?.address === tailnet);
  if (isIP(tailnet) !== 4 || a !== 100 || b < 64 || b > 127 || !local)
    throw new Error("NODEX_TLS_PROOF_TAILNET must be this host's own 100.64.0.0/10 address");
}
const routes = [
  { name: "loopback", host: loopback, sni: null },
  ...(dnsHost ? [{ name: "dns", host: dnsHost, sni: dnsHost }] : []),
  ...(tailnet ? [{ name: "tailnet", host: tailnet, sni: null, bind: tailnet }] : []),
];
const san = ["-addext", `subjectAltName=${dnsHost ? `DNS:${dnsHost}` : "DNS:proof.invalid"}`];
mkdirSync(output, { recursive: true });
const file = (name) => resolve(output, `${platform}-${name}`);
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    file("key.pem"),
    "-out",
    file("first.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=wrong-host.invalid",
    ...san,
  ],
  { stdio: "ignore" },
);
// Same key, different full certificate: an SPKI implementation would incorrectly accept it.
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-new",
    "-key",
    file("key.pem"),
    "-out",
    file("replacement.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=replacement.invalid",
    ...san,
  ],
  { stdio: "ignore" },
);
let cert = readFileSync(file("first.pem"));
const key = readFileSync(file("key.pem"));
let phase = "initial";
const evidence = {};
const counter = () =>
  (evidence[phase] ??= {
    requests: 0,
    upgrades: 0,
    applicationBytes: 0,
    closed: [],
    messages: [],
    handshakes: [],
  });
const events = [];
const record = (event) => {
  events.push({ time: new Date().toISOString(), phase, ...event });
  writeFileSync(file("events.json"), JSON.stringify(events, null, 2));
};
const handle = (request, response) => {
  counter().requests++;
  const current = counter();
  const requestPhase = phase;
  record({
    type: "request",
    method: request.method,
    path: request.url,
    headers: request.headers,
    local: request.socket.localAddress,
  });
  request.socket.on("close", () => {
    current.closed.push(request.url);
    record({ phase: requestPhase, type: "http-close", path: request.url });
  });
  if (request.url === "/hang") return;
  if (request.url === "/chunked") {
    // No length: HTTP/1.1 frames this body with chunked coding.
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("hello ");
    setTimeout(() => response.end("chunked world"), 50);
    return;
  }
  const chunks = [];
  request.on("data", (data) => chunks.push(data));
  request.on("end", () => {
    response.writeHead(201, { "x-proof": request.headers["x-proof"] ?? "echo" });
    response.end(Buffer.concat(chunks));
  });
};
const ws = new WebSocketServer({ noServer: true });
const servers = [...new Set(routes.map((route) => route.bind ?? "127.0.0.1"))].map((address) => {
  const server = https.createServer({ key, cert, minVersion: "TLSv1.2" }, handle);
  server.on("secureConnection", (socket) => {
    const current = counter();
    const handshake = {
      version: socket.getProtocol(),
      alpn: socket.alpnProtocol,
      servername: socket.servername || null,
      local: socket.localAddress,
    };
    current.handshakes.push(handshake);
    record({ type: "tls", ...handshake });
    socket.on("data", (data) => {
      current.applicationBytes += data.length;
    });
  });
  server.on("tlsClientError", (error, socket) =>
    record({
      type: "tls-rejected",
      message: error.message,
      servername: socket.servername || null,
      local: socket.localAddress,
    }),
  );
  server.on("upgrade", (request, socket, head) => {
    counter().upgrades++;
    const current = counter();
    const socketPhase = phase;
    record({ type: "upgrade", path: request.url, headers: request.headers });
    ws.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (bytes, binary) => {
        current.messages.push({ binary, body: bytes.toString("base64") });
        client.send(bytes, { binary });
      });
      client.on("close", (code) => {
        current.closed.push(request.url);
        record({ phase: socketPhase, type: "ws-close", path: request.url, code });
      });
      // The host's own close codes (4401 renew, 4403 revoked, 4406 incompatible) reach the app.
      if (request.url === "/close-4403") client.close(4403, "revoked");
    });
  });
  server.listen(19443, address);
  return server;
});
const control = http.createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/config") {
    response.end(
      JSON.stringify({
        routes: routes.map(({ name, host }) => ({
          name,
          https: `https://${host}:19443`,
          wss: `wss://${host}:19443`,
        })),
        pin: new X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase(),
      }),
    );
    return;
  }
  if (request.url.startsWith("/phase/")) {
    phase = request.url.slice(7);
    counter();
    response.end("{}");
    return;
  }
  if (request.url === "/rotate") {
    cert = readFileSync(file("replacement.pem"));
    for (const server of servers) server.setSecureContext({ key, cert, minVersion: "TLSv1.2" });
    response.end("{}");
    return;
  }
  if (request.url === "/result") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = JSON.parse(Buffer.concat(chunks).toString());
    const observedClose = (phase, type, path) =>
      events.some((event) => event.phase === phase && event.type === type && event.path === path);
    // Every route round-trips HTTP and WebSocket bytes at its own address, with SNI only for names.
    const reached = Object.fromEntries(
      routes.map((route) => {
        const proof = evidence[`route-${route.name}`];
        const handshakes = proof?.handshakes ?? [];
        return [
          route.name,
          result[`route-${route.name}`] === true &&
            proof?.requests >= 1 &&
            proof?.upgrades >= 1 &&
            observedClose(`route-${route.name}`, "ws-close", "/echo") &&
            handshakes.length >= 2 &&
            handshakes.every(
              (handshake) =>
                handshake.servername === route.sni &&
                handshake.alpn === "http/1.1" &&
                (!route.bind || handshake.local === route.bind),
            ),
        ];
      }),
    );
    const rejected = ["wrong-pin", "replaced-cert"].every(
      (p) =>
        evidence[p]?.requests === 0 &&
        evidence[p]?.upgrades === 0 &&
        evidence[p]?.applicationBytes === 0 &&
        result[p] === true,
    );
    const closed =
      observedClose("cancel", "http-close", "/hang") &&
      observedClose("cancel", "ws-close", "/abandon");
    const behaviour =
      result.behaviour === true &&
      observedClose("behaviour", "http-close", "/chunked") &&
      observedClose("behaviour", "http-close", "/hang") &&
      events.some(
        (event) => event.phase === "behaviour" && event.type === "ws-close" && event.code === 4403,
      );
    const passed =
      result.ok === true &&
      Object.values(reached).every(Boolean) &&
      rejected &&
      closed &&
      behaviour;
    const report = {
      passed,
      result,
      routes: routes.map(({ name, host, sni }) => ({ name, host, sni })),
      reached,
      evidence,
      rejectedBeforeApplicationBytes: rejected,
      cancellationObserved: closed,
      chunkedCloseCodeAndTimeout: behaviour,
      certificates: {
        original: new X509Certificate(readFileSync(file("first.pem"))).fingerprint256,
        replacement: new X509Certificate(cert).fingerprint256,
        samePublicKey: new X509Certificate(cert).publicKey
          .export({ type: "spki", format: "der" })
          .equals(
            new X509Certificate(readFileSync(file("first.pem"))).publicKey.export({
              type: "spki",
              format: "der",
            }),
          ),
      },
    };
    writeFileSync(file("result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    response.end(JSON.stringify({ passed }));
    return;
  }
  response.writeHead(404);
  response.end("{}");
});
control.listen(19444, "127.0.0.1", () =>
  console.log(
    `Ready: ${platform} control :19444 TLS :19443 at ${routes.map(({ host }) => host).join(", ")}`,
  ),
);
