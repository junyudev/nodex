import { expect, test } from "vite-plus/test";

import { encodePairingUri, MOBILE_URL_SCHEME, parsePairingUri, type PairingOffer } from "./pairing";

const offer: PairingOffer = {
  hostKey: "A".repeat(43),
  hostName: "开发 🖥️",
  secret: `${"B".repeat(42)}A`,
  routes: ["wss://desktop.example/nodex", "ws://192.168.1.10:9754"],
  expiresAt: 1,
};
const prefix = `${MOBILE_URL_SCHEME}://pair#`;
const uri = encodePairingUri(offer);

test("round trips a UTF-8 pairing offer in the existing base64url format", () => {
  const encoded = uri.slice(prefix.length);
  expect(uri.startsWith(prefix)).toBe(true);
  expect(encoded).toBe(
    "eyJob3N0S2V5IjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsImhvc3RO" +
      "YW1lIjoi5byA5Y-RIPCflqXvuI8iLCJzZWNyZXQiOiJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJC" +
      "QkJCQkJCQkJCQkJBIiwicm91dGVzIjpbIndzczovL2Rlc2t0b3AuZXhhbXBsZS9ub2RleCIsIndzOi8vMTky" +
      "LjE2OC4xLjEwOjk3NTQiXSwiZXhwaXJlc0F0IjoxfQ",
  );
  expect(parsePairingUri(` ${uri}\n`)).toEqual(offer);
});

test.each([
  ["wrong scheme", `https://pair#${uri.slice(prefix.length)}`],
  ["wrong endpoint", uri.replace("://pair#", "://other#")],
  ["missing fragment", prefix.slice(0, -1)],
  ["empty fragment", prefix],
  ["invalid base64url alphabet", `${prefix}++++`],
  ["invalid base64url length", `${prefix}A`],
  ["nonzero base64url padding bits", `${uri.slice(0, -1)}R`],
  ["invalid UTF-8", uri.replace("5byA", "wK8g")],
  ["invalid JSON", `${prefix}ew`],
  ["missing offer fields", `${prefix}e30`],
  ["missing route", encodePairingUri({ ...offer, routes: [] })],
])("rejects a malformed pairing URI with %s", (_, uri) => {
  expect(parsePairingUri(uri)).toBeNull();
});
