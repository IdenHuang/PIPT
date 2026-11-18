// @vitest-environment jsdom
// jsdom provides the DOMParser and window that sanitizeEmbedCode/DOMPurify need.
import { describe, expect, it } from 'vitest';
import { EMBED_IFRAME_SANDBOX, sanitizeEmbedCode, toAllowedIframeSrc, toSafeHttpsUrl } from './embedSafety';

// Render-sink guards for persona_media.url (finding f-f43ba393).
describe('toSafeHttpsUrl', () => {
  it.each([
    'javascript:alert(document.domain)',
    ' JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/uuid',
    'http://example.com/',
    '//example.com/',
    '/relative',
    'https://user:pass@example.com/',
    '',
    null,
    undefined,
  ])('rejects %s', (value) => {
    expect(toSafeHttpsUrl(value)).toBeNull();
  });

  it('accepts https URLs', () => {
    expect(toSafeHttpsUrl(' https://example.com/a.png ')).toBe('https://example.com/a.png');
  });
});

describe('toAllowedIframeSrc', () => {
  it.each([
    'https://www.youtube.com/embed/abc',
    'https://ubc.ca.panopto.com/Panopto/Pages/Embed.aspx?id=1',
    'https://cdnapisec.kaltura.com/p/1/embedIframeJs',
    'https://player.vimeo.com/video/1',
  ])('allows %s', (value) => {
    expect(toAllowedIframeSrc(value)).not.toBeNull();
  });

  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&index=2', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=90', 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=90'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s', 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=90'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ?start=5', 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=5'],
    ['https://vimeo.com/123456', 'https://player.vimeo.com/video/123456'],
    ['https://vimeo.com/123456/abcdef12', 'https://player.vimeo.com/video/123456?h=abcdef12'],
  ])('rewrites %s to its embed URL', (value, expected) => {
    expect(toAllowedIframeSrc(value)).toBe(expected);
  });

  it.each([
    'https://www.youtube.com/watch?v=bad',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ"onload=x',
  ])('leaves unrecognized YouTube links unchanged (%s)', (value) => {
    expect(toAllowedIframeSrc(value)).toBe(new URL(value).href);
  });

  it('does not treat youtu.be as a framable host on its own', () => {
    expect(toAllowedIframeSrc('https://youtu.be/not-a-video-id')).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'http://www.youtube.com/embed/abc',
    'http://youtu.be/dQw4w9WgXcQ',
    'https://attacker.example/',
    'https://youtube.com.attacker.example/',
    'https://notyoutube.com/',
    'https://www.youtube.com@attacker.example/',
  ])('blocks %s', (value) => {
    expect(toAllowedIframeSrc(value)).toBeNull();
  });
});

// Embed-snippet sink guard (finding f-279ac83c): exactly one allowlisted
// iframe, rebuilt with allowlisted attributes and a fixed sandbox.
describe('sanitizeEmbedCode', () => {
  function parse(html: string): HTMLIFrameElement[] {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('iframe')];
  }

  it('rebuilds a single allowlisted iframe with the fixed sandbox', () => {
    const out = sanitizeEmbedCode(
      '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="640" height="360" title="Demo" allowfullscreen></iframe>',
    );
    const frames = parse(out);
    expect(frames).toHaveLength(1);
    const [frame] = frames;
    expect(frame.getAttribute('src')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(frame.getAttribute('width')).toBe('640');
    expect(frame.getAttribute('height')).toBe('360');
    expect(frame.getAttribute('title')).toBe('Demo');
    expect(frame.hasAttribute('allowfullscreen')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe(EMBED_IFRAME_SANDBOX);
  });

  it('rejects a second iframe after an allowlisted one', () => {
    const html =
      '<iframe src="https://www.youtube.com/embed/x"></iframe>' +
      '<iframe src="https://attacker.example/phish" style="position:absolute;inset:0;width:100%;height:100%;z-index:9999"></iframe>';
    expect(sanitizeEmbedCode(html)).toBe('');
  });

  it('rejects two iframes even when both are allowlisted', () => {
    const html =
      '<iframe src="https://www.youtube.com/embed/a"></iframe><iframe src="https://player.vimeo.com/video/1"></iframe>';
    expect(sanitizeEmbedCode(html)).toBe('');
  });

  it('replaces an instructor-supplied sandbox', () => {
    const out = sanitizeEmbedCode('<iframe src="https://player.vimeo.com/video/1" sandbox=""></iframe>');
    expect(parse(out)[0].getAttribute('sandbox')).toBe(EMBED_IFRAME_SANDBOX);
  });

  it('drops non-allowlisted attributes, other tags and stray text', () => {
    const out = sanitizeEmbedCode(
      '<iframe src="https://player.vimeo.com/video/1" onload="alert(1)" name="x"></iframe><script>alert(1)</script>hello',
    );
    const frames = parse(out);
    expect(frames).toHaveLength(1);
    expect(frames[0].getAttributeNames().sort()).toEqual(['sandbox', 'src']);
    expect(out).not.toMatch(/<script|hello/);
  });

  it.each([
    '<iframe src="https://attacker.example/"></iframe>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<iframe src="http://www.youtube.com/embed/x"></iframe>',
    '<iframe></iframe>',
    '<div>no frame</div>',
    '',
  ])('returns empty string for %s', (html) => {
    expect(sanitizeEmbedCode(html)).toBe('');
  });
});