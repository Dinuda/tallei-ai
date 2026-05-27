export interface Env {
  BACKEND_URL: string;
  INTERNAL_API_SECRET: string;
  DISPATCH_LIMIT?: string;
}

function backendWakeUrl(env: Env): string {
  const base = env.BACKEND_URL.replace(/\/$/, "");
  return `${base}/api/workflows/internal/loops/scheduler/wake`;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const limit = Number.parseInt(env.DISPATCH_LIMIT ?? "4", 10);
    ctx.waitUntil(fetch(backendWakeUrl(env), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": env.INTERNAL_API_SECRET,
      },
      body: JSON.stringify({
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 25) : 4,
      }),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Loop scheduler wake failed: HTTP ${response.status} ${await response.text()}`);
      }
    }));
  },
};
