"use strict";
/**
 * Write-side backstop for persona_media.url (finding f-f43ba393): only https
 * URLs or iframe embed code with an https src may be stored. Also pins the
 * instructor handlers to call the validator so a refactor can't drop it.
 */
const fs = require("fs");
const path = require("path");
const { validatePersonaMediaUrl, MAX_MEDIA_URL_LENGTH } = require("../mediaUrlValidation.js");

describe("validatePersonaMediaUrl", () => {
  test.each([undefined, null, "", "   "])("accepts empty value %p", (value) => {
    expect(validatePersonaMediaUrl(value).ok).toBe(true);
  });

  test.each([
    "https://www.youtube.com/embed/abc",
    "  https://ubc.ca.panopto.com/Panopto/Pages/Embed.aspx?id=1  ",
    '<iframe src="https://cdnapisec.kaltura.com/p/1/embedIframeJs" width="640" height="360" allowfullscreen></iframe>',
    "<iframe src='https://h5p.org/h5p/embed/1'></iframe>",
    "<IFRAME SRC=https://player.vimeo.com/video/1></IFRAME>",
  ])("accepts %s", (value) => {
    const result = validatePersonaMediaUrl(value);
    expect(result).toEqual({ ok: true, value: value.trim() });
  });

  test.each([
    "javascript:alert(document.domain)",
    " JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/uuid",
    "http://example.com/video",
    "//example.com/video",
    "/relative/path",
    "https://user:pass@example.com/",
    "not a url",
  ])("rejects plain value %s", (value) => {
    expect(validatePersonaMediaUrl(value).ok).toBe(false);
  });

  test.each([
    '<iframe src="javascript:alert(1)"></iframe>',
    '<iframe src="data:text/html,<b>x</b>"></iframe>',
    '<iframe src="http://example.com"></iframe>',
    "<iframe></iframe>",
    '<iframe src="https://ok.example" onload="alert(1)"></iframe>',
    '<iframe src="https://ok.example"></iframe><script>alert(1)</script>',
    '<iframe srcdoc="<script>alert(1)</script>" src="https://ok.example"></iframe>',
    '<iframe title="x src=https://ok.example" src="javascript:alert(1)"></iframe>',
  ])("rejects embed code %s", (value) => {
    expect(validatePersonaMediaUrl(value).ok).toBe(false);
  });

  test("rejects non-string and oversized values", () => {
    expect(validatePersonaMediaUrl(42).ok).toBe(false);
    expect(validatePersonaMediaUrl({ href: "https://x.example" }).ok).toBe(false);
    expect(validatePersonaMediaUrl("https://x.example/" + "a".repeat(MAX_MEDIA_URL_LENGTH)).ok).toBe(false);
  });
});

describe("instructor persona_media handlers validate url", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "instructorFunction.js"), "utf8");
  function handlerBlock(routeKey) {
    const start = source.indexOf(`case "${routeKey}":`);
    if (start === -1) throw new Error(`route not found: ${routeKey}`);
    const next = source.indexOf('\n      case "', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  test.each(["POST /instructor/persona_media", "PUT /instructor/persona_media"])("%s", (route) => {
    const block = handlerBlock(route);
    const validateAt = block.indexOf("validatePersonaMediaUrl(rawUrl)");
    const writeAt = Math.max(block.indexOf("INSERT INTO"), block.indexOf("UPDATE \"persona_media\""));
    expect(validateAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(writeAt);
  });
});
