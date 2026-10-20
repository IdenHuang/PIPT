"""
CORS origin helper for Python Lambda functions.

Reads ALLOWED_ORIGINS from environment (comma-separated, supports wildcard subdomains).
Returns headers dict with the matching origin echoed back.
Fails closed (empty Access-Control-Allow-Origin) if ALLOWED_ORIGINS is unset or empty;
only an explicit "*" entry allows every origin.
"""

import os
import re

_raw = os.environ.get("ALLOWED_ORIGINS", "")
_ALLOWED = [s.strip() for s in _raw.split(",") if s.strip()]

# "*" matches one or more DNS labels (letters, digits, hyphens joined by dots), so
# it can never span a scheme, port, userinfo or path delimiter (":", "@", "/").
_WILDCARD_HOST_LABELS = r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*"


def get_cors_headers(event):
    """Build CORS headers dict for a Lambda proxy response."""
    origin = (event.get("headers") or {}).get("origin") or (event.get("headers") or {}).get("Origin") or ""
    return {
        "Content-Type": "application/json",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Origin": _resolve_origin(origin),
        "Access-Control-Allow-Methods": "*",
    }


def _resolve_origin(origin):
    if not _ALLOWED:
        return ""  # misconfigured: fail closed, browsers reject an empty origin
    if "*" in _ALLOWED:
        return "*"
    if not origin:
        return _ALLOWED[0]
    for p in _ALLOWED:
        if "*" in p:
            regex = "^" + re.escape(p).replace(r"\*", _WILDCARD_HOST_LABELS) + "$"
            if re.fullmatch(regex, origin):
                return origin
        elif p == origin:
            return origin
    return _ALLOWED[0]
