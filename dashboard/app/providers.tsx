"use client";

import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";
import { useSession } from "next-auth/react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { useEffect } from "react";

const isPostHogEnabled =
  process.env.NODE_ENV === "production" &&
  Boolean(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN);

function PostHogTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();

  // Capture page views
  useEffect(() => {
    if (!isPostHogEnabled || !pathname) return;

    const query = searchParams.toString();
    const currentUrl = `${window.location.origin}${pathname}${query ? `?${query}` : ""}`;

    posthog.capture("$pageview", {
      $current_url: currentUrl,
    });
  }, [pathname, searchParams]);

  // Identify user when authenticated
  useEffect(() => {
    if (!isPostHogEnabled || status === "loading") return;

    if (status === "unauthenticated") {
      posthog.reset();
      return;
    }

    if (session?.user?.id) {
      posthog.identify(session.user.id, {
        email: session.user.email,
        name: session.user.name,
      });
    }
  }, [session?.user?.email, session?.user?.id, session?.user?.name, status]);

  return null;
}

export function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session: Session | null;
}) {
  return (
    <SessionProvider session={session}>
      <PostHogTracker />
      {children}
    </SessionProvider>
  );
}
