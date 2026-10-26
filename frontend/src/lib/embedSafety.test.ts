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
    'javascript:alert(1)',
    'data:text/html,<b>x</b>',
    'http://www.youtube.com/embed/abc',
    'https://attacker.example/',
    'https://youtube.com.attacker.example/',
    'https://notyoutube.com/',
    'https://www.youtube.com@attacker.example/',
  ])('blocks %s', (value) => {
    expect(toAllowedIframeSrc(value)).toBeNull();
  });
});
