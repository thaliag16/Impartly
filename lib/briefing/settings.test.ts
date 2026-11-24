import { describe, expect, it } from "vitest";
import { DEFAULT_LISTEN_SETTINGS, loadListenSettings, parseListenSettings, saveListenSettings } from "./settings";

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
