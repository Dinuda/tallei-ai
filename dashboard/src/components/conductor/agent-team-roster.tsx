"use client";

import { UserRound } from "lucide-react";
import { useSession } from "next-auth/react";
import { useMemo } from "react";

import { AgentTeamAvatar, rosterAvatarShellClassName } from "@/components/conductor/agent-team-avatar";
import { LabBadge } from "@/components/conductor/lab-badge";
import { OutcomeBriefCard } from "@/components/conductor/outcome-brief-card";
import type {
  AgentTeamReviewer,
  AgentTeamSpecialist,
  AgentTeamTrigger,
  PresentAgentTeamOutput,
} from "@/components/conductor/conductor-shared";
import { buildSpecialistWorkflowViewModel } from "@/components/conductor/outcome-review-view-model";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

function humanizeConnector(slug: string): string {
  return slug
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function identityInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function specialistDisplayName(name: string): string {
  return name.trim().split(/\s+/)[0] || name.trim();
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

function uniqueConnectors(steps: Array<{ connector?: string }>): string[] {
  const seen = new Set<string>();
  const connectors: string[] = [];
  for (const step of steps) {
    const connector = step.connector?.trim();
    if (!connector || seen.has(connector)) continue;
    seen.add(connector);
    connectors.push(connector);
  }
  return connectors;
}

function TriggerLabRow({ trigger }: { trigger: AgentTeamTrigger }) {
  return (
    <article className="border border-[var(--ed-border-light)] bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ed-text-muted)]">Starts when</p>
          <p className="mt-1 text-xs leading-5 text-[var(--ed-text-2)]">{trigger.description}</p>
        </div>
        {trigger.connector ? (
          <div className="shrink-0">
            <ConnectorBadge connector={trigger.connector} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function SpecialistRow({ specialist }: { specialist: AgentTeamSpecialist }) {
  const connectors = uniqueConnectors(specialist.steps);
  const displayName = specialistDisplayName(specialist.name);
  const workflowViewModel = useMemo(
    () => buildSpecialistWorkflowViewModel({
      specialistName: displayName,
      roleTitle: specialist.roleTitle,
      ownershipSummary: specialist.ownershipSummary,
      steps: specialist.steps,
    }),
    [displayName, specialist.ownershipSummary, specialist.roleTitle, specialist.steps],
  );

  return (
    <article className="border border-[var(--ed-border-light)] bg-white px-4 py-3">
      <div className="flex items-start gap-3">
        <span className={rosterAvatarShellClassName(specialist.avatarSeed)}>
          <AgentTeamAvatar
            alt={`${displayName} avatar`}
            className="size-10"
            seed={specialist.avatarSeed}
            size={40}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h4 className="text-sm font-semibold text-[var(--ed-text)]">{displayName}</h4>
            <p className="text-xs font-medium text-[var(--ed-text-muted)]">{specialist.roleTitle}</p>
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--ed-text-2)]">{specialist.ownershipSummary}</p>
        </div>
        {connectors.length > 0 ? (
          <div className="flex shrink-0 flex-col items-end gap-2">
            {connectors.map((connector) => (
              <ConnectorBadge key={connector} connector={connector} />
            ))}
          </div>
        ) : null}
      </div>

      {specialist.steps.length > 0 ? (
        <div className="mt-2 flex justify-end">
          <Accordion className="w-full" collapsible type="single">
            <AccordionItem className="border-0" value="workflow">
              <AccordionTrigger
                className="ml-auto w-auto justify-end gap-1.5 py-1 text-[11px] font-semibold text-[var(--ed-text-muted)] hover:no-underline [&>svg]:size-3.5"
              >
                Workflow
              </AccordionTrigger>
              <AccordionContent className="pb-0">
                <OutcomeBriefCard streaming={false} viewModel={workflowViewModel} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      ) : null}
    </article>
  );
}

function ReviewerRow({
  reviewer,
  userName,
  userImage,
}: {
  reviewer: AgentTeamReviewer;
  userName?: string | null;
  userImage?: string | null;
}) {
  const displayName = userName?.trim() ? `${userName.trim()} (You)` : "You";

  return (
    <article className="border border-[var(--ed-accent-bg)] bg-[var(--ed-accent-bg)] px-4 py-3">
      <div className="flex items-start gap-3">
        <Avatar className="size-10 shrink-0 shadow-[0_0_0_2px_#ffffff,0_4px_14px_rgba(45,90,135,0.35)] ring-2 ring-white">
          {userImage ? <AvatarImage alt={displayName} src={userImage} /> : null}
          <AvatarFallback className="bg-[var(--tag-blue-bg)] text-[11px] font-semibold text-[var(--tag-blue-text)]">
            {userName?.trim() ? identityInitials(userName) : <UserRound className="size-4" />}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h4 className="text-sm font-semibold text-[var(--tag-blue-text)]">{displayName}</h4>
            <p className="text-xs font-medium text-[var(--ed-text-muted)]">{reviewer.roleTitle}</p>
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--ed-text-2)]">{reviewer.description}</p>
        </div>
      </div>
    </article>
  );
}

export function AgentTeamRoster({
  team,
  streaming = false,
}: {
  team: PresentAgentTeamOutput;
  streaming?: boolean;
}) {
  const { data: session } = useSession();
  const reviewerInsertAt = team.reviewer
    ? (team.reviewerInsertIndex ?? team.specialists.length)
    : team.specialists.length;
  const specialistsBeforeReviewer = team.specialists.slice(0, reviewerInsertAt);
  const specialistsAfterReviewer = team.specialists.slice(reviewerInsertAt);

  return (
    <section
      aria-busy={streaming}
      aria-label="Agent team roster"
      className="overflow-hidden border border-[var(--ed-border)] bg-white"
      data-transcript-block
    >
      <LabBadge />

      <div className="border-b border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] px-4 py-4 sm:px-5">
        <h3 className="text-base font-semibold leading-6 text-[var(--ed-text)]">{team.title}</h3>
        <p className="mt-1 text-xs text-[var(--ed-text-muted)]">Specialists grouped by responsibility.</p>
      </div>

      <div className="space-y-2 bg-[var(--ed-surface-alt)] p-3 sm:p-4">
        {team.triggers?.length ? (
          <div className="space-y-2">
            {team.triggers.map((trigger) => (
              <TriggerLabRow key={trigger.outcomeId} trigger={trigger} />
            ))}
          </div>
        ) : null}
        {specialistsBeforeReviewer.map((specialist) => (
          <SpecialistRow key={specialist.id} specialist={specialist} />
        ))}
        {team.reviewer ? (
          <ReviewerRow
            reviewer={team.reviewer}
            userImage={session?.user?.image}
            userName={session?.user?.name}
          />
        ) : null}
        {specialistsAfterReviewer.map((specialist) => (
          <SpecialistRow key={specialist.id} specialist={specialist} />
        ))}
      </div>

      {streaming ? (
        <footer className="border-t border-slate-100 px-4 py-2 text-right text-[11px] font-medium text-slate-500">
          Assembling team…
        </footer>
      ) : null}
    </section>
  );
}

export function AgentTeamRosterPlaceholder({ title = "Automation team" }: { title?: string }) {
  return (
    <section
      aria-busy
      aria-label="Agent team roster"
      className={cn(
        "overflow-hidden border border-[var(--ed-border)] bg-white",
      )}
      data-transcript-block
    >
      <LabBadge />

      <div className="border-b border-[var(--ed-border-light)] bg-[var(--ed-surface-alt)] px-4 py-4 sm:px-5">
        <h3 className="text-base font-semibold leading-6 text-[var(--ed-text)]">{title}</h3>
        <p className="mt-1 text-xs text-[var(--ed-text-muted)]">Assigning specialists…</p>
      </div>
      <div className="space-y-2 bg-[var(--ed-surface-alt)] p-3 sm:p-4">
        <div className="h-20 animate-pulse border border-[var(--ed-border-light)] bg-white" />
        <div className="h-20 animate-pulse border border-[var(--ed-border-light)] bg-white" />
      </div>
    </section>
  );
}
