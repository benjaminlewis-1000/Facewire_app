# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` / `npx expo start` — start the Metro bundler / Expo dev server
- `npm run android` / `npm run ios` — start with a specific platform target
- `npm run web` — run in the browser

There is no test suite, linter, or typecheck configured. The project is plain JavaScript (no TypeScript) on Expo SDK 53 / React Native 0.79 / React 19, with the New Architecture enabled (`newArchEnabled: true` in `app.json`).

## Architecture

PhotoVerify is a single-screen Expo mobile app for human review of face-recognition guesses. A reviewer is shown a cropped face image plus a list of candidate names and confirms, rejects, ignores, or skips each one. All state is local component state — there is no navigation library, Redux, or context; the app swaps between two top-level components based on an `isLoggedIn` flag.

### Two components

- **`LoginScreen.js`** — auth. Owns login, biometric auto-login, and the *initial data fetch*. On successful auth it calls three endpoints in sequence and stashes results in `AsyncStorage` before calling `onLoginSuccess()`:
  1. `POST /api/token/obtain/` → `userToken` (access), `refreshToken`
  2. `GET /api/mobile/confident_unlabeled/` → `confidentUnlabeledIds` (array of instance IDs to review)
  3. `GET /api/mobile/name_list/` → `nameList`
- **`App.js`** — the review UI. On mount (after login) it reads `confidentUnlabeledIds` from `AsyncStorage` and walks the list one ID at a time, fetching per-instance detail on demand.

`index.js` → `registerRootComponent(App)` is the entry point.

### Backend

All requests go to `https://picasa.exploretheworld.tech` (a Django REST backend). Auth header format is **`Authorization: JWT <token>`** (not `Bearer`). Key endpoints beyond the three above:

- `GET /api/mobile/unlabeled_instance/{id}/` — detail for one review item. Response drives the whole screen: `face_img_url`, `source_img_url`, `names[]`, plus per-name action URLs (`confirm_patch_url` + `confirm_patch_data`, `disassociate_patch_url`) and instance-level `ignore_url` + `ignore_payload`.
- `POST /api/token/refresh/` — token refresh.

**HATEOAS-style actions:** the client does not construct action URLs. Each instance-detail response embeds the exact URL + payload for every action (confirm a name, disassociate a name, ignore the person). Review actions are always `PATCH`. See `handleProcessAction` in `App.js`.

### Token refresh pattern

Every authenticated request in `App.js` (`sendPatchRequest`, `fetchUnlabeledInstanceData`) follows the same shape: send request → on `401`/`403`, call `refreshAccessToken()` → retry once with the new token → if refresh fails, `handleLogout()`. When adding a new authenticated call, replicate this pattern rather than assuming the token is valid.

### Review flow state (App.js)

- `confidentUnlabeledIds` — the full work list (from storage).
- `currentUnlabeledInstanceIndex` — which item is on screen.
- `latestProcessedIndex` — how far the reviewer has advanced. When `currentUnlabeledInstanceIndex < latestProcessedIndex` the user is looking *back* at an already-handled item, and the UI swaps the name list / Skip / Verify / Ignore buttons for a single "Reset Face" button.
- Selection is mutually exclusive: picking a name clears "Ignore person" and vice versa. "Verify" is enabled only when one of them is selected; "Skip" advances without a PATCH.
- `"None of the above"` is appended to `buttonNames` client-side and, when chosen, fires a `disassociate_patch_url` PATCH for *every* name on the instance.

### Known incomplete areas

- "Reset Face" (`confirmUndoAssignment`) is a TODO — logs only, no API call.
- The image zoom libraries are in flux: several are in `package.json`, `App.js` currently uses `@likashefqet/react-native-image-zoom` for the full-screen source-image modal and a plain `<Image>` for the main view, with commented-out alternatives (`react-native-zoom-toolkit`).

### Credential storage caveat

`savedUsername` / `savedPassword` are stored **in plaintext** in `AsyncStorage` to support biometric re-login (biometrics gate access to the stored password, which is then replayed to `/api/token/obtain/`). `handleLogout` intentionally keeps them; only "Delete Saved Login" clears them.
