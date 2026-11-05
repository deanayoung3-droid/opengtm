"use client";

import { useEffect, useState } from "react";

const BUILD = process.env.APP_BUILD ?? "";
const EVERY_MS = 60_000;

/** True while someone is mid-edit: a focused field, or a form whose fields differ from how they loaded. */
function busy(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  for (const f of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))) {
    if (f.type === "hidden" || f.type === "submit") continue;
    const changed = f instanceof HTMLInputElement && (f.type === "checkbox" || f.type === "radio") ? f.checked !== f.defaultChecked : f.value !== f.defaultValue;
    if (changed) return true;
  }
  return false;
}

/**
 * After a redeploy, a page from the old build can't save. Notice the new build (on focus and every
 * minute), reload quietly when nobody is typing, and otherwise ask with a small bar.
 */
export function DeployWatcher() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!BUILD) return;
    let done = false;
    const check = async () => {
      if (done || document.visibilityState !== "visible") return;
      try {
        const r = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
        if (!r.ok) return;
        const { build } = (await r.json()) as { build?: string };
        if (!build || build === BUILD) return;
        done = true;
        if (busy()) setStale(true);
        else location.reload();
      } catch {
        // Offline or the sign-in expired; try again later.
      }
    };
    const t = setInterval(check, EVERY_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);
  if (!stale) return null;
  return (
    <div className="update-bar rise" role="status">
      <span>The app was just updated. Reload to keep saving (copy anything you typed first).</span>
      <button className="sm primary" type="button" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}
