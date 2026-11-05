import { savingsByDay, savingsDays } from "@opengtm/core";
import { describe, expect, it } from "vitest";

// "Total saved": the replaced plans' price for what we sent, minus what we actually paid.
describe("savings vs the plans we'd otherwise pay for", () => {
  const engine = {
    savings: {
      replaces: [{ name: "OtherTool", plan: "Classic", per_email_usd: 0.04, monthly_usd: 0 }],
      our_fixed: [{ name: "Mailboxes", monthly_usd: 30 }],
      since: "2026-10-23",
    },
  };

  it("counts metered spend and a daily share of fixed costs against the other plan's price", () => {
    const s = savingsByDay(engine, [100, 0, 50], [0.5, 0, 0.25]);
    expect(s.theirs).toEqual([4, 0, 2]);
    expect(s.ours).toEqual([1.5, 1, 1.25]); // $30/month = $1 a day of mailboxes
    expect(s.saved).toEqual([2.5, -1, 0.75]);
    expect(s.total).toEqual({ theirs: 6, ours: 3.75, saved: 2.25, emails: 150 });
    expect(s.compareTo).toBe("OtherTool");
    expect(s.vendors).toEqual([{ name: "OtherTool", plan: "Classic", total: 6 }]);
  });

  it("adds up every replaced plan, including monthly fees", () => {
    const two = { savings: { ...engine.savings, replaces: [...engine.savings.replaces, { name: "Smartlead", plan: "Basic", per_email_usd: 0, monthly_usd: 30 }] } };
    const s = savingsByDay(two, [100], [0]);
    expect(s.compareTo).toBe("OtherTool + Smartlead");
    expect(s.total.theirs).toBe(5); // $4 of emails + $1/day of the monthly plan
    expect(s.total.saved).toBe(4);
  });

  it("is honestly negative before anything is sent, and counts days from the start date", () => {
    expect(savingsByDay(engine, [0, 0], [0, 0]).total.saved).toBe(-2);
    expect(savingsDays(engine, new Date("2026-10-25T15:00:00Z"))).toEqual(["2026-10-23", "2026-10-24", "2026-10-25"]);
    // No fixed costs are charged for days before we started.
    expect(savingsByDay(engine, [0, 0, 0], [0, 0, 0], ["2026-10-21", "2026-10-22", "2026-10-23"]).total.ours).toBe(1);
  });
});
