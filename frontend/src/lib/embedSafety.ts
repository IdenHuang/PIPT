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

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']);

/** Parse a YouTube `t`/`start` value ("90", "90s", "1m30s") into seconds. */
function parseYouTubeStart(value: string | null): number | null {
  if (!value) return null;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return seconds > 0 ? seconds : null;
}

/**
 * Rewrite share/watch page links to their embeddable player URL. YouTube and
 * Vimeo watch pages send X-Frame-Options: SAMEORIGIN, so framing them shows
 * "refused to connect"; their /embed and player URLs are meant to be framed.
 * Anything not recognized is returned unchanged.
 */
function toEmbeddableUrl(url: URL): URL {
  const host = url.hostname.toLowerCase();

  if (YOUTUBE_HOSTS.has(host)) {
    let id: string | null = null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (host.endsWith('youtu.be')) {
      id = segments[0] ?? null;
    } else if (segments[0] === 'watch') {
      id = url.searchParams.get('v');
    } else if (segments[0] === 'shorts' || segments[0] === 'live') {
      id = segments[1] ?? null;
    }
    if (id && YOUTUBE_VIDEO_ID.test(id)) {
      const embed = new URL(`https://www.youtube.com/embed/${id}`);
      const start = parseYouTubeStart(url.searchParams.get('t') ?? url.searchParams.get('start'));
      if (start) embed.searchParams.set('start', String(start));
      return embed;
    }
    return url;
  }

  if (host === 'vimeo.com' || host === 'www.vimeo.com') {
    const m = /^\/(\d+)(?:\/([A-Za-z0-9]+))?\/?$/.exec(url.pathname);
    if (m) {
      const embed = new URL(`https://player.vimeo.com/video/${m[1]}`);
      if (m[2]) embed.searchParams.set('h', m[2]); // unlisted-video hash
      return embed;
    }
  }

  return url;
}

/**
 * Returns the normalized URL when it is safe to use as an iframe src
 * (https and an allowlisted host), otherwise null. YouTube/Vimeo page links
 * are rewritten to their embed URL so they can be framed.
 */
export function toAllowedIframeSrc(value: string | null | undefined): string | null {
  const href = toSafeHttpsUrl(value);
  if (!href) return null;
  const url = toEmbeddableUrl(new URL(href));
  return isAllowedIframeHost(url.hostname) ? url.href : null;
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
