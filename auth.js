// OIDC (Authelia) auth for PhotoVerify.
//
// The app is a public OIDC client ("photoverify_mobile") registered in
// Authelia. It runs an Authorization Code + PKCE flow in the system
// browser (see LoginScreen.js), then talks to the Django API with the
// resulting ID token as `Authorization: Bearer <id_token>` (validated
// server-side by api/authentication.py:AutheliaOIDCAuthentication).
//
// The refresh token (offline_access scope) is kept in expo-secure-store
// and used to silently mint fresh tokens on later launches, gated behind
// a device biometric prompt. Only when the refresh token itself expires
// or is revoked does the user do the full browser login again.

import * as SecureStore from 'expo-secure-store';
import * as AuthSession from 'expo-auth-session';

export const ISSUER = 'https://auth.exploretheworld.tech';
export const CLIENT_ID = 'photoverify_mobile';
export const SCOPES = ['openid', 'profile', 'email', 'offline_access'];
export const API_BASE = 'https://picasa.exploretheworld.tech/api';

// Standalone builds resolve this to `photoverify://redirect`; in Expo Go
// it becomes an `exp://<metro-host>/--/redirect` URL. Whatever it
// resolves to at runtime must be registered verbatim in Authelia's
// `redirect_uris` for this client -- LoginScreen logs it on mount.
export const REDIRECT_URI = AuthSession.makeRedirectUri({
  scheme: 'photoverify',
  path: 'redirect',
});

const KEYS = {
  refresh: 'pv_refresh_token',
  id: 'pv_id_token',
  access: 'pv_access_token',
  idExp: 'pv_id_token_exp',
};

let _discovery = null;

export async function getDiscovery() {
  if (_discovery) return _discovery;
  _discovery = await AuthSession.fetchDiscoveryAsync(ISSUER);
  return _discovery;
}

function decodeJwtExp(jwt) {
  try {
    const payload = JSON.parse(
      // atob is available in the Hermes/RN runtime via a polyfill in SDK 53
      decodeURIComponent(
        atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      )
    );
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch (e) {
    return 0;
  }
}

export async function saveTokenResponse(tokenResponse) {
  // tokenResponse is an expo-auth-session TokenResponse (or the plain
  // object returned by refreshAsync).
  const idToken = tokenResponse.idToken;
  const accessToken = tokenResponse.accessToken;
  const refreshToken = tokenResponse.refreshToken;

  const writes = [];
  if (idToken) {
    writes.push(SecureStore.setItemAsync(KEYS.id, idToken));
    writes.push(
      SecureStore.setItemAsync(KEYS.idExp, String(decodeJwtExp(idToken)))
    );
  }
  if (accessToken) writes.push(SecureStore.setItemAsync(KEYS.access, accessToken));
  // Authelia rotates refresh tokens; only overwrite when we got a new one.
  if (refreshToken) writes.push(SecureStore.setItemAsync(KEYS.refresh, refreshToken));
  await Promise.all(writes);
}

export async function hasRefreshToken() {
  return !!(await SecureStore.getItemAsync(KEYS.refresh));
}

// Authelia rotates refresh tokens, so concurrent refreshes (the app fires
// many parallel authedFetch calls) would race: the first invalidates the
// shared refresh token and the rest fail. Dedupe to a single in-flight
// refresh that all callers await.
let _refreshInFlight = null;

export function refreshTokens() {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async () => {
    try {
      const refreshToken = await SecureStore.getItemAsync(KEYS.refresh);
      if (!refreshToken) throw new Error('no_refresh_token');
      const discovery = await getDiscovery();
      const result = await AuthSession.refreshAsync(
        { clientId: CLIENT_ID, refreshToken, scopes: SCOPES },
        discovery
      );
      await saveTokenResponse(result);
      return result;
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}

// Returns a currently-valid ID token, refreshing first if it's within
// `skewSeconds` of expiry. Throws if there's no way to get one (caller
// should send the user back to the login screen).
export async function getValidIdToken(skewSeconds = 60) {
  const [idToken, expStr] = await Promise.all([
    SecureStore.getItemAsync(KEYS.id),
    SecureStore.getItemAsync(KEYS.idExp),
  ]);
  const exp = Number(expStr) || 0;
  const now = Math.floor(Date.now() / 1000);

  if (idToken && exp - skewSeconds > now) return idToken;

  const refreshed = await refreshTokens();
  if (!refreshed.idToken) throw new Error('no_id_token_after_refresh');
  return refreshed.idToken;
}

// Force a refresh regardless of local expiry (used after the API returns
// 401/403 -- the token may have been revoked server-side).
export async function forceRefreshIdToken() {
  const refreshed = await refreshTokens();
  if (!refreshed.idToken) throw new Error('no_id_token_after_refresh');
  return refreshed.idToken;
}

// Full sign-out: wipe everything, including the refresh token. Getting
// back in requires the browser OIDC flow.
export async function signOut() {
  await Promise.all(
    Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k))
  );
}

// Lock: drop the active-session tokens but KEEP the refresh token, so the
// login screen can offer an instant biometric sign-in.
export async function lockSession() {
  await Promise.all(
    [KEYS.id, KEYS.idExp, KEYS.access].map((k) => SecureStore.deleteItemAsync(k))
  );
}

const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3; // 1 try + 2 retries
const RETRY_BASE_MS = 500;

// A single fetch with a hard timeout (RN's fetch never times out on its
// own -- a half-open connection would hang forever otherwise).
async function timedFetch(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() with:
 *  - bearer token attached, one refresh-and-retry on 401/403
 *  - a per-request timeout
 *  - automatic retry with backoff on network failure / 5xx (not on 4xx)
 *
 * Never throws. On unrecoverable failure returns a sentinel:
 *  - { ok:false, status:401, authError:true }   token unavailable / rejected
 *  - { ok:false, status:0,   networkError:true } offline / timeout / server
 *    unreachable after retries
 * Otherwise returns the real Response (4xx included, for the caller to read).
 */
export async function authedFetch(url, options = {}) {
  let idToken;
  try {
    idToken = await getValidIdToken();
  } catch (e) {
    return { ok: false, status: 401, authError: true };
  }

  const withAuth = (tok) => ({
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${tok}` },
  });

  let lastNetworkErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await timedFetch(url, withAuth(idToken));
    } catch (e) {
      // Network down, DNS failure, timeout (AbortError), TLS error, ...
      lastNetworkErr = e;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      break;
    }

    if (response.status === 401 || response.status === 403) {
      try {
        idToken = await forceRefreshIdToken();
      } catch (e) {
        response.authError = true;
        return response;
      }
      try {
        response = await timedFetch(url, withAuth(idToken));
      } catch (e) {
        lastNetworkErr = e;
        break;
      }
      if (response.status === 401 || response.status === 403) {
        response.authError = true;
      }
      return response;
    }

    // Transient server errors -> retry; everything else -> hand back.
    if (response.status >= 500 && response.status <= 599 && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      continue;
    }
    return response;
  }

  console.warn('authedFetch gave up:', url, lastNetworkErr?.message);
  return { ok: false, status: 0, networkError: true };
}
