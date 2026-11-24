// Newsletter HTML to plain text for the summarizer. Shared by every source (mail and web
// feeds): web content is just as untrusted as mail, so the same hidden-text rules apply.
//
// The rule that matters most: text a reader cannot see must not reach the summarizer.
// Hidden text is the easiest place to plant instructions for a model (a white-on-white
// "ignore your instructions" line, a display:none preheader), so anything this module
// judges hidden is dropped, along with scripts, styles, images (tracking pixels) and
// link URLs. Link text is kept.
//
// HTML is parsed with parse5, a spec-compliant HTML parser, so the tree matches what a
// browser or mail client builds from the same markup (misnested and unclosed tags
// included). Regular expressions over raw HTML are not safe for this.
//
// What counts as hidden (on the element or any ancestor):
//   * the hidden attribute, aria-hidden="true", <input type="hidden">
//   * inline style or a <style> rule (simple .class / #id / tag selectors, including inside
//     @media) with display:none, visibility:hidden|collapse, opacity <= 0.1, a font size
//     of 2px or less (or any zero size), mso-hide:all, color:transparent,
//     zero height/width/max-height/max-width together with overflow:hidden,
//     clip/clip-path that clips to nothing, transform scale(0), or a far negative
//     offset / text-indent (offscreen)
//   * text whose colour has almost no contrast with its background (contrast ratio
//     below 1.25). A background nobody set counts as white, as most mail clients show it.
// Limits: CSS is not fully evaluated. Complex selectors match on their last part only, and
// any rule that hides counts even if a media query applies it only on some screens. Both
// err toward dropping text. Background images are not considered.

import { parse, type DefaultTreeAdapterTypes as T } from "parse5";

export const DEFAULT_MAX_CHARS = 20_000;

export interface TextResult {
  text: string;
  /** The text was cut to `maxChars`. */
  truncated: boolean;
}

/** Elements whose content is never shown as text. */
const SKIP = new Set([
  "head", "title", "script", "style", "noscript", "template", "svg", "math", "iframe",
  "object", "embed", "canvas", "audio", "video", "img", "picture", "source", "map", "area",
  "select", "option", "textarea", "input", "meta", "link", "base",
]);

/** Elements that start a new line. */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "details", "dialog",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

// Characters with no visible glyph, used to hide or smuggle text: soft hyphen,
// combining grapheme joiner, Hangul fillers, zero-width and bidi controls, word joiners,
// variation selectors, BOM, braille blank, and the Unicode "tag" block (U+E0000-E007F),
// which can spell out ASCII instructions invisibly.
const INVISIBLE =
  /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯⠀ㅤ︀-️﻿ﾠ]|\uDB40[\uDC00-\uDC7F]/g;

const URL_RE = /<?\b(?:https?:\/\/|www\.)[^\s<>"')\]]+>?/gi;

type Style = Map<string, string>;

export function parseStyle(style: string): Style {
  const out: Style = new Map();
  for (const decl of style.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl
      .slice(i + 1)
      .replace(/!\s*important/gi, "")
      .trim()
      .toLowerCase();
    if (prop) out.set(prop, value);
  }
  return out;
}

/** A CSS length in px, or null if it is not a plain length. Zero in any unit is 0. */
function lengthPx(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = value.match(/^(-?\d*\.?\d+)\s*(px|pt|em|rem|%|vh|vw|ex|ch)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (n === 0) return 0;
  switch (m[2]) {
    case "pt":
      return n * (4 / 3);
    case "em":
    case "rem":
      return n * 16;
    case "%":
      return (n / 100) * 16;
    case undefined:
    case "px":
      return n;
    default:
      return n * 8; // ex, ch, vh, vw: rough, only used for "tiny or not"
  }
}

/** Does this set of declarations hide its element (colour contrast is checked separately)? */
export function styleHides(s: Style): boolean {
  if (s.get("display") === "none") return true;
  const visibility = s.get("visibility");
  if (visibility === "hidden" || visibility === "collapse") return true;
  if (s.get("mso-hide") === "all") return true;
  if (s.get("color") === "transparent") return true;

  const opacity = s.get("opacity");
  if (opacity !== undefined) {
    const n = opacity.endsWith("%") ? parseFloat(opacity) / 100 : parseFloat(opacity);
    if (!Number.isNaN(n) && n <= 0.1) return true;
  }

  const fontSize = lengthPx(s.get("font-size"));
  if (fontSize !== null && fontSize <= 2) return true;

  const overflowHidden = ["hidden", "clip"].includes(s.get("overflow") ?? "") ||
    ["hidden", "clip"].includes(s.get("overflow-y") ?? "") ||
    ["hidden", "clip"].includes(s.get("overflow-x") ?? "");
  if (overflowHidden) {
    for (const prop of ["height", "max-height", "width", "max-width"]) {
      const px = lengthPx(s.get(prop));
      if (px !== null && px <= 1) return true;
    }
  }

  const clip = s.get("clip");
  if (clip && /rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)/.test(clip)) return true;
  const clipPath = s.get("clip-path");
  if (clipPath && /inset\(\s*(?:50%|100%)/.test(clipPath)) return true;

  const transform = s.get("transform");
  if (transform && /scale[xy]?\(\s*0(?:\.0*)?\s*[,)]/.test(transform)) return true;

  const position = s.get("position");
  if (position === "absolute" || position === "fixed") {
    for (const prop of ["left", "top", "right", "bottom"]) {
      const px = lengthPx(s.get(prop));
      if (px !== null && px <= -500) return true;
    }
  }
  const indent = lengthPx(s.get("text-indent"));
  if (indent !== null && indent <= -500) return true;

  return false;
}

// ---- Colours ----------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", blue: "#0000ff",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", whitesmoke: "#f5f5f5",
  snow: "#fffafa", ivory: "#fffff0", ghostwhite: "#f8f8ff", floralwhite: "#fffaf0",
  linen: "#faf0e6", seashell: "#fff5ee", azure: "#f0ffff", mintcream: "#f5fffa",
  aliceblue: "#f0f8ff", honeydew: "#f0fff0", lavenderblush: "#fff0f5", beige: "#f5f5dc",
  oldlace: "#fdf5e6", cornsilk: "#fff8dc", navy: "#000080", yellow: "#ffff00",
};

/** [r, g, b] for a simple CSS colour, or null (unknown, or a gradient / image). */
export function parseColor(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (NAMED[v]) v = NAMED[v];
  let m = v.match(/^#([0-9a-f]{3,4})$/);
  if (m) {
    const [r, g, b] = m[1].split("").map((c) => parseInt(c + c, 16));
    return [r, g, b];
  }
  m = v.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/);
  if (m) {
    return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as [number, number, number];
  }
  m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Below this contrast ratio, text is treated as invisible on its background. */
export const MIN_VISIBLE_CONTRAST = 1.25;

/** A background colour from a `background` shorthand, if it is a plain colour. */
function backgroundColor(s: Style): string | undefined {
  const bg = s.get("background-color");
  if (bg) return bg;
  const shorthand = s.get("background");
  if (!shorthand) return undefined;
  // Take a leading or lone colour token; ignore images and gradients.
  const token = shorthand.match(/(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b)/);
  return token && parseColor(token[1]) ? token[1] : undefined;
}

// ---- Stylesheet rules ---------------------------------------------------------------------

export interface HidingRule {
  tag?: string;
  ids: string[];
  classes: string[];
}

/** Rules in <style> blocks that hide what they match (simple selectors only, see header). */
export function hidingRules(css: string): HidingRule[] {
  const rules: HidingRule[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--|-->/g, "");
  // Innermost blocks only: this flattens @media { ... } wrappers.
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].trim();
    if (selectors.startsWith("@")) continue;
    if (!styleHides(parseStyle(m[2]))) continue;
    for (const sel of selectors.split(",")) {
      // The last compound selector: ".wrap .hide" -> ".hide", "td.x > span.y" -> "span.y".
      const last = sel.trim().split(/[\s>+~]+/).pop() ?? "";
      const compound = last.replace(/:{1,2}[\w-]+(\([^)]*\))?/g, "").replace(/\[[^\]]*\]/g, "");
      const cm = compound.match(/^([a-z][a-z0-9]*|\*)?((?:[.#][\w-]+)*)$/i);
      if (!cm || (!cm[1] && !cm[2])) continue;
      const tag = cm[1] && cm[1] !== "*" ? cm[1].toLowerCase() : undefined;
      const parts: string[] = cm[2].match(/[.#][\w-]+/g) ?? [];
      const ids = parts.filter((p) => p.startsWith("#")).map((p) => p.slice(1));
      const classes = parts.filter((p) => p.startsWith(".")).map((p) => p.slice(1));
      // A bare tag rule ("span { display:none }") is unusual but honoured.
      rules.push({ tag, ids, classes });
    }
  }
  return rules;
}

// ---- Tree walk ------------------------------------------------------------------------------

function attr(el: T.Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function isElement(node: T.ChildNode): node is T.Element {
  return "tagName" in node;
}

function matchesRule(el: T.Element, rule: HidingRule): boolean {
  if (rule.tag && rule.tag !== el.tagName) return false;
  if (rule.ids.length && !rule.ids.includes(attr(el, "id") ?? "")) return false;
  if (rule.classes.length) {
    const classes = new Set((attr(el, "class") ?? "").split(/\s+/).filter(Boolean));
    if (!rule.classes.every((c) => classes.has(c))) return false;
  }
  return true;
}

function collectStyles(node: T.Node, out: string[]) {
  if ("tagName" in node && node.tagName === "style") {
    for (const child of node.childNodes) if ("value" in child && child.nodeName === "#text") out.push(child.value);
    return;
  }
  const children = "content" in node && node.nodeName === "template" ? [] : "childNodes" in node ? node.childNodes : [];
  for (const child of children) collectStyles(child, out);
}

interface Inherited {
  color?: [number, number, number];
  background: [number, number, number];
}

const WHITE: [number, number, number] = [255, 255, 255];

export interface HtmlToTextOptions {
  maxChars?: number;
  /**
   * Walk only this element of the parsed document (e.g. a web page's main article). The
   * rest of the document still counts: its <style> rules apply, and if an ancestor of the
   * element is hidden the result is empty. Null or absent: the whole document.
   */
  root?: (doc: T.Document) => T.Element | null;
  /** Leave out elements this returns true for (e.g. a share bar inside an article). */
  skip?: (el: T.Element) => boolean;
}

/** The hiding rules from every <style> block in a parsed document. */
export function documentHidingRules(doc: T.Node): HidingRule[] {
  const css: string[] = [];
  collectStyles(doc, css);
  return hidingRules(css.join("\n"));
}

/** Whether this element itself is hidden from a reader (attributes, inline style, <style> rules). */
export function isHiddenElement(el: T.Element, rules: readonly HidingRule[]): boolean {
  if (attr(el, "hidden") !== undefined) return true;
  if ((attr(el, "aria-hidden") ?? "").toLowerCase() === "true") return true;
  if (el.tagName === "input" && (attr(el, "type") ?? "").toLowerCase() === "hidden") return true;
  if (styleHides(parseStyle(attr(el, "style") ?? ""))) return true;
  return rules.some((r) => matchesRule(el, r));
}

/** Plain text a reader would see, for the summarizer. */
export function htmlToText(html: string, options: HtmlToTextOptions = {}): TextResult {
  const doc = parse(html);
  const rules = documentHidingRules(doc);

  const out: string[] = [];
  const newline = () => out.push("\n");

  const inherit = (node: T.Element, inherited: Inherited, style: Style): Inherited => {
    const next: Inherited = { ...inherited };
    const color = parseColor(style.get("color")) ?? (node.tagName === "font" ? parseColor(attr(node, "color")) : null);
    if (color) next.color = color;
    const bg = parseColor(backgroundColor(style)) ?? parseColor(attr(node, "bgcolor"));
    if (bg) next.background = bg;
    return next;
  };

  const walk = (node: T.ChildNode, inherited: Inherited) => {
    if (node.nodeName === "#text") {
      const value = (node as T.TextNode).value;
      if (!value.trim()) {
        out.push(" ");
        return;
      }
      if (inherited.color && contrastRatio(inherited.color, inherited.background) < MIN_VISIBLE_CONTRAST) {
        return;
      }
      out.push(value.replace(/\s+/g, " "));
      return;
    }
    if (!isElement(node)) return; // comments, doctype

    const tag = node.tagName;
    if (SKIP.has(tag)) return;
    if (isHiddenElement(node, rules)) return;
    if (options.skip?.(node)) return;

    const next = inherit(node, inherited, parseStyle(attr(node, "style") ?? ""));

    if (tag === "br") {
      newline();
      return;
    }
    const block = BLOCK.has(tag);
    if (block) newline();
    // For <a>, only the link text is walked: href is an attribute and never read. Link
    // text that is itself a URL is dropped in finish().
    for (const child of node.childNodes) walk(child, next);
    if (block) newline();
  };

  const root = options.root?.(doc) ?? null;
  if (!root) {
    for (const child of doc.childNodes) walk(child, { background: WHITE });
    return finish(out.join(""), options.maxChars);
  }
  // Ancestors of the chosen element, outermost first: any hidden one hides it all, and
  // their colours carry down.
  const chain: T.Element[] = [];
  for (let n: T.ParentNode | null = root.parentNode; n && "tagName" in n; n = (n as T.Element).parentNode) chain.unshift(n as T.Element);
  let inherited: Inherited = { background: WHITE };
  for (const a of chain) {
    if (SKIP.has(a.tagName) || isHiddenElement(a, rules)) return finish("", options.maxChars);
    inherited = inherit(a, inherited, parseStyle(attr(a, "style") ?? ""));
  }
  walk(root, inherited);
  return finish(out.join(""), options.maxChars);
}

/** A text/plain body, cleaned the same way (used only when a message has no HTML part). */
export function plainTextToText(text: string, options: { maxChars?: number } = {}): TextResult {
  return finish(text, options.maxChars);
}

function finish(raw: string, maxChars = DEFAULT_MAX_CHARS): TextResult {
  const text = raw
    .replace(INVISIBLE, "")
    .replace(/ /g, " ")
    .replace(URL_RE, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cap(text, maxChars);
}

function cap(text: string, maxChars: number): TextResult {
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = text.slice(0, maxChars);
  // End on a sentence if one ends in the last fifth, else on a word.
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (sentenceEnd > maxChars * 0.8) cut = cut.slice(0, sentenceEnd + 1);
  else {
    const space = cut.search(/\s\S*$/);
    if (space > 0) cut = cut.slice(0, space);
  }
  return { text: cut.trim(), truncated: true };
}
