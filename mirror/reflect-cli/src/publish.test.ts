import {expect, jest, test} from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {assert, assertString} from 'shared/src/asserts.js';
import {publishHandler} from './publish.js';
import {useFakeAuthConfig} from './test-helpers.js';

type Args = Parameters<typeof publishHandler>[0];

useFakeAuthConfig();

test('it should throw if file not found', async () => {
  const script = `./test${Math.random().toString(32).slice(2)}.ts`;

  await expect(publishHandler({script} as Args)).rejects.toEqual(
    expect.objectContaining({
      constructor: Error,
      message: expect.stringMatching(
        new RegExp('^File not found: .*' + script + '$'),
      ),
    }),
  );
});

async function writeTempFile(data: string, filename = 'test.js') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reflect-publish-test-'));
  const testFilePath = path.join(dir, filename);
  await fs.writeFile(testFilePath, data, 'utf-8');
  return testFilePath;
}

test('it should throw if the source has syntax errors', async () => {
  const testFilePath = await writeTempFile('const x =');
  await expect(publishHandler({script: testFilePath} as Args)).rejects.toEqual(
    expect.objectContaining({
      constructor: Error,
      message: expect.stringMatching(/Unexpected end of file/),
    }),
  );
});

test('it should compile typescript', async () => {
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  fetchSpy.mockImplementationOnce((url, init) => {
    expect(url).toMatch(/\/publish$/);
    assert(init);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-type': 'application/json',
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'Authorization': expect.stringMatching(/^Bearer /),
    });
    assertString(init.body);
    const body = JSON.parse(init.body);

    expect(body).toMatchObject({
      data: {
        name: 'test-name',
        requester: {
          userAgent: {
            type: 'reflect-cli',
            version: '0.1.0',
          },
          userID: 'fake-uid',
        },
        source: {
          content: expect.stringContaining(`var x = 42;`),
          name: 'test.js',
        },
        sourcemap: {content: expect.any(String), name: 'test.js.map'},
      },
    });
    return Promise.resolve(new Response('{"result":{"success":"OK"}}'));
  });

  const testFilePath = await writeTempFile(
    'const x: number = 42; console.log(x);',
    'test.ts',
  );
  await publishHandler({script: testFilePath, name: 'test-name'} as Args);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
