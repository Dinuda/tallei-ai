import { cn } from "@/lib/utils";

export type GlyphName =
  | "parent"
  | "search"
  | "input"
  | "draft"
  | "review"
  | "gate"
  | "agent"
  | "ok"
  | "fail"
  | "doc"
  | "memory"
  | "rerun";

export const GLYPH_LABELS: Record<GlyphName, string> = {
  parent: "Orchestrator",
  search: "Memory search",
  input: "Input check",
  draft: "Draft writer",
  review: "Review",
  gate: "Approval gate",
  agent: "Agent",
  ok: "Complete",
  fail: "Failed",
  doc: "Artifact",
  memory: "Memory",
  rerun: "Rerun",
};

export const GLYPH_CODES: Record<GlyphName, string> = {
  parent: "ORC",
  search: "SRC",
  input: "IN",
  draft: "WRT",
  review: "REV",
  gate: "GATE",
  agent: "RUN",
  ok: "OK",
  fail: "ERR",
  doc: "DOC",
  memory: "MEM",
  rerun: "RER",
};

/** Max 2 lines — simple symbol art only. */
export const GLYPH_ART: Record<GlyphName, readonly string[]> = {
  parent: ["< |", "._."],
  search: [" o_", "/ "],
  input: ["| |", "|v|"],
  draft: [" /", "/_"],
  review: ["[~]", "|_|"],
  gate: ["|!|", "|_|"],
  agent: [" o ", "/|\\"],
  ok: [" \\", " v"],
  fail: ["\\ /", " x "],
  doc: ["|~|", "|_|"],
  memory: ["{=}", "{=}"],
  rerun: ["o>", "/|"],
};

export {
  ACTION_GLYPH_ART,
  ACTION_GLYPH_LABELS,
  EditorialActionButton,
  GlyphActionBadge,
  type ActionGlyphName,
} from "@/components/glyph-action";

export function GlyphIcon({
  name,
  className,
  boxClassName,
  size = "md",
  showCode = true,
}: {
  name: GlyphName;
  className?: string;
  boxClassName?: string;
  size?: "sm" | "md";
  showCode?: boolean;
}) {
  const lines = GLYPH_ART[name].slice(0, 2);
  const code = GLYPH_CODES[name];
  const boxSize = size === "sm" ? "h-10 w-10" : "h-11 w-11";

  return (
    <div
      className={cn("grid shrink-0 place-items-center border", boxSize, boxClassName)}
      title={GLYPH_LABELS[name]}
      aria-label={GLYPH_LABELS[name]}
    >
      <div className="flex flex-col items-center justify-center gap-0.5">
        <pre
          className={cn(
            "m-0 select-none font-mono leading-none tracking-tight text-current",
            size === "sm" ? "text-[9px]" : "text-[10px]",
            className,
          )}
        >
          {lines.map((line, index) => (
            <span key={`${name}-${index}`} className="block whitespace-pre text-center">
              {line}
            </span>
          ))}
        </pre>
        {showCode ? (
          <span
            className={cn(
              "font-mono font-bold uppercase tracking-wider text-current/75",
              size === "sm" ? "text-[6px]" : "text-[7px]",
            )}
          >
            {code}
          </span>
        ) : null}
      </div>
    </div>
  );
}
