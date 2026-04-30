import Image from "next/image";
import Link from "next/link";

type AuthErrorPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const AUTH_ERROR_COPY: Record<string, { title: string; description: string }> = {
  AccessDenied: {
    title: "Sign-in was denied",
    description: "We could not complete authentication for this account. Please try again.",
  },
  CallbackRouteError: {
    title: "Authentication callback failed",
    description: "The OAuth callback was invalid or incomplete. Please retry sign-in.",
  },
  Configuration: {
    title: "Authentication is not configured",
    description: "Tallei auth is temporarily unavailable due to a configuration issue.",
  },
  Default: {
    title: "Authentication error",
    description: "Something went wrong while signing you in. Please try again.",
  },
};

export default async function AuthErrorPage({ searchParams }: AuthErrorPageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const rawError = resolvedSearchParams.error;
  const errorCode = typeof rawError === "string" ? rawError : "Default";
  const copy = AUTH_ERROR_COPY[errorCode] ?? AUTH_ERROR_COPY.Default;

  return (
    <main className="auth-screen">
      <div className="auth-card animate-fade-up">
        <div className="auth-logo-wrap">
          <Image src="/tallei.svg" alt="Tallei Logo" width={98} height={40} style={{ height: "40px", width: "auto" }} />
        </div>

        <div className="auth-heading">
          <p className="auth-status-code">Auth error</p>
          <h2>{copy.title}</h2>
          <p>{copy.description}</p>
        </div>

        <div className="auth-action-row">
          <Link href="/login" className="btn auth-google-btn">
            Try sign-in again
          </Link>
          <Link href="/" className="btn btn-secondary">
            Back to home
          </Link>
        </div>

        {errorCode !== "Default" ? <p className="auth-footnote">Error code: {errorCode}</p> : null}
      </div>
    </main>
  );
}
