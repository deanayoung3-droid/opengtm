"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  count?: number;
  hot?: boolean;
  /** Campaign entries show a status dot instead of an icon (green = running). */
  dot?: "on" | "off";
}

export interface NavGroup {
  label: string;
  items: NavItem[];
  /** Folds into a dropdown; `open` is how it starts the first time (then it remembers). */
  collapsible?: { open: boolean; summary?: string };
}

const STORE = "gtm:nav-open";

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Sidebar navigation; highlights the section the current page belongs to. */
export function Nav({ groups }: { groups: NavGroup[] }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : !href.includes("#") && (path === href || path.startsWith(`${href}/`)));
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(groups.map((g) => [g.label, g.collapsible?.open ?? true])));
  useEffect(() => setOpen((o) => ({ ...o, ...readOpen() })), []);
  const toggle = (label: string) =>
    setOpen((o) => {
      const next = { ...o, [label]: !o[label] };
      try {
        localStorage.setItem(STORE, JSON.stringify(next));
      } catch {}
      return next;
    });

  // One white chip glides to the active row; it jumps without animating on first paint and while a group folds.
  const box = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLSpanElement>(null);
  const [glide, setGlide] = useState<"instant" | "on" | undefined>(undefined);
  const openKey = groups.map((g) => (open[g.label] ? 1 : 0)).join("");
  useLayoutEffect(() => {
    const el = box.current;
    const c = chip.current;
    if (!el || !c) return;
    let raf = 0;
    const place = (instant: boolean) => {
      const on = el.querySelector<HTMLElement>(".nav a.on");
      if (!on || on.closest(".nav-fold[aria-hidden='true']")) return setGlide(undefined);
      c.style.transform = `translateY(${on.offsetTop}px)`;
      c.style.height = `${on.offsetHeight}px`;
      if (instant || el.dataset.glide === undefined) {
        setGlide("instant");
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => setGlide("on"))));
      }
    };
    place(false);
    const ro = new ResizeObserver(() => place(true));
    el.querySelectorAll(".nav-fold > div").forEach((f) => ro.observe(f));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [path, openKey]);

  return (
    <div className="nav-groups" ref={box} data-glide={glide}>
      <span className="nav-glide" ref={chip} aria-hidden />
      {groups.map((g) => {
        // A folded group still opens when you're on one of its pages.
        const isOpen = !g.collapsible || open[g.label] || g.items.some((i) => active(i.href));
        const links = (
          <nav className="nav">
            {g.items.map((i) => (
              <Link key={i.href} href={i.href} className={active(i.href) ? "on" : ""} aria-current={active(i.href) ? "page" : undefined} tabIndex={isOpen ? undefined : -1}>
                {i.dot ? <span className={`nav-dot ${i.dot}`} /> : <Icon name={i.icon} />}
                {i.label}
                {i.count ? <span className={`count${i.hot ? " hot" : ""}`}>{i.count}</span> : null}
              </Link>
            ))}
          </nav>
        );
        if (!g.collapsible) {
          return (
            <div key={g.label} className="nav-group">
              <div className="nav-label">{g.label}</div>
              {links}
            </div>
          );
        }
        return (
          <div key={g.label} className={`nav-group fold${isOpen ? " open" : ""}`}>
            <button type="button" className="nav-label nav-toggle" aria-expanded={isOpen} onClick={() => toggle(g.label)}>
              <span>{g.label}</span>
              {g.collapsible.summary && <span className="nav-sum">{g.collapsible.summary}</span>}
              <Icon name="chevron" size={14} className="nav-chev" />
            </button>
            <div className="nav-fold" aria-hidden={!isOpen}>
              <div>{links}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
