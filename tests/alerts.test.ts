import { DAY, HOUR } from "@opengtm/core";
import { createTestCtx, type TestCtx } from "@opengtm/core/testing";
import { afterEach, describe, expect, it } from "vitest";

describe("alerts", () => {
  let ctx: TestCtx;
  afterEach(async () => ctx?.close());

  it("repeats an alert at most once an hour, or once a day when it asks to stay quiet longer", async () => {
    ctx = await createTestCtx();
    const hourly = { level: "warn" as const, key: "x", title: "X", body: "" };
    const daily = { level: "critical" as const, key: "job_failing:send", title: "Worker job failing: send", body: "", quietMs: DAY };
    const sent = (key: string) => ctx.sink.alerts.filter((a) => a.key === key).length;

    await ctx.alerts.notify(hourly);
    await ctx.alerts.notify(daily);
    ctx.clock.advance(30 * 60_000);
    await ctx.alerts.notify(hourly);
    await ctx.alerts.notify(daily);
    expect([sent("x"), sent("job_failing:send")]).toEqual([1, 1]);

    // A job broken all night: the hourly kind would have emailed every hour, the daily kind waits a day.
    for (let h = 0; h < 10; h++) {
      ctx.clock.advance(HOUR);
      await ctx.alerts.notify(hourly);
      await ctx.alerts.notify(daily);
    }
    expect(sent("job_failing:send")).toBe(1);
    expect(sent("x")).toBeGreaterThan(5);

    ctx.clock.advance(DAY);
    await ctx.alerts.notify(daily);
    expect(sent("job_failing:send")).toBe(2);
  });
});
