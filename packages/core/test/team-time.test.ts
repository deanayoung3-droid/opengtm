import { describe, expect, it } from "vitest";
import { lastTeamDays, startOfTeamDay, teamDay } from "../src/clock";
import { nextCronRun } from "../src/geo";

// Northwind runs on Pacific time: days roll over at midnight Pacific, and job times are Pacific.
describe("team (Pacific) time", () => {
  it("puts an evening send on the Pacific day, not the UTC day", () => {
    const d = new Date("2026-10-27T03:30:00Z"); // Mon Oct 26, 8:30 PM PDT
    expect(teamDay(d)).toBe("2026-10-26");
    expect(startOfTeamDay(d).toISOString()).toBe("2026-10-26T07:00:00.000Z");
    // After the clocks go back, midnight is 08:00 UTC.
    expect(startOfTeamDay(new Date("2026-11-03T20:00:00Z")).toISOString()).toBe("2026-11-03T08:00:00.000Z");
    expect(lastTeamDays(3, d)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
  });

  it("finds the next run of daily and weekly jobs in Pacific time", () => {
    const sunNight = new Date("2026-10-26T06:00:00Z"); // Sun Oct 25, 11 PM PDT
    expect(nextCronRun("0 6 * * 1-5", sunNight)?.toISOString()).toBe("2026-10-26T13:00:00.000Z"); // Mon 6 AM PDT
    expect(nextCronRun("0 8 * * 1", new Date("2026-10-26T16:00:00Z"))?.toISOString()).toBe("2026-11-02T16:00:00.000Z"); // next Mon 8 AM PST
    expect(nextCronRun("*/5 * * * *", sunNight)).toBeNull();
  });
});
