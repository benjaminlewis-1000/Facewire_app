#!/usr/bin/env bash
#
# Build a PhotoVerify Android APK via EAS Build (Expo's cloud builder).
#
# Local Android/Java toolchain is NOT required -- the build runs on Expo's
# servers and you download the finished .apk.
#
# One-time setup:
#   1. Have a (free) Expo account:  https://expo.dev/signup
#   2. Log in:                      npx eas-cli login
#      (or export EXPO_TOKEN=... from an account access token)
#
# Then just run:  ./build-apk.sh
#
#   --profile <name>   EAS build profile (default: preview -> installable APK)
#   --production       shorthand for --profile production
#   --no-wait          queue the build and exit (don't stream progress)
#
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="preview"
WAIT_FLAG=""
GET_ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --production) PROFILE="production"; shift ;;
    --no-wait) WAIT_FLAG="--no-wait"; shift ;;
    --get) GET_ONLY=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Prefer an already-installed eas-cli (global, or one npx has cached from a
# previous run) -- re-downloading eas-cli@latest on every build is ~400 MB
# of npm traffic that's slow and flaky. Fall back to npx only if nothing
# is cached.
_find_cached_eas() {
  command -v eas >/dev/null 2>&1 && { echo "eas"; return; }
  local b
  for b in "$HOME"/.npm/_npx/*/node_modules/.bin/eas; do
    [ -x "$b" ] && { echo "$b"; return; }
  done
  echo ""
}
EAS="$(_find_cached_eas)"
[ -n "$EAS" ] || EAS="npx --yes eas-cli@latest"

TOKEN_FILE="${EAS_TOKEN_FILE:-$HOME/.config/photoverify/eas-token}"
OUT_DIR="$HOME/PhotoVerify-builds"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node is not installed."

if [[ -z "${EXPO_TOKEN:-}" && -r "$TOKEN_FILE" ]]; then
  EXPO_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"; export EXPO_TOKEN
fi

# --get: just download the most recent finished Android build, no rebuild.
if [[ -n "$GET_ONLY" ]]; then
  say "Fetching the latest finished Android build"
  URL=$($EAS build:list --platform android --status finished --limit 1 --json --non-interactive 2>/dev/null | node -e \
    'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d)[0].artifacts.applicationArchiveUrl||"")}catch{console.log("")}})')
  [[ -n "$URL" ]] || die "No finished build found."
  mkdir -p "$OUT_DIR"
  DEST="$OUT_DIR/PhotoVerify-$(date +%Y%m%d-%H%M).apk"
  curl -fSL -o "$DEST" "$URL"
  say "Saved: $DEST"
  exit 0
fi

say "Checking Expo login"
if [[ -n "${EXPO_TOKEN:-}" ]]; then
  echo "Using EXPO_TOKEN ($([[ -r "$TOKEN_FILE" ]] && echo "from $TOKEN_FILE" || echo "from environment"))."
elif WHO=$($EAS whoami 2>/dev/null); then
  echo "Logged in as: $WHO"
else
  die "Not logged in. Run 'npx eas-cli login' (or set EXPO_TOKEN), then re-run."
fi

# Non-interactive when we have a token (CI-style); interactive otherwise.
NI=""
[[ -n "${EXPO_TOKEN:-}" ]] && NI="--non-interactive"

# EAS needs the project registered (writes extra.eas.projectId into app.json).
if ! grep -q '"projectId"' app.json 2>/dev/null; then
  say "First run: registering this app with EAS (creates a project on your account)"
  $EAS init $NI --force
fi

say "Sanity-checking the JS bundle before uploading"
npx expo export --platform android --output-dir .easbuild-check >/dev/null
rm -rf .easbuild-check
echo "Bundle OK."

say "Starting EAS build  (platform=android, profile=$PROFILE)"
echo "The keystore is auto-generated and stored on your Expo account the first time."
$EAS build --platform android --profile "$PROFILE" $NI $WAIT_FLAG

if [[ -n "$WAIT_FLAG" ]]; then
  cat <<EOF

Build queued. Watch it / grab the APK from the build page URL above, or run
  ./build-apk.sh --get
once it finishes.
EOF
  exit 0
fi

# Build ran to completion (no --no-wait) -> pull the artifact down.
say "Downloading the finished APK"
APK_URL=$($EAS build:view --json 2>/dev/null | node -e \
  'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).artifacts.applicationArchiveUrl||"")}catch{console.log("")}})')
if [[ -z "$APK_URL" ]]; then
  APK_URL=$($EAS build:list --platform android --limit 1 --json --non-interactive 2>/dev/null | node -e \
    'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d)[0].artifacts.applicationArchiveUrl||"")}catch{console.log("")}})')
fi
if [[ -n "$APK_URL" ]]; then
  mkdir -p "$OUT_DIR"
  DEST="$OUT_DIR/PhotoVerify-$PROFILE-$(date +%Y%m%d-%H%M).apk"
  curl -fSL -o "$DEST" "$APK_URL"
  say "Saved: $DEST"
else
  echo "Could not resolve the artifact URL -- grab it from the build page above." >&2
fi

cat <<'EOF'

Side-load it:  adb install <file>.apk   (or copy to the phone and open it).
Sign-in works out of the box: the standalone app's redirect URI
  photoverify://redirect  is already in Authelia's photoverify_mobile client.
EOF
