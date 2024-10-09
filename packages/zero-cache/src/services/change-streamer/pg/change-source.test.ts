import {LogContext} from '@rocicorp/logger';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {AbortError} from '../../../../../shared/src/abort-error.js';
import {createSilentLogContext} from '../../../../../shared/src/logging-test-utils.js';
import {Queue} from '../../../../../shared/src/queue.js';
import {StatementRunner} from '../../../db/statements.js';
import {
  dropReplicationSlot,
  getConnectionURI,
  testDBs,
} from '../../../test/db.js';
import {DbFile} from '../../../test/lite.js';
import {
  oneAfter,
  versionFromLexi,
  versionToLexi,
} from '../../../types/lexi-version.js';
import type {PostgresDB} from '../../../types/pg.js';
import type {Source} from '../../../types/streams.js';
import {getSubscriptionState} from '../../replicator/schema/replication-state.js';
import type {ChangeSource} from '../change-streamer-service.js';
import type {Commit, DownstreamChange} from '../change-streamer.js';
import {initializeChangeSource} from './change-source.js';
import {replicationSlot} from './initial-sync.js';
import {fromLexiVersion} from './lsn.js';

const SHARD_ID = 'change_source_test_id';

describe('change-source/pg', () => {
  let lc: LogContext;
  let upstream: PostgresDB;
  let upstreamURI: string;
  let replicaDbFile: DbFile;
  let source: ChangeSource;

  beforeEach(async () => {
    lc = createSilentLogContext();
    upstream = await testDBs.create('change_source_pg_test_upstream');
    replicaDbFile = new DbFile('change_source_pg_test_replica');

    upstreamURI = getConnectionURI(upstream);
    await upstream.unsafe(`
    CREATE TABLE foo(
      id TEXT PRIMARY KEY,
      int INT4,
      big BIGINT,
      flt FLOAT8,
      bool BOOLEAN,
      timea TIMESTAMPTZ,
      timeb TIMESTAMPTZ
    );
    CREATE PUBLICATION zero_all FOR TABLE foo WHERE (id != 'exclude-me');
    `);

    source = (
      await initializeChangeSource(
        lc,
        upstreamURI,
        {id: SHARD_ID, publications: ['zero_all']},
        replicaDbFile.path,
      )
    ).changeSource;
  });

  afterEach(async () => {
    await dropReplicationSlot(upstream, replicationSlot(SHARD_ID));
    await testDBs.drop(upstream);
    await replicaDbFile.unlink();
  });

  function drainToQueue(
    sub: Source<DownstreamChange>,
  ): Queue<DownstreamChange> {
    const queue = new Queue<DownstreamChange>();
    void (async () => {
      for await (const msg of sub) {
        void queue.enqueue(msg);
      }
    })();
    return queue;
  }

  const WATERMARK_REGEX = /[0-9a-z]{2,}/;

  test('filtered changes and acks', async () => {
    const {replicaVersion} = getSubscriptionState(
      new StatementRunner(replicaDbFile.connect(lc)),
    );

    const {initialWatermark, changes, acks} = await source.startStream('00');
    const downstream = drainToQueue(changes);

    await upstream.begin(async tx => {
      await tx`INSERT INTO foo(id) VALUES('hello')`;
      await tx`INSERT INTO foo(id) VALUES('world')`;
      await tx`
      INSERT INTO foo(id, int, big, flt, bool, timea, timeb) 
        VALUES('datatypes',
               123456789, 
               987654321987654321, 
               123.456, 
               true, 
               '2003-04-12 04:05:06 America/New_York',
               '2019-01-12T00:30:35.381101032Z'
               )`;
      // zero.schemaVersions
      await tx`
      UPDATE zero."schemaVersions" SET "maxSupportedVersion" = 2;
      `;
    });

    expect(initialWatermark).toEqual(oneAfter(replicaVersion));
    expect(await downstream.dequeue()).toMatchObject(['begin', {tag: 'begin'}]);
    expect(await downstream.dequeue()).toMatchObject([
      'data',
      {
        tag: 'insert',
        new: {id: 'hello'},
      },
    ]);
    expect(await downstream.dequeue()).toMatchObject([
      'data',
      {
        tag: 'insert',
        new: {id: 'world'},
      },
    ]);
    expect(await downstream.dequeue()).toMatchObject([
      'data',
      {
        tag: 'insert',
        new: {
          id: 'datatypes',
          int: 123456789,
          big: 987654321987654321n,
          flt: 123.456,
          bool: true,
          timea: 1050134706000000n,
          timeb: 1547253035381101n,
        },
      },
    ]);
    expect(await downstream.dequeue()).toMatchObject([
      'data',
      {
        tag: 'update',
        new: {minSupportedVersion: 1, maxSupportedVersion: 2},
      },
    ]);
    const firstCommit = (await downstream.dequeue()) as Commit;
    expect(firstCommit).toMatchObject([
      'commit',
      {tag: 'commit'},
      {watermark: expect.stringMatching(WATERMARK_REGEX)},
    ]);
    acks.push(firstCommit);

    // Write more upstream changes.
    await upstream.begin(async tx => {
      await tx`DELETE FROM foo WHERE id = 'world'`;
      await tx`UPDATE foo SET int = 123 WHERE id = 'hello';`;
      await tx`TRUNCATE foo`;
      // Should be excluded by zero_all.
      await tx`INSERT INTO foo(id) VALUES ('exclude-me')`;
      await tx`INSERT INTO foo(id) VALUES ('include-me')`;
      // zero.clients change that should not be included in _zero_{SHARD_ID}_client.
      await tx`INSERT INTO zero.clients("shardID", "clientGroupID", "clientID", "lastMutationID")
                  VALUES ('different-shard', 'boo', 'far', 12)`;
      // zero.clients change that should be included in _zero_{SHARD_ID}_client.
      await tx`INSERT INTO zero.clients("shardID", "clientGroupID", "clientID", "lastMutationID")
                  VALUES (${SHARD_ID}, 'foo', 'bar', 23)`;
    });

    expect(await downstream.dequeue()).toMatchObject(['begin', {tag: 'begin'}]);
    expect(await downstream.dequeue()).toMatchObject([
      'data',
      {
        tag: 'delete',
        key: {id: 'world'},
      },
    ]);
    expect(await downstream.dequeue()).toMatchObject([
      'data',
      {
        tag: 'update',
        new: {id: 'hello', int: 123},
      },
    ]);
    expect(await downstream.dequeue()).toMatchObject([
      'data',
      {
        tag: 'truncate',
      },
    ]);
    expect(await downstream.dequeue()).toMatchObject([
      'data',
      {
        tag: 'insert',
        new: {id: 'include-me'},
      },
    ]);
    // Only zero.client updates for this SHARD_ID are replicated.
    expect(await downstream.dequeue()).toMatchObject([
      'data',
      {
        tag: 'insert',
        new: {
          shardID: SHARD_ID,
          clientGroupID: 'foo',
          clientID: 'bar',
          lastMutationID: 23n,
        },
      },
    ]);
    expect(await downstream.dequeue()).toMatchObject([
      'commit',
      {tag: 'commit'},
      {watermark: expect.stringMatching(WATERMARK_REGEX)},
    ]);

    // Close the stream.
    changes.cancel();

    // Verify that the ACK was stored with the replication slot.
    // Postgres stores 1 + the LSN of the confirmed ACK.
    const results = await upstream<{confirmed: string}[]>`
    SELECT confirmed_flush_lsn as confirmed FROM pg_replication_slots
        WHERE slot_name = ${replicationSlot(SHARD_ID)}`;
    const expected = versionFromLexi(firstCommit[2].watermark) + 1n;
    expect(results).toEqual([
      {confirmed: fromLexiVersion(versionToLexi(expected))},
    ]);
  });

  test('start after confirmed flush', async () => {
    const {replicaVersion} = getSubscriptionState(
      new StatementRunner(replicaDbFile.connect(lc)),
    );

    // Write three transactions, to experiment with different starting points.
    await upstream`INSERT INTO foo(id) VALUES('hello')`;
    await upstream`INSERT INTO foo(id) VALUES('world')`;
    await upstream`INSERT INTO foo(id) VALUES('foobar')`;

    const stream1 = await source.startStream('00');
    const changes1 = drainToQueue(stream1.changes);

    expect(stream1.initialWatermark).toEqual(oneAfter(replicaVersion));
    expect(await changes1.dequeue()).toMatchObject(['begin', {tag: 'begin'}]);
    expect(await changes1.dequeue()).toMatchObject(['data', {tag: 'insert'}]);
    const firstCommit = (await changes1.dequeue()) as Commit;
    expect(firstCommit).toMatchObject([
      'commit',
      {tag: 'commit'},
      {watermark: expect.stringMatching(WATERMARK_REGEX)},
    ]);

    expect(await changes1.dequeue()).toMatchObject(['begin', {tag: 'begin'}]);
    expect(await changes1.dequeue()).toMatchObject(['data', {tag: 'insert'}]);
    const secondCommit = (await changes1.dequeue()) as Commit;
    expect(secondCommit).toMatchObject([
      'commit',
      {tag: 'commit'},
      {watermark: expect.stringMatching(WATERMARK_REGEX)},
    ]);

    expect(await changes1.dequeue()).toMatchObject(['begin', {tag: 'begin'}]);
    expect(await changes1.dequeue()).toMatchObject(['data', {tag: 'insert'}]);
    const thirdCommit = (await changes1.dequeue()) as Commit;
    expect(thirdCommit).toMatchObject([
      'commit',
      {tag: 'commit'},
      {watermark: expect.stringMatching(WATERMARK_REGEX)},
    ]);

    stream1.changes.cancel();

    // Starting a new stream should replay at the original position since we did not ACK.
    const stream2 = await source.startStream('00');
    const changes2 = drainToQueue(stream2.changes);

    expect(stream2.initialWatermark).toEqual(oneAfter(replicaVersion));
    expect(await changes2.dequeue()).toMatchObject(['begin', {tag: 'begin'}]);
    expect(await changes2.dequeue()).toMatchObject(['data', {tag: 'insert'}]);
    expect(await changes2.dequeue()).toEqual(firstCommit);

    stream2.changes.cancel();

    // Still with no ACK, start a stream from after the secondCommit.
    const stream3 = await source.startStream(secondCommit[2].watermark);
    const changes3 = drainToQueue(stream3.changes);

    expect(stream3.initialWatermark).toEqual(
      oneAfter(secondCommit[2].watermark),
    );
    expect(await changes3.dequeue()).toMatchObject(['begin', {tag: 'begin'}]);
    expect(await changes3.dequeue()).toMatchObject(['data', {tag: 'insert'}]);
    expect(await changes3.dequeue()).toEqual(thirdCommit);

    stream3.changes.cancel();
  });

  test('error handling', async () => {
    // Purposely drop the replication slot to test the error case.
    await dropReplicationSlot(upstream, replicationSlot(SHARD_ID));

    let err;
    try {
      await source.startStream('00');
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeUndefined();
  });

  test('abort', async () => {
    const {changes} = await source.startStream('00');

    const results = await upstream<{pid: number}[]>`
      SELECT active_pid as pid from pg_replication_slots WHERE
        slot_name = ${replicationSlot(SHARD_ID)}`;
    const {pid} = results[0];

    await upstream`SELECT pg_terminate_backend(${pid})`;

    let err;
    try {
      for await (const _ of changes) {
        throw new Error('DatabaseError was not thrown');
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AbortError);
  });

  test('handoff', {retry: 3}, async () => {
    const {changes} = await source.startStream('00');

    // Starting another stream should stop the first.
    const {changes: changes2} = await source.startStream('00');

    let err;
    try {
      for await (const _ of changes) {
        throw new Error('DatabaseError was not thrown');
      }
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(AbortError);
    changes2.cancel();
  });

  test('error on wrong publications', async () => {
    let err;
    try {
      await initializeChangeSource(
        lc,
        upstreamURI,
        {id: SHARD_ID, publications: ['zero_different_publication']},
        replicaDbFile.path,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toMatchInlineSnapshot(
      `[Error: Invalid ShardConfig. Requested publications [zero_different_publication] do not match synced publications: [zero_all]]`,
    );
  });
});
