"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { Segmented } from "./Segmented";

export type Theme = "system" | "light" | "dark";
const THEMES: { id: Theme; label: string; icon: IconName }[] = [
  { id: "system", label: "System", icon: "monitor" },
  { id: "light", label: "Light", icon: "sun" },
  { id: "dark", label: "Dark", icon: "moon" },
];

/** The theme is a cookie, so the server renders the right colors on the first paint. "System" follows the computer's setting. */
function saveTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
  document.cookie = t === "system" ? "gtm-theme=; path=/; max-age=0" : `gtm-theme=${t}; path=/; max-age=31536000; samesite=lax`;
}

/** Bottom-left account menu: who you are, theme, your own settings, sign out. Workspace settings stay in Settings. */
export function ProfileMenu({ name, email, initials, theme, links }: { name: string; email: string; initials: string; theme: Theme; links: { href: string; label: string; icon: IconName; external?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Theme>(theme);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="profile-menu" ref={ref}>
      {open && (
        <div className="profile-pop" role="menu">
          <div className="profile-pop-head">
            <b>{name}</b>
            <span>{email}</span>
          </div>
          <div className="profile-pop-label">Theme</div>
          <Segmented className="theme-switch" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={current === t.id}
                className={current === t.id ? "on" : ""}
                onClick={() => {
                  saveTheme(t.id);
                  setCurrent(t.id);
                }}
              >
                <Icon name={t.icon} size={14} /> {t.label}
              </button>
            ))}
          </Segmented>
          <div className="profile-pop-links">
            {links.map((l) =>
              l.external ? (
                <a key={l.href} href={l.href} role="menuitem">
                  <Icon name={l.icon} size={15} /> {l.label}
                </a>
              ) : (
                <Link key={l.href} href={l.href} role="menuitem" onClick={() => setOpen(false)}>
                  <Icon name={l.icon} size={15} /> {l.label}
                </Link>
              ),
            )}
          </div>
        </div>
      )}
      <button type="button" className="me-chip" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        <span className="avatar">{initials}</span>
        <span className="me-text">
          <span className="me-name">{name}</span>
          {name !== email && <span className="me-mail">{email}</span>}
        </span>
        <Icon name="chevron" size={14} className="me-caret" />
      </button>
    </div>
  );
}
