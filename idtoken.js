// Verifies sign-in tokens from the 6j0.org ID server, using only node:crypto.
//
// Tokens are compact JWTs signed with Ed25519 ("EdDSA"). The public keys come from the ID server's JWKS
// (ID_JWKS_URL, default ID_ORIGIN + /.well-known/jwks.json), cached and re-fetched when an unknown kid shows up.
// A token is accepted once: iss, aud, exp, and nonce must match, and its jti is remembered until it expires.
// Deletion notices (a 6j0 ID was deleted) are checked the same way, but have no nonce and carry an event instead.

import { createPublicKey, verify } from 'node:crypto';

export class IdTokenError extends Error {}

const JWKS_MIN_REFETCH_MS = 60 * 1000;
const CLOCK_SKEW_S = 30;

let keys = new Map(); // kid -> KeyObject
let fetchedAt = 0;

async function refreshKeys(jwksUrl) {
  if (Date.now() - fetchedAt < JWKS_MIN_REFETCH_MS) return;
  fetchedAt = Date.now();
  const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new IdTokenError(`Couldn't load the ID server's keys (HTTP ${res.status})`);
  const next = new Map();
  for (const k of (await res.json()).keys || []) {
    if (k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.kid === 'string')
      next.set(k.kid, createPublicKey({ key: { kty: k.kty, crv: k.crv, x: k.x }, format: 'jwk' }));
  }
  keys = next;
}

const seen = new Map(); // jti -> exp (seconds)

const part = (s) => {
  try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { throw new IdTokenError('Bad sign-in token'); }
};

// The checks every token gets: signature, iss, aud, exp, iat, sub, and jti. Returns the claims; the caller checks
// the rest, then calls use() to accept the token once.
async function check(token, { issuer, audience, jwksUrl }) {
  if (typeof token !== 'string' || token.length > 4096) throw new IdTokenError('Bad sign-in token');
  const [h, b, s] = token.split('.');
  if (!h || !b || !s) throw new IdTokenError('Bad sign-in token');
  const head = part(h), claims = part(b);
  if (head.alg !== 'EdDSA') throw new IdTokenError('Unexpected sign-in token algorithm');

  if (!keys.has(head.kid)) await refreshKeys(jwksUrl);
  const key = keys.get(head.kid);
  if (!key) throw new IdTokenError('Sign-in token was signed with an unknown key');
  if (!verify(null, Buffer.from(`${h}.${b}`), key, Buffer.from(s, 'base64url'))) throw new IdTokenError('Sign-in token signature check failed');

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== issuer) throw new IdTokenError('Sign-in token is from a different ID server');
  if (claims.aud !== audience) throw new IdTokenError('Sign-in token is for a different app');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) throw new IdTokenError('Sign-in token expired. Please try again.');
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_S > now) throw new IdTokenError('Sign-in token is from the future');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 64) throw new IdTokenError('Bad sign-in token subject');
  if (typeof claims.jti !== 'string' || !claims.jti) throw new IdTokenError('Bad sign-in token');
  return claims;
}
function use(claims) {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, exp] of seen) if (exp + CLOCK_SKEW_S < now) seen.delete(k);
  if (seen.has(claims.jti)) throw new IdTokenError('Sign-in token was already used');
  seen.set(claims.jti, claims.exp);
  return claims;
}

// A sign-in token. Returns its claims ({ sub, saved?, ... }) or throws IdTokenError.
export async function verifyIdToken(token, { issuer, audience, nonce, jwksUrl }) {
  const claims = await check(token, { issuer, audience, jwksUrl });
  if (claims.events !== undefined) throw new IdTokenError("That's not a sign-in token");
  if (typeof nonce !== 'string' || claims.nonce !== nonce) throw new IdTokenError('Sign-in token does not match this sign-in');
  return use(claims);
}

// A notice that a 6j0 ID was deleted (the ID server POSTs it to /api/id/deleted): signed like a sign-in token, but
// with no nonce and with events: { "6j0/v1/identity-deleted": {} } (the event's name is from before "ID", and stays).
// Returns its claims or throws.
const DELETED_EVENT = '6j0/v1/identity-deleted';
export async function verifyDeletionToken(token, { issuer, audience, jwksUrl }) {
  const claims = await check(token, { issuer, audience, jwksUrl });
  if (claims.nonce !== undefined || !claims.events || typeof claims.events !== 'object' || !Object.hasOwn(claims.events, DELETED_EVENT))
    throw new IdTokenError("That's not a deletion notice");
  return use(claims);
}
