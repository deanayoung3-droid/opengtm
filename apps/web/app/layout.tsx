// Inter with its optical-size axis: titles and big numbers use the tighter display cut automatically.
import "@fontsource-variable/inter/opsz.css";
import "./globals.css";
import Link from "next/link";
import { isKillSwitchOn, messages, replies, segments, sendingBlockers } from "@opengtm/core";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { DeployWatcher } from "../components/DeployWatcher";
import { BrandTile } from "../components/BrandTile";
import { MobileNav } from "../components/MobileNav";
import { Nav } from "../components/Nav";
import { ProfileMenu, type Theme } from "../components/ProfileMenu";
import { initials, pretty } from "../components/ui";
import { APP_NAME } from "../lib/brand";
import { identity, rtReady } from "../lib/runtime";

export const metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { ctx, dryRun } = await rtReady();
  const saved = (await cookies()).get("gtm-theme")?.value;
  const theme: Theme = saved === "light" || saved === "dark" ? saved : "system";
  const signedInAs = await identity();
  const n = sql<number>`count(*)::int`;
  const [killed, [drafts], [unhandled], segRows] = await Promise.all([
    isKillSwitchOn(ctx.db),
    ctx.db
      .select({ n })
      .from(messages)
      .where(and(eq(messages.status, "draft"), inArray(messages.approvalState, ["pending", "needs_review"]))),
    ctx.db
      .select({ n })
      .from(replies)
      .where(or(eq(replies.handled, false), eq(replies.draftState, "pending"))),
    ctx.db.select({ id: segments.id, status: segments.status }).from(segments),
  ]);
  const paused = new Set(segRows.filter((r) => r.status === "paused").map((r) => r.id));
  const blockers = sendingBlockers(ctx.config);

  const status = killed
    ? {
        dot: "off",
        title: "Sending stopped",
        hint: "Kill switch is on. Nothing goes out.",
      }
    : blockers.length
      ? {
          dot: "warn",
          title: "Not sending yet",
          hint: `Add the ${blockers.map((b) => b.field.replace("company.", "").replaceAll("_", " ")).join(" and ")} on Project docs.`,
        }
      : dryRun
        ? {
            dot: "idle",
            title: "Dry run",
            hint: "Fake mailboxes and mock data.",
          }
        : {
            dot: "",
            title: "Sending live",
            hint: "Within caps and business hours.",
          };

  return (
    <html lang="en" data-theme={theme === "system" ? undefined : theme}>
      <body>
        <div className="shell">
          <MobileNav label={APP_NAME} />
          <aside className="sidebar">
            <div className="switcher">
              <Link href="/" className="switcher-btn">
                <BrandTile size={30} className="brand-tile" />
                <span className="switcher-text">
                  <span className="brand-name">{APP_NAME}</span>
                  <span className="brand-sub">{ctx.config.business.company.name}</span>
                </span>
              </Link>
            </div>
            <Nav
              groups={[
                {
                  label: "Mailbox",
                  items: [
                    { href: "/", label: "Dashboard", icon: "gauge" },
                    {
                      href: "/approvals",
                      label: "Approvals",
                      icon: "approvals",
                      count: drafts?.n,
                      hot: true,
                    },
                    {
                      href: "/inbox",
                      label: "Inbox",
                      icon: "inbox",
                      count: unhandled?.n,
                      hot: true,
                    },
                    { href: "/inbox?status=sent", label: "Sent", icon: "send" },
                  ],
                },
                {
                  label: "Setup",
                  collapsible: { open: true },
                  items: [
                    { href: "/project", label: "Project docs", icon: "book" },
                    {
                      href: "/sequence",
                      label: "Email sequence",
                      icon: "mail",
                    },
                    { href: "/schedule", label: "Schedule", icon: "calendar" },
                    {
                      href: "/campaigns",
                      label: "Targeting",
                      icon: "crosshair",
                    },
                    { href: "/leads", label: "Leads", icon: "users" },
                    { href: "/mailboxes", label: "Channels", icon: "globe" },
                    {
                      href: "/suppress",
                      label: "Suppress list",
                      icon: "upload",
                    },
                    { href: "/team", label: "Team", icon: "user" },
                    { href: "/settings", label: "Settings", icon: "settings" },
                  ],
                },
                {
                  label: "Campaigns",
                  collapsible: {
                    open: false,
                    summary: `${ctx.config.business.icp.segments.filter((sg) => !paused.has(sg.id)).length} live`,
                  },
                  items: [
                    ...ctx.config.business.icp.segments.map((sg) => ({
                      href: `/campaigns#${sg.id}`,
                      label: pretty(sg.id),
                      icon: "campaigns" as const,
                      dot: paused.has(sg.id) ? ("off" as const) : ("on" as const),
                    })),
                    {
                      href: "/campaigns#new",
                      label: "New campaign",
                      icon: "plus" as const,
                    },
                  ],
                },
              ]}
            />
            <div className="sidebar-foot">
              <Link href={blockers.length && !killed ? "/project" : "/settings"} className="status-card">
                <div className="line">
                  <span className={`dot ${status.dot}`} />
                  {status.title}
                </div>
                <div className="hint">{status.hint}</div>
              </Link>
              <ProfileMenu
                name={signedInAs}
                email="Dashboard login"
                initials={initials(signedInAs)}
                theme={theme}
                links={[
                  { href: "/team", label: "Team", icon: "user" },
                  { href: "/settings#notifications", label: "Email alerts", icon: "bell" },
                  { href: "/settings", label: "Workspace settings", icon: "settings" },
                ]}
              />
            </div>
          </aside>
          <div className="workspace">
            <main className="panel">
              <div className="panel-body">
                <div className="panel-inner">{children}</div>
              </div>
            </main>
            <DeployWatcher />
          </div>
        </div>
      </body>
    </html>
  );
}
