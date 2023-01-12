import {test, expect} from '@jest/globals';
import {
  ClientRecord,
  clientRecordKey,
  clientRecordSchema,
} from '../../src/types/client-record.js';
import {getEntry, putEntry} from '../../src/db/data.js';
import type {ClientMap, Socket} from '../../src/types/client-state.js';
import {
  client,
  clientRecord,
  createSilentLogContext,
  Mocket,
} from '../util/test-utils.js';
import {
  getConnectRequest,
  handleConnection,
  maybeOldClientStateMessage,
} from '../../src/server/connect.js';
import {USER_DATA_HEADER_NAME} from './auth.js';
import {encodeHeaderValue} from '../util/headers.js';
import {DurableStorage} from '../storage/durable-storage.js';
import {NullableVersion, putVersion} from '../../src/types/version.js';

const {roomDO} = getMiniflareBindings();
const id = roomDO.newUniqueId();

function freshClient(
  id: string,
  userID: string,
  socket: Socket = new Mocket(),
) {
  const [clientID, c] = client(id, userID, socket);
  c.clockBehindByMs = undefined;
  return [clientID, c] as const;
}

function createHeadersWithValidUserData(userID: string) {
  const headers = new Headers();
  headers.set(
    USER_DATA_HEADER_NAME,
    encodeHeaderValue(JSON.stringify({userID})),
  );
  return headers;
}

function createHeadersWithInvalidUserData() {
  const headers = new Headers();
  headers.set(USER_DATA_HEADER_NAME, 'invalid');
  return headers;
}

function createHeadersWithUserDataMissingUserID() {
  const headers = new Headers();
  headers.set(USER_DATA_HEADER_NAME, encodeHeaderValue(JSON.stringify({})));
  return headers;
}

function createHeadersWithUserDataWithEmptyUserID() {
  const headers = new Headers();
  headers.set(
    USER_DATA_HEADER_NAME,
    encodeHeaderValue(JSON.stringify({userID: ''})),
  );
  return headers;
}

test('handleConnection', async () => {
  type Case = {
    name: string;
    url: string;
    headers: Headers;
    expectErrorResponse?: string;
    existingRecord?: ClientRecord;
    expectedRecord?: ClientRecord;
    existingClients: ClientMap;
    expectedClients: (socket: Socket) => ClientMap;
    socket?: Socket;
    version: NullableVersion;
  };
  const c2 = client('c2', 'u2');

  const cases: Case[] = [
    {
      name: 'invalid clientid',
      url: 'http://google.com/?baseCookie=1&timestamp=t1&lmid=0&requestID=rid',
      headers: createHeadersWithValidUserData('u1'),
      expectErrorResponse: 'Error: invalid querystring - missing clientID',
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: 1,
    },
    {
      name: 'invalid timestamp',
      url: 'http://google.com/?clientID=c1&baseCookie=1&lmid=0&requestID=rid',
      headers: createHeadersWithValidUserData('u1'),
      expectErrorResponse: 'Error: invalid querystring - missing ts',
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: 1,
    },
    {
      name: 'invalid (non-numeric) timestamp',
      url: 'http://google.com/?clientID=c1&baseCookie=1&ts=xx&lmid=0&requestID=rid',
      headers: createHeadersWithValidUserData('u1'),
      expectErrorResponse:
        'Error: invalid querystring parameter ts, url: http://google.com/?clientID=c1&baseCookie=1&ts=xx&lmid=0&requestID=rid, got: xx',
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: 1,
    },
    {
      name: 'missing lmid',
      url: 'http://google.com/?clientID=c1&baseCookie=1&ts=123',
      headers: createHeadersWithValidUserData('u1'),
      expectErrorResponse: 'Error: invalid querystring - missing lmid',
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: 1,
    },
    {
      name: 'invalid (non-numeric) lmid',
      url: 'http://google.com/?clientID=c1&baseCookie=1&ts=123&lmid=xx',
      headers: createHeadersWithValidUserData('u1'),
      expectErrorResponse:
        'Error: invalid querystring parameter lmid, url: http://google.com/?clientID=c1&baseCookie=1&ts=123&lmid=xx, got: xx',
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: 1,
    },
    {
      name: 'missing requestID',
      url: 'http://google.com/?clientID=c1&baseCookie=1&ts=123&lmid=12',
      headers: createHeadersWithValidUserData('u1'),
      expectErrorResponse: 'Error: invalid querystring - missing requestID',
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: 1,
    },
    {
      name: 'baseCookie: null and version: null',
      url: 'http://google.com/?clientID=c1&baseCookie=&ts=42&lmid=0&requestID=rid',
      headers: createHeadersWithValidUserData('u1'),
      existingClients: new Map(),
      expectedClients: socket => new Map([freshClient('c1', 'u1', socket)]),
      existingRecord: clientRecord(null, 0),
      expectedRecord: clientRecord(null, 0),
      version: null,
    },
    {
      name: 'baseCookie: 1 and version null',
      url: 'http://google.com/?clientID=c1&baseCookie=1&ts=42&lmid=0&requestID=rid',
      headers: createHeadersWithValidUserData('u1'),
      expectErrorResponse: `Unexpected baseCookie. ${maybeOldClientStateMessage}`,
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: null,
    },
    {
      name: 'baseCookie: 2 and version: 1',
      url: 'http://google.com/?clientID=c1&baseCookie=2&ts=42&lmid=0&requestID=rid',
      headers: createHeadersWithValidUserData('u1'),
      expectErrorResponse: `Unexpected baseCookie. ${maybeOldClientStateMessage}`,
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: null,
    },
    {
      name: 'baseCookie: 1 and version: 2',
      url: 'http://google.com/?clientID=c1&baseCookie=1&ts=42&lmid=0&requestID=rid',
      headers: createHeadersWithValidUserData('u1'),
      existingClients: new Map(),
      expectedClients: socket => new Map([freshClient('c1', 'u1', socket)]),
      existingRecord: clientRecord(2, 0),
      expectedRecord: clientRecord(1, 0),
      version: 2,
    },
    {
      name: 'baseCookie: null w/existing clients',
      url: 'http://google.com/?clientID=c1&baseCookie=&ts=42&lmid=0&requestID=rid',
      headers: createHeadersWithValidUserData('u1'),
      existingClients: new Map([c2]),
      expectedClients: socket => new Map([freshClient('c1', 'u1', socket), c2]),
      expectedRecord: clientRecord(null, 0),
      version: 1,
    },
    {
      name: 'existing record',
      url: 'http://google.com/?clientID=c1&baseCookie=7&ts=42&lmid=0&requestID=rid',
      headers: createHeadersWithValidUserData('u1'),
      existingClients: new Map(),
      expectedClients: socket => new Map([freshClient('c1', 'u1', socket)]),
      existingRecord: clientRecord(4, 0),
      expectedRecord: clientRecord(7, 0),
      version: 7,
    },
    {
      name: 'missing user data',
      url: 'http://google.com/?clientID=c1&baseCookie=7&ts=42&lmid=0&requestID=rid',
      headers: new Headers(),
      expectErrorResponse: 'Error: missing user-data',
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: 10,
    },
    {
      name: 'invalid user data',
      url: 'http://google.com/?clientID=c1&baseCookie=7&ts=42&lmid=0&requestID=rid',
      headers: createHeadersWithInvalidUserData(),
      expectErrorResponse: 'Error: invalid user-data - failed to decode/parse',
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: 7,
    },
    {
      name: 'user data missing userID',
      url: 'http://google.com/?clientID=c1&baseCookie=7&ts=42&lmid=0&requestID=rid',
      headers: createHeadersWithUserDataMissingUserID(),
      expectErrorResponse: 'Error: invalid user-data - missing userID',
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: 7,
    },
    {
      name: 'user data with empty userID',
      url: 'http://google.com/?clientID=c1&baseCookie=7&ts=42&lmid=0&requestID=rid',
      headers: createHeadersWithUserDataWithEmptyUserID(),
      expectErrorResponse: 'Error: invalid user-data - missing userID',
      existingClients: new Map(),
      expectedClients: () => new Map(),
      version: 7,
    },
    {
      name: 'Invalid lastMutationID',
      url: 'http://google.com/?clientID=c1&baseCookie=7&ts=42&lmid=100&requestID=rid',
      existingClients: new Map(),
      expectedClients: socket => new Map([freshClient('c1', 'u1', socket)]),
      headers: createHeadersWithValidUserData('u1'),
      existingRecord: clientRecord(7, 0),
      expectErrorResponse: `Unexpected lmid. ${maybeOldClientStateMessage}`,
      version: 7,
    },
  ];

  const durable = await getMiniflareDurableObjectStorage(id);
  const storage = new DurableStorage(durable);

  for (const c of cases) {
    await durable.deleteAll();
    if (c.existingRecord) {
      await putEntry(durable, clientRecordKey('c1'), c.existingRecord, {});
    }

    if (c.version !== null) {
      await putVersion(c.version, storage);
    }

    const onMessage = () => undefined;
    const onClose = () => undefined;
    const mocket = new Mocket();
    const clients = c.existingClients;

    await handleConnection(
      createSilentLogContext(),
      mocket,
      storage,
      new URL(c.url),
      c.headers,
      clients,
      onMessage,
      onClose,
    );

    if (c.expectErrorResponse) {
      expect(mocket.log).toEqual([
        ['send', JSON.stringify(['error', c.expectErrorResponse])],
        ['close'],
      ]);
      continue;
    }
    try {
      expect(mocket.log).toEqual([
        ['send', JSON.stringify(['connected', {requestID: 'rid'}])],
      ]);
      const expectedClients = c.expectedClients(mocket);
      expect(clients).toEqual(expectedClients);

      const actualRecord = await getEntry(
        durable,
        clientRecordKey('c1'),
        clientRecordSchema,
        {},
      );
      expect(actualRecord).toEqual(c.expectedRecord);
    } catch (e) {
      console.log('c.name failed:', c.name);
      throw e;
    }
  }
});

test('getConnectRequest', () => {
  const testError = (
    url: string,
    expectedError: string,
    headers: Headers = new Headers(),
  ) => {
    expect(getConnectRequest(new URL(url), headers)).toEqual({
      error: expectedError,
      result: null,
    });
  };

  const testResult = (
    url: string,
    headers: Headers,
    expectedResult: unknown,
  ) => {
    expect(getConnectRequest(new URL(url), headers)).toEqual({
      error: null,
      result: expectedResult,
    });
  };

  testError(
    'https://www.example.com',
    'Error: invalid querystring - missing clientID',
  );
  testError(
    'https://www.example.com/?clientID=123',
    'Error: invalid querystring - missing ts',
  );

  let url = 'https://www.example.com/?clientID=123&ts=abc';
  testError(
    url,
    `Error: invalid querystring parameter ts, url: ${url}, got: abc`,
  );
  testError(
    'https://www.example.com/?clientID=123&ts=123',
    'Error: invalid querystring - missing lmid',
  );
  testError(
    'https://www.example.com/?clientID=123&ts=123&lmid=456',
    'Error: invalid querystring - missing requestID',
  );
  testError(
    'https://www.example.com/?clientID=123&ts=123&lmid=456&requestID=rid',
    'Error: missing user-data',
  );
  url = 'https://www.example.com/?clientID=123&ts=123&lmid=456&baseCookie=abc';
  testError(
    url,
    `Error: invalid querystring parameter baseCookie, url: ${url}, got: abc`,
  );
  testError(
    'https://www.example.com/?clientID=123&ts=123&lmid=456&requestID=rid',
    'Error: invalid user-data - failed to decode/parse',
    new Headers([[USER_DATA_HEADER_NAME, 'abc']]),
  );
  testError(
    'https://www.example.com/?clientID=123&ts=123&lmid=456&requestID=rid',
    'Error: invalid user-data - missing userID',
    new Headers([[USER_DATA_HEADER_NAME, '42']]),
  );
  testError(
    'https://www.example.com/?clientID=123&ts=123&lmid=456&requestID=rid',
    'Error: invalid user-data - missing userID',
    new Headers([[USER_DATA_HEADER_NAME, '{"userID":null}']]),
  );
  testError(
    'https://www.example.com/?clientID=123&ts=123&lmid=456&requestID=rid',
    'Error: invalid user-data - failed to decode/parse',
    new Headers([[USER_DATA_HEADER_NAME, '{"userID":"u1}']]),
  );

  testResult(
    'https://www.example.com/?clientID=cid1&ts=123&lmid=456&requestID=rid1',
    new Headers([[USER_DATA_HEADER_NAME, '{"userID":"u1","more":"data"}']]),
    {
      clientID: 'cid1',
      userData: {userID: 'u1', more: 'data'},
      timestamp: 123,
      lmid: 456,
      baseCookie: null,
      requestID: 'rid1',
    },
  );
  testResult(
    'https://www.example.com/?clientID=cid1&ts=123&lmid=456&baseCookie=789&requestID=rid2',
    new Headers([[USER_DATA_HEADER_NAME, '{"userID":"u1","more":"data"}']]),
    {
      clientID: 'cid1',
      userData: {userID: 'u1', more: 'data'},
      timestamp: 123,
      lmid: 456,
      baseCookie: 789,
      requestID: 'rid2',
    },
  );
});
