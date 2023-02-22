import * as s from 'superstruct';
import {pingMessageSchema} from './ping.js';
import {pullRequestMessageSchema} from './pull.js';
import {pushMessageSchema} from './push.js';

export const upstreamSchema = s.union([
  pingMessageSchema,
  pushMessageSchema,
  pullRequestMessageSchema,
]);

export type Upstream = s.Infer<typeof upstreamSchema>;
