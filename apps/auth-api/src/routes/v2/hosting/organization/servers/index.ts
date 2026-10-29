import { createFileRoute } from "@tanstack/solid-router";
import { Effect } from "effect";
import { runApiResponse } from "../../../../../server/effect-runtime";
import { readJsonObject } from "../../../../../server/json-body";
import { hostedServerErrorResponse, json, requestHostedServerService } from "../../../../../server/request-auth";

export const Route = createFileRoute("/v2/hosting/organization/servers/")({
  server: {
    handlers: {
      GET: ({ request }) =>
        runApiResponse(
          Effect.gen(function* () {
            const hosting = requestHostedServerService();
            yield* Effect.try({
              try: () => hosting.authorizeOperator(request.headers.get("Authorization")),
              catch: (error) => error,
            });
            return json({ servers: yield* hosting.operatorList() });
          }),
          hostedServerErrorResponse,
        ),
      POST: ({ request }) =>
        runApiResponse(
          Effect.gen(function* () {
            const hosting = requestHostedServerService();
            yield* Effect.try({
              try: () => hosting.authorizeOperator(request.headers.get("Authorization")),
              catch: (error) => error,
            });
            const body = yield* readJsonObject(request);
            return json({ server: yield* hosting.operatorCreate(body, request.headers.get("Idempotency-Key")) }, 201);
          }),
          hostedServerErrorResponse,
        ),
    },
  },
});
