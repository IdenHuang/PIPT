import DOMPurify from 'dompurify';

/**
 * URL and embed-code guards for instructor-supplied media (persona_media.url).
 *
 * The stored value is either a plain URL or an `<iframe ...>` embed snippet.
 * Every render sink (iframe src, img src, a href) must pass through one of the
 * helpers below so that non-https schemes (javascript:, data:, blob:, http:)
 * and non-allowlisted frame hosts are never rendered.
 */

/**
 * Hosts allowed as an iframe src. Subdomains match too (e.g. `ubc.ca.panopto.com`).
 * Extend this list as new embed providers are needed.
 */
export const ALLOWED_IFRAME_DOMAINS: readonly string[] = [
  'youtube.com',
  'www.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'player.vimeo.com',
  'vimeo.com',
  'h5p.org',
  'www.h5p.org',
  'h5p.com',
  'embed.h5p.com',
  'apps.pharmacy.ubc.ca',
  'docs.google.com',
  'drive.google.com',
  'open.spotify.com',
  'w.soundcloud.com',
  'codepen.io',
  'codesandbox.io',
  'loom.com',
  'www.loom.com',
  // Kaltura and Panopto are the providers offered in the instructor editor.
  'kaltura.com',
  'panopto.com',
];

/**
 * Parse `value` as an absolute https URL. Returns the normalized href, or null
 * for anything else (relative URLs, javascript:, data:, http:, malformed input).
 */
export function toSafeHttpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** True when the hostname is an allowlisted embed host or one of its subdomains. */
function isAllowedIframeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_IFRAME_DOMAINS.some((domain) => host === domain || host.endsWith('.' + domain));
}

/**
 * Returns the normalized URL when it is safe to use as an iframe src
 * (https and an allowlisted host), otherwise null.
 */
export function toAllowedIframeSrc(value: string | null | undefined): string | null {
  const href = toSafeHttpsUrl(value);
  if (!href) return null;
  return isAllowedIframeHost(new URL(href).hostname) ? href : null;
}

/** Detect whether a value is embed HTML (starts with <iframe) rather than a plain URL. */
export function isEmbedCode(value: string): boolean {
  return value.trimStart().toLowerCase().startsWith('<iframe');
}

/**
 * Sanitize embed HTML down to a single iframe with safe attributes and an
 * allowlisted https src. Returns '' when the embed can't be rendered safely.
 */
export function sanitizeEmbedCode(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['iframe'],
    ALLOWED_ATTR: [
      'src',
      'width',
      'height',
      'allow',
      'allowfullscreen',
      'frameborder',
      'title',
      'style',
      'loading',
      'referrerpolicy',
      'sandbox',
    ],
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allowfullscreen'],
  });

  const doc = new DOMParser().parseFromString(clean, 'text/html');
  const iframe = doc.querySelector('iframe');
  if (!iframe) return '';

  return toAllowedIframeSrc(iframe.getAttribute('src')) ? clean : '';
}

/**
 * Extract the iframe src from an embed snippet, only if it is an https URL.
 * Used for the "open in a new tab" fallback link.
 */
export function extractSafeIframeSrc(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return toSafeHttpsUrl(doc.querySelector('iframe')?.getAttribute('src'));
}
