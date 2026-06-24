export type LoopMinerSummary = {
  id: string;
  status: string;
  createdAt?: string;
  episodesBuilt?: number;
  loopsDetected?: number;
  loopsQualified?: number;
  suggestionsCreated?: number;
  skipped?: boolean;
  skipReason?: string | null;
};
