import type {LogContext} from '@rocicorp/logger';
import {unreachable} from '../../../../shared/src/asserts.ts';
import {
  assertJSONValue,
  type JSONObject as SafeJSONObject,
} from '../../../../shared/src/json.ts';
import * as v from '../../../../shared/src/valita.ts';
import type {AST} from '../../../../zero-protocol/src/ast.ts';
import {rowSchema} from '../../../../zero-protocol/src/data.ts';
import type {Downstream} from '../../../../zero-protocol/src/down.ts';
import type {
  PokePartBody,
  PokeStartBody,
} from '../../../../zero-protocol/src/poke.ts';
import {primaryKeyValueRecordSchema} from '../../../../zero-protocol/src/primary-key.ts';
import type {RowPatchOp} from '../../../../zero-protocol/src/row-patch.ts';
import type {JSONObject} from '../../types/bigint-json.ts';
import {getLogLevel} from '../../types/error-for-client.ts';
import {
  getErrorForClientIfSchemaVersionNotSupported,
  type SchemaVersions,
} from '../../types/schema-versions.ts';
import type {Subscription} from '../../types/subscription.ts';
import {unescapedSchema as schema} from '../change-source/pg/schema/shard.ts';
import {
  type ClientPatch,
  cmpVersions,
  cookieToVersion,
  type CVRVersion,
  type DelQueryPatch,
  type NullableCVRVersion,
  type PutQueryPatch,
  type RowID,
  versionToCookie,
  versionToNullableCookie,
} from './schema/types.ts';

export type PutRowPatch = {
  type: 'row';
  op: 'put';
  id: RowID;
  contents: JSONObject;
};

export type DeleteRowPatch = {
  type: 'row';
  op: 'del';
  id: RowID;
};

export type RowPatch = PutRowPatch | DeleteRowPatch;
export type ConfigPatch =
  | ClientPatch
  | DelQueryPatch
  | (PutQueryPatch & {ast: AST});

export type Patch = ConfigPatch | RowPatch;

export type PatchToVersion = {
  patch: Patch;
  toVersion: CVRVersion;
};

export interface PokeHandler {
  addPatch(patch: PatchToVersion): void;
  cancel(): void;
  end(finalVersion: CVRVersion): void;
}

const NOOP: PokeHandler = {
  addPatch: () => {},
  cancel: () => {},
  end: () => {},
};

// Semi-arbitrary threshold at which poke body parts are flushed.
// When row size is being computed, that should be used as a threshold instead.
const PART_COUNT_FLUSH_THRESHOLD = 100;

/**
 * Handles a single `ViewSyncer` connection.
 */
export class ClientHandler {
  readonly #clientGroupID: string;
  readonly clientID: string;
  readonly wsID: string;
  readonly #zeroClientsTable: string;
  readonly #lc: LogContext;
  readonly #pokes: Subscription<Downstream>;
  #baseVersion: NullableCVRVersion;
  readonly #protocolVersion: number;
  readonly #schemaVersion: number;

  constructor(
    lc: LogContext,
    clientGroupID: string,
    clientID: string,
    wsID: string,
    shardID: string,
    baseCookie: string | null,
    protocolVersion: number,
    schemaVersion: number,
    pokes: Subscription<Downstream>,
  ) {
    this.#clientGroupID = clientGroupID;
    this.clientID = clientID;
    this.wsID = wsID;
    this.#zeroClientsTable = `${schema(shardID)}.clients`;
    this.#lc = lc;
    this.#pokes = pokes;
    this.#baseVersion = cookieToVersion(baseCookie);
    this.#protocolVersion = protocolVersion;
    this.#schemaVersion = schemaVersion;
  }

  version(): NullableCVRVersion {
    return this.#baseVersion;
  }

  supportsRevisedCookieProtocol() {
    // https://github.com/rocicorp/mono/pull/3735
    return this.#protocolVersion >= 5;
  }

  fail(e: unknown) {
    this.#lc[getLogLevel(e)]?.(
      `view-syncer closing connection with error: ${String(e)}`,
      e,
    );
    this.#pokes.fail(e instanceof Error ? e : new Error(String(e)));
  }

  close(reason: string) {
    this.#lc.debug?.(`view-syncer closing connection: ${reason}`);
    this.#pokes.cancel();
  }

  startPoke(
    tentativeVersion: CVRVersion,
    schemaVersions?: SchemaVersions, // absent for config-only pokes
  ): PokeHandler {
    const pokeID = versionToCookie(tentativeVersion);
    const lc = this.#lc.withContext('pokeID', pokeID);

    if (schemaVersions) {
      const schemaVersionError = getErrorForClientIfSchemaVersionNotSupported(
        this.#schemaVersion,
        schemaVersions,
      );

      if (schemaVersionError) {
        this.fail(schemaVersionError);
        return NOOP;
      }
    }

    if (cmpVersions(this.#baseVersion, tentativeVersion) >= 0) {
      lc.info?.(`already caught up, not sending poke.`);
      return NOOP;
    }

    const baseCookie = versionToNullableCookie(this.#baseVersion);
    const cookie = versionToCookie(tentativeVersion);
    lc.info?.(`starting poke from ${baseCookie} to ${cookie}`);

    const pokeStart: PokeStartBody = {pokeID, baseCookie, cookie};
    if (schemaVersions) {
      pokeStart.schemaVersions = schemaVersions;
    }

    let pokeStarted = false;
    let body: PokePartBody | undefined;
    let partCount = 0;
    const ensureBody = () => {
      if (!pokeStarted) {
        this.#pokes.push(['pokeStart', pokeStart]);
        pokeStarted = true;
      }
      return (body ??= {pokeID});
    };
    const flushBody = () => {
      if (body) {
        this.#pokes.push(['pokePart', body]);
        body = undefined;
        partCount = 0;
      }
    };

    const addPatch = (patchToVersion: PatchToVersion) => {
      const {patch, toVersion} = patchToVersion;
      if (cmpVersions(toVersion, this.#baseVersion) <= 0) {
        return;
      }
      const body = ensureBody();

      const {type, op} = patch;
      switch (type) {
        case 'client':
          (body.clientsPatch ??= []).push({op, clientID: patch.id});
          break;
        case 'query': {
          const patches = patch.clientID
            ? ((body.desiredQueriesPatches ??= {})[patch.clientID] ??= [])
            : (body.gotQueriesPatch ??= []);
          if (op === 'put') {
            const {ast} = patch;
            patches.push({op, hash: patch.id, ast});
          } else {
            patches.push({op, hash: patch.id});
          }
          break;
        }
        case 'row':
          if (patch.id.table === this.#zeroClientsTable) {
            this.#updateLMIDs((body.lastMutationIDChanges ??= {}), patch);
          } else {
            (body.rowsPatch ??= []).push(makeRowPatch(patch));
          }
          break;
        default:
          unreachable(patch);
      }

      if (++partCount >= PART_COUNT_FLUSH_THRESHOLD) {
        flushBody();
      }
    };

    return {
      addPatch: (patchToVersion: PatchToVersion) => {
        try {
          addPatch(patchToVersion);
        } catch (e) {
          this.#pokes.fail(e instanceof Error ? e : new Error(String(e)));
        }
      },

      cancel: () => {
        if (pokeStarted) {
          this.#pokes.push(['pokeEnd', {pokeID, cancel: true}]);
        }
      },

      end: (finalVersion: CVRVersion) => {
        const cookie = versionToCookie(finalVersion);
        if (!pokeStarted) {
          if (cmpVersions(this.#baseVersion, finalVersion) === 0) {
            return; // Nothing changed and nothing was sent.
          }
          this.#pokes.push(['pokeStart', {...pokeStart, cookie}]);
        } else if (cmpVersions(this.#baseVersion, finalVersion) >= 0) {
          // Sanity check: If the poke was started, the finalVersion
          // must be > #baseVersion.
          throw new Error(
            `Patches were sent but finalVersion ${finalVersion} is ` +
              `not greater than baseVersion ${this.#baseVersion}`,
          );
        }
        flushBody();
        this.#pokes.push([
          'pokeEnd',
          this.supportsRevisedCookieProtocol() ? {pokeID, cookie} : {pokeID},
        ]);
        this.#baseVersion = finalVersion;
      },
    };
  }

  #updateLMIDs(lmids: Record<string, number>, patch: RowPatch) {
    if (patch.op === 'put') {
      const row = ensureSafeJSON(patch.contents);
      const {clientGroupID, clientID, lastMutationID} = v.parse(
        row,
        lmidRowSchema,
        'passthrough',
      );
      if (clientGroupID !== this.#clientGroupID) {
        this.#lc.error?.(
          `Received zero.clients row for wrong clientGroupID. Ignoring.`,
          clientGroupID,
        );
      } else {
        lmids[clientID] = lastMutationID;
      }
    } else {
      // The 'constrain' and 'del' ops for zero.clients can be ignored.
      patch.op satisfies 'constrain' | 'del';
    }
  }
}

// Note: The zero_{SHARD_ID}.clients table is set up in replicator/initial-sync.ts.
const lmidRowSchema = v.object({
  clientGroupID: v.string(),
  clientID: v.string(),
  lastMutationID: v.number(), // Actually returned as a bigint, but converted by ensureSafeJSON().
});

function makeRowPatch(patch: RowPatch): RowPatchOp {
  const {
    op,
    id: {table: tableName, rowKey: id},
  } = patch;

  switch (op) {
    case 'put':
      return {
        op: 'put',
        tableName,
        value: v.parse(ensureSafeJSON(patch.contents), rowSchema),
      };

    case 'del':
      return {
        op,
        tableName,
        id: v.parse(id, primaryKeyValueRecordSchema),
      };

    default:
      unreachable(op);
  }
}

/**
 * Column values of type INT8 are returned as the `bigint` from the
 * Postgres library. These are converted to `number` if they are within
 * the safe Number range, allowing the protocol to support numbers larger
 * than 32-bits. Values outside of the safe number range (e.g. > 2^53) will
 * result in an Error.
 */
export function ensureSafeJSON(row: JSONObject): SafeJSONObject {
  const modified = Object.entries(row)
    .filter(([k, v]) => {
      if (typeof v === 'bigint') {
        if (v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER) {
          return true; // send this entry onto the next map() step.
        }
        throw new Error(`Value of "${k}" exceeds safe Number range (${v})`);
      } else if (typeof v === 'object') {
        assertJSONValue(v);
      }
      return false;
    })
    .map(([k, v]) => [k, Number(v)]);

  return modified.length ? {...row, ...Object.fromEntries(modified)} : row;
}

export function revisedCookieProtocolSupportedByAll(clients: ClientHandler[]) {
  for (const c of clients) {
    if (!c.supportsRevisedCookieProtocol()) {
      return false;
    }
  }
  return true;
}
