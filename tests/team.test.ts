import { inviteMember, listMembers, nameFromEmail, removeMember, renameMember, setNotify, TeamEmailSink, TeamError } from "@opengtm/core";
import { createTestCtx, type TestCtx } from "@opengtm/core/testing";
import { afterEach, describe, expect, it } from "vitest";

// The team: the people who get emailed about hot leads, replies and problems.
describe("team", () => {
  let ctx: TestCtx | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  it("adds, renames and removes people; adding again restores them", async () => {
    ctx = await createTestCtx();
    const db = ctx.db;
    const p = await inviteMember(db, "Riley.Chen@Example.com", "", "web:admin");
    expect(p).toMatchObject({ email: "riley.chen@example.com", name: "Riley Chen" });
    await renameMember(db, p.id, "Riley C.", "web:admin");
    expect((await listMembers(db)).map((m) => m.name)).toEqual(["Riley C."]);
    await removeMember(db, p.id, "web:admin");
    expect(await listMembers(db)).toHaveLength(0);
    await inviteMember(db, "riley.chen@example.com", "", "web:admin");
    expect(await listMembers(db)).toHaveLength(1);
    await expect(inviteMember(db, "not-an-email", "", "x")).rejects.toThrow("not a valid email");
    await expect(renameMember(db, p.id, "  ", "x")).rejects.toBeInstanceOf(TeamError);
  });

  it("emails each teammate only the kinds of alerts they switched on", async () => {
    ctx = await createTestCtx();
    const db = ctx.db;
    await inviteMember(db, "sam@example.com", "Sam", "x"); // defaults: hot + problems
    const riley = await inviteMember(db, "riley@example.com", "Riley", "x");
    await setNotify(db, riley.id, { hot: true, replies: true, problems: false }, "x");
    const gone = await inviteMember(db, "old@example.com", "Old", "x");
    await setNotify(db, gone.id, { hot: true, replies: true, problems: true }, "x");
    await removeMember(db, gone.id, "x");

    const sent: { to: string; subject: string; text: string }[] = [];
    const sink = new TeamEmailSink(db, async (to, subject, text) => void sent.push(...to.map((t) => ({ to: t, subject, text }))), "https://gtm.example.com/");
    await sink.send({ level: "warn", key: "hot_lead:r1", title: "Hot lead: Tiffany Hale at Lakeshore Title", body: "Said yes" });
    expect(sent.map((m) => m.to).sort()).toEqual(["riley@example.com", "sam@example.com"]);
    expect(sent[0]!.subject).toBe("🔥 Hot lead: Tiffany Hale at Lakeshore Title");
    expect(sent[0]!.text).toContain("https://gtm.example.com/inbox?status=all&c=r1");

    sent.length = 0;
    await sink.send({ level: "info", key: "reply:r2", title: "James Hart replied", body: "Not interested" });
    expect(sent.map((m) => m.to)).toEqual(["riley@example.com"]);

    // Someone can route their alerts to another inbox.
    const personal = await inviteMember(db, "jo.personal@example.net", "Jo", "x");
    await setNotify(db, personal.id, { hot: false, replies: true, problems: false }, "x", "Jo@Example.com");
    sent.length = 0;
    await sink.send({ level: "info", key: "reply:r3", title: "Ana replied", body: "?" });
    expect(sent.map((m) => m.to).sort()).toEqual(["jo@example.com", "riley@example.com"]);
    await expect(setNotify(db, personal.id, { hot: true, replies: true, problems: true }, "x", "not an email")).rejects.toBeInstanceOf(TeamError);

    sent.length = 0;
    await sink.send({ level: "critical", key: "mailbox_paused:m1", title: "Mailbox paused", body: "auth failed" });
    expect(sent.map((m) => m.to)).toEqual(["sam@example.com"]);
    expect(sent[0]!.subject).toContain("needs attention");

    sent.length = 0;
    await sink.send({ level: "info", key: "variant_proposed:x", title: "New variant", body: "" });
    expect(sent).toHaveLength(0); // routine info is not emailed
  });

  it("starts names from the email", () => {
    expect(nameFromEmail("dana.whitfield@x.com")).toBe("Dana Whitfield");
    expect(nameFromEmail("jsmith42@example.com")).toBe("Jsmith42");
    expect(nameFromEmail("alex_rivera@outbound-example.org")).toBe("Alex Rivera");
  });
});
