import { describe, expect, it } from "vitest";
import { gmailFixture } from "../../tests/mail/fake-gmail";
import { parseGmailMessage, type GmailMessage } from "./gmail/adapter";
import { contrastRatio, DEFAULT_MAX_CHARS, hidingRules, htmlToText, parseColor, plainTextToText, styleHides, parseStyle } from "./html-to-text";
import { visibleText } from "./newsletters";

const t = (html: string) => htmlToText(html).text;
const harbor = () => parseGmailMessage(gmailFixture<GmailMessage>("messages/19a0c0ffee000002.json"));
const TAG_CHARS = /\uDB40[\uDC00-\uDC7F]/;

describe("hidden prompt-injection fixture (Harbor Notes)", () => {
  it("the fixture really contains the hidden instructions (so the test below means something)", () => {
    const m = harbor();
    for (let i = 1; i <= 17; i++) expect(m.html).toContain(`HIDDEN-MARKER-${String(i).padStart(2, "0")}`);
    expect(m.html).toMatch(TAG_CHARS);
    expect(m.text).toContain("PLAINONLY-MARKER");
  });

  it("no hidden text reaches the summarizer; the visible story does", () => {
    const { text } = visibleText(harbor());
    expect(text).not.toMatch(/HIDDEN-MARKER/);
    expect(text).not.toMatch(/PLAINONLY-MARKER/);
    expect(text).not.toMatch(TAG_CHARS);
    expect(text).not.toMatch(/ignore|password|developer mode|system prompt|sponsored|credit card/i);
    expect(text).toContain("The Westport ferry adds two evening sailings from December 1, at 7:15 and 8:45.");
    expect(text).toContain("Fares stay at $3.50.");
    expect(text).toContain("The harbor commission also approved $2.1 million to repair the north pier.");
    expect(text).toContain("Tide tables for next week are on the back page.");
    // Zero-width characters inside words are removed, joining the word back up.
    expect(text).toContain("Harbor update ends here.");
    expect(text).toContain("Unsubscribe any time.");
  });

  it("each hiding technique is caught on its own (one passage per check)", () => {
    const cases: [string, string][] = [
      ["display:none", `<p style="display: none !important">X</p>`],
      ["visibility", `<p style="visibility:hidden">X</p>`],
      ["font-size 0", `<span style="font-size:0px">X</span>`],
      ["font-size 1px", `<span style="font-size:1px">X</span>`],
      ["font-size 0.1em", `<span style="font-size:0.1em">X</span>`],
      ["opacity", `<span style="opacity:0.05">X</span>`],
      ["mso-hide", `<div style="mso-hide:all">X</div>`],
      ["collapsed height", `<div style="height:0;overflow:hidden">X</div>`],
      ["collapsed width", `<div style="max-width:0px;overflow-x:hidden">X</div>`],
      ["clip rect", `<span style="position:absolute;clip:rect(0 0 0 0)">X</span>`],
      ["clip-path", `<span style="clip-path:inset(50%)">X</span>`],
      ["scale 0", `<span style="transform:scale(0)">X</span>`],
      ["offscreen", `<div style="position:absolute;top:-2000px">X</div>`],
      ["text-indent", `<div style="text-indent:-9999px">X</div>`],
      ["transparent", `<span style="color:transparent">X</span>`],
      ["white on default", `<span style="color:#fff">X</span>`],
      ["near-white", `<span style="color:#fefefe">X</span>`],
      ["same as bg", `<div style="background:#123456"><span style="color:rgb(18,52,86)">X</span></div>`],
      ["font colour on bgcolor", `<table bgcolor="#000"><tr><td><font color="black">X</font></td></tr></table>`],
      ["hidden attr", `<div hidden>X</div>`],
      ["aria-hidden", `<div aria-hidden="true">X</div>`],
      ["class rule", `<style>.pre{display:none}</style><div class="a pre">X</div>`],
      ["id rule", `<style>#x{visibility:hidden}</style><div id="x">X</div>`],
      ["descendant rule", `<style>.wrap .h{font-size:0}</style><div class="wrap"><p class="h">X</p></div>`],
      ["media rule", `<style>@media screen { .m { display:none } }</style><p class="m">X</p>`],
      ["script", `<script>X</script>`],
      ["style text", `<style>p{color:red} /* X */</style>`],
      ["template", `<template>X</template>`],
      ["noscript", `<noscript>X</noscript>`],
      ["comment", `<!-- X -->`],
      ["title", `<title>X</title>`],
      ["svg text", `<svg><text>X</text></svg>`],
      ["input value", `<input value="X">`],
      ["textarea", `<textarea>X</textarea>`],
      ["img alt", `<img alt="X" src="https://p.example/x.gif">`],
      ["unicode tags", `<p>${[..."X"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("")}</p>`],
      ["nested in hidden", `<div style="display:none"><p><b>X</b></p></div>`],
    ];
    for (const [label, html] of cases) {
      const out = t(`<p>Visible.</p>${html.replace(/X/g, "SECRET-INSTRUCTION")}<p>Also visible.</p>`);
      expect(out, label).not.toContain("SECRET-INSTRUCTION");
      expect(out, label).toContain("Visible.");
      expect(out, label).toContain("Also visible.");
    }
  });

  it("controls: ordinary styling is not mistaken for hidden text", () => {
    const visible = [
      `<span style="font-size:12px;color:#666666">X</span>`,
      `<span style="opacity:0.8">X</span>`,
      `<div style="height:0">X</div>`, // no overflow:hidden: the text still shows
      `<div style="background:#000000"><span style="color:#ffffff">X</span></div>`,
      `<table bgcolor="#1a1a1a"><tr><td style="color:#f0f0f0">X</td></tr></table>`,
      `<div style="position:relative;left:-10px">X</div>`,
      `<style>.show{display:block}</style><p class="show">X</p>`,
      `<style>.x{display:none}</style><p class="xy">X</p>`,
      `<a href="https://news.example/story">X</a>`,
    ];
    for (const html of visible) expect(t(html.replace(/X/g, "Shown text")), html).toContain("Shown text");
  });
});

describe("HTML to text", () => {
  it("keeps link text, drops URLs, pixels, scripts and styles", () => {
    const m = parseGmailMessage(gmailFixture<GmailMessage>("messages/19a0c0ffee000001.json"));
    const { text } = visibleText(m);
    expect(text).toContain("Read the full story");
    expect(text).toContain("Larkspur Robotics raised $40 million in a Series B led by Northgate Ventures.");
    expect(text).not.toMatch(/https?:|www\.|\.gif|utm_source/);
    expect(text).not.toMatch(/trackOpen|font-family|Georgia/);
    expect(text).toContain("Plain link: and tracking-free text, a=b stays.");
    expect(text).not.toContain("Brightline Weekly\nBrightline Weekly"); // <title> not repeated
  });

  it("puts blocks on their own lines and collapses whitespace", () => {
    expect(t("<h1>Title</h1><p>One   two\n\tthree.</p><ul><li>A</li><li>B</li></ul><p>x<br>y</p>")).toBe(
      "Title\n\nOne two three.\n\nA\n\nB\n\nx\ny",
    );
    expect(t("<p>a&nbsp;b &amp; c&#39;s</p>")).toBe("a b & c's");
  });

  it("handles broken markup the way a browser does", () => {
    expect(t("<p>one<p>two<div>three")).toBe("one\n\ntwo\n\nthree");
    expect(t(`<div style="display:none"><p>gone</div><p>kept`)).toBe("kept");
    // A browser reads "<scr<script>" as one unknown tag and shows the rest as text; so do we.
    expect(t("<scr<script>ipt>alert(1)</script>ok")).toBe("ipt>alert(1)ok");
    expect(t("<p>a<script>hidden()</script>b</p>")).toBe("ab");
  });

  it("caps the length on a sentence or word boundary and says so", () => {
    const sentence = "The council voted seven to two in favour. ";
    const html = `<p>${sentence.repeat(1000)}</p>`;
    const r = htmlToText(html, { maxChars: 500 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(500);
    expect(r.text.endsWith("favour.")).toBe(true);
    const words = htmlToText(`<p>${"word ".repeat(300)}</p>`, { maxChars: 101 });
    expect(words.text.endsWith("word")).toBe(true);
    expect(htmlToText("<p>short</p>")).toEqual({ text: "short", truncated: false });
    expect(DEFAULT_MAX_CHARS).toBe(20_000);
  });

  it("plain text: strips URLs and invisible characters, keeps the words", () => {
    const r = plainTextToText("Read more at <https://a.example/x> or www.b.example.\r\n\r\n\r\nNext​ line here.");
    expect(r.text).toBe("Read more at or\n\nNext line here.");
  });

  it("CSS helpers", () => {
    expect(parseStyle("Display : NONE !important; color:#FFF")).toEqual(
      new Map([["display", "none"], ["color", "#fff"]]),
    );
    expect(styleHides(parseStyle("display:block"))).toBe(false);
    expect(parseColor("white")).toEqual([255, 255, 255]);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
    expect(parseColor("url(x.png)")).toBeNull();
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
    expect(hidingRules(".a, #b, td.c, .d:hover, [x] { display:none } .e { color: red }")).toHaveLength(4);
  });
});
