import { auth } from "../../auth";
import { redirect } from "next/navigation";

/**
 * MCP OAuth authorization endpoint.
 *
 * Claude.ai (or any MCP client using OAuth) redirects the user's browser here.
 * We check the NextAuth session. If logged in, we call the backend to issue an
 * auth code and redirect back to the client's redirect_uri. If not logged in,
 * we redirect to /login with a callbackUrl so the user is bounced back here
 * after signing in.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const { client_id, code_challenge, redirect_uri, scope, state, resource } = params;

  // Basic validation
  if (!client_id || !code_challenge || !redirect_uri) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.2rem" }}>Authorization Error</h1>
        <p style={{ color: "#6b7280" }}>Missing required OAuth parameters.</p>
      </main>
    );
  }

  const session = await auth();

  if (!session?.user?.id) {
    // Not logged in — redirect to login, then come back here after.
    const callbackUrl = `/authorize?${new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) as Record<string, string>
    ).toString()}`;
    redirect(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  // Logged in — ask the backend to issue an MCP auth code for this user.
  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:3000";
  const secret = process.env.INTERNAL_API_SECRET!;

  let code: string | null = null;
  let finalRedirectUri: string | null = null;
  let returnedState: string | null = null;
  let errorTitle: string | null = null;
  let errorMessage: string | null = null;

  try {
    const res = await fetch(`${backendUrl}/api/mcp/code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": secret,
        "X-User-Id": session.user.id,
      },
      body: JSON.stringify({
        clientId: client_id,
        codeChallenge: code_challenge,
        redirectUri: redirect_uri,
        scope,
        state,
        resource,
      }),
    });

    if (!res.ok) {
      const { error } = (await res.json()) as { error: string };
      errorTitle = "Authorization Failed";
      errorMessage = error;
    } else {
      ({ code, redirectUri: finalRedirectUri, state: returnedState } = (await res.json()) as {
        code: string;
        redirectUri: string;
        state: string | null;
      });
    }
  } catch (err) {
    console.error("[authorize] Failed to obtain auth code:", err);
    errorTitle = "Authorization Error";
    errorMessage = "Could not connect to the Tallei backend.";
  }

  if (errorTitle && errorMessage) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.2rem" }}>{errorTitle}</h1>
        <p style={{ color: "#6b7280" }}>{errorMessage}</p>
      </main>
    );
  }

  if (!code || !finalRedirectUri) {
    return (
      <main style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 480 }}>
        <h1 style={{ fontSize: "1.2rem" }}>Authorization Error</h1>
        <p style={{ color: "#6b7280" }}>Failed to create an authorization code.</p>
      </main>
    );
  }

  // Redirect back to the MCP client with the code.
  const target = new URL(finalRedirectUri);
  target.searchParams.set("code", code);
  if (returnedState) target.searchParams.set("state", returnedState);

  redirect(target.toString());
}
