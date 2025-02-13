import {
  createRemoteJWKSet,
  jwtVerify,
  type JWK,
  type JWTClaimVerificationOptions,
  type JWTPayload,
  type KeyLike,
} from 'jose';
import type {AuthConfig} from '../config/zero-config.ts';
import {assert} from '../../../shared/src/asserts.ts';

let remoteKeyset: ReturnType<typeof createRemoteJWKSet> | undefined;
function getRemoteKeyset(jwksUrl: string) {
  if (remoteKeyset === undefined) {
    remoteKeyset = createRemoteJWKSet(new URL(jwksUrl));
  }

  return remoteKeyset;
}

export async function verifyToken(
  config: AuthConfig,
  token: string,
  verifyOptions: JWTClaimVerificationOptions,
): Promise<JWTPayload> {
  const numOptionsSet = [config.jwk, config.secret, config.jwksUrl].reduce(
    (l, r) => l + (r !== undefined ? 1 : 0),
    0,
  );
  assert(
    numOptionsSet === 1,
    'Exactly one of jwk, secret, or jwksUrl must be set in order to verify tokens',
  );

  if (config.jwk !== undefined) {
    return verifyTokenImpl(token, loadJwk(config.jwk), verifyOptions);
  }

  if (config.secret !== undefined) {
    return verifyTokenImpl(token, loadSecret(config.secret), verifyOptions);
  }

  if (config.jwksUrl !== undefined) {
    const remoteKeyset = getRemoteKeyset(config.jwksUrl);
    return (await jwtVerify(token, remoteKeyset, verifyOptions)).payload;
  }

  throw new Error(
    'verifyToken was called but no auth options (one of: jwk, secret, jwksUrl) were configured.',
  );
}

function loadJwk(jwkString: string) {
  return JSON.parse(jwkString) as JWK;
}

function loadSecret(secret: string) {
  return new TextEncoder().encode(secret);
}

async function verifyTokenImpl(
  token: string,
  verifyKey: Uint8Array | KeyLike | JWK,
  verifyOptions: JWTClaimVerificationOptions,
): Promise<JWTPayload> {
  const {payload} = await jwtVerify(token, verifyKey, verifyOptions);

  return payload;
}
