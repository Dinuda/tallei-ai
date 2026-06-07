/** Models that only accept the API default temperature (1); custom values return 400. */
export function openAiModelSupportsCustomTemperature(model: string): boolean {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("gpt-5")) return false;
  if (normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4")) return false;
  if (normalized.includes("nano")) return false;
  return true;
}

export function openAiTemperatureParam(
  model: string,
  temperature?: number,
): { temperature?: number } {
  if (!openAiModelSupportsCustomTemperature(model)) return {};
  return { temperature: temperature ?? 1 };
}
