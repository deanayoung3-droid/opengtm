import { replyEmail, replyGist } from "@opengtm/core";
import { describe, expect, it } from "vitest";

// The email a teammate gets when a lead replies: their words only, what we did, and one button.
describe("reply alert email", () => {
  const rosa = "Yes!\n\n[image: Delgado & Park] <https://www.delgadopark.example>\nRosa Delgado\nOwner\nPhoenix - Tucson <https://delgadopark.example/locations>\nrosa@delgadopark.example\n+1 (555) 014-8526 <+15550148526>\nNOTICE: This email is confidential.";

  it("keeps only what they wrote, not the signature block", () => {
    expect(replyGist(rosa, { first: "Rosa", last: "Delgado" })).toBe("Yes!");
    expect(replyGist("Do you integrate with QuickBooks?\nAlso what does it cost?\n\nThanks,\nMark\n555-010-0005", { first: "Mark" })).toBe("Do you integrate with QuickBooks?\nAlso what does it cost?");
    expect(replyGist("Thanks!")).toBe("Thanks!");
  });

  it("puts their words in the subject and the drafted answer in the body", () => {
    const m = replyEmail({
      person: { firstName: "Rosa", lastName: "Delgado", title: "Owner", email: "rosa@delgadopark.example" },
      company: "Delgado & Park",
      reply: { body: rosa, label: "interested", hot: true, summary: "Said yes", draftBody: "Hi Rosa,\n\nHere's the preview.\n\nBest,\nDaniela\n\nNorthwind, 1 Main St. Reply \"stop\" and I won't email again.", autoSendAt: null },
      link: "https://gtm.example/inbox?c=1",
    });
    expect(m.subject).toBe("🔥 Rosa Delgado at Delgado & Park replied: “Yes!”");
    expect(m.html).toContain("Delgado &amp; Park just replied");
    expect(m.html).toContain("Here&#39;s the preview.");
    expect(m.html).not.toContain("8526"); // no phone, links or notice from their signature
    expect(m.html).not.toContain("Reply \"stop\""); // our footer isn't repeated in the draft preview
    expect(m.html).toContain('href="https://gtm.example/inbox?c=1"');
    expect(m.text).toContain("Reply now: https://gtm.example/inbox?c=1");
    // The app's name heads it; nothing is fetched or attached.
    expect(m.html).toContain(">OpenGTM</td>");
    expect(m.inline).toEqual([]);
  });

  it("a follow-up from someone already hot says 'replied again', not a new hot lead", () => {
    const m = replyEmail({
      person: { firstName: "Morgan", lastName: "Blake", title: null, email: "m@summit.example" },
      company: "Summit Cleaning & Air",
      reply: { body: "How does reporting work?", label: "question", hot: true, summary: null, draftBody: null, autoSendAt: null },
      link: null,
      again: true,
    });
    expect(m.subject).toBe("Morgan Blake at Summit Cleaning & Air replied again: “How does reporting work?”");
    expect(m.html).toContain("Follow-up");
    expect(m.html).toContain("replied again</h1>");
  });

  it("says when a drafted answer sends by itself", () => {
    const m = replyEmail({
      person: { firstName: "Mohit", lastName: null, title: null, email: "m@ls.example" },
      company: null,
      reply: { body: "We have an in-house system.", label: "objection", hot: false, summary: "Uses in-house software", draftBody: "Hi Mohit,\n\nUnderstood.\n\nBest,\nDaniela", autoSendAt: new Date("2026-10-27T21:30:00Z") },
      link: null,
    });
    expect(m.subject).toBe("Mohit replied: “We have an in-house system.”");
    expect(m.text).toContain("Not Interested");
    expect(m.text).toContain("It sends by itself Tue 2:30 PM PT");
  });
});
