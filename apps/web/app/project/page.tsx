import { ConfirmButton } from "../../components/ConfirmButton";
import { Flash, PageHeader, PageTitle, Section } from "../../components/ui";
import { rtReady } from "../../lib/runtime";
import { saveProjectDocsAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Project docs" };

function Field({ label, name, value, hint, area, tall, full, placeholder }: { label: string; name: string; value: string; hint?: string; area?: boolean; tall?: boolean; full?: boolean; placeholder?: string }) {
  return (
    <label className={`field${full ? " full" : ""}`}>
      <span>{label}</span>
      {area ? <textarea name={name} defaultValue={value} className={tall ? "tall" : ""} placeholder={placeholder} /> : <input name={name} defaultValue={value} placeholder={placeholder} />}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export default async function ProjectDocs({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await rtReady();
  const c = ctx.config.business;
  const co = c.company;

  return (
    <>
      <PageHeader icon="file" title="Project docs" />
      <PageTitle title="Project docs">Everything the agent knows about your company. Every email, follow-up and reply draft is written from this page, and changes apply to the next draft.</PageTitle>
      <Flash ok={sp.ok} error={sp.error} />

      <form action={saveProjectDocsAction}>
        <Section title="Company" sub="Who we are and what we offer.">
          <div className="card">
            <div className="form-grid">
              <Field label="Company name" name="name" value={co.name} />
              <Field label="Website" name="site" value={co.site} />
              <Field label="What you do (one line)" name="one_liner" value={co.one_liner} area full />
              <Field label="Why it exists" name="thesis" value={co.thesis} area full hint="The problem you solve, in plain words." />
              <Field label="The offer in every email" name="offer" value={co.offer} full hint={`What "just reply yes" gets them, e.g. a 2-minute video of the product.`} />
              <Field label="Booking link" name="booking_link" value={co.booking_link} hint="Books a call with the founders. Only replies to people who wrote back use it; the first email and the follow-up never have a link." />
              <Field label="Pricing" name="pricing" value={co.pricing} hint="Reply drafts use this to answer price questions." />
              <Field label="Postal address" name="physical_address" value={co.physical_address} full placeholder="Required by law in every email: street, city, state, ZIP" hint={co.physical_address ? undefined : "Sending is blocked until this is filled in."} />
            </div>
          </div>
        </Section>

        <Section title="Proof and limits" sub="The only specific claims emails may make, and what they must never say.">
          <div className="card">
            <div className="form-grid">
              <Field label="Proof points (one per line)" name="proof_points" value={ctx.config.proofPoints.map((p) => p.text).join("\n")} area tall full hint="True, specific facts about your company. Emails cite these; anything else gets rejected by the checker." />
              <Field label="Strengths (one per line)" name="strengths" value={co.strengths.join("\n")} area />
              <Field label="Never say (one per line)" name="banned_claims" value={co.banned_claims.join("\n")} area placeholder="e.g. guaranteed savings" />
            </div>
          </div>
        </Section>

        <Section title="Competitors" sub="Tools these companies may already use. Emails can name them as alternatives, never make claims about them.">
          <div className="card">
            <Field label="Competitors (comma or one per line)" name="competitors" value={c.competitors.join(", ")} area full />
          </div>
        </Section>

        <Section title="Reply facts" sub="What auto-drafted replies may use to answer questions: capabilities, integrations, trial terms, anything a prospect asks.">
          <div className="card">
            <Field label="Facts" name="facts" value={c.facts} area tall full />
          </div>
        </Section>

        <Section title="Replies" sub="When someone says yes, the drafted reply sends the free preview and offers a call they book at the booking link. A real person is copied on every reply we send.">
          <div className="card">
            <Field label="Call we offer" name="demo_offer" value={c.outreach.demo_offer} full hint="What hot-lead replies offer after the preview, booked at the booking link, e.g. a call with our founders." />
            <Field label="Cc on every reply" name="reply_cc" value={c.outreach.reply_cc.join(", ")} full hint="Comma-separated email addresses." />
          </div>
        </Section>

        <div className="save-bar">
          <span className="muted small">Saved values override config/business.yaml.</span>
          <ConfirmButton className="primary">Save project docs</ConfirmButton>
        </div>
      </form>
    </>
  );
}
