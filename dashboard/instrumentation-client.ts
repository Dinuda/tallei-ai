import posthog from "posthog-js";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

if (process.env.NODE_ENV === "production" && posthogKey) {
  try {
    posthog.init(posthogKey, {
      api_host: posthogHost,
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
