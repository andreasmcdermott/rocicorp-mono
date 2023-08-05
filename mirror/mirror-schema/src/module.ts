import type {Storage} from 'firebase-admin/storage';
import type {Bucket} from '@google-cloud/storage';
import * as crypto from 'shared/src/mirror/crypto.js';
import {parseCloudStorageURL} from './cloud-storage.js';
import * as v from 'shared/src/valita.js';

// Subset of the wrangler `CfModuleType` applicable to Mirror.
export const moduleTypeSchema = v.union(v.literal('esm'), v.literal('text'));

export type ModuleType = v.Infer<typeof moduleTypeSchema>;

export const moduleRefSchema = v.object({
  name: v.string(),
  type: v.union(v.literal('esm'), v.literal('text')),
  // gs://bucketname/filename. url is the filename used in Google Cloud Storage. It has a GUID in it.
  url: v.string(),
});

export type ModuleRef = v.Infer<typeof moduleRefSchema>;

export type Module = {
  name: string;
  type: ModuleType;
  content: string;
};

/**
 * Stores the module in Google Cloud Storage and returns the URL (gs://...) of
 * the uploaded file.
 */
export async function storeModule(
  bucket: Bucket,
  module: Module,
): Promise<ModuleRef> {
  const filename = await sha256OfString(module.content);
  const file = bucket.file(filename);
  const [exists] = await file.exists();
  if (!exists) {
    await file.save(module.content, {resumable: false});
  }
  return {
    name: module.name,
    url: file.cloudStorageURI.href,
    type: module.type,
  };
}

export async function loadModule(
  storage: Storage,
  ref: ModuleRef,
): Promise<Module> {
  const {url} = ref;
  const {bucketName, filename} = parseCloudStorageURL(url);
  const file = (await storage.bucket(bucketName).file(filename).get())[0];
  const [content] = await file.download();

  return {
    name: ref.name,
    type: ref.type,
    content: content.toString('utf-8'),
  };
}

export async function sha256OfString(s: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(s);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return hexStringFromBuffer(hash);
}

function hexStringFromBuffer(hash: ArrayBuffer): string {
  let s = '';
  for (const byte of new Uint8Array(hash)) {
    s += byte < 10 ? '0' : '' + byte.toString(16);
  }
  return s;
}
