import Link from "next/link";
import { Icon, type IconName } from "./Icon";

/** Sticky page bar: icon + breadcrumb on the left, actions on the right. */
export function PageHeader({ icon, title, parent, actions }: { icon: IconName; title: React.ReactNode; parent?: { href: string; label: string }; actions?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div className="crumb">
        <span className="crumb-ico">
          <Icon name={icon} size={15} />
        </span>
        {parent && (
          <>
            <Link href={parent.href}>{parent.label}</Link>
            <span className="sep">/</span>
          </>
        )}
        <span>{title}</span>
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/** Large title with a one-line explanation under the page bar. */
export function PageTitle({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="page-title">
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Section({ id, title, count, sub, actions, children }: { id?: string; title: React.ReactNode; count?: number; sub?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="section" id={id}>
      <div className="section-head">
        <h2>{title}</h2>
        {count !== undefined && <span className="count">{count}</span>}
        {actions && <div className="actions">{actions}</div>}
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ icon = "check", title, children }: { icon?: IconName; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="icon">
        <Icon name={icon} size={18} />
      </div>
      <div className="title">{title}</div>
      {children && <div className="text">{children}</div>}
    </div>
  );
}

const NOTICE_ICON: Record<string, IconName> = { warn: "alert", bad: "alert", info: "info", good: "check" };

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "good"; children: React.ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === "bad" || tone === "warn" ? "alert" : "status"}>
      <Icon name={NOTICE_ICON[tone]!} />
      <div>{children}</div>
    </div>
  );
}

/** ?ok= and ?error= messages that server actions redirect back with. */
export function Flash({ ok, error }: { ok?: string; error?: string }) {
  return (
    <>
      {error && <Notice tone="warn">{error}</Notice>}
      {ok && <Notice tone="good">{ok}</Notice>}
    </>
  );
}

export function Metric({ icon, label, value, sub, href, tone, meter }: { icon: IconName; label: string; value: React.ReactNode; sub?: React.ReactNode; href?: string; tone?: "warn" | "brand"; meter?: { value: number; max: number } }) {
  const ratio = meter && meter.max > 0 ? Math.min(1, meter.value / meter.max) : 0;
  const body = (
    <>
      <span className="metric-ico">
        <Icon name={icon} size={18} />
      </span>
      <div className="metric-body">
        <div className="label">
          {label}
          {href && <Icon name="arrow" size={14} className="go" />}
        </div>
        <div className={`value${tone ? ` ${tone}` : ""}`}>{value}</div>
        {meter && (
          <div className={`meter${ratio >= 1 ? " bad" : ratio >= 0.8 ? " warn" : ""}`}>
            <span style={{ width: `${Math.round(ratio * 100)}%` }} />
          </div>
        )}
        {sub && <div className="sub">{sub}</div>}
      </div>
    </>
  );
  return href ? (
    <Link href={href} className="card metric">
      {body}
    </Link>
  ) : (
    <div className="card metric">{body}</div>
  );
}

export function initials(nameOrEmail: string): string {
  const parts = nameOrEmail.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function Person({ name, meta }: { name: string; meta?: React.ReactNode }) {
  return (
    <div className="person">
      <div className="avatar">{initials(name)}</div>
      <div>
        <div className="name">{name}</div>
        {meta && <div className="meta">{meta}</div>}
      </div>
    </div>
  );
}

/** "solo_small_family" -> "Solo small family" for display. */
export const pretty = (s: string | null | undefined) =>
  s ? s.split("_").map((w, i) => (w.length <= 2 && i > 0 ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ") : "-";

const TONE: Record<string, string> = {
  active: "good", verified: "good", enrolled: "good", sent: "good", inbox: "good", qualified: "good", researched: "good", interested: "good", question: "good", won: "good", held: "good", booked: "accent",
  paused: "warn", warming: "info", needs_review: "warn", proposed: "accent", objection: "warn", new: "info", hot: "accent", referral: "accent", research_failed: "warn",
  suppressed: "bad", bounced: "bad", spam: "bad", hostile: "bad", unsubscribe: "bad", bounce: "bad",
};

/** Status badge with a consistent color for each known state. */
export function Badge({ value, tone, dot }: { value: string | null | undefined; tone?: string; dot?: boolean }) {
  const v = value ?? "unknown";
  return <span className={`chip ${tone ?? TONE[v] ?? ""}${dot ? " dotted" : ""}`}>{pretty(v)}</span>;
}
