import { cn } from "@/lib/utils";

export type ActionGlyphName = "approve" | "reject" | "submit" | "rerun" | "edit";

export const ACTION_GLYPH_LABELS: Record<ActionGlyphName, string> = {
  approve: "Approve and continue",
  reject: "Request changes",
  submit: "Submit input",
  rerun: "Rerun this step",
  edit: "Open editor",
};

const ACTION_SYMBOLS: Record<ActionGlyphName, string> = {
  approve: "/>",
  reject: "<\\",
  submit: "|>",
  rerun: "↻",
  edit: "",
};

/** Max 2 lines for action button badges. */
export const ACTION_GLYPH_ART: Record<ActionGlyphName, readonly string[]> = {
  approve: [" \\", " v"],
  reject: [" <~", " ~~"],
  submit: ["|>|", "|_|"],
  rerun: ["o>", "/|"],
  edit: ["[/]"],
};

const actionBadgeTone: Record<"primary" | "secondary" | "danger" | "muted", string> = {
  primary: "border-white/25 bg-white/10 text-white",
  secondary: "border-[#9bb8d9] bg-[#edf3fb] text-[#2d5a87]",
  danger: "border-white/25 bg-white/10 text-white",
  muted: "border-[#e5e7eb] bg-[#fafafa] text-[#6b7280]",
};

export function GlyphActionBadge({
  glyph,
  tone = "primary",
}: {
  glyph: ActionGlyphName;
  tone?: keyof typeof actionBadgeTone;
}) {
  const lines = ACTION_GLYPH_ART[glyph].slice(0, 2);

  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center border font-mono leading-none",
        actionBadgeTone[tone],
      )}
      aria-hidden
    >
      <pre className="m-0 text-[8px]">
        {lines.map((line, index) => (
          <span key={`${glyph}-${index}`} className="block whitespace-pre text-center">
            {line}
          </span>
        ))}
      </pre>
    </span>
  );
}

export function EditorialActionButton({
  label,
  glyph,
  variant = "primary",
  onClick,
  disabled,
  className,
  fullWidth,
  size = "md",
}: {
  label: string;
  glyph: ActionGlyphName;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  fullWidth?: boolean;
  size?: "md" | "lg";
}) {
  const badgeTone = variant === "primary"
    ? "primary"
    : variant === "danger"
      ? "danger"
      : variant === "secondary"
        ? "secondary"
        : "muted";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex shrink-0 items-center gap-2.5 transition-colors disabled:opacity-50",
        size === "lg" ? "h-12 px-5 text-[14px]" : "h-10 px-4 text-[13px]",
        variant === "primary" && "border border-[#2563eb] bg-[#2563eb] font-semibold text-white hover:bg-[#1d4ed8] outline outline-2 outline-[#2563eb] outline-offset-2",
        variant === "secondary" && "border border-[#9bb8d9] bg-white font-medium text-[#4a6f96] hover:bg-[#f8fbff] disabled:opacity-40",
        variant === "danger" && "border border-[#dc2626] bg-[#dc2626] font-semibold text-white hover:bg-[#b91c1c]",
        variant === "ghost" && "border-0 bg-transparent px-0 font-medium text-[#6b7280] hover:underline disabled:opacity-40",
        fullWidth && "flex-1 justify-center",
        className,
      )}
      style={{ fontFamily: "var(--font-fustat)" }}
      title={ACTION_GLYPH_LABELS[glyph]}
    >
      {glyph === "edit" ? (
        <GlyphActionBadge glyph={glyph} tone={badgeTone} />
      ) : (
        <span className="grid size-5 shrink-0 place-items-center text-[13px] font-bold leading-none" aria-hidden>
          {ACTION_SYMBOLS[glyph]}
        </span>
      )}
      {label}
    </button>
  );
}
