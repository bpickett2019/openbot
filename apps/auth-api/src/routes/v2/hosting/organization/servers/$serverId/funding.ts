import { createFileRoute } from "@tanstack/solid-router";
import { Effect } from "effect";
import { runApiResponse } from "../../../../../../server/effect-runtime";
import { readJsonObject } from "../../../../../../server/json-body";
import { hostedServerErrorResponse, json, requestHostedServerService } from "../../../../../../server/request-auth";

export const Route = createFileRoute("/v2/hosting/organization/servers/$serverId/funding")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        runApiResponse(
          Effect.gen(function* () {
            const hosting = requestHostedServerService();
            yield* Effect.try({
              try: () => hosting.authorizeOperator(request.headers.get("Authorization")),
              catch: (error) => error,
            });
            const body = yield* readJsonObject(request);
            return json({ server: yield* hosting.operatorFunding(params.serverId, body) });
          }),
          hostedServerErrorResponse,
        ),
    },
  },
});
