import type {
  ReadTransaction as ReplicacheReadTransaction,
  WriteTransaction as ReplicacheWriteTransaction,
  ReadonlyJSONObject,
  MutatorReturn,
} from 'replicache';

/**
 * `AuthData` must include a `userID` which is unique stable identifier
 * for the user.
 * `AuthData` has a size limit of 6 KB.
 * `AuthData` is passed via {@link WriteTransaction.auth} to mutators
 * when they are run on the server, which can use it to supplement
 * mutator args and to authorize the mutation.
 */
export type AuthData = ReadonlyJSONObject & {readonly userID: string};

export interface ReadTransaction extends ReplicacheReadTransaction {
  /**
   * When a mutator is run on the server, the `AuthData` for the connection
   * that pushed the mutation (i.e. the `AuthData` returned by the
   * {@link ReflectServerOptions.authHandler} when it authenticated the
   * connection).  Always undefined on the client. This can be used to implement
   * fine-grained server-side authorization of mutations.
   */
  readonly auth?: AuthData | undefined;
}

export interface WriteTransaction extends ReplicacheWriteTransaction {
  /**
   * When a mutator is run on the server, the `AuthData` for the connection
   * that pushed the mutation (i.e. the `AuthData` returned by the
   * {@link ReflectServerOptions.authHandler} when it authenticated the
   * connection).  Always undefined on the client. This can be used to implement
   * fine-grained server-side authorization of mutations.
   */
  readonly auth?: AuthData | undefined;
}

export type MutatorDefs = {
  [key: string]: (
    tx: WriteTransaction,
    // Not sure how to not use any here...
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args?: any,
  ) => MutatorReturn;
};
