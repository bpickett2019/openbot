import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/solid-router";
import { Effect } from "effect";
import { DigitalOceanClient } from "../../server/digitalocean-client";
import { runApiResponse } from "../../server/effect-runtime";
import { apiError } from "../../server/request-auth";
import { requireWorkerBindings } from "../../server/types";

/** Cache the read-only provider catalog check. This does not prove desktop readiness. */
const CACHE_SECONDS = 60;

const hostingResponse = (healthy: boolean) =>
  Response.json(
    healthy
      ? { service: "openbot-hosted-servers", status: "ok" }
      : { error: { code: "hosting_not_ready", message: "Hosted servers are not available." } },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}`, "X-Content-Type-Options": "nosniff" },
    },
  );

export const Route = createFileRoute("/health/hosting")({
  server: {
    handlers: {
      GET: ({ request }) =>
        runApiResponse(
          Effect.gen(function* () {
            // One cache entry for every query string, so a query cannot skip the cache.
            const cacheKey = new Request(new URL("/health/hosting", request.url));
            // A cache failure changes only the number of read-only provider requests.
            const cache = yield* Effect.tryPromise(() => caches.open("health-hosting")).pipe(
              Effect.orElseSucceed(() => null),
            );
            const cached = cache
              ? yield* Effect.tryPromise(() => cache.match(cacheKey)).pipe(Effect.orElseSucceed(() => undefined))
              : undefined;
            if (cached) return cached;

            const bindings = requireWorkerBindings(env);
            const token = bindings.DIGITALOCEAN_API_TOKEN?.trim();
            const size = bindings.HOSTED_DIGITALOCEAN_SIZE?.trim();
            const region = bindings.HOSTED_DIGITALOCEAN_REGION?.trim();
            const healthy =
              token && size && region
                ? yield* new DigitalOceanClient({ token }).checkSize(size, region).pipe(
                    Effect.as(true),
                    Effect.orElseSucceed(() => false),
                  )
                : false;
            const response = hostingResponse(healthy);
            if (cache) yield* Effect.tryPromise(() => cache.put(cacheKey, response.clone())).pipe(Effect.ignore);
            return response;
          }),
          () => apiError(503, "hosting_not_ready", "Hosted servers are not available."),
        ),
    },
  },
});
