import { Deferred, Effect, Schema } from "effect";
import { z } from "zod";
import type { RemoteApiConfig } from "./config";
import { type IceServer, type RemoteTicketClaims, SIGNAL_TURN_CREDENTIAL_TTL_SECONDS } from "./protocol";

const REUSE_MILLISECONDS = 5 * 60_000;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_SESSIONS = 100_000;
const MAXIMUM_RESPONSE_BYTES = 16 * 1024;
const iceServerSchema = z.object({
  urls: z.union([z.string().min(1).max(512), z.array(z.string().min(1).max(512)).min(1).max(16)]),
  username: z.string().min(1).max(512).optional(),
  credential: z.string().min(1).max(512).optional(),
});
const responseSchema = z.object({ iceServers: z.array(iceServerSchema).min(1).max(8) });

export class RemoteTurnError extends Schema.TaggedError<RemoteTurnError>()("RemoteTurnError", {
  message: Schema.String,
}) {}

interface IssuedCredentials {
  servers: IceServer[];
  issuedAt: number;
  validUntil: number;
  expiresAt: number;
  revoked: boolean;
  revoking: Deferred.Deferred<void, RemoteTurnError> | null;
}

interface TurnSession {
  claims: RemoteTicketClaims;
  revoked: boolean;
  issued: IssuedCredentials[];
  pending: Deferred.Deferred<IceServer[], RemoteTurnError> | null;
  nextAttemptAt: number;
}

/** Process-owned credential ledger. Lost process state can only be bounded by the issued TTL. */
export class RealtimeTurn {
  readonly #sessions = new Map<string, TurnSession>();
  readonly #revokedEpochs = new Map<string, number>();
  readonly #revokedSessions = new Map<string, number>();
  constructor(private readonly config: RemoteApiConfig["turn"]) {}

  readonly iceServers = Effect.fn("RealtimeTurn.iceServers")((claims: RemoteTicketClaims) =>
    Effect.gen({ self: this }, function* () {
      const now = Date.now();
      this.#prune(now);
      if (claims.sessionExpiresAt * 1_000 <= now)
        return yield* new RemoteTurnError({ message: "The remote session expired." });
      if (
        (this.#revokedEpochs.get(claims.hostId) ?? 0) > claims.authEpoch ||
        (claims.role !== "host" && this.#revokedSessions.has(claims.sessionId))
      )
        return yield* new RemoteTurnError({ message: "The remote session was revoked." });
      if (!this.config) return yield* new RemoteTurnError({ message: "The TURN issuer is not configured." });
      // A new ticket for the same session shares the quota and the pending mint, including on reconnect.
      const key = JSON.stringify([
        claims.hostId,
        claims.sessionId,
        claims.userId,
        claims.membershipId,
        claims.role,
        claims.authEpoch,
        claims.sessionExpiresAt,
      ]);
      let session = this.#sessions.get(key);
      if (!session) {
        if (this.#sessions.size >= MAXIMUM_SESSIONS)
          return yield* new RemoteTurnError({ message: "The TURN credential capacity is exhausted." });
        session = { claims, revoked: false, issued: [], pending: null, nextAttemptAt: 0 };
        this.#sessions.set(key, session);
      }
      if (session.revoked) return yield* new RemoteTurnError({ message: "The remote session was revoked." });
      const latest = session.issued.at(-1);
      if (latest && !latest.revoked && latest.validUntil > now && now - latest.issuedAt < REUSE_MILLISECONDS)
        return latest.servers;
      if (session.pending) {
        const servers = yield* Deferred.await(session.pending);
        if (session.revoked || claims.sessionExpiresAt * 1_000 <= Date.now())
          return yield* new RemoteTurnError({ message: "The remote session ended during TURN issuance." });
        return servers;
      }
      if (session.nextAttemptAt > now)
        return yield* new RemoteTurnError({ message: "The TURN issuer is temporarily unavailable." });
      // A failed or uncertain mint has the same rate bound as a successful one, not a new quota per retry.
      session.nextAttemptAt = now + REUSE_MILLISECONDS;
      const pending = Deferred.makeUnsafe<IceServer[], RemoteTurnError>();
      session.pending = pending;
      const issuingSession = session;
      // A mint is a mutation. Finish its bounded response and ledger publication even if a socket closes.
      yield* Deferred.complete(pending, this.#mint(session)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            issuingSession.pending = null;
          }),
        ),
        Effect.uninterruptible,
      );
      return yield* Deferred.await(pending);
    }),
  );

  readonly revokeHost = Effect.fn("RealtimeTurn.revokeHost")((hostId: string, authEpoch: number) =>
    Effect.gen({ self: this }, function* () {
      this.#revokedEpochs.set(hostId, Math.max(this.#revokedEpochs.get(hostId) ?? 0, authEpoch));
      yield* this.#revoke((claims) => claims.hostId === hostId && claims.authEpoch < authEpoch);
    }),
  );

  readonly revokeSession = Effect.fn("RealtimeTurn.revokeSession")((sessionId: string) =>
    Effect.gen({ self: this }, function* () {
      this.#revokedSessions.set(sessionId, Date.now() + 24 * 60 * 60_000);
      yield* this.#revoke((claims) => claims.role !== "host" && claims.sessionId === sessionId);
    }),
  );

  readonly #revoke = Effect.fn("RealtimeTurn.revoke")((matches: (claims: RemoteTicketClaims) => boolean) =>
    Effect.gen({ self: this }, function* () {
      const sessions = [...this.#sessions.values()].filter((session) => matches(session.claims));
      // Invalidate every cache before the first network await, including credentials still being minted.
      for (const session of sessions) session.revoked = true;
      let failed = false;
      for (const session of sessions) {
        if (session.pending) yield* Deferred.await(session.pending).pipe(Effect.result);
        for (const issued of session.issued) {
          const result = yield* this.#revokeIssued(issued).pipe(Effect.result);
          if (result._tag === "Failure") failed = true;
        }
      }
      if (failed) return yield* new RemoteTurnError({ message: "TURN credential revocation is incomplete." });
    }),
  );

  readonly #mint = Effect.fn("RealtimeTurn.mint")((session: TurnSession) =>
    Effect.gen({ self: this }, function* () {
      const issuedAt = Date.now();
      // Reserve the full request deadline: even a late provider response cannot extend the session TTL.
      const ttl = Math.min(
        SIGNAL_TURN_CREDENTIAL_TTL_SECONDS,
        Math.floor((session.claims.sessionExpiresAt * 1_000 - issuedAt - REQUEST_TIMEOUT_MILLISECONDS) / 1_000),
      );
      if (ttl < 1 || session.revoked)
        return yield* new RemoteTurnError({ message: "The remote session cannot receive TURN credentials." });
      const servers = yield* this.#request("generate-ice-servers", { ttl });
      const issued: IssuedCredentials = {
        servers,
        issuedAt,
        validUntil: issuedAt + ttl * 1_000,
        expiresAt: issuedAt + ttl * 1_000 + REQUEST_TIMEOUT_MILLISECONDS,
        revoked: false,
        revoking: null,
      };
      session.issued.push(issued);
      if (session.revoked || issued.validUntil <= Date.now() || session.claims.sessionExpiresAt * 1_000 <= Date.now()) {
        yield* this.#revokeIssued(issued);
        return yield* new RemoteTurnError({ message: "The remote session ended during TURN issuance." });
      }
      return servers;
    }),
  );

  readonly #revokeIssued = Effect.fn("RealtimeTurn.revokeIssued")((issued: IssuedCredentials) =>
    Effect.gen({ self: this }, function* () {
      if (issued.revoked || issued.expiresAt <= Date.now()) return;
      if (issued.revoking) return yield* Deferred.await(issued.revoking);
      const pending = Deferred.makeUnsafe<void, RemoteTurnError>();
      issued.revoking = pending;
      yield* Deferred.complete(
        pending,
        Effect.gen({ self: this }, function* () {
          const usernames = new Set(issued.servers.flatMap((server) => (server.username ? [server.username] : [])));
          for (const username of usernames) yield* this.#request(`${encodeURIComponent(username)}/revoke`);
          issued.revoked = true;
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            issued.revoking = null;
          }),
        ),
        Effect.uninterruptible,
      );
      return yield* Deferred.await(pending);
    }),
  );

  readonly #request = Effect.fn("RealtimeTurn.request")((path: string, body?: { ttl: number }) =>
    Effect.tryPromise({
      try: async (signal) => {
        const config = this.config;
        if (!config) throw new Error();
        const response = await fetch(
          `${config.apiOrigin}/v1/turn/keys/${encodeURIComponent(config.keyId)}/credentials/${path}`,
          {
            method: "POST",
            redirect: "error",
            headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)]),
          },
        );
        try {
          if (!body) {
            if (response.status !== 204) throw new Error();
            return [];
          }
          if (response.status !== 201 || !response.body) throw new Error();
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > MAXIMUM_RESPONSE_BYTES) throw new Error();
              chunks.push(chunk.value);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const { iceServers } = responseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
          let hasTurn = false;
          for (const server of iceServers) {
            for (const url of typeof server.urls === "string" ? [server.urls] : server.urls) {
              if (!/^(stun|stuns|turn|turns):[^\s]+$/u.test(url)) throw new Error();
              if (/^turns?:/u.test(url)) {
                if (!server.username || !server.credential) throw new Error();
                hasTurn = true;
              }
            }
          }
          if (!hasTurn) throw new Error();
          return iceServers;
        } finally {
          await response.body?.cancel();
        }
      },
      // Never include provider response text, URLs, bearer tokens, usernames or fetch causes.
      catch: () => new RemoteTurnError({ message: "The TURN credential operation failed." }),
    }),
  );

  #prune(now: number): void {
    for (const [sessionId, expiresAt] of this.#revokedSessions) {
      if (expiresAt <= now) this.#revokedSessions.delete(sessionId);
    }
    for (const [key, session] of this.#sessions) {
      session.issued = session.issued.filter((issued) => issued.expiresAt > now);
      if (!session.pending && session.issued.length === 0 && session.claims.sessionExpiresAt * 1_000 <= now)
        this.#sessions.delete(key);
    }
  }
}
