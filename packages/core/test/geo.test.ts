import { describe, expect, it } from "vitest";
import { isWithinWindow, nextWindowStart, timezoneForState } from "../src/index";

const w = { business_start: "09:00", business_end: "16:30", send_weekends: false };

describe("timezones and business windows", () => {
  it("maps states to timezones, defaulting to Central", () => {
    expect(timezoneForState("CA")).toBe("America/Los_Angeles");
    expect(timezoneForState("new york")).toBe("America/New_York");
    expect(timezoneForState(null)).toBe("America/Chicago");
  });

  it("honors local business hours", () => {
    // 2026-10-20 is a Tuesday. 15:00Z = 11:00 EDT, 08:00 PDT.
    const t = new Date("2026-10-20T15:00:00Z");
    expect(isWithinWindow(t, "America/New_York", w)).toBe(true);
    expect(isWithinWindow(t, "America/Los_Angeles", w)).toBe(false);
  });

  it("skips weekends", () => {
    const sat = new Date("2026-10-24T16:00:00Z");
    expect(isWithinWindow(sat, "America/New_York", w)).toBe(false);
    const next = nextWindowStart(sat, "America/New_York", w);
    expect(next.toISOString()).toBe("2026-10-26T13:00:00.000Z"); // Mon 09:00 EDT
  });
});
