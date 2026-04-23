import Link from "next/link";

type NotFoundViewProps = {
  title?: string;
  description?: string;
};

export function NotFoundView({
  title = "Page not found",
  description = "The page you requested does not exist or may have moved.",
}: NotFoundViewProps) {
  return (
    <main className="auth-screen">
      <div className="auth-card animate-fade-up">
        <div className="auth-logo-wrap">
          <img src="/tallei.svg" alt="Tallei Logo" style={{ height: "40px", width: "auto" }} />
        </div>

        <div className="auth-heading">
          <p className="auth-status-code">404</p>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>

        <div className="auth-action-row">
          <Link href="/" className="btn btn-primary">
            Go home
          </Link>
          <Link href="/login" className="btn btn-secondary">
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
