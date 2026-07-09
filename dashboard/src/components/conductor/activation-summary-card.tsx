"use client";

import { Check } from "lucide-react";

import {
  AgentTeamAvatar,
  rosterAvatarShellClassName,
} from "@/components/conductor/agent-team-avatar";
import type { ActivationSummaryViewModel } from "@/components/conductor/activation-summary-view-model";
import { cn } from "@/lib/utils";

function humanizeConnector(slug: string): string {
  return slug
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function ConnectorBadge({ connector }: { connector: string }) {
  const label = humanizeConnector(connector);

  return (
    <span className="inline-flex items-center gap-1.5 border border-[var(--ed-border)] bg-white px-2 py-1 text-[11px] font-semibold leading-none text-[var(--ed-text)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        aria-hidden
        className="size-4 shrink-0 object-contain"
        draggable={false}
        src={`https://logos.composio.dev/api/${connector}`}
      />
      <span>{label}</span>
    </span>
  );
}

function WhoCell({ who, avatarSeed }: { who: string; avatarSeed?: string }) {
  if (avatarSeed) {
    return (
      <div className="flex items-center gap-2">
        <span className={rosterAvatarShellClassName(avatarSeed)}>
          <AgentTeamAvatar
            alt=""
            className="size-6"
            seed={avatarSeed}
            size={24}
          />
        </span>
        <span className="text-xs font-medium text-[var(--ed-text)]">{who}</span>
      </div>
    );
  }

  return (
    <span className="text-xs font-medium text-[var(--ed-text)]">{who}</span>
  );
}

export function ActivationSummaryCard({
  viewModel,
  streaming = false,
}: {
  viewModel: ActivationSummaryViewModel;
  streaming?: boolean;
}) {
  const statusLabel = viewModel.alreadyActive ? "Already active" : "Active";

  return (
    <section
      aria-busy={streaming}
      aria-label="Active automation summary"
      className="overflow-hidden border border-[var(--ed-border)] bg-white"
      data-transcript-block
    >
      <div className="border-b border-[var(--ed-border-light)] bg-[var(--builder-emerald-bg)] px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold leading-6 text-[var(--builder-emerald-text)]">
              {viewModel.title}
            </h3>
              {viewModel.monitoringNote ? (
                <p className="mt-3 px-1 text-xs leading-5 text-[var(--ed-text-muted)]">
                  {viewModel.monitoringNote}
                </p>
              ) : null}
          </div>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em]",
              "border-[var(--builder-emerald-border)] bg-white text-[var(--builder-emerald-text)]",
            )}
          >
            <Check className="size-3.5" aria-hidden />
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="bg-[var(--ed-surface-alt)] p-3 sm:p-4">
        <p className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ed-text-muted)]">
          What&apos;s live
        </p>
        <div className="overflow-x-auto border border-[var(--ed-border-light)] bg-white">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)]">
                <th
                  className="px-3 py-2 font-semibold text-[var(--ed-text-muted)]"
                  scope="col"
                >
                  Step
                </th>
                <th
                  className="px-3 py-2 font-semibold text-[var(--ed-text-muted)]"
                  scope="col"
                >
                  What happens
                </th>
                <th
                  className="px-3 py-2 font-semibold text-[var(--ed-text-muted)]"
                  scope="col"
                >
                  Who
                </th>
              </tr>
            </thead>
            <tbody>
              {viewModel.steps.map((row) => (
                <tr
                  key={`${row.step}-${row.what}`}
                  className="border-b border-[var(--ed-border-light)] last:border-b-0"
                >
                  <td className="px-3 py-3 align-top font-semibold text-[var(--ed-text-muted)]">
                    {row.step}
                  </td>
                  <td className="px-3 py-3 align-top text-[var(--ed-text-2)]">
                    <div className="space-y-2">
                      <p className="leading-5">{row.what}</p>
                      {row.connector ? (
                        <ConnectorBadge connector={row.connector} />
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <WhoCell avatarSeed={row.avatarSeed} who={row.who} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {viewModel.preferences.length > 0 ? (
          <div className="mt-3 border border-[var(--ed-border-light)] bg-white px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ed-text-muted)]">
              Your preferences
            </p>
            <ul className="mt-2 space-y-1.5 text-xs leading-5 text-[var(--ed-text-2)]">
              {viewModel.preferences.map((preference) => (
                <li key={preference}>{preference}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {streaming ? (
        <footer className="border-t border-slate-100 px-4 py-2 text-right text-[11px] font-medium text-slate-500">
          Activating…
        </footer>
      ) : null}
    </section>
  );
}
