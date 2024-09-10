import {assert} from 'shared/src/asserts.js';
import {versionToLexi, type LexiVersion} from './lexi-version.js';

/**
 * Parsing and conversion utilities for the pg_lsn Type, which represents
 * the "Log Sequence Number" used as a monotonic progress marker for logical
 * replication from a PostreSQL database.
 *
 * The LSN is a 64-bit integer represented in logical replication as two
 * hexadecimal numbers (up to 8 digits each) separated by a slash. This is
 * converted to a LexiVersion and used as DB-agnostic version in change log,
 * invalidation index, and row version in the tables of the sync replica.
 */
export type LSN = string;

function toBigInt(lsn: LSN): bigint {
  const parts = lsn.split('/');
  assert(parts.length === 2, `Malformed LSN: "${lsn}"`);
  const high = BigInt(`0x${parts[0]}`);
  const low = BigInt(`0x${parts[1]}`);
  return (high << 32n) + low;
}

export function toLexiVersion(lsn: LSN): LexiVersion {
  return versionToLexi(toBigInt(lsn));
}

export function compareLSN(a: LSN, b: LSN): number {
  const diff = toBigInt(a) - toBigInt(b);
  return diff < 0n ? -1 : diff === 0n ? 0 : 1;
}
