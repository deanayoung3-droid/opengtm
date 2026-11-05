import { describe, expect, it } from "vitest";
import { isWithinWindow } from "../src/geo";

// OtherTool's schedule: weekdays plus Sunday (so Sunday sends sit at the top of Monday's inbox).
describe("send days", () => {
  const w = { business_start: "09:00", business_end: "16:30", send_weekends: false };
  const ny = "America/New_York";
  const sun = new Date("2026-10-25T15:00:00Z"); // Sunday 11:00 in New York
  const sat = new Date("2026-10-24T15:00:00Z"); // Saturday 11:00

  it("uses send_days when set, and falls back to send_weekends otherwise", () => {
    expect(isWithinWindow(sun, ny, w)).toBe(false);
    expect(isWithinWindow(sun, ny, { ...w, send_days: ["mon", "tue", "wed", "thu", "fri", "sun"] })).toBe(true);
    expect(isWithinWindow(sat, ny, { ...w, send_days: ["mon", "tue", "wed", "thu", "fri", "sun"] })).toBe(false);
  });
});
