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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --production) PROFILE="production"; shift ;;
    --no-wait) WAIT_FLAG="--no-wait"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

EAS="npx --yes eas-cli@latest"
TOKEN_FILE="${EAS_TOKEN_FILE:-$HOME/.config/photoverify/eas-token}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "node is not installed."

# Reuse a saved access token if the env var isn't already set.
if [[ -z "${EXPO_TOKEN:-}" && -r "$TOKEN_FILE" ]]; then
  EXPO_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  export EXPO_TOKEN
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

if [[ -z "$WAIT_FLAG" ]]; then
  say "Done"
  cat <<'EOF'
Grab the .apk from the build page URL printed above (or:
  npx eas-cli build:list --platform android --limit 1
), then side-load it:  adb install <file>.apk   (or open it on the phone).

The standalone app uses the redirect URI  photoverify://redirect  --
already registered in Authelia's photoverify_mobile client, so sign-in
works without any further config.
EOF
fi
