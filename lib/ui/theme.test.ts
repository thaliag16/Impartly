// GOAL.md section 1a, checked on the source:
//   * the colour tokens live in ONE theme file (app/theme.css) with the exact values of
//     the GOAL.md table, and no hex, rgb() or hsl() colour appears anywhere else in the
//     UI code (app/, except the Phase 0 spike pages, and lib/feeds, lib/ui);
//   * every text and background pair the theme uses meets 4.5:1 (WCAG AA), with one
//     flagged exception: mocha ink on watermelon is about 4.3:1, so it is allowed only as
//     large bold text (3:1), in the primary button;
//   * watermelon is used only for the one main action, sage never for text, and text on
//     watermelon or blush is always mocha ink.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const THEME = "app/theme.css";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const GOAL_TOKENS: Record<string, string> = {
  sand: "#F4E8D3",
  card: "#FBF4E8",
  dune: "#D9C4A0",
  "mocha-ink": "#3A3125",
  "mocha-green": "#4E5E3F",
  sage: "#A9B78F",
  watermelon: "#EE6A82",
  blush: "#F8C4CB",
};

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function rules(css: string): { selector: string; decls: Map<string, string> }[] {
  const out: { selector: string; decls: Map<string, string> }[] = [];
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    out.push({ selector: m[1].trim(), decls });
  }
  return out;
}

function tokens(css: string): Record<string, string> {
  const root = rules(css).find((r) => r.selector === ":root");
  if (!root) throw new Error("no :root block in the theme");
  const t: Record<string, string> = {};
  for (const [k, v] of root.decls) if (k.startsWith("--") && /^#[0-9a-f]{6}$/i.test(v)) t[k.slice(2)] = v.toUpperCase();
  return t;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** The token a declaration value names, e.g. "var(--sand)" -> "sand". */
const tokenOf = (value: string | undefined) => value?.match(/^var\(--([a-z-]+)\)$/)?.[1] ?? null;

function uiFiles(dir: string): string[] {
  const out: string[] = [];
  const abs = path.join(ROOT, dir);
  for (const name of readdirSync(abs)) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) {
      if (rel === path.join("app", "spike")) continue; // Phase 0 spike pages, outside the themed UI
      out.push(...uiFiles(rel));
    } else if (/\.(tsx?|css|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

// Every text-on-background pair the themed UI uses: [text token, background token].
// Rules that set both are checked against this list below, so it cannot drift silently;
// the rest are text classes (.px-muted, .px-label) inherited on the surfaces they sit on.
const NORMAL_PAIRS: [string, string][] = [
  ["mocha-ink", "sand"],
  ["mocha-ink", "card"],
  ["mocha-ink", "blush"],
  ["mocha-green", "sand"],
  ["mocha-green", "card"],
  ["sand", "mocha-green"],
  ["sand", "mocha-ink"],
];
const LARGE_TEXT_PAIRS: [string, string][] = [["mocha-ink", "watermelon"]];

describe("theme tokens (GOAL.md 1a)", () => {
  const css = read(THEME);
  const t = tokens(css);

  it("app/theme.css holds exactly the GOAL.md palette", () => {
    expect(t).toEqual(GOAL_TOKENS);
  });

  it("inside the theme, colour literals appear only as :root token definitions", () => {
    const outsideRoot = stripComments(css).replace(/:root\s*\{[^}]*\}/, "");
    expect(outsideRoot.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi) ?? []).toEqual([]);
  });

  it("no hex, rgb() or hsl() colour anywhere else in the UI code", () => {
    const files = [...uiFiles("app"), ...uiFiles("lib/feeds"), ...uiFiles("lib/ui")].filter((f) => f !== THEME);
    expect(files).toContain(path.join("app", "newsletters", "picker.tsx"));
    const offenders = files.filter((f) => /#[0-9a-f]{3}(?:[0-9a-f]{3}(?:[0-9a-f]{2})?)?\b(?![\w-])|\b(?:rgba?|hsla?)\(/i.test(stripComments(read(f)).replace(/&#\d+;|&#x[0-9a-f]+;/gi, "")));
    expect(offenders).toEqual([]);
  });

  it("the hex check catches a colour literal (control)", () => {
    const sample = 'style={{ background: "#1f1e1d" }}';
    expect(/#[0-9a-f]{3}(?:[0-9a-f]{3}(?:[0-9a-f]{2})?)?\b(?![\w-])/i.test(sample)).toBe(true);
  });
});

describe("contrast (GOAL.md 1a: all text meets 4.5:1)", () => {
  const css = read(THEME);
  const t = tokens(css);

  it.each(NORMAL_PAIRS)("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(LARGE_TEXT_PAIRS)("%s on %s is at least 3:1 (large bold text only)", (fg, bg) => {
    const ratio = contrast(t[fg], t[bg]);
    expect(ratio).toBeGreaterThanOrEqual(3);
    // Documents the exception flagged to Thalia: it does not reach 4.5:1.
    expect(ratio).toBeLessThan(4.5);
  });

  it("every theme rule that sets both text and background uses a checked pair", () => {
    const known = new Set([...NORMAL_PAIRS, ...LARGE_TEXT_PAIRS].map(([a, b]) => `${a}/${b}`));
    for (const r of rules(css)) {
      const fg = tokenOf(r.decls.get("color"));
      const bg = tokenOf(r.decls.get("background"));
      if (fg && bg) expect(known.has(`${fg}/${bg}`), `${r.selector}: ${fg} on ${bg}`).toBe(true);
    }
  });

  it("the large-text pair is used only with large bold text (at least 18.66px and bold)", () => {
    for (const r of rules(css)) {
      const pair = `${tokenOf(r.decls.get("color"))}/${tokenOf(r.decls.get("background"))}`;
      if (!LARGE_TEXT_PAIRS.some(([a, b]) => `${a}/${b}` === pair)) continue;
      expect(parseFloat(r.decls.get("font-size") ?? "0"), r.selector).toBeGreaterThanOrEqual(18.66);
      expect(Number(r.decls.get("font-weight")), r.selector).toBeGreaterThanOrEqual(700);
    }
  });

  it("the contrast maths matches known values (control)", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#FFFFFF")).toBeCloseTo(4.48, 2);
  });
});

describe("colour roles (GOAL.md 1a)", () => {
  const all = rules(read(THEME));

  it("watermelon appears only in the primary-action rule", () => {
    const users = all.filter((r) => [...r.decls.entries()].some(([k, v]) => !k.startsWith("--") && v.includes("--watermelon")));
    expect(users.map((r) => r.selector)).toEqual([".px-btn-primary"]);
  });

  it("sage is never a text colour", () => {
    for (const r of all) expect(tokenOf(r.decls.get("color")), r.selector).not.toBe("sage");
  });

  it("text on watermelon or blush is always mocha ink", () => {
    for (const r of all) {
      const bg = tokenOf(r.decls.get("background"));
      if (bg === "watermelon" || bg === "blush") expect(tokenOf(r.decls.get("color")), r.selector).toBe("mocha-ink");
    }
  });

  it("corners are square: no border-radius above 0 in the theme", () => {
    for (const r of all) {
      const v = r.decls.get("border-radius");
      if (v !== undefined) expect(v, r.selector).toBe("0");
    }
  });
});
