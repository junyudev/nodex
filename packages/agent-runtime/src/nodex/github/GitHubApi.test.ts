import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { GitHubApi, GitHubApiNotFoundError, sourceApiLayer } from "../GitHubSource.ts";

/** A GitHub that answers every GraphQL request with `body`, as GitHub does: HTTP 200. */
const githubAnswering = (body: unknown) =>
  sourceApiLayer(() =>
    Effect.succeed({ token: Redacted.make("token"), fingerprint: "fingerprint" }),
  ).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body))),
        ),
      ),
    ),
  );

const read = (body: unknown, allowMissingFields: boolean) =>
  Effect.gen(function* () {
    const api = yield* GitHubApi;
    return yield* api.graphql({
      host: "github.com",
      operation: "test.read",
      query: "query { r0: repository { id } r1: repository { id } }",
      allowMissingFields,
      allowReserve: true,
    });
  }).pipe(Effect.provide(githubAnswering(body)));

const missingField = (path?: readonly string[]) => ({
  data: { r0: { id: "found" }, r1: null },
  errors: [{ type: "NOT_FOUND", ...(path ? { path } : {}), message: "Could not resolve" }],
});

describe("GitHub GraphQL answers", () => {
  it.effect("keep partial data for a request that allows missing fields", () =>
    Effect.gen(function* () {
      const body = yield* read(missingField(["r1"]), true);
      expect(JSON.parse(body).data).toEqual({ r0: { id: "found" }, r1: null });
    }),
  );

  it.effect("stay not found for any other request, or an error no field owns", () =>
    Effect.gen(function* () {
      for (const [body, allowMissingFields] of [
        [missingField(["r1"]), false],
        [missingField(), true],
        [missingField([]), true],
      ] as const) {
        const error = yield* Effect.flip(read(body, allowMissingFields));
        expect(error).toBeInstanceOf(GitHubApiNotFoundError);
      }
    }),
  );
});
