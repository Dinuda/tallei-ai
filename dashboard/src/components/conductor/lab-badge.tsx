import { cn } from "@/lib/utils";

export function LabBadge({ label = "LAB" }: { label?: string }) {
  const isLong = label.length > 5;

  return (
    <div aria-label={label} className="agent-team-lab-badge">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        aria-hidden
        className="agent-team-lab-badge__icon"
        draggable={false}
        height={24}
        src="/svg/wool-lab.svg"
        width={24}
      />
      <span
        aria-hidden
        className={cn("agent-team-lab-badge__text", isLong && "agent-team-lab-badge__text--long")}
      >
        {label}
      </span>
    </div>
  );
}
