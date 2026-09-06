import { createLogger } from "../logging.js";
import { applyOp, type Json0Op } from "../ot/apply.js";
import type { RestClient } from "../transport/rest.js";
import type { ShareDBPool } from "../transport/sharedb.js";
import type { Geo, TripPlan } from "../types.js";

const log = createLogger("wanderdog");

type CacheEntry = {
  snapshot: TripPlan;
  version: number;
  geos: Geo[];
  listener?: (ops: Json0Op[], version: number) => void;
};

/**
 * Live trip cache. On first access, validates the trip exists via REST
 * (fast 404 path for bad keys), then subscribes via ShareDBPool for live
 * updates. Incoming remote ops are applied to the cached doc so reads stay
 * current without refetching.
 *
 * Callers can read `entry.snapshot` and `entry.version` to prepare submit
 * ops with the correct version vector.
 */
export class TripCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly subscribing = new Map<string, Promise<CacheEntry>>();

  constructor(
    private readonly rest: RestClient,
    private readonly pool: ShareDBPool,
  ) {}

  async get(tripKey: string): Promise<TripPlan> {
    const entry = await this.ensureEntry(tripKey);
    return entry.snapshot;
  }

  async getEntry(tripKey: string): Promise<CacheEntry> {
    return this.ensureEntry(tripKey);
  }

  private async ensureEntry(tripKey: string): Promise<CacheEntry> {
    const existing = this.entries.get(tripKey);
    if (existing) {
      log.debug(`trip cache hit for ${tripKey} (v${existing.version})`, {
        tripKey,
        version: existing.version,
      });
      return existing;
    }

    const pending = this.subscribing.get(tripKey);
    if (pending) return pending;

    const promise = this.subscribeAndCache(tripKey);
    this.subscribing.set(tripKey, promise);
    try {
      return await promise;
    } finally {
      this.subscribing.delete(tripKey);
    }
  }

  private async subscribeAndCache(tripKey: string): Promise<CacheEntry> {
    // REST pre-check: fails fast with 404 → WanderlogNotFoundError.
    // Without this, a bogus trip key hangs on the WS subscribe timeout.
    // The response also gives us the trip's associated geos, which the
    // WebSocket snapshot doesn't include — we store them for search biasing.
    log.info(`subscribing to trip ${tripKey} via REST and ShareDB`, { tripKey });
    const { geos } = await this.rest.getTripWithResources(tripKey);

    const client = this.pool.get(tripKey);
    const snapshot = await client.subscribe();

    const listener = (ops: Json0Op[], version: number) => {
      const current = this.entries.get(tripKey);
      if (!current) return;
      try {
        current.snapshot = applyOp(current.snapshot, ops);
        current.version = version;
        log.debug(`applied remote op to cache for ${tripKey} (new v${version}, ${ops.length} ops)`, {
          tripKey,
          version,
          opCount: ops.length,
        });
      } catch (err) {
        // If a remote op fails to apply to our snapshot, our view is stale.
        // Drop the entry; next get() re-subscribes from a fresh snapshot.
        log.warn(`remote op failed to apply to cache for ${tripKey}; dropping cache entry: ${(err as Error).message}`, {
          tripKey,
          version,
          error: (err as Error).message,
        });
        this.deleteEntry(tripKey);
      }
    };

    client.on("remoteOp", listener);

    const entry: CacheEntry = { snapshot, version: client.version, geos, listener };
    this.entries.set(tripKey, entry);
    log.info(`cached trip ${tripKey} (v${client.version}, ${snapshot.itinerary?.sections?.length ?? 0} sections)`, {
      tripKey,
      version: client.version,
      sectionCount: snapshot.itinerary?.sections?.length ?? 0,
    });

    return entry;
  }

  /**
   * Called after submitting an op ourselves. Applies the op locally and
   * bumps the version so the cache matches what the server just accepted.
   */
  applyLocalOp(tripKey: string, ops: Json0Op[], newVersion: number): void {
    const entry = this.entries.get(tripKey);
    if (!entry) return;
    entry.snapshot = applyOp(entry.snapshot, ops);
    entry.version = newVersion;
    log.debug(`applied local op to cache for ${tripKey} (new v${newVersion}, ${ops.length} ops)`, {
      tripKey,
      newVersion,
      opCount: ops.length,
    });
  }

  private deleteEntry(tripKey: string): void {
    const entry = this.entries.get(tripKey);
    if (entry) {
      log.info(`invalidating cache entry for trip ${tripKey} (was v${entry.version})`, {
        tripKey,
        version: entry.version,
      });
      if (entry.listener) {
        const client = this.pool.get(tripKey);
        client.off("remoteOp", entry.listener);
      }
      this.entries.delete(tripKey);
    }
  }

  invalidate(tripKey: string): void {
    this.deleteEntry(tripKey);
  }

  clear(): void {
    for (const tripKey of this.entries.keys()) {
      this.deleteEntry(tripKey);
    }
  }
}
