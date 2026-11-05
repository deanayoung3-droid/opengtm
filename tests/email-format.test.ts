import { checkCompliance, composeBody, emailHtml, stripFooter, tidyBody } from "@opengtm/writer";
import { buildMime } from "@opengtm/sequencer";
import { simpleParser } from "mailparser";
import { testConfig } from "@opengtm/core/testing";
import { describe, expect, it } from "vitest";

/** A 1x1 PNG standing in for a company logo (config/business.yaml company.logo). */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const withLogos = () => ({ ...testConfig(), logos: { light: PNG, dark: PNG } });

// What a lead sees: a greeting line, short paragraphs, plain punctuation, then "Best," and the footer.
describe("email format", () => {
  it("puts the greeting on its own line, separates paragraphs and drops em dashes", () => {
    const raw = "Hi Timothy, I saw Ferraro Roofing focuses on roofing.\nHow are you handling scheduling today—and would a free preview help? Just reply \"yes\".";
    expect(tidyBody(raw)).toBe('Hi Timothy,\n\nI saw Ferraro Roofing focuses on roofing.\n\nHow are you handling scheduling today, and would a free preview help? Just reply "yes".');
    expect(tidyBody("Hi Ana,\n\nOpen 9–5 on weekdays.")).toBe("Hi Ana,\n\nOpen 9–5 on weekdays."); // ranges keep their dash
  });

  it("signs off like a person and keeps the address and opt-out", () => {
    const cfg = testConfig();
    const co = cfg.business.company.name;
    const full = composeBody("Hi Ana,\n\nWould a preview help?", cfg, { name: "Daniela" });
    // "Best, <first name>", the mailbox's signature, then one line with our address and the opt-out.
    expect(full).toBe(`Hi Ana,\n\nWould a preview help?\n\nBest,\nDaniela\n\n--\nDaniela\n${co}\n\n${co}, ${cfg.business.company.physical_address}. Reply "stop" and I won't email again.`);
    expect(checkCompliance(full, cfg, { name: "Daniela" })).toEqual([]);
    expect(stripFooter(full)).toBe("Hi Ana,\n\nWould a preview help?");
  });

  it("signs with the mailbox's name, title and phone, and shows the company logo in the HTML part", async () => {
    const cfg = withLogos();
    const co = cfg.business.company.name;
    const sender = { name: "Alex Reed", title: "Partnerships", phone: "+1 (555) 010-0199" };
    const full = composeBody("Hi Ana,\n\nWould a preview help?", cfg, sender);
    expect(full).toContain(`\n\nBest,\nAlex\n\n--\nAlex Reed\nPartnerships | C: +1 (555) 010-0199\n${co}\n\n`);
    expect(checkCompliance(full, cfg, sender)).toEqual([]);

    const rich = emailHtml(full, sender, cfg)!;
    expect(rich.html).toContain("font-weight:bold");
    expect(rich.html).toContain(">Alex Reed<");
    expect(rich.html).toContain('Partnerships | C: <a href="tel:+15550100199"');
    expect(rich.html).toContain('src="cid:brand-logo"');
    expect(rich.html).toContain('src="cid:brand-logo-dark"');
    expect(rich.html).toContain(cfg.business.company.physical_address);
    expect(rich.html).not.toMatch(/https?:\/\//); // no remote images, no tracking
    expect(rich.html).toContain('<meta name="color-scheme" content="light dark">');

    const mime = (
      await buildMime({ from: { name: "Alex Reed", address: "alex@outreach.example" }, replyTo: "alex@outreach.example", to: "ana@company.example", subject: "Hi", text: full, html: rich.html, inline: rich.inline, messageId: "<1@x>", listUnsubscribe: { mailto: "mailto:alex@outreach.example?subject=unsubscribe" } })
    ).toString("utf8");
    expect(mime).toMatch(/multipart\/related/);
    expect(mime).toMatch(/Content-Type: text\/plain/);
    expect(mime).toMatch(/Content-Id: <brand-logo>/i);
    expect(mime).toMatch(/Content-Disposition: inline/);

    // Read back the way a mail client does: the HTML's logo reference resolves to the attached PNG.
    const parsed = await simpleParser(mime);
    const logo = parsed.attachments.find((x) => x.cid === "brand-logo");
    expect(logo?.contentType).toBe("image/png");
    expect(logo!.content.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(String(parsed.html)).toMatch(new RegExp(`<img class="brand-logo-light" src="data:image/png;base64,iVBORw0KGgo[^"]+" alt="${co}"`));

    // A draft written before signatures existed still sends, as plain text.
    expect(emailHtml(`Hi Ana,\n\nOld?\n\nBest,\nDaniela\n\n${co}. Reply "stop" and I won't email again.`, sender, cfg)).toBeNull();
  });

  it("without a logo, the signature has no image and nothing is attached", () => {
    const cfg = testConfig();
    const sender = { name: "Alex Reed" };
    const rich = emailHtml(composeBody("Hi Ana,\n\nWould a preview help?", cfg, sender), sender, cfg)!;
    expect(rich.html).not.toContain("<img");
    expect(rich.inline).toEqual([]);
  });

  it("makes the booking link and our own site clickable in a reply, but never an email address", () => {
    const cfg = testConfig((raw) => (raw.business.company.site = "https://www.northwind.example.com"));
    const sender = { name: "Kelsey" };
    const body = composeBody(
      "Hi David,\n\nHere's the video, and more on northwind.example.com's home page.\n\nPick a time here:\n\nhttps://cal.example.com/northwind/intro\n\nOr write to sam@northwind.example.com.",
      cfg,
      sender,
    );
    const html = emailHtml(body, sender, cfg)!.html;
    expect(html).toContain(`<a href="https://northwind.example.com" style="color:#1a73e8">northwind.example.com</a>'s home page`);
    expect(html).toContain('<a href="https://cal.example.com/northwind/intro" style="color:#1a73e8">https://cal.example.com/northwind/intro</a>');
    expect(html).toContain("sam@northwind.example.com");
    expect(html.match(/<a href/g)).toHaveLength(2);
    // A cold email has no links, so its HTML has none either.
    const cold = emailHtml(composeBody('Hi Ana,\n\nWant a quick look? Just reply "yes".', cfg, sender), sender, cfg)!.html;
    expect(cold).not.toContain("<a href");
  });
});
