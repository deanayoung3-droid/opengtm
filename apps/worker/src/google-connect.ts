/**
 * One-time Google sign-in for a sending mailbox, run on a laptop (not the server):
 *   pnpm gtm connect-google you@sendingdomain.com --client-id ... --client-secret ... --creds MB1
 * Opens Google's consent page for that mailbox, catches the redirect on 127.0.0.1, swaps the code
 * for a refresh token and prints the MBn_GOOGLE_* settings to paste into .env. The token lets the
 * engine send (gmail.send) and read replies and bounces (gmail.readonly); nothing else.
 */
import { createServer } from "node:http";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];

export function googleAuthUrl(o: { clientId: string; redirectUri: string; email: string; state: string }): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline", // we need a refresh token
    prompt: "consent", // Google only returns a refresh token on (re)consent
    login_hint: o.email,
    state: o.state,
  }).toString();
  return u.toString();
}

export async function exchangeGoogleCode(
  o: { clientId: string; clientSecret: string; redirectUri: string; code: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string; email: string | null }> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: o.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri }),
  });
  const body = (await res.json()) as { refresh_token?: string; access_token?: string; error?: string; error_description?: string; scope?: string };
  if (!res.ok || !body.refresh_token) throw new Error(`Google did not return a refresh token: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim());
  const granted = (body.scope ?? "").split(" ");
  const missing = GMAIL_SCOPES.filter((s) => !granted.includes(s));
  if (body.scope && missing.length) throw new Error(`these permissions were not granted: ${missing.join(", ")}`);
  let email: string | null = null;
  if (body.access_token) {
    const p = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${body.access_token}` } });
    if (p.ok) email = ((await p.json()) as { emailAddress?: string }).emailAddress ?? null;
  }
  return { refreshToken: body.refresh_token, email };
}

/** Run the loopback flow and resolve with the refresh token. */
export async function connectGoogle(o: { clientId: string; clientSecret: string; email: string; port?: number }): Promise<{ refreshToken: string; email: string | null }> {
  const state = crypto.randomUUID();
  const port = o.port ?? 53682;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  console.log(`\nOpen this link, sign in as ${o.email}, and allow access:\n\n${googleAuthUrl({ clientId: o.clientId, redirectUri, email: o.email, state })}\n`);
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") return void res.writeHead(404).end();
      const done = (msg: string) => res.writeHead(200, { "content-type": "text/plain" }).end(msg);
      try {
        if (url.searchParams.get("state") !== state) throw new Error("state mismatch; start again");
        const err = url.searchParams.get("error");
        if (err) throw new Error(`Google said: ${err}`);
        const result = await exchangeGoogleCode({ clientId: o.clientId, clientSecret: o.clientSecret, redirectUri, code: url.searchParams.get("code") ?? "" });
        done("Connected. You can close this tab and go back to the terminal.");
        server.close();
        resolve(result);
      } catch (e) {
        done(`Not connected: ${(e as Error).message}`);
        server.close();
        reject(e);
      }
    });
    server.listen(port, "127.0.0.1");
  });
}
