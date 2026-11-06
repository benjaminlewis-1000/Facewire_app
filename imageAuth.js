import { useState, useEffect } from 'react';

import { getValidIdToken } from './auth';

/**
 * Everything that touches authenticated face/source image URLs
 * (KeyedImageView's access_key path, now rate-limited to 2/min unless
 * authenticated) should go through this module rather than re-deriving
 * its own headers or token-fetch effect. Centralizing it is what makes
 * two past bugs structurally impossible to reintroduce elsewhere:
 *   - Image.prefetch(url) can't carry headers at all -- there's no
 *     prefetch export here on purpose. A hidden, authenticated <Image>
 *     pool (see App.js's prefetchUrls) is the only way to warm the cache.
 *   - RN Android's Image.android.js only wires source.headers into
 *     native props when source is an ARRAY ([{uri, headers}]), not a
 *     plain {uri, headers} object -- authedSource always returns the
 *     array form.
 */

// Holds the current ID token, (re)fetched whenever `active` flips true.
// Cheap to call repeatedly -- getValidIdToken only hits the network when
// the cached token is near expiry. Returns [idToken, setIdToken] like
// useState, so callers with their own extra refresh triggers (e.g. an
// early per-item refresh, a keepalive ping) can still prime it directly.
export function useAuthedIdToken(active) {
  const [idToken, setIdToken] = useState(null);
  useEffect(() => {
    if (!active) return;
    getValidIdToken()
      .then(setIdToken)
      .catch((e) => console.warn('image auth token fetch failed:', e?.message));
  }, [active]);
  return [idToken, setIdToken];
}

// Array-form <Image>/<ImageZoom> source carrying the Authorization header
// these URLs require. Returns null while idToken (or uri) isn't ready,
// so callers can gate mounting on it directly:
//   authedSource(uri, idToken) && <Image source={authedSource(uri, idToken)} .../>
export function authedSource(uri, idToken) {
  if (!idToken || !uri) return null;
  return [{ uri, headers: { Authorization: `Bearer ${idToken}` } }];
}
