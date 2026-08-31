jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock('expo-auth-session', () => ({
  fetchDiscoveryAsync: jest.fn(() => Promise.resolve({})),
  refreshAsync: jest.fn(),
  makeRedirectUri: jest.fn(() => 'photoverify://redirect'),
}));

import * as SecureStore from 'expo-secure-store';
import * as AuthSession from 'expo-auth-session';
import {
  authedFetch,
  getValidIdToken,
  refreshTokens,
  saveTokenResponse,
  signOut,
  lockSession,
} from '../auth';

const FAR_FUTURE = String(Math.floor(Date.now() / 1000) + 3600);

beforeEach(() => {
  jest.clearAllMocks();
  SecureStore.getItemAsync.mockImplementation((k) => {
    if (k === 'pv_id_token') return Promise.resolve('TOKEN');
    if (k === 'pv_id_token_exp') return Promise.resolve(FAR_FUTURE);
    if (k === 'pv_refresh_token') return Promise.resolve('REFRESH');
    return Promise.resolve(null);
  });
  global.fetch = jest.fn();
});

test('success: returns the response, no retry, bearer attached', async () => {
  global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });
  const r = await authedFetch('http://x/');
  expect(r.status).toBe(200);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer TOKEN');
});

test('retries on a thrown network error, then succeeds', async () => {
  global.fetch
    .mockRejectedValueOnce(new Error('Network request failed'))
    .mockResolvedValueOnce({ ok: true, status: 200 });
  const r = await authedFetch('http://x/');
  expect(r.status).toBe(200);
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test('gives up with a networkError sentinel after max attempts', async () => {
  global.fetch.mockRejectedValue(new Error('down'));
  const r = await authedFetch('http://x/');
  expect(r).toEqual({ ok: false, status: 0, networkError: true });
  expect(global.fetch).toHaveBeenCalledTimes(3);
});

test('retries on 5xx', async () => {
  global.fetch
    .mockResolvedValueOnce({ ok: false, status: 503 })
    .mockResolvedValueOnce({ ok: true, status: 200 });
  const r = await authedFetch('http://x/');
  expect(r.status).toBe(200);
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test('does NOT retry on 4xx', async () => {
  global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
  const r = await authedFetch('http://x/');
  expect(r.status).toBe(404);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('401 -> refreshes the token and retries once', async () => {
  AuthSession.refreshAsync.mockResolvedValueOnce({ idToken: 'NEW', refreshToken: 'R2' });
  global.fetch
    .mockResolvedValueOnce({ ok: false, status: 401 })
    .mockResolvedValueOnce({ ok: true, status: 200 });
  const r = await authedFetch('http://x/');
  expect(r.status).toBe(200);
  expect(AuthSession.refreshAsync).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer NEW');
});

test('401 after refresh -> authError', async () => {
  AuthSession.refreshAsync.mockResolvedValueOnce({ idToken: 'NEW' });
  global.fetch
    .mockResolvedValueOnce({ ok: false, status: 401 })
    .mockResolvedValueOnce({ ok: false, status: 401 });
  const r = await authedFetch('http://x/');
  expect(r.authError).toBe(true);
});

test('refresh token genuinely rejected (invalid_grant) -> authError', async () => {
  const err = new Error('The refresh token is invalid.');
  err.code = 'invalid_grant';
  AuthSession.refreshAsync.mockRejectedValue(err);
  global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
  const r = await authedFetch('http://x/');
  expect(r.authError).toBe(true);
  // invalid_grant is terminal -- no point retrying the refresh.
  expect(AuthSession.refreshAsync).toHaveBeenCalledTimes(1);
});

test('transient refresh failure -> networkError (session kept), refresh retried', async () => {
  AuthSession.refreshAsync.mockRejectedValue(new Error('Network request failed'));
  global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
  const r = await authedFetch('http://x/');
  expect(r.networkError).toBe(true);
  expect(r.authError).toBeUndefined();
  expect(AuthSession.refreshAsync).toHaveBeenCalledTimes(3); // 1 + 2 retries
});

test('refresh recovers on a retry after a transient blip', async () => {
  AuthSession.refreshAsync
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValueOnce({ idToken: 'NEW', refreshToken: 'R2' });
  global.fetch
    .mockResolvedValueOnce({ ok: false, status: 401 })
    .mockResolvedValueOnce({ ok: true, status: 200 });
  const r = await authedFetch('http://x/');
  expect(r.status).toBe(200);
  expect(AuthSession.refreshAsync).toHaveBeenCalledTimes(2);
});

describe('getValidIdToken (proactive refresh)', () => {
  const setExp = (secondsFromNow) =>
    SecureStore.getItemAsync.mockImplementation((k) => {
      if (k === 'pv_id_token') return Promise.resolve('OLD');
      if (k === 'pv_id_token_exp')
        return Promise.resolve(String(Math.floor(Date.now() / 1000) + secondsFromNow));
      if (k === 'pv_refresh_token') return Promise.resolve('REFRESH');
      return Promise.resolve(null);
    });

  test('returns the current token when comfortably valid', async () => {
    setExp(3600);
    expect(await getValidIdToken()).toBe('OLD');
    expect(AuthSession.refreshAsync).not.toHaveBeenCalled();
  });

  test('refreshes when within the default 60s skew', async () => {
    setExp(30);
    AuthSession.refreshAsync.mockResolvedValueOnce({ idToken: 'FRESH' });
    expect(await getValidIdToken()).toBe('FRESH');
  });

  test('honours a larger skew (the foreground keepalive uses 300s)', async () => {
    setExp(120); // valid for 2 more min, but < 5 min
    AuthSession.refreshAsync.mockResolvedValueOnce({ idToken: 'FRESH' });
    expect(await getValidIdToken(300)).toBe('FRESH');
  });

  test('already expired -> refreshes', async () => {
    setExp(-10);
    AuthSession.refreshAsync.mockResolvedValueOnce({ idToken: 'FRESH' });
    expect(await getValidIdToken()).toBe('FRESH');
  });
});

describe('refreshTokens', () => {
  const tick = () => new Promise((r) => setImmediate(r));

  test('concurrent callers share ONE in-flight refresh (no token-rotation storm)', async () => {
    let resolveRefresh;
    AuthSession.refreshAsync.mockImplementationOnce(
      () => new Promise((r) => { resolveRefresh = r; })
    );

    const all = Promise.all([refreshTokens(), refreshTokens(), refreshTokens()]);
    // let the shared async body get as far as calling refreshAsync
    while (!resolveRefresh) await tick();
    resolveRefresh({ idToken: 'FRESH', refreshToken: 'ROTATED' });
    await all;

    expect(AuthSession.refreshAsync).toHaveBeenCalledTimes(1);
  });

  test('a new refresh can happen after the previous one settled', async () => {
    AuthSession.refreshAsync
      .mockResolvedValueOnce({ idToken: 'A' })
      .mockResolvedValueOnce({ idToken: 'B' });
    await refreshTokens();
    await refreshTokens();
    expect(AuthSession.refreshAsync).toHaveBeenCalledTimes(2);
  });
});

describe('token storage', () => {
  test('saveTokenResponse only overwrites the refresh token when a new one is returned', async () => {
    await saveTokenResponse({ idToken: 'i', accessToken: 'a' }); // no refreshToken
    const keys = SecureStore.setItemAsync.mock.calls.map(([k]) => k);
    expect(keys).not.toContain('pv_refresh_token');

    SecureStore.setItemAsync.mockClear();
    await saveTokenResponse({ idToken: 'i', refreshToken: 'r2' });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('pv_refresh_token', 'r2');
  });

  test('signOut clears everything including the refresh token', async () => {
    await signOut();
    const cleared = SecureStore.deleteItemAsync.mock.calls.map(([k]) => k);
    expect(cleared).toEqual(
      expect.arrayContaining([
        'pv_refresh_token',
        'pv_id_token',
        'pv_access_token',
        'pv_id_token_exp',
      ])
    );
  });

  test('lockSession drops the session tokens but KEEPS the refresh token', async () => {
    await lockSession();
    const cleared = SecureStore.deleteItemAsync.mock.calls.map(([k]) => k);
    expect(cleared).toEqual(
      expect.arrayContaining(['pv_id_token', 'pv_id_token_exp', 'pv_access_token'])
    );
    expect(cleared).not.toContain('pv_refresh_token');
  });
});
