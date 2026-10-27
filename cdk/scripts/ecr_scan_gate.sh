#!/bin/bash
# Fail-closed ECR vulnerability gate, run in CodeBuild post_build before an
# image is recorded as approved and deployed (cdk/scripts/deploy_image.sh).
#
# Exit 0 only when a scan of $REPO_NAME:$IMAGE_TAG has finished AND it reports
# zero findings at every blocking severity. Anything else exits non-zero and
# fails the build: an API error, a failed or unsupported scan, a scan still
# running after the wait window, or output that isn't a number.
#
# Required env: REPO_NAME, IMAGE_TAG
# Optional env:
#   BLOCKING_SEVERITIES  space-separated, default "CRITICAL HIGH"
#   SCAN_MAX_ATTEMPTS    status polls before giving up, default 40
#   SCAN_POLL_SECONDS    seconds between polls, default 15
#
# API reference (response shape and status values):
#   https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_DescribeImageScanFindings.html
#   https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_ImageScanStatus.html
set -euo pipefail

: "${REPO_NAME:?REPO_NAME is required}"
: "${IMAGE_TAG:?IMAGE_TAG is required}"
BLOCKING_SEVERITIES="${BLOCKING_SEVERITIES:-CRITICAL HIGH}"
SCAN_MAX_ATTEMPTS="${SCAN_MAX_ATTEMPTS:-40}"
SCAN_POLL_SECONDS="${SCAN_POLL_SECONDS:-15}"
# A zero or non-numeric attempt count would skip the wait loop entirely.
[[ "$SCAN_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || { echo "SCAN_MAX_ATTEMPTS must be a positive integer" >&2; exit 1; }
[[ "$SCAN_POLL_SECONDS" =~ ^[0-9]+$ ]] || { echo "SCAN_POLL_SECONDS must be a non-negative integer" >&2; exit 1; }
[ -n "${BLOCKING_SEVERITIES// /}" ] || { echo "BLOCKING_SEVERITIES must not be empty" >&2; exit 1; }

IMAGE="$REPO_NAME:$IMAGE_TAG"
ERR_FILE="$(mktemp)"
trap 'rm -f "$ERR_FILE"' EXIT

block() {
  echo "BLOCKED: $*" >&2
  echo "Image $IMAGE will NOT be recorded as approved or deployed." >&2
  exit 1
}

# Run describe-image-scan-findings with a JMESPath query and print the text
# result. The CLI paginates automatically, so list queries cover all findings.
# Returns 1 (error text left in $ERR_FILE) if the call fails.
scan_query() {
  aws ecr describe-image-scan-findings \
    --repository-name "$REPO_NAME" \
    --image-id "imageTag=$IMAGE_TAG" \
    --query "$1" \
    --output text 2>"$ERR_FILE"
}

# Print a non-negative integer or block. JMESPath returns "None" for a missing
# key; a missing severity key inside a present findingSeverityCounts map means 0.
require_count() {
  local label="$1" value="$2"
  [ "$value" = "None" ] && value=0
  [[ "$value" =~ ^[0-9]+$ ]] || block "unexpected $label value from ECR: '$value'"
  echo "$value"
}

# 1. Wait for the scan to finish. Only "not started yet" and throttling are
#    retried; every other error or terminal status blocks.
echo "Waiting for vulnerability scan of $IMAGE..."
STATUS=""
for ((i = 1; i <= SCAN_MAX_ATTEMPTS; i++)); do
  if STATUS="$(scan_query "imageScanStatus.status")"; then
    case "$STATUS" in
      COMPLETE | ACTIVE) break ;;
      IN_PROGRESS | PENDING) ;;
      *)
        DESCRIPTION="$(scan_query "imageScanStatus.description" || true)"
        block "scan status is $STATUS (${DESCRIPTION:-no description})"
        ;;
    esac
  elif grep -qE "ScanNotFoundException|Throttl|TooManyRequests" "$ERR_FILE"; then
    STATUS="NOT_STARTED"
  else
    cat "$ERR_FILE" >&2
    block "describe-image-scan-findings failed"
  fi
  if ((i == SCAN_MAX_ATTEMPTS)); then
    block "scan did not complete after $SCAN_MAX_ATTEMPTS attempts (last status: $STATUS)"
  fi
  echo "Scan status: $STATUS. Waiting ${SCAN_POLL_SECONDS}s... (attempt $i/$SCAN_MAX_ATTEMPTS)"
  sleep "$SCAN_POLL_SECONDS"
done
echo "Scan status: $STATUS"

# 2. A finished scan must actually carry results.
HAS_RESULTS="$(scan_query "imageScanFindings != null")" || {
  cat "$ERR_FILE" >&2
  block "could not read scan results"
}
[ "$HAS_RESULTS" = "True" ] || block "scan reports $STATUS but returned no imageScanFindings"

# 3. Count findings at each blocking severity. Use findingSeverityCounts when
#    ECR provides it; otherwise count the basic and enhanced (Inspector)
#    finding lists directly so a missing summary can't read as zero.
BLOCKED_SUMMARY=""
for SEV in $BLOCKING_SEVERITIES; do
  [[ "$SEV" =~ ^[A-Z]+$ ]] || block "invalid severity name '$SEV' in BLOCKING_SEVERITIES"

  if ! COUNTS_PRESENT="$(scan_query "imageScanFindings.findingSeverityCounts != null")"; then
    cat "$ERR_FILE" >&2
    block "could not read finding severity counts"
  fi

  if [ "$COUNTS_PRESENT" = "True" ]; then
    RAW="$(scan_query "imageScanFindings.findingSeverityCounts.$SEV")" || {
      cat "$ERR_FILE" >&2
      block "could not read $SEV count"
    }
    COUNT="$(require_count "$SEV count" "$RAW")"
  else
    BASIC="$(scan_query "length(imageScanFindings.findings[?severity=='$SEV'] || \`[]\`)")" || {
      cat "$ERR_FILE" >&2
      block "could not count basic $SEV findings"
    }
    ENHANCED="$(scan_query "length(imageScanFindings.enhancedFindings[?severity=='$SEV'] || \`[]\`)")" || {
      cat "$ERR_FILE" >&2
      block "could not count enhanced $SEV findings"
    }
    # Separate assignments so a failed require_count stops the script (set -e
    # doesn't see failures inside an arithmetic expansion).
    BASIC="$(require_count "basic $SEV count" "$BASIC")"
    ENHANCED="$(require_count "enhanced $SEV count" "$ENHANCED")"
    COUNT=$((BASIC + ENHANCED))
  fi

  echo "$SEV findings: $COUNT"
  if ((COUNT > 0)); then
    BLOCKED_SUMMARY+="$SEV=$COUNT "
  fi
done

[ -z "$BLOCKED_SUMMARY" ] || block "vulnerabilities at blocking severity: ${BLOCKED_SUMMARY% }"

echo "Scan passed: no findings at severities [$BLOCKING_SEVERITIES]."
