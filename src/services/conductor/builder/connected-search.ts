import type { ToolContract } from "../../tool-spec/types.js";

export function connectedSearchToolkits(contracts: ToolContract[]): Array<{ toolkit: string; name: string; connected: boolean }> {
  const seen = new Set<string>();
  const toolkits: Array<{ toolkit: string; name: string; connected: boolean }> = [];
  for (const contract of contracts) {
    const match = contract.toolRef.match(/^composio\.([^.]+)\.search$/i);
    if (!match?.[1]) continue;
    const toolkit = match[1].toLowerCase();
    if (seen.has(toolkit)) continue;
    seen.add(toolkit);
    toolkits.push({
      toolkit,
      name: contract.name,
      connected: contract.constraints.connected === true,
    });
  }
  return toolkits;
}
