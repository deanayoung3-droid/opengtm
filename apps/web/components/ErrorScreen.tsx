"use client";

import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useEffect } from "react";
import { AppMark } from "./Icon";

const RELOADED_AT = "gtm:stale-reload";

/** The page was opened before a redeploy, so the button it pressed no longer exists on the server. */
function isStale(error: Error): boolean {
  const message = String((error as { message?: unknown }).message ?? "");
  return unstable_isUnrecognizedActionError(error) || /Server Action .* was not found|Failed to find Server Action|older or newer deployment/i.test(message);
}

/**
 * Shared by app/error.tsx and app/global-error.tsx. A stale page reloads itself once (a reload
 * picks up the new build, then saving works); anything else gets a plain explanation and buttons.
 */
export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = isStale(error);
  useEffect(() => {
    if (!stale) return;
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
      sessionStorage.setItem(RELOADED_AT, String(Date.now()));
    } catch {}
    // Guard against a reload loop if something else is wrong.
    if (Date.now() - last > 30_000) location.reload();
  }, [stale]);

  return (
    <div className="gate">
      <div className="card gate-card rise">
        <span className="brand-mark">
          <AppMark />
        </span>
        <h1>{stale ? "The app was just updated" : "Something went wrong"}</h1>
        <p className="muted">
          {stale
            ? "This page was opened before the update, so that click didn't go through. Reloading picks up the new version; then do it again."
            : "That didn't work. Try again, and if it keeps happening, reload the page."}
          {error.digest && !stale ? <span className="small"> Reference: {error.digest}</span> : null}
        </p>
        <div className="row">
          <button className="primary" type="button" onClick={() => location.reload()}>
            Reload page
          </button>
          {!stale && (
            <button type="button" onClick={reset}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
