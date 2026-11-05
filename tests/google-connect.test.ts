import { describe, expect, it } from "vitest";
import { exchangeGoogleCode, GMAIL_SCOPES, googleAuthUrl } from "../apps/worker/src/google-connect";

describe("connect-google", () => {
  it("asks only for send + read, offline, for the named mailbox", () => {
    const u = new URL(googleAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:53682/callback", email: "jamie@getnorthwind.example.com", state: "s1" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")!.split(" ")).toEqual(GMAIL_SCOPES);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("login_hint")).toBe("jamie@getnorthwind.example.com");
  });

  it("returns the refresh token and the signed-in address, and refuses partial permissions", async () => {
    const ok = (async (url: string) =>
      String(url).includes("/token")
        ? Response.json({ refresh_token: "rt", access_token: "at", scope: GMAIL_SCOPES.join(" ") })
        : Response.json({ emailAddress: "jamie@getnorthwind.example.com" })) as unknown as typeof fetch;
    expect(await exchangeGoogleCode({ clientId: "c", clientSecret: "s", redirectUri: "r", code: "x" }, ok)).toEqual({ refreshToken: "rt", email: "jamie@getnorthwind.example.com" });

    const partial = (async () => Response.json({ refresh_token: "rt", access_token: "at", scope: GMAIL_SCOPES[0] })) as unknown as typeof fetch;
    await expect(exchangeGoogleCode({ clientId: "c", clientSecret: "s", redirectUri: "r", code: "x" }, partial)).rejects.toThrow(/not granted/);
    const none = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeGoogleCode({ clientId: "c", clientSecret: "s", redirectUri: "r", code: "x" }, none)).rejects.toThrow(/invalid_grant/);
  });
});
