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
import { authedFetch, getValidIdToken } from '../auth';

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

test('token refresh fails -> authError, no retry', async () => {
  AuthSession.refreshAsync.mockRejectedValueOnce(new Error('bad refresh token'));
  global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
  const r = await authedFetch('http://x/');
  expect(r.authError).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
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
