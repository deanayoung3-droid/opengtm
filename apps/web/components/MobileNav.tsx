"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";

/**
 * Phones: a slim top bar whose menu button slides the full sidebar in as a drawer (the sidebar itself is
 * unchanged; CSS moves it off screen below 860px). Closes on navigation, a tap outside, or Escape.
 */
export function MobileNav({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    const root = document.documentElement;
    if (!open) {
      delete root.dataset.navOpen;
      return;
    }
    root.dataset.navOpen = "";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // Links to a section of the same page (/settings#team) don't change the path, so close on any link tap.
    const onClick = (e: MouseEvent) => (e.target as Element | null)?.closest(".sidebar a") && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      delete root.dataset.navOpen;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open]);

  return (
    <>
      <header className="mobile-bar">
        <Link href="/" className="mobile-brand" aria-label={`${label} home`}>
          <span className="app-tile">
            <Icon name="gtm" size={16} />
          </span>
          <span>{label}</span>
        </Link>
        <button type="button" className="mobile-menu" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? "x" : "menu"} size={20} />
        </button>
      </header>
      <div className="nav-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
    </>
  );
}
