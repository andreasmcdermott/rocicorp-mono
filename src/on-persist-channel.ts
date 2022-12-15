import {assertObject, assertString} from './asserts.js';
import type {ClientGroupID, ClientID} from './sync/ids.js';

function makeChannelName(replicacheName: string): string {
  return `replicache-on-persist:${replicacheName}`;
}

export type PersistInfo = {
  clientGroupID: ClientGroupID;
  clientID: ClientID;
};

export type OnPersist = (persistInfo: PersistInfo) => void;

type HandlePersist = OnPersist;

function assertPersistInfo(value: unknown): asserts value is PersistInfo {
  assertObject(value);
  assertString(value.clientGroupID);
  assertString(value.clientID);
}

export function initOnPersistChannel(
  replicacheName: string,
  signal: AbortSignal,
  handlePersist: HandlePersist,
): OnPersist {
  if (signal.aborted) {
    return () => undefined;
  }
  const channel = new BroadcastChannel(makeChannelName(replicacheName));

  channel.onmessage = e => {
    const {data} = e;
    assertPersistInfo(data);
    handlePersist({
      clientGroupID: data.clientGroupID,
      clientID: data.clientID,
    });
  };

  signal.addEventListener('abort', () => {
    channel.close();
  });

  return (persistInfo: PersistInfo) => {
    if (signal.aborted) {
      return;
    }
    channel.postMessage(persistInfo);
    handlePersist(persistInfo);
  };
}
