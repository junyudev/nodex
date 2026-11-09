// Only selected by Metro's explicit tls-proof variant, never imported by the product.
import React, { useEffect, useState } from "react";
import { Linking, Platform, Text, View } from "react-native";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { pinnedTls } from "../src/runtime/expo-platform";
import { decodeUtf8, encodeUtf8 } from "../src/runtime/encoding";

type Route = { name: string; https: string; wss: string };

export function App() {
  const [status, setStatus] = useState("Waiting for TLS proof link");
  useEffect(() => {
    let running = false;
    const run = async (url: string | null | undefined) => {
      if (!url || running) return;
      running = true;
      const control = new URL(url).searchParams.get("control");
      if (!control) return;
      const report: Record<string, unknown> = { platform: Platform.OS };
      const phase = async (name: string) => {
        setStatus(name);
        await fetch(`${control}/phase/${name}`, { method: "POST" });
      };
      try {
        const config: { routes: Route[]; pin: string } = await (
          await fetch(`${control}/config`)
        ).json();
        const [loopback] = config.routes;
        if (!loopback) throw new Error("no proof routes");
        const endpoint = { fingerprint: config.pin.toUpperCase(), timeoutMs: 3000 };
        // The same self-signed, pinned certificate at every address form: IP, name and tailnet.
        for (const route of config.routes) {
          await phase(`route-${route.name}`);
          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const response = yield* pinnedTls.request({
                  ...endpoint,
                  url: `${route.https}/echo`,
                  method: "POST",
                  headers: { Authorization: "proof-secret", "x-proof": "request" },
                  body: new Uint8Array([0, 255, 128, 42]),
                });
                if (
                  response.status !== 201 ||
                  response.body.join() !== "0,255,128,42" ||
                  response.headers["x-proof"] !== "request"
                )
                  throw new Error(`${route.name}: request round-trip failed`);
                const ws = yield* pinnedTls.openSocket({
                  ...endpoint,
                  url: `${route.wss}/echo`,
                  headers: { Authorization: "proof-secret" },
                });
                yield* ws.send("hello π");
                const text = yield* ws.take;
                if (text.type !== "message" || text.data !== "hello π")
                  throw new Error(`${route.name}: text echo failed`);
                yield* ws.send(new Uint8Array([0, 255, 128, 42]));
                const binary = yield* ws.take;
                if (
                  binary.type !== "message" ||
                  typeof binary.data === "string" ||
                  binary.data.join() !== "0,255,128,42"
                )
                  throw new Error(`${route.name}: binary echo failed`);
                yield* ws.close;
              }),
            ),
          );
          report[`route-${route.name}`] = true;
        }
        // Framing, close codes and the request deadline that the connection runtime relies on.
        await phase("behaviour");
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const chunked = yield* pinnedTls.request({
                ...endpoint,
                url: `${loopback.https}/chunked`,
              });
              if (
                chunked.status !== 200 ||
                chunked.headers["transfer-encoding"] !== "chunked" ||
                decodeUtf8(chunked.body) !== "hello chunked world"
              )
                throw new Error(`chunked response failed: ${JSON.stringify(chunked.headers)}`);
              const ws = yield* pinnedTls.openSocket({
                ...endpoint,
                url: `${loopback.wss}/close-4403`,
              });
              const closed = yield* ws.take;
              if (closed.type !== "close" || closed.code !== 4403)
                throw new Error(`close code failed: ${JSON.stringify(closed)}`);
              const timedOut = yield* Effect.result(
                pinnedTls.request({ ...endpoint, timeoutMs: 500, url: `${loopback.https}/hang` }),
              );
              if (!Result.isFailure(timedOut) || timedOut.failure.code !== "timeout")
                throw new Error(`request deadline failed: ${JSON.stringify(timedOut)}`);
            }),
          ),
        );
        report.behaviour = true;
        const reject = async (pin: string, label: string) => {
          await phase(label);
          const failures: Record<string, unknown> = {};
          for (const route of config.routes) {
            const http = await Effect.runPromise(
              Effect.result(
                pinnedTls.request({
                  ...endpoint,
                  fingerprint: pin,
                  url: `${route.https}/secret`,
                  method: "POST",
                  headers: { Authorization: "proof-secret" },
                  body: encodeUtf8("secret"),
                }),
              ),
            );
            const ws = await Effect.runPromise(
              Effect.result(
                Effect.scoped(
                  pinnedTls.openSocket({
                    ...endpoint,
                    fingerprint: pin,
                    url: `${route.wss}/secret`,
                    headers: { Authorization: "proof-secret" },
                  }),
                ),
              ),
            );
            if (
              !Result.isFailure(http) ||
              http.failure.code !== "pin" ||
              !Result.isFailure(ws) ||
              ws.failure.code !== "pin"
            )
              throw new Error(`${label} at ${route.name}: ${JSON.stringify({ http, ws })}`);
            failures[route.name] = { http: http.failure.code, ws: ws.failure.code };
          }
          report[label] = true;
          report[`${label}-failures`] = failures;
        };
        await reject("00".repeat(32), "wrong-pin");
        await fetch(`${control}/rotate`, { method: "POST" });
        await reject(config.pin, "replaced-cert");
        const next = await (await fetch(`${control}/config`)).json();
        await phase("cancel");
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const request = yield* Effect.forkChild(
                pinnedTls.request({
                  ...endpoint,
                  fingerprint: next.pin,
                  url: `${loopback.https}/hang`,
                }),
              );
              const ws = yield* pinnedTls.openSocket({
                ...endpoint,
                fingerprint: next.pin,
                url: `${loopback.wss}/abandon`,
              });
              yield* ws.send("scope-owned");
              yield* ws.take;
              yield* Effect.sleep("500 millis");
              yield* Fiber.interrupt(request);
              // Leaving this scope cancels the abandoned socket without an explicit close.
            }),
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        report.cancel = true;
        report.ok = true;
      } catch (error) {
        report.ok = false;
        report.error = String(error);
      }
      await fetch(`${control}/result`, { method: "POST", body: JSON.stringify(report) });
      setStatus(JSON.stringify(report, null, 2));
    };
    void Linking.getInitialURL().then((url) =>
      run(
        url ??
          `nodex-mobile-tls-proof://run?control=${encodeURIComponent(Platform.OS === "ios" ? "http://127.0.0.1:19444" : "http://10.0.2.2:19444")}`,
      ),
    );
    const listener = Linking.addEventListener("url", ({ url }) => {
      void run(url);
    });
    return () => listener.remove();
  }, []);
  return (
    <View style={{ padding: 30, paddingTop: 100 }}>
      <Text selectable>{status}</Text>
    </View>
  );
}
