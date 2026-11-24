// robots.txt (RFC 9309), checked before every web request Impartly makes.
//
// Group selection: the group whose user-agent line matches our product token ("impartly",
// case-insensitive) wins; otherwise the "*" group; otherwise everything is allowed. Rules:
// the longest matching Allow or Disallow path wins, Allow wins a tie, "*" matches any run
// of characters and a trailing "$" anchors the end. /robots.txt itself is always allowed.
//
// When robots.txt cannot be read (RFC 9309 section 2.3.1):
//   * 4xx (it does not exist, or is not public): everything is allowed
//   * 5xx, a network error or a timeout: nothing is allowed ("unreachable" means complete
//     disallow), so a failing site is skipped this run rather than crawled blind
// Only the first 500 KiB is parsed, as the RFC allows.

export const ROBOTS_MAX_BYTES = 500 * 1024;

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: Rule[];
}

export type RobotsPolicy =
  | { kind: "rules"; rules: Rule[] }
  | { kind: "allow-all" }
  | { kind: "disallow-all" };

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (!current) continue; // rules before any user-agent line belong to no group
      // An empty Disallow allows everything, so it adds no rule.
      if (value === "") continue;
      current.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false; // sitemap, crawl-delay, ... end the user-agent run
    }
  }
  return groups;
}

/** The rules that apply to `productToken` (lower case): its own groups, else "*" groups. */
export function rulesFor(groups: RobotsGroup[], productToken: string): Rule[] {
  const own = groups.filter((g) => g.agents.some((a) => a === productToken || a.split("/")[0] === productToken));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

/** Percent-encode the way RFC 9309 compares paths: decode unreserved escapes, upper-case the rest. */
function normalizePath(p: string): string {
  return p.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = normalizePath(anchored ? pattern.slice(0, -1) : pattern);
  const re = new RegExp(
    "^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""),
  );
  return re.test(path);
}

/** Whether `pathAndQuery` (e.g. "/feed?x=1") may be fetched under `rules`. */
export function isAllowedBy(rules: Rule[], pathAndQuery: string): boolean {
  const path = normalizePath(pathAndQuery || "/");
  if (path === "/robots.txt") return true;
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

export function policyAllows(policy: RobotsPolicy, url: URL): boolean {
  if (url.pathname === "/robots.txt") return true;
  if (policy.kind === "allow-all") return true;
  if (policy.kind === "disallow-all") return false;
  return isAllowedBy(policy.rules, `${url.pathname}${url.search}`);
}

export interface RobotsExtras {
  /** Crawl-delay in seconds from our group (else the "*" group), or null if none is set. */
  crawlDelaySeconds: number | null;
  /** Sitemap URLs (absolute http(s)) listed anywhere in the file, at most 10. */
  sitemaps: string[];
}

/**
 * The non-standard lines RFC 9309 leaves to crawlers: Crawl-delay (honoured by the archive
 * source, never shortened) and Sitemap (used to find newsletter issues).
 */
export function robotsExtras(text: string, productToken: string): RobotsExtras {
  const sitemaps: string[] = [];
  const delays = new Map<string, number>(); // agent -> delay
  let agents: string[] = [];
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) agents = [];
      agents.push(value.toLowerCase().split("/")[0]);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") {
      if (sitemaps.length < 10 && /^https?:\/\//i.test(value)) sitemaps.push(value);
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) for (const a of agents) if (!delays.has(a)) delays.set(a, n);
    }
  }
  const delay = delays.get(productToken) ?? delays.get("*") ?? null;
  return { crawlDelaySeconds: delay, sitemaps };
}

/** The policy for a robots.txt response (status and body), per RFC 9309 section 2.3.1. */
export function policyFromResponse(status: number, body: string, productToken: string): RobotsPolicy {
  if (status >= 200 && status < 300) return { kind: "rules", rules: rulesFor(parseRobots(body), productToken) };
  if (status >= 400 && status < 500) return { kind: "allow-all" };
  return { kind: "disallow-all" };
}
