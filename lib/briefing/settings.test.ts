import { describe, expect, it } from "vitest";
import {
  DEFAULT_LISTEN_SETTINGS,
  SPEED_OPTIONS,
  VOICE_LABELS,
  loadListenSettings,
  moveFeed,
  orderFeeds,
  parseListenSettings,
  positionAnnouncement,
  previewSentence,
  saveListenSettings,
  savedOrderFor,
  speedLabel,
} from "./settings";

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const OWN = [F1, F2, F3];

describe("parseListenSettings", () => {
  it("accepts the two voices, speeds 0.5 to 2 in 0.05 steps, and an order of the user's own feeds", () => {
    expect(parseListenSettings({ voice: "bm_daniel", speed: 1.25, feedOrder: [F3, F1] }, OWN)).toEqual({
      ok: true,
      value: { voice: "bm_daniel", speed: 1.25, feedOrder: [F3, F1] },
    });
    expect(parseListenSettings({ voice: "af_heart", speed: "0.5", feedOrder: [] }, OWN)).toMatchObject({ ok: true, value: { speed: 0.5 } });
    expect(parseListenSettings({ voice: "af_heart", speed: 2, feedOrder: [] }, OWN)).toMatchObject({ ok: true });
  });

  it.each([
    [{ voice: "af_bella", speed: 1, feedOrder: [] }, "invalid_voice"],
    [{ voice: 7, speed: 1, feedOrder: [] }, "invalid_voice"],
    [{ voice: "af_heart", speed: 2.5, feedOrder: [] }, "invalid_speed"],
    [{ voice: "af_heart", speed: 0.4, feedOrder: [] }, "invalid_speed"],
    [{ voice: "af_heart", speed: 1.13, feedOrder: [] }, "invalid_speed"],
    [{ voice: "af_heart", speed: "fast", feedOrder: [] }, "invalid_speed"],
    [{ voice: "af_heart", speed: 1, feedOrder: "F1" }, "invalid_order"],
    [{ voice: "af_heart", speed: 1, feedOrder: [F1, F1] }, "invalid_order"],
    [{ voice: "af_heart", speed: 1, feedOrder: ["44444444-4444-4444-8444-444444444444"] }, "invalid_order"],
    [{ voice: "af_heart", speed: 1, feedOrder: ["not-a-uuid"] }, "invalid_order"],
    [null, "invalid_voice"],
  ])("refuses %j (%s)", (input, error) => {
    expect(parseListenSettings(input, OWN)).toEqual({ ok: false, error });
  });
});

/** A tiny stand-in for the Supabase client's query builder (only what settings.ts uses). */
function fakeClient(tables: { user_settings: Record<string, unknown>[]; web_feeds: { id: string }[] }, failOn?: string) {
  const writes: { op: string; values: Record<string, unknown> }[] = [];
  const from = (table: keyof typeof tables) => {
    const result = (data: unknown) => ({ data, error: failOn === table ? { code: "XX000", message: "boom" } : null });
    const builder = {
      select: () => ({
        limit: async () => result(tables[table].slice(0, 1)),
        then: (resolve: (v: unknown) => void) => resolve(result(tables[table])),
      }),
      update: (values: Record<string, unknown>) => ({
        eq: () => ({
          select: async () => {
            writes.push({ op: "update", values });
            const rows = tables[table];
            rows.forEach((r) => Object.assign(r, values));
            return result(rows.map(() => ({ user_id: "u" })));
          },
        }),
      }),
      insert: async (values: Record<string, unknown>) => {
        writes.push({ op: "insert", values });
        (tables[table] as Record<string, unknown>[]).push(values);
        return result(null);
      },
    };
    return builder;
  };
  return { client: { from } as never, writes };
}

describe("loadListenSettings and saveListenSettings", () => {
  it("loads the defaults when the user has no row", async () => {
    const { client } = fakeClient({ user_settings: [], web_feeds: [] });
    expect(await loadListenSettings(client)).toEqual({ ...DEFAULT_LISTEN_SETTINGS, saved: false });
  });

  it("loads a saved row, keeping only ids that look like feed ids", async () => {
    const { client } = fakeClient({
      user_settings: [{ voice: "bm_daniel", speed: "1.50", feed_order: [F2, "junk"] }],
      web_feeds: [],
    });
    expect(await loadListenSettings(client)).toEqual({ voice: "bm_daniel", speed: 1.5, feedOrder: [F2], saved: true });
  });

  it("returns null when the read fails", async () => {
    const { client } = fakeClient({ user_settings: [], web_feeds: [] }, "user_settings");
    expect(await loadListenSettings(client)).toBeNull();
  });

  it("saves validated values to the user's row, checking the order against the user's own feeds", async () => {
    const { client, writes } = fakeClient({ user_settings: [{ user_id: "u" }], web_feeds: OWN.map((id) => ({ id })) });
    const saved = await saveListenSettings(client, "u", { voice: "bm_daniel", speed: 0.75, feedOrder: [F2, F1] });
    expect(saved).toEqual({ ok: true, value: { voice: "bm_daniel", speed: 0.75, feedOrder: [F2, F1] } });
    expect(writes[0]).toMatchObject({ op: "update", values: { voice: "bm_daniel", speed: 0.75, feed_order: [F2, F1] } });
  });

  it("inserts the row when there is none yet", async () => {
    const tables = { user_settings: [] as Record<string, unknown>[], web_feeds: [{ id: F1 }] };
    const { client, writes } = fakeClient(tables);
    expect(await saveListenSettings(client, "u", { voice: "af_heart", speed: 1, feedOrder: [F1] })).toMatchObject({ ok: true });
    expect(writes.map((w) => w.op)).toEqual(["update", "insert"]);
    expect(writes[1].values).toEqual({ user_id: "u", voice: "af_heart", speed: 1, feed_order: [F1] });
  });

  it("refuses an order naming another user's feed, and writes nothing", async () => {
    const { client, writes } = fakeClient({ user_settings: [{ user_id: "u" }], web_feeds: [{ id: F1 }] });
    expect(await saveListenSettings(client, "u", { voice: "af_heart", speed: 1, feedOrder: [F3] })).toEqual({
      ok: false,
      error: "invalid_order",
    });
    expect(writes).toEqual([]);
  });
});

describe("parseListenSettings edge cases (run 25)", () => {
  it.each([
    ["0x1", "a hex string"],
    ["1e0", "an exponent string"],
    ["Infinity", "Infinity as text"],
    ["", "an empty string"],
    ["  ", "spaces"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "infinity"],
    [true, "a boolean"],
    [[1], "an array"],
    [0.45, "just under the minimum"],
    [2.05, "just over the maximum"],
    [1.0000001, "off the 0.05 grid by a hair"],
  ] as [unknown, string][])("refuses the speed %j (%s)", (speed) => {
    expect(parseListenSettings({ voice: "af_heart", speed, feedOrder: [] }, OWN)).toEqual({ ok: false, error: "invalid_speed" });
  });

  it.each([
    [0.5, 0.5],
    [0.55, 0.55],
    [1.1, 1.1],
    [1.15, 1.15],
    [1.95, 1.95],
    [2, 2],
    ["1.10", 1.1],
    [" 0.75 ", 0.75],
  ])("accepts the speed %j as %d", (speed, value) => {
    expect(parseListenSettings({ voice: "af_heart", speed, feedOrder: [] }, OWN)).toMatchObject({ ok: true, value: { speed: value } });
  });

  it("every offered speed passes validation, 0.50 to 2.00 in 31 steps", () => {
    expect(SPEED_OPTIONS).toHaveLength(31);
    expect(SPEED_OPTIONS[0]).toBe(0.5);
    expect(SPEED_OPTIONS.at(-1)).toBe(2);
    for (const speed of SPEED_OPTIONS) {
      expect(parseListenSettings({ voice: "bm_daniel", speed, feedOrder: [] }, OWN)).toMatchObject({ ok: true, value: { speed } });
    }
    expect(SPEED_OPTIONS.map(speedLabel).slice(0, 3)).toEqual(["0.50x", "0.55x", "0.60x"]);
  });

  it("normalises upper-case ids, and refuses the same id in two cases", () => {
    expect(parseListenSettings({ voice: "af_heart", speed: 1, feedOrder: [F1.toUpperCase()] }, OWN)).toEqual({
      ok: true,
      value: { voice: "af_heart", speed: 1, feedOrder: [F1] },
    });
    expect(parseListenSettings({ voice: "af_heart", speed: 1, feedOrder: [F1, F1.toUpperCase()] }, OWN)).toEqual({
      ok: false,
      error: "invalid_order",
    });
  });

  it("accepts an order of 200 own feeds and refuses 201", () => {
    const ids = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(parseListenSettings({ voice: "af_heart", speed: 1, feedOrder: ids.slice(0, 200) }, ids)).toMatchObject({ ok: true });
    expect(parseListenSettings({ voice: "af_heart", speed: 1, feedOrder: ids }, ids)).toEqual({ ok: false, error: "invalid_order" });
  });

  it.each([
    [{ voice: "af_heart", speed: 1, feedOrder: [F1, 7] }],
    [{ voice: "af_heart", speed: 1, feedOrder: [F1, null] }],
    [{ voice: "af_heart", speed: 1, feedOrder: { 0: F1, length: 1 } }],
    [{ voice: "af_heart", speed: 1 }],
  ])("refuses a malformed order %j", (input) => {
    expect(parseListenSettings(input, OWN)).toEqual({ ok: false, error: "invalid_order" });
  });

  it("refuses a voice that differs only in case or spacing", () => {
    for (const voice of ["AF_HEART", " af_heart", "bm_daniel "]) {
      expect(parseListenSettings({ voice, speed: 1, feedOrder: [] }, OWN)).toEqual({ ok: false, error: "invalid_voice" });
    }
  });
});

describe("the settings screen's order helpers", () => {
  const feeds = [
    { id: F1, title: "One", included: true },
    { id: F2, title: "Two", included: false },
    { id: F3, title: "Three", included: true },
  ];

  it("lists the saved order first, then the rest as given, and drops ids that are not the user's feeds", () => {
    expect(orderFeeds(feeds, [F3.toUpperCase(), "44444444-4444-4444-8444-444444444444", F2]).map((f) => f.title)).toEqual([
      "Three",
      "Two",
      "One",
    ]);
    expect(orderFeeds(feeds, []).map((f) => f.title)).toEqual(["One", "Two", "Three"]);
    expect(savedOrderFor(feeds, [F3.toUpperCase(), "44444444-4444-4444-8444-444444444444", F3])).toEqual([F3]);
  });

  it("moves one feed up or down, and refuses a move past either end", () => {
    expect(moveFeed([F1, F2, F3], 1, -1)).toEqual([F2, F1, F3]);
    expect(moveFeed([F1, F2, F3], 1, 1)).toEqual([F1, F3, F2]);
    expect(moveFeed([F1, F2, F3], 0, -1)).toBeNull();
    expect(moveFeed([F1, F2, F3], 2, 1)).toBeNull();
    expect(moveFeed([F1, F2, F3], 5, -1)).toBeNull();
  });

  it("announces the new position in words", () => {
    expect(positionAnnouncement("Harbor Notes", 0, 2)).toBe("Harbor Notes moved to position 1 of 2.");
  });

  it("names the voices and gives one short preview sentence per voice", () => {
    expect(VOICE_LABELS).toEqual({ af_heart: "Heart", bm_daniel: "Daniel" });
    expect(previewSentence("bm_daniel")).toBe("This is Daniel, reading your briefing at the speed you picked.");
  });
});
