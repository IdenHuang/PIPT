"use strict";
/**
 * Server-side validation for persona_media.url.
 *
 * The stored value is either a plain URL or an `<iframe ...>` embed snippet
 * (see EditPatientPanel "Embed Link or Code"). The frontend sanitizes and
 * host-allowlists at render time (frontend/src/lib/embedSafety.ts); this is
 * the write-side backstop so non-https schemes (javascript:, data:, blob:,
 * http:, ...) are never stored in the first place.
 *
 * Pure module with no database or Lambda-event dependency so it can be unit
 * tested directly.
 */

const MAX_MEDIA_URL_LENGTH = 4096;

/**
 * True when `value` is an absolute https URL without embedded credentials.
 * @param {string} value
 * @returns {boolean}
 */
function isHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password;
}

/**
 * Validates an embed snippet: only `<iframe>` tags, no inline event handlers,
 * and a src that is an https URL.
 * @param {string} html
 * @returns {string|null} error message, or null when valid
 */
function validateEmbedCode(html) {
  const tagNames = [...html.matchAll(/<\s*\/?\s*([a-z][a-z0-9-]*)/gi)].map((m) => m[1].toLowerCase());
  if (tagNames.length === 0 || tagNames.some((name) => name !== "iframe")) {
    return "embed code may only contain an <iframe> element";
  }
  if (/[\s"'/]on[a-z]+\s*=/i.test(html)) {
    return "embed code may not contain event handler attributes";
  }
  if (/[\s"'/]srcdoc\s*=/i.test(html)) {
    return "embed code may not contain a srcdoc attribute";
  }
  // Check every src-looking attribute, not just the first, so a decoy src
  // hidden inside another attribute value can't mask the real one.
  const srcValues = [...html.matchAll(/[\s"'/]src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((m) =>
    (m[1] ?? m[2] ?? m[3]).trim()
  );
  if (srcValues.length === 0 || srcValues.some((src) => !isHttpsUrl(src))) {
    return "embed code iframe src must be an https URL";
  }
  return null;
}

/**
 * Validates the `url` field of a persona_media POST/PUT body.
 *
 * `undefined`, `null` and the empty string mean "no URL" (POST stores '',
 * PUT leaves the stored value unchanged) and are accepted as-is. Any other
 * value must be a string that is either an https URL or an iframe embed
 * snippet whose src is an https URL.
 *
 * @param {unknown} url
 * @returns {{ ok: true, value: string|undefined|null }|{ ok: false, error: string }}
 */
function validatePersonaMediaUrl(url) {
  if (url === undefined || url === null || url === "") {
    return { ok: true, value: url };
  }
  if (typeof url !== "string") {
    return { ok: false, error: "url must be a string" };
  }
  const value = url.trim();
  if (value === "") {
    return { ok: true, value };
  }
  if (value.length > MAX_MEDIA_URL_LENGTH) {
    return { ok: false, error: `url must be at most ${MAX_MEDIA_URL_LENGTH} characters` };
  }
  if (value.toLowerCase().startsWith("<iframe")) {
    const error = validateEmbedCode(value);
    return error ? { ok: false, error } : { ok: true, value };
  }
  if (!isHttpsUrl(value)) {
    return { ok: false, error: "url must be an https URL or iframe embed code" };
  }
  return { ok: true, value };
}

module.exports = { validatePersonaMediaUrl, MAX_MEDIA_URL_LENGTH };
