import posthog from "posthog-js";

const posthogProjectToken =
  process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

if (process.env.NODE_ENV === "production" && posthogProjectToken) {
  try {
    posthog.init(posthogProjectToken, {
      api_host: posthogHost,
      defaults: "2026-01-30",
      capture_pageview: false,
      capture_pageleave: true,
      person_profiles: "identified_only",
      session_recording: {
        maskAllInputs: true,
        maskInputOptions: {
          password: true,
        },
      },
    });
  } catch (error) {
    console.error("[posthog] Failed to initialize", error);
  }
}
