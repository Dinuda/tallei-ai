export function debugConductorClientTiming(
  label: string,
  timings: Record<string, number>,
): void {
  if (process.env.NODE_ENV === "production") return;
  console.debug(`[conductor:${label}]`, timings);
}

export function startConductorClientTimer(): () => number {
  const started = performance.now();
  return () => performance.now() - started;
}
