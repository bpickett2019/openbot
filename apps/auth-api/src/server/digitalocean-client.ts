import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Context, Effect, Layer, Schema } from "effect";

export type DigitalOceanFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Provider response text and transport causes can contain credentials. Do not retain them. */
export class DigitalOceanError extends Schema.TaggedError<DigitalOceanError>()("DigitalOceanError", {
  status: Schema.Number,
  code: Schema.String,
}) {}

const DropletSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  status: Schema.Literals(["new", "active", "off", "archive"]),
  locked: Schema.Boolean,
  vcpus: Schema.Number,
  memory: Schema.Number,
  size_slug: Schema.String,
  region: Schema.Struct({ slug: Schema.String }),
  image: Schema.Struct({ id: Schema.Number }),
  volume_ids: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
});
export type DigitalOceanDroplet = typeof DropletSchema.Type;
const VolumeSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  size_gigabytes: Schema.Number,
  filesystem_type: Schema.String,
  region: Schema.Struct({ slug: Schema.String }),
  droplet_ids: Schema.NullOr(Schema.Array(Schema.Number)),
});
export type DigitalOceanVolume = typeof VolumeSchema.Type;
const ActionSchema = Schema.Struct({
  id: Schema.Number,
  status: Schema.Literals(["in-progress", "completed", "errored"]),
  type: Schema.String,
  started_at: Schema.String,
  resource_id: Schema.NullOr(Schema.Number),
});
export type DigitalOceanAction = typeof ActionSchema.Type;
const SizeSchema = Schema.Struct({
  slug: Schema.String,
  memory: Schema.Number,
  vcpus: Schema.Number,
  available: Schema.Boolean,
  regions: Schema.Array(Schema.String),
});
class Transport extends Context.Service<Transport, { token: string; fetch: DigitalOceanFetch }>()(
  "auth-api/DigitalOceanTransport",
) {}

const request = Effect.fn("DigitalOcean.request")(function* (method: string, path: string, body?: unknown) {
  const transport = yield* Transport;
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      transport.fetch(`https://api.digitalocean.com/v2${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${transport.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      }),
    catch: () => new DigitalOceanError({ status: 503, code: "provider_transport_uncertain" }),
  });
  if (!response.ok) {
    const responseBody = response.body;
    if (responseBody) yield* Effect.tryPromise(() => responseBody.cancel()).pipe(Effect.ignore);
    return yield* new DigitalOceanError({ status: response.status, code: "provider_http_error" });
  }
  if (response.status === 204) return null;
  return yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: () => new DigitalOceanError({ status: 502, code: "provider_response_uncertain" }),
  });
});
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new DigitalOceanError({ status: 502, code: "provider_response_invalid" })),
  );

/** All mutation replay decisions belong to HostedServerService's durable operation records. */
export class DigitalOceanClient {
  readonly #layer: Layer.Layer<Transport>;
  constructor(options: { token: string; fetch?: DigitalOceanFetch }) {
    this.#layer = Layer.succeed(Transport, {
      token: options.token,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    });
  }

  readonly checkSize = Effect.fn("DigitalOcean.checkSize")(
    function* (size: string, region: string) {
      let page = 1;
      while (true) {
        const payload = yield* request("GET", `/sizes?per_page=200&page=${page}`);
        const decoded = yield* decode(Schema.Struct({ sizes: Schema.Array(SizeSchema) }), payload);
        const match = decoded.sizes.find((entry) => entry.slug === size);
        if (match) {
          if (!match.available || match.vcpus !== 4 || match.memory !== 8192 || !match.regions.includes(region))
            return yield* new DigitalOceanError({ status: 409, code: "provider_size_unavailable" });
          return;
        }
        if (!hasNextPage(payload))
          return yield* new DigitalOceanError({ status: 409, code: "provider_size_unavailable" });
        page += 1;
      }
    },
    (effect) => effect.pipe(Effect.provide(this.#layer)),
  );

  readonly getDroplet = Effect.fn("DigitalOcean.getDroplet")(
    function* (id: number) {
      const payload = yield* request("GET", `/droplets/${id}`);
      return (yield* decode(Schema.Struct({ droplet: DropletSchema }), payload)).droplet;
    },
    (effect) => effect.pipe(Effect.provide(this.#layer)),
  );

  readonly findDroplets = Effect.fn("DigitalOcean.findDroplets")(
    function* (tag: string) {
      const found: DigitalOceanDroplet[] = [];
      let page = 1;
      while (true) {
        const payload = yield* request(
          "GET",
          `/droplets?tag_name=${encodeURIComponent(tag)}&per_page=200&page=${page}`,
        );
        const decoded = yield* decode(Schema.Struct({ droplets: Schema.Array(DropletSchema) }), payload);
        found.push(...decoded.droplets);
        if (!hasNextPage(payload)) return found;
        page += 1;
      }
    },
    (effect) => effect.pipe(Effect.provide(this.#layer)),
  );

  readonly createDroplet = Effect.fn("DigitalOcean.createDroplet")(
    function* (input: {
      name: string;
      tag: string;
      region: string;
      size: string;
      image: number;
      volumeId: string;
      userData: string;
    }) {
      const payload = yield* request("POST", "/droplets", {
        name: input.name,
        region: input.region,
        size: input.size,
        image: input.image,
        volumes: [input.volumeId],
        tags: [input.tag],
        user_data: input.userData,
        backups: false,
        ipv6: false,
        monitoring: false,
      });
      return (yield* decode(Schema.Struct({ droplet: DropletSchema }), payload)).droplet;
    },
    (effect) => effect.pipe(Effect.provide(this.#layer)),
  );

  readonly getVolume = Effect.fn("DigitalOcean.getVolume")(
    function* (id: string) {
      const payload = yield* request("GET", `/volumes/${encodeURIComponent(id)}`);
      return (yield* decode(Schema.Struct({ volume: VolumeSchema }), payload)).volume;
    },
    (effect) => effect.pipe(Effect.provide(this.#layer)),
  );

  readonly findVolume = Effect.fn("DigitalOcean.findVolume")(
    function* (name: string, region: string) {
      const payload = yield* request(
        "GET",
        `/volumes?name=${encodeURIComponent(name)}&region=${encodeURIComponent(region)}&per_page=200`,
      );
      const decoded = yield* decode(Schema.Struct({ volumes: Schema.Array(VolumeSchema) }), payload);
      if (hasNextPage(payload) || decoded.volumes.length > 1)
        return yield* new DigitalOceanError({ status: 409, code: "provider_identity_conflict" });
      return decoded.volumes[0] ?? null;
    },
    (effect) => effect.pipe(Effect.provide(this.#layer)),
  );

  readonly createVolume = Effect.fn("DigitalOcean.createVolume")(
    function* (name: string, region: string, hostId: string) {
      const payload = yield* request("POST", "/volumes", {
        name,
        region,
        size_gigabytes: 100,
        filesystem_type: "ext4",
        description: `OpenBot host ${hostId}. Retain until owner-confirmed deletion.`,
      });
      return (yield* decode(Schema.Struct({ volume: VolumeSchema }), payload)).volume;
    },
    (effect) => effect.pipe(Effect.provide(this.#layer)),
  );

  readonly actions = Effect.fn("DigitalOcean.actions")(
    function* (id: number, since: number) {
      const found: DigitalOceanAction[] = [];
      let page = 1;
      while (true) {
        const payload = yield* request("GET", `/droplets/${id}/actions?per_page=200&page=${page}`);
        const decoded = yield* decode(Schema.Struct({ actions: Schema.Array(ActionSchema) }), payload);
        found.push(...decoded.actions.filter((action) => Date.parse(action.started_at) >= since - 1000));
        if (!hasNextPage(payload)) return found;
        page += 1;
      }
    },
    (effect) => effect.pipe(Effect.provide(this.#layer)),
  );

  readonly act = Effect.fn("DigitalOcean.act")(
    function* (id: number, type: "power_on" | "shutdown" | "power_off") {
      const payload = yield* request("POST", `/droplets/${id}/actions`, { type });
      return (yield* decode(Schema.Struct({ action: ActionSchema }), payload)).action;
    },
    (effect) => effect.pipe(Effect.provide(this.#layer)),
  );

  deleteDroplet(id: number) {
    return request("DELETE", `/droplets/${id}`).pipe(Effect.asVoid, Effect.provide(this.#layer));
  }
  deleteVolume(id: string) {
    return request("DELETE", `/volumes/${encodeURIComponent(id)}`).pipe(Effect.asVoid, Effect.provide(this.#layer));
  }
}

function hasNextPage(value: unknown): boolean {
  return (
    isDynamicRecord(value) &&
    isDynamicRecord(value.links) &&
    isDynamicRecord(value.links.pages) &&
    typeof value.links.pages.next === "string"
  );
}

export function isDefinitiveProviderRefusal(error: DigitalOceanError): boolean {
  return [400, 401, 403, 404, 422, 429].includes(error.status) && error.code === "provider_http_error";
}
