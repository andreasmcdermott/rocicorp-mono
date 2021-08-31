import type * as kv from '../kv/mod';
import {Chunk} from './chunk';
import {chunkDataKey, chunkMetaKey, headKey} from './key';
import * as utf8 from '../utf8';

export class Read {
  private readonly _kvr: kv.Read;

  constructor(kv: kv.Read) {
    this._kvr = kv;
  }

  async hasChunk(hash: string): Promise<boolean> {
    return await this._kvr.has(chunkDataKey(hash));
  }

  async getChunk(hash: string): Promise<Chunk | undefined> {
    const data = await this._kvr.get(chunkDataKey(hash));
    if (data === undefined) {
      return undefined;
    }

    const meta = await this._kvr.get(chunkMetaKey(hash));
    return Chunk.read(hash, data, meta);
  }

  async getHead(name: string): Promise<string | undefined> {
    const data = await this._kvr.get(headKey(name));
    return data && utf8.decode(data);
  }

  close(): void {
    this._kvr.release();
  }
}
