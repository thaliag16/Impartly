import { describe, expect, it } from "vitest";
import type { RenderReport } from "./render-ahead";
import {
  deviceClassHint,
  parseRenderLog,
  renderLogInput,
  shouldLogRender,
  writeRenderLog,
  type RenderLogRow,
} from "./render-log";

const DELIVERY = "2026-11-24T15:00:00.000Z";

const report = (over: Partial<RenderReport> = {}): RenderReport => ({
  voice: "af_heart",
  speed: 1,
  sentences: 12,
  rendered: 10,
  cached: 2,
  characters: 1400,
  renderSeconds: 41.23456,
  audioSeconds: 95.5,
  renderedAudioSeconds: 80.25,
  realTimeFactor: 41.23456 / 80.25,
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({ ...renderLogInput(report(), DELIVERY, "mobile"), ...over });

describe("render log input", () => {
  it("maps a render report to one row, rounded to milliseconds, with no user id (the database sets it)", () => {
    const parsed = parseRenderLog(input());
    expect(parsed).toEqual({
      ok: true,
      value: {
        delivery_at: DELIVERY,
        voice: "af_heart",
        speed: 1,
        chars: 1400,
        sentences: 12,
        rendered: 10,
        cached: 2,
        audio_seconds: 95.5,
        rendered_audio_seconds: 80.25,
        render_seconds: 41.235,
        device_class: "mobile",
      } satisfies RenderLogRow,
    });
    expect(Object.keys((parsed as { value: object }).value)).not.toContain("user_id");
  });

  it("only renders that rendered something are logged (an all-cached open costs nothing)", () => {
    expect(shouldLogRender(report())).toBe(true);
    expect(shouldLogRender(report({ rendered: 0, cached: 12, renderSeconds: 0, renderedAudioSeconds: 0 }))).toBe(false);
  });

  it("refuses a user_id or any field it does not know", () => {
    expect(parseRenderLog(input({ user_id: "11111111-1111-4111-8111-111111111111" }))).toEqual({ ok: false, error: "invalid_render_log" });
    expect(parseRenderLog(input({ userAgent: "Mozilla/5.0" }))).toEqual({ ok: false, error: "invalid_render_log" });
    expect(parseRenderLog(input({ ip: "203.0.113.9" }))).toEqual({ ok: false, error: "invalid_render_log" });
  });

  it.each([
    ["not an object", null],
    ["an array", []],
    ["an unknown voice", { voice: "am_adam" }],
    ["an off-grid speed", { speed: 1.03 }],
    ["a speed string in hex", { speed: "0x1" }],
    ["a speed too fast", { speed: 2.05 }],
    ["fractional characters", { characters: 1.5 }],
    ["negative characters", { characters: -1 }],
    ["too many characters", { characters: 2_000_001 }],
    ["no sentences", { sentences: 0, rendered: 0, cached: 0 }],
    ["too many sentences", { sentences: 10_001, rendered: 10_001, cached: 0 }],
    ["counts that do not add up", { rendered: 5 }],
    ["nothing rendered", { rendered: 0, cached: 12 }],
    ["negative render time", { renderSeconds: -0.1 }],
    ["NaN audio", { audioSeconds: Number.NaN }],
    ["infinite render time", { renderSeconds: Number.POSITIVE_INFINITY }],
    ["over four hours of audio", { audioSeconds: 14_401 }],
    ["a render time as a string", { renderSeconds: "41" }],
    ["rendered audio longer than the briefing", { renderedAudioSeconds: 96 }],
    ["an unparseable delivery", { deliveryAt: "yesterday" }],
    ["a delivery far in the future", { deliveryAt: "2099-01-01T00:00:00.000Z" }],
    ["a delivery before the app existed", { deliveryAt: "2001-01-01T00:00:00.000Z" }],
    ["an unknown device class", { deviceClass: "iPhone 15 Pro" }],
  ])("refuses %s", (_label, over) => {
    const value = over === null || Array.isArray(over) ? over : input(over as Record<string, unknown>);
    expect(parseRenderLog(value)).toEqual({ ok: false, error: "invalid_render_log" });
  });

  it("accepts a rendered-audio sum a hair over the total (float addition) and caps it at the total", () => {
    const parsed = parseRenderLog(input({ renderedAudioSeconds: 95.5000000001 }));
    expect(parsed.ok && parsed.value.rendered_audio_seconds).toBe(95.5);
  });

  it("normalises the delivery time", () => {
    const parsed = parseRenderLog(input({ deliveryAt: "2026-11-24T07:00:00-08:00" }));
    expect(parsed.ok && parsed.value.delivery_at).toBe(DELIVERY);
  });
});

describe("device class hint (coarse, no fingerprinting)", () => {
  it("uses the browser's own mobile flag when there is one", () => {
    expect(deviceClassHint({ userAgentData: { mobile: true } })).toBe("mobile");
    expect(deviceClassHint({ userAgentData: { mobile: false } })).toBe("desktop");
  });

  it("falls back to whether the main pointer is a finger", () => {
    expect(deviceClassHint({ matchMedia: (q) => ({ matches: q === "(pointer: coarse)" }) })).toBe("mobile");
    expect(deviceClassHint({ matchMedia: () => ({ matches: false }) })).toBe("desktop");
  });

  it("is unknown when neither exists, and never reads the user agent string", () => {
    expect(deviceClassHint({})).toBe("unknown");
    const nav = {
      get userAgent(): string {
        throw new Error("the user agent string must not be read");
      },
    };
    expect(deviceClassHint(nav as never)).toBe("unknown");
  });
});

describe("writeRenderLog", () => {
  // A stand-in for the user's Supabase client: records the insert, returns stored rows, and
  // the briefing's summary usage rows (summary_usage, own rows under RLS).
  function fakeClient(
    options: {
      insertError?: boolean;
      selectError?: boolean;
      stored?: Record<string, unknown>[];
      usage?: Record<string, unknown>[];
      usageError?: boolean;
    } = {},
  ) {
    const inserted: unknown[] = [];
    const filters: [string, unknown][] = [];
    const usageFilters: [string, unknown][] = [];
    const client = {
      from(table: string) {
        if (table === "summary_usage") {
          return {
            select: (cols: string) => {
              expect(cols).toBe("cost_usd");
              return {
                eq: async (col: string, value: unknown) => {
                  usageFilters.push([col, value]);
                  if (options.usageError) return { data: null, error: { message: "boom" } };
                  return { data: options.usage ?? [], error: null };
                },
              };
            },
          };
        }
        expect(table).toBe("render_log");
        return {
          insert: async (row: unknown) => {
            inserted.push(row);
            return { error: options.insertError ? { code: "42501", message: "denied" } : null };
          },
          select: (cols: string) => {
            expect(cols).toBe("delivery_at, audio_seconds, rendered_audio_seconds, render_seconds");
            return {
              eq: async (col: string, value: unknown) => {
                filters.push([col, value]);
                if (options.selectError) return { data: null, error: { message: "boom" } };
                return { data: options.stored ?? inserted, error: null };
              },
            };
          },
        };
      },
    };
    return { client: client as never, inserted, filters, usageFilters };
  }

  it("checks the briefing's summary spend from its recorded usage, and never fails on it", async () => {
    const fake = fakeClient({ usage: [{ cost_usd: "0.00012" }, { cost_usd: 0.00013 }] });
    const out = await writeRenderLog(fake.client, input());
    expect(fake.usageFilters).toEqual([["delivery_at", DELIVERY]]);
    expect(out).toMatchObject({ ok: true, budget: { over: [] } });
    expect((out as { budget: { summaryCostUsd: number } }).budget.summaryCostUsd).toBeCloseTo(0.00025, 10);
    const over = await writeRenderLog(fakeClient({ usage: [{ cost_usd: 0.2 }] }).client, input());
    expect(over).toMatchObject({ ok: true, budget: { over: ["summary_cost"] } });
    // Unreadable usage: unknown, not an error (the render row is already saved).
    const unknown = await writeRenderLog(fakeClient({ usageError: true }).client, input());
    expect(unknown).toMatchObject({ ok: true, budget: { summaryCostUsd: null, over: [] } });
  });

  it("inserts exactly one row and checks the briefing's budget over its rows", async () => {
    const fake = fakeClient();
    const out = await writeRenderLog(fake.client, input());
    expect(fake.inserted).toHaveLength(1);
    expect(fake.filters).toEqual([["delivery_at", DELIVERY]]);
    expect(out).toMatchObject({ ok: true, budget: { deliveryAt: DELIVERY, renders: 1, over: [] } });
  });

  it("reads numeric columns returned as text", async () => {
    const fake = fakeClient({
      stored: [{ delivery_at: "2026-11-24T15:00:00+00:00", audio_seconds: "95.5", rendered_audio_seconds: "80.25", render_seconds: "400" }],
    });
    const out = await writeRenderLog(fake.client, input());
    expect(out).toMatchObject({ ok: true, budget: { deliveryAt: DELIVERY, renderSeconds: 400, over: ["real_time_factor", "render_time"] } });
  });

  it("writes nothing for invalid input", async () => {
    const fake = fakeClient();
    expect(await writeRenderLog(fake.client, input({ voice: "x" }))).toEqual({ ok: false, error: "invalid_render_log" });
    expect(fake.inserted).toEqual([]);
  });

  it("reports a refused insert or a failed read as save_failed", async () => {
    expect(await writeRenderLog(fakeClient({ insertError: true }).client, input())).toEqual({ ok: false, error: "save_failed" });
    expect(await writeRenderLog(fakeClient({ selectError: true }).client, input())).toEqual({ ok: false, error: "save_failed" });
  });
});
