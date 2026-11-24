import { describe, expect, it } from "vitest";
import {
  DELIVERY_TIMES,
  LEGACY_ZONES,
  fromDbTime,
  isKnownTimezone,
  nextBriefingLabel,
  parseDeliverySettings,
  timeLabel,
  timezoneLabel,
  timezoneOptions,
} from "./delivery";

describe("delivery settings: values and validation", () => {
  it("offers every 15 minutes of the day", () => {
    expect(DELIVERY_TIMES).toHaveLength(96);
    expect(DELIVERY_TIMES.slice(0, 3)).toEqual(["00:00", "00:15", "00:30"]);
    expect(DELIVERY_TIMES.at(-1)).toBe("23:45");
    expect(DELIVERY_TIMES).toContain("07:00");
  });

  it("accepts a listed time and a known zone", () => {
    expect(parseDeliverySettings({ deliveryTime: "06:15", timezone: "America/Los_Angeles" })).toEqual({
      ok: true,
      value: { deliveryTime: "06:15", timezone: "America/Los_Angeles" },
    });
    expect(parseDeliverySettings({ deliveryTime: "00:00", timezone: "UTC" }).ok).toBe(true);
  });

  it("refuses times off the 15-minute grid or out of range, and anything that is not a string", () => {
    for (const deliveryTime of ["07:05", "7:00", "24:00", "07:00:00", "", " 07:00", null, 700, ["07:00"], { toString: () => "07:00" }]) {
      expect(parseDeliverySettings({ deliveryTime, timezone: "UTC" }), String(deliveryTime)).toEqual({ ok: false, error: "invalid_time" });
    }
  });

  it("refuses unknown or malformed zones", () => {
    for (const timezone of ["Mars/Olympus", "", "America/Los Angeles", "../etc/passwd", "UTC; drop table x", "x".repeat(80), null, 1]) {
      expect(parseDeliverySettings({ deliveryTime: "07:00", timezone }), String(timezone)).toEqual({ ok: false, error: "invalid_timezone" });
    }
    expect(isKnownTimezone("Europe/Berlin")).toBe(true);
    expect(isKnownTimezone("America/Argentina/Buenos_Aires")).toBe(true);
  });

  it("stores old zone names under their current name", () => {
    expect(parseDeliverySettings({ deliveryTime: "07:00", timezone: "Asia/Calcutta" })).toEqual({
      ok: true,
      value: { deliveryTime: "07:00", timezone: "Asia/Kolkata" },
    });
    expect(parseDeliverySettings({ deliveryTime: "07:00", timezone: "Europe/Kiev" })).toMatchObject({ value: { timezone: "Europe/Kyiv" } });
    expect(parseDeliverySettings({ deliveryTime: "07:00", timezone: "constructor" }).ok).toBe(false);
  });

  it("refuses input that is not an object", () => {
    for (const input of [null, undefined, "07:00", 42]) {
      expect(parseDeliverySettings(input).ok).toBe(false);
    }
  });

  it("reads Postgres time values", () => {
    expect(fromDbTime("07:00:00")).toBe("07:00");
    expect(fromDbTime("23:45:00.000")).toBe("23:45");
    expect(fromDbTime("07:00")).toBe("07:00");
    expect(fromDbTime("25:00:00")).toBeNull();
    expect(fromDbTime(null)).toBeNull();
  });
});

describe("delivery settings: labels", () => {
  it("12-hour time labels", () => {
    expect(timeLabel("07:00")).toBe("7:00 AM");
    expect(timeLabel("00:15")).toBe("12:15 AM");
    expect(timeLabel("12:00")).toBe("12:00 PM");
    expect(timeLabel("23:45")).toBe("11:45 PM");
  });

  it("the next briefing in the user's zone: weekday and time", () => {
    const at = new Date("2026-11-25T15:00:00Z"); // Wednesday
    expect(nextBriefingLabel(at, "America/Los_Angeles")).toBe("Wed 7:00 AM");
    expect(nextBriefingLabel(at, "UTC")).toBe("Wed 3:00 PM");
    expect(nextBriefingLabel(at, "Asia/Tokyo")).toBe("Thu 12:00 AM");
    expect(nextBriefingLabel(new Date("2026-11-25T00:45:00Z"), "Asia/Kolkata")).toBe("Wed 6:15 AM");
  });

  it("zone options start with UTC, use current names, list each zone once and keep a saved name", () => {
    const zones = timezoneOptions(["Europe/Berlin", "Mars/Olympus"]);
    expect(zones[0]).toBe("UTC");
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones).toContain("America/Los_Angeles");
    for (const [old, now] of Object.entries(LEGACY_ZONES)) {
      expect(zones, old).not.toContain(old);
      expect(zones, now).toContain(now);
    }
    expect(timezoneOptions(["Asia/Calcutta"])).toContain("Asia/Calcutta"); // a saved old name stays selectable
    expect(zones).not.toContain("Mars/Olympus");
    expect(timezoneLabel("America/Los_Angeles")).toBe("America/Los Angeles");
  });
});
