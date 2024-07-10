import type {LogContext, LogLevel} from '@rocicorp/logger';
import postgres from 'postgres';
import {jsonObjectSchema} from 'shared/src/json-schema.js';
import * as v from 'shared/src/valita.js';
import type {JSONObject} from '../types/bigint-json.js';
import {PostgresDB, postgresTypeConfig} from '../types/pg.js';
import {streamIn, type CancelableAsyncIterable} from '../types/streams.js';
import {
  InvalidationWatcher,
  InvalidationWatcherService,
} from './invalidation-watcher/invalidation-watcher.js';
import type {InvalidationWatcherRegistry} from './invalidation-watcher/registry.js';
import {Mutagen, MutagenService} from './mutagen/mutagen.js';
import {
  REGISTER_FILTERS_PATTERN,
  REPLICATOR_STATUS_PATTERN,
  VERSION_CHANGES_PATTERN,
} from './paths.js';
import type {ReplicatorRegistry} from './replicator/registry.js';
import {
  RegisterInvalidationFiltersRequest,
  RegisterInvalidationFiltersResponse,
  Replicator,
  ReplicatorService,
  VersionChange,
  registerInvalidationFiltersResponse,
  versionChangeSchema,
} from './replicator/replicator.js';
import type {Service} from './service.js';
import {ViewSyncer, ViewSyncerService} from './view-syncer/view-syncer.js';
import type {DurableStorage} from '../storage/durable-storage.js';
import WebSocket from 'ws';
export interface ServiceRunnerEnv {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  UPSTREAM_URI: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  SYNC_REPLICA_URI: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  LOG_LEVEL: LogLevel;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  DATADOG_LOGS_API_KEY?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  DATADOG_SERVICE_LABEL?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  REPLICATOR_HOST?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  EMBEDDED_REPLICATOR?: boolean;
}

const REPLICATOR_ID = 'r1';
const INVALIDATION_WATCHER_ID = 'iw1';

export class ServiceRunner
  implements ReplicatorRegistry, InvalidationWatcherRegistry
{
  readonly #viewSyncers: Map<string, ViewSyncerService> = new Map();
  readonly #replicators: Map<string, ReplicatorService> = new Map();
  readonly #invalidationWatchers: Map<string, InvalidationWatcherService> =
    new Map();

  readonly #storage: DurableStorage;
  readonly #env: ServiceRunnerEnv;
  readonly #upstream: PostgresDB;
  readonly #replica: PostgresDB;
  readonly #lc: LogContext;
  readonly #runReplicator: boolean;

  constructor(
    lc: LogContext,
    storage: DurableStorage,
    env: ServiceRunnerEnv,
    runReplicator: boolean,
  ) {
    this.#lc = lc;
    this.#storage = storage;
    this.#env = env;
    // Connections are capped to stay within the DO limit of 6 TCP connections.
    // Note that the Replicator uses one extra connection for replication.
    //
    // TODO: We should have separate upstream URIs for the Replicator (direct connection)
    //       vs mutagen (can be a pooled connection).
    this.#upstream = postgres(this.#env.UPSTREAM_URI, {
      ...postgresTypeConfig(),
      max: 1,
    });
    this.#replica = postgres(this.#env.SYNC_REPLICA_URI, {
      ...postgresTypeConfig(),
      max: 4,
    });
    this.#runReplicator = runReplicator;
    this.#warmUpConnections();
  }

  getInvalidationWatcher(): Promise<InvalidationWatcher> {
    return Promise.resolve(
      this.#getService(
        INVALIDATION_WATCHER_ID,
        this.#invalidationWatchers,
        id => new InvalidationWatcherService(id, this.#lc, this, this.#replica),
        'InvalidationWatcherService',
      ),
    );
  }

  // eslint-disable-next-line require-await
  async getReplicator(): Promise<Replicator> {
    if (this.#runReplicator) {
      return this.#getService(
        REPLICATOR_ID,
        this.#replicators,
        id =>
          new ReplicatorService(
            this.#lc,
            id,
            this.#env.UPSTREAM_URI,
            this.#upstream,
            this.#replica,
          ),
        'ReplicatorService',
      );
    }
    return this.#getReplicatorStub();
  }

  #getReplicatorStub(): ReplicatorStub {
    if (!this.#env.REPLICATOR_HOST) {
      throw new Error('REPLICATOR_HOST not set');
    }
    return new ReplicatorStub(this.#lc, this.#env.REPLICATOR_HOST);
  }

  getViewSyncer(clientGroupID: string): ViewSyncer {
    return this.#getService(
      clientGroupID,
      this.#viewSyncers,
      id =>
        new ViewSyncerService(this.#lc, id, this.#storage, this, this.#replica),
      'ViewSyncer',
    );
  }

  #warmUpConnections() {
    const start = Date.now();
    void Promise.all([
      // Warm up 1 upstream connection for mutagen, and 4 replica connections for view syncing.
      // Note: These can be much larger when not limited to 6 TCP connections per DO.
      this.#upstream`SELECT 1`.simple().execute(),
      ...Array.from({length: 4}, () =>
        this.#replica`SELECT 1`.simple().execute(),
      ),
    ])
      .then(
        () =>
          this.#lc.info?.(
            `warmed up db connections (${Date.now() - start} ms)`,
          ),
      )
      .catch(e => this.#lc.error?.(`error warming up db connections`, e));
  }

  getMutagen(clientGroupID: string): Mutagen {
    // The MutagenService implementation is stateless. No need to keep a map or share instances.
    return new MutagenService(this.#lc, clientGroupID, this.#upstream);
  }

  #getService<S extends Service>(
    id: string,
    registry: Map<string, S>,
    create: (id: string) => S,
    description: string,
  ): S {
    const existing = registry.get(id);
    if (existing) {
      return existing;
    }
    this.#lc.debug?.('Creating and running service', description);
    const service = create(id);
    registry.set(id, service);
    void service
      .run()
      .catch(e => {
        this.#lc.info?.('Error in run of', description, e);
        this.#lc.info?.(e.toString());
      })
      .finally(() => {
        registry.delete(id);
      });
    return service;
  }

  async status(): Promise<JSONObject> {
    // One ping to warm up the connections
    await Promise.all([this.#replica`SELECT 1`, this.#upstream`SELECT 1`]);

    const start = Date.now();
    const replicaPingMs = this.#replica`SELECT 1`
      .simple()
      .then(() => Date.now() - start);
    const upstreamPingMs = this.#upstream`SELECT 1`
      .simple()
      .then(() => Date.now() - start);
    return {
      status: 'OK',
      replicaPingMs: await replicaPingMs,
      upstreamPingMs: await upstreamPingMs,
    };
  }
}

class ReplicatorStub implements Replicator {
  readonly #lc: LogContext;
  readonly #host: string;
  constructor(lc: LogContext, host: string) {
    this.#lc = lc.withContext('stub', 'Replicator');
    this.#host = host;
  }

  async status() {
    const lc = this.#lc.withContext('method', 'status');
    const res = await fetch(
      `http://${this.#host}${REPLICATOR_STATUS_PATTERN.replace(
        ':version',
        'v0',
      )}`,

      {method: 'POST'},
    );
    const data = await res.json();
    lc.debug?.('received', data);
    return v.parse(data, jsonObjectSchema);
  }

  async registerInvalidationFilters(
    req: RegisterInvalidationFiltersRequest,
  ): Promise<RegisterInvalidationFiltersResponse> {
    const lc = this.#lc.withContext('method', 'registerInvalidationFilters');
    const res = await fetch(
      `http://${this.#host}${REGISTER_FILTERS_PATTERN.replace(
        ':version',
        'v0',
      )}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req),
      },
    );
    if (!res.ok) {
      throw new Error(
        `registerInvalidationFilters: ${res.status}: ${await res.text()}`,
      );
    }
    const data = await res.json();
    lc.debug?.('received', data);
    return v.parse(data, registerInvalidationFiltersResponse);
  }

  versionChanges(): Promise<CancelableAsyncIterable<VersionChange>> {
    const lc = this.#lc.withContext('method', 'versionChanges');
    const ws = new WebSocket(
      `http://${this.#host}${VERSION_CHANGES_PATTERN.replace(
        ':version',
        'v0',
      )}`,
    );

    return Promise.resolve(streamIn(lc, ws, versionChangeSchema));
  }
}
