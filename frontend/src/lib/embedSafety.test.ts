import { describe, expect, it } from 'vitest';
import { toAllowedIframeSrc, toSafeHttpsUrl } from './embedSafety';

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
