/**
 * Security response headers (CSP, HSTS, etc.) for the Amplify-hosted SPA.
 *
 * Values may contain CDK tokens (API id, CloudFront domain, ...); they are
 * resolved by CloudFormation when the Amplify app is deployed.
 * https://docs.aws.amazon.com/amplify/latest/userguide/custom-headers.html
 */

/**
 * Hosts the frontend may render in an iframe for instructor-supplied media.
 * MUST stay in sync with ALLOWED_IFRAME_DOMAINS in
 * frontend/src/lib/embedSafety.ts (checked by test/securityHeaders.test.ts).
 * Subdomains are allowed, matching the frontend's isAllowedIframeHost().
 */
export const FRONTEND_IFRAME_DOMAINS: readonly string[] = [
  "youtube.com",
  "www.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "vimeo.com",
  "h5p.org",
  "www.h5p.org",
  "h5p.com",
  "embed.h5p.com",
  "apps.pharmacy.ubc.ca",
  "docs.google.com",
  "drive.google.com",
  "open.spotify.com",
  "w.soundcloud.com",
  "codepen.io",
  "codesandbox.io",
  "loom.com",
  "www.loom.com",
  "kaltura.com",
  "panopto.com",
];

export interface CspHosts {
  region: string;
  /** REST API host, e.g. abc123.execute-api.ca-central-1.amazonaws.com */
  apiHost: string;
  /** AppSync API id (hosts are <id>.appsync-api / appsync-realtime-api.<region>.amazonaws.com) */
  appSyncApiId: string;
  /** Socket.IO host (CloudFront in front of the NLB) */
  socketHost: string;
  /** CloudFront document/profile-picture distribution domain */
  docsHost: string;
  /** Bucket that receives presigned-POST uploads */
  uploadBucketName: string;
}

/** `https://d https://*.d` for each base domain, skipping ones covered by a parent. */
function iframeSources(domains: readonly string[]): string[] {
  const bases = domains.filter(
    (d) => !domains.some((other) => other !== d && d.endsWith("." + other))
  );
  return bases.flatMap((d) => [`https://${d}`, `https://*.${d}`]);
}

export function buildContentSecurityPolicy(hosts: CspHosts): string {
  // Built by concatenation (not string replace) because the inputs may be CDK tokens.
  const appSyncHost = `${hosts.appSyncApiId}.appsync-api.${hosts.region}.amazonaws.com`;
  const appSyncRealtimeHost = `${hosts.appSyncApiId}.appsync-realtime-api.${hosts.region}.amazonaws.com`;
  const docs = `https://${hosts.docsHost}`;

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    // blob: is required by the AudioWorklet that the voice client loads from a Blob URL
    // (frontend/src/lib/socketio-audio-client.ts).
    "script-src": ["'self'", "blob:"],
    "worker-src": ["'self'", "blob:"],
    // Inline style attributes and Radix/Recharts-injected styles.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", docs],
    "media-src": ["'self'", "blob:", docs],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      `https://${hosts.apiHost}`,
      `https://${appSyncHost}`,
      `wss://${appSyncRealtimeHost}`,
      `https://${hosts.socketHost}`,
      `wss://${hosts.socketHost}`,
      `https://cognito-idp.${hosts.region}.amazonaws.com`,
      `https://cognito-identity.${hosts.region}.amazonaws.com`,
      `https://${hosts.uploadBucketName}.s3.amazonaws.com`,
      `https://${hosts.uploadBucketName}.s3.${hosts.region}.amazonaws.com`,
      docs,
    ],
    "frame-src": [docs, ...iframeSources(FRONTEND_IFRAME_DOMAINS)],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };

  return [
    ...Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`),
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Amplify customHeaders YAML. When `enforceCsp` is false the CSP is sent as
 * Content-Security-Policy-Report-Only, so violations show in the browser
 * console without blocking anything.
 */
export function buildAmplifyCustomHeaders(csp: string, enforceCsp: boolean): string {
  const headers: [string, string][] = [
    ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["Permissions-Policy", "camera=(), microphone=(self), geolocation=(), payment=()"],
    [enforceCsp ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", csp],
  ];

  // Single-quoted YAML scalars: escape embedded quotes ('self' -> ''self'').
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return [
    "customHeaders:",
    "  - pattern: '**'",
    "    headers:",
    ...headers.flatMap(([key, value]) => [
      `      - key: ${quote(key)}`,
      `        value: ${quote(value)}`,
    ]),
    "",
  ].join("\n");
}
