"use client";

import "@fontsource-variable/inter";
import "./globals.css";
import { ErrorScreen } from "../components/ErrorScreen";

// Used when the root layout itself fails; it replaces the whole page, so it brings its own <html>.
export default function GlobalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <ErrorScreen {...props} />
      </body>
    </html>
  );
}
