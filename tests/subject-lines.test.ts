import { checkSubject } from "@opengtm/writer";
import { testConfig } from "@opengtm/core/testing";
import { expect, it } from "vitest";

// Version B subjects are used exactly as written, so each one must pass the same checks as a written subject.
it("version B subjects pass the subject checks; misleading ones don't", () => {
  const c = testConfig();
  for (const s of [...c.business.outreach.subject_lines_b, "your scheduler is overcharging you", "fire your whiteboard", "hot take: dispatch should be easy"]) {
    expect(checkSubject(s, c.business.company.banned_claims), s).toEqual([]);
  }
  for (const s of ["Re: your invoice", "Fwd: our call"]) expect(checkSubject(s, c.business.company.banned_claims).length, s).toBeGreaterThan(0);
});
