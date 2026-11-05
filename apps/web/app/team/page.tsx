import { listMembers } from "@opengtm/core";
import { ConfirmButton } from "../../components/ConfirmButton";
import { Icon } from "../../components/Icon";
import { Flash, initials, PageHeader, PageTitle, Section } from "../../components/ui";
import { rtReady } from "../../lib/runtime";
import { inviteMemberAction, removeMemberAction, renameMemberAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team" };

/**
 * The people who hear about hot leads, replies and problems. Everyone shares the one dashboard login
 * (DASHBOARD_USER / DASHBOARD_PASSWORD); this list is who gets emailed, set per person in Settings.
 */
export default async function Team({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await rtReady();
  const members = await listMembers(ctx.db);

  return (
    <>
      <PageHeader icon="user" title="Team" />
      <PageTitle title="Team">
        The people who get emails about hot leads, replies and problems. Everyone uses the same dashboard login; add teammates here, then choose what each person hears about in Settings.
      </PageTitle>
      <Flash ok={sp.ok} error={sp.error} />

      <Section title="Add a teammate" sub="They'll get the emails they're switched on for in Settings, each with a link back to the conversation.">
        <form action={inviteMemberAction} className="card invite-row">
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" required placeholder="name@yourcompany.com" />
          </label>
          <label className="field">
            <span>Name</span>
            <input name="name" placeholder="Optional, e.g. Sam Rivera" />
          </label>
          <ConfirmButton className="primary">
            <Icon name="plus" size={14} /> Add
          </ConfirmButton>
        </form>
      </Section>

      <Section title="People" count={members.length}>
        <div className="card flush member-list">
          {members.map((m) => (
            <div key={m.id} className="member">
              <span className="avatar">{initials(m.name || m.email)}</span>
              <form action={renameMemberAction} className="member-name">
                <input type="hidden" name="id" value={m.id} />
                <input name="name" defaultValue={m.name} aria-label={`Name for ${m.email}`} placeholder="Add a name" />
                <button className="sm ghost" type="submit">
                  Save
                </button>
              </form>
              <span className="member-mail">{m.email}</span>
              <span className="small muted member-seen" />
              <form action={removeMemberAction}>
                <input type="hidden" name="id" value={m.id} />
                <ConfirmButton className="sm ghost" confirm={`Remove ${m.name || m.email}? They'll stop getting emails.`}>
                  Remove
                </ConfirmButton>
              </form>
            </div>
          ))}
          {members.length === 0 && <div className="member muted">Nobody yet. Add yourself above to get an email when a lead says yes.</div>}
        </div>
      </Section>
    </>
  );
}
