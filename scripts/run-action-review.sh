#!/usr/bin/env bash

# Canonical GitHub Action review runner. Contributor code enters only as patch
# data; this script never checks out or executes a pull-request head.
set -u

DIFF_FILE=$(mktemp)
trap 'rm -f "$DIFF_FILE"' EXIT

MAX_TIMEOUT="${GITGECKO_MAX_TIMEOUT:-600}"
CURL_BIN="${GITGECKO_CURL_BIN:-curl}"
case "$MAX_TIMEOUT" in
  ''|*[!0-9]*) echo "max_timeout must be an integer number of seconds" >&2; exit 2 ;;
esac
if [ "$MAX_TIMEOUT" -lt 1 ] || [ "$MAX_TIMEOUT" -gt 3600 ]; then
  echo "max_timeout must be between 1 and 3600 seconds" >&2
  exit 2
fi

OUTPUT=""
EXIT_CODE=0
set +e
if [ -n "${GITGECKO_CLOUD_URL:-}" ]; then
  if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
    OUTPUT="cloud mode requires permissions: id-token: write"
    EXIT_CODE=2
  elif [ -z "${GITGECKO_PR_NUMBER:-}" ]; then
    OUTPUT="cloud mode requires a pull_request or pull_request_target event"
    EXIT_CODE=2
  else
    OIDC_RESPONSE=$("$CURL_BIN" --fail-with-body --silent --show-error \
      -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
      "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=https%3A%2F%2Fgitgecko.com%2Factions" 2>&1)
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 0 ]; then
      OIDC_TOKEN=$(printf '%s' "$OIDC_RESPONSE" | node -e \
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s).value;if(typeof v!=='string'||!v)process.exit(2);process.stdout.write(v)}catch{process.exit(2)}})")
      EXIT_CODE=$?
    fi
    if [ "$EXIT_CODE" -eq 0 ]; then
      REQUEST_BODY=$(node -e \
        "process.stdout.write(JSON.stringify({pullNumber:Number(process.env.GITGECKO_PR_NUMBER),title:process.env.GITGECKO_PR_TITLE}))")
      RESPONSE=$(timeout "${MAX_TIMEOUT}s" "$CURL_BIN" --fail-with-body --silent --show-error \
        -H "Authorization: Bearer $OIDC_TOKEN" \
        -H "Content-Type: application/json" \
        --data "$REQUEST_BODY" \
        "${GITGECKO_CLOUD_URL%/}/api/actions/reviews/run" 2>&1)
      EXIT_CODE=$?
      if [ "$EXIT_CODE" -eq 0 ]; then
        OUTPUT=$(printf '%s' "$RESPONSE" | node "$GITGECKO_ACTION_PATH/scripts/parse-action-review-response.mjs" 2>&1)
        EXIT_CODE=$?
      else
        # Provider and bridge response bodies may contain internal diagnostics.
        OUTPUT="GitGecko cloud review request failed"
      fi
    else
      # OIDC bodies are credential-bearing and never become logs or comments.
      OUTPUT="GitHub OIDC token exchange failed"
    fi
  fi
else
  PATCH_READY=0
  if [ -n "${GITGECKO_PR_NUMBER:-}" ]; then
    gh pr diff "$GITGECKO_PR_NUMBER" --patch > "$DIFF_FILE"
    PATCH_READY=$?
  elif git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    git diff HEAD~1...HEAD > "$DIFF_FILE"
    PATCH_READY=$?
  else
    git show --format= --patch HEAD > "$DIFF_FILE"
    PATCH_READY=$?
  fi

  if [ "$PATCH_READY" -ne 0 ]; then
    OUTPUT="GitGecko could not load the review patch"
    EXIT_CODE=2
  else
    OUTPUT=$(timeout "${MAX_TIMEOUT}s" gitgecko review \
      --diff-file "$DIFF_FILE" \
      --pathway "${GITGECKO_PATHWAY:-auto}" \
      --title "${GITGECKO_PR_TITLE:-Review}" 2>&1)
    EXIT_CODE=$?
  fi
fi
set -e

DELIMITER="GITGECKO_$(openssl rand -hex 16)"
{
  echo "GITGECKO_REVIEW_OUTPUT<<$DELIMITER"
  echo "$OUTPUT"
  echo "$DELIMITER"
  echo "GITGECKO_REVIEW_EXIT_CODE=$EXIT_CODE"
} >> "$GITHUB_ENV"
