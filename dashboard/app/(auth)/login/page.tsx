import { signIn } from "../../../auth";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const rawCallbackUrl = resolvedSearchParams.callbackUrl;
  const callbackUrl =
    typeof rawCallbackUrl === "string" && rawCallbackUrl.startsWith("/")
      ? rawCallbackUrl
      : "/dashboard/setup";

  return (
    <main className="auth-screen">
      <div className="auth-card animate-fade-up">
        <div className="auth-logo-wrap">
          <div className="auth-logo-stack" style={{ alignItems: "center" }}>
            <img src="/tallei.svg" alt="Tallei Logo" style={{ height: "40px", width: "auto" }} />
          </div>
        </div>

        <div className="auth-heading">
          <h2>Welcome back</h2>
          <p>Sign in to access your AI memory workspace</p>
        </div>

        <div className="auth-divider">
          <div className="auth-divider-line" />
          <span className="auth-divider-text">continue with</span>
        </div>

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: callbackUrl });
          }}
        >
          <button type="submit" className="btn auth-google-btn">
            <svg width="20" height="20" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden>
              <path fill="#EA4335" d="M24 9.5c3.2 0 5.7 1.1 7.8 3.1l5.8-5.8C34.2 3.5 29.4 1.5 24 1.5 15.5 1.5 8.2 6.5 4.9 13.7l6.8 5.3C13.5 13 18.3 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.5 24c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.6 36.8 46.5 30.8 46.5 24z" />
              <path fill="#FBBC05" d="M11.7 28.3A14.4 14.4 0 0 1 9.5 24c0-1.5.3-3 .8-4.3l-6.8-5.3A22.4 22.4 0 0 0 1.5 24c0 3.6.9 6.9 2.4 9.9l7.8-5.6z" />
              <path fill="#34A853" d="M24 46.5c5.4 0 9.9-1.8 13.2-4.8l-7.5-5.8c-1.8 1.2-4.2 2-5.7 2-5.6 0-10.4-3.8-12.1-9l-7.8 5.6C8.2 41.5 15.5 46.5 24 46.5z" />
            </svg>
            Continue with Google
          </button>
        </form>

        <p className="auth-footnote">
          New users are created automatically on first sign-in.
          <br />
          By continuing you agree to our Terms of Service.
        </p>
      </div>
    </main>
  );
}
