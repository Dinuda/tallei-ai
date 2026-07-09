"use client";

import { BuilderCompletedCard } from "@/components/conductor/builder-completed-card";
import type { HiddenToolSummaryViewModel } from "@/components/conductor/conductor-hidden-tool-summary-view-model";

export function HiddenToolSummaryCard({ viewModel }: { viewModel: HiddenToolSummaryViewModel }) {
  return (
    <BuilderCompletedCard
      subtitle={viewModel.subtitle}
      title={viewModel.title}
      variant={viewModel.variant ?? "emerald"}
    />
  );
}
