import {LogContext} from '@rocicorp/logger';
import UrlPattern from 'url-pattern';
import {h32} from '../../../../shared/src/hash.js';
import type {IncomingMessageSubset} from '../../types/http.js';
import type {Worker} from '../../types/processes.js';
import {HttpService, type Options} from '../http-service.js';
import {getConnectParams} from './connect-params.js';
import {installWebSocketHandoff} from './websocket-handoff.js';

// The server allows the client to use any /:base/ path to facilitate
// servicing requests on the same domain as the application.
const CONNECT_URL_PATTERN = new UrlPattern('(/:base)/sync/v:version/connect');

export class SyncDispatcher extends HttpService {
  readonly id = 'dispatcher';
  readonly #taskID: string;
  readonly #syncers: Worker[];

  constructor(
    lc: LogContext,
    taskID: string,
    parent: Worker | null,
    syncers: Worker[],
    opts: Options,
  ) {
    super('dispatcher', lc, opts, fastify => {
      fastify.get('/', (_req, res) => res.send('OK'));
      installWebSocketHandoff(lc, req => this.#handoff(req), fastify.server);
    });

    this.#taskID = taskID;
    this.#syncers = syncers;
    if (parent) {
      installWebSocketHandoff(lc, req => this.#handoff(req), parent);
    }
  }

  #handoff(req: IncomingMessageSubset) {
    const {headers, url: u} = req;
    const url = new URL(u ?? '', 'http://unused/');
    const syncPath = parseSyncPath(url);
    if (!syncPath) {
      throw new Error(`Invalid sync URL: ${u}`);
    }
    const version = Number(syncPath.version);
    if (Number.isNaN(version)) {
      throw new Error(`Invalid sync version: ${u}`);
    }
    const {params, error} = getConnectParams(version, url, headers);
    if (error !== null) {
      throw new Error(error);
    }
    const {clientGroupID} = params;
    // Include the TaskID when hash-bucketting the client group to the sync
    // worker. This diversifies the distribution of client groups (across
    // workers) for different tasks, so that if one task sheds connections
    // from its most heavily loaded sync worker(s), those client groups will
    // be distributed uniformly across workers on the receiving task(s).
    const syncer =
      h32(this.#taskID + '/' + clientGroupID) % this.#syncers.length;

    this._lc.debug?.(`connecting ${clientGroupID} to syncer ${syncer}`);
    return {payload: params, receiver: this.#syncers[syncer]};
  }
}

export function parseSyncPath(
  url: URL,
): {base?: string; version: string} | undefined {
  // The match() returns both null and undefined.
  return CONNECT_URL_PATTERN.match(url.pathname) || undefined;
}
