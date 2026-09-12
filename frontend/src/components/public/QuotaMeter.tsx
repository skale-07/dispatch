import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { Eyebrow } from "./Eyebrow";

/**
 * "4 of 15 applications" as a bar the user can read at a glance and a
 * number they can quote. The count is mono; the bar is the brand accent
 * on the inset surface (Progress is bridged to the tokens). max === 0
 * is a real state — no quota granted — and says so instead of dividing
 * by zero into a full bar.
 */
export function QuotaMeter({
  used,
  max,
  label = "applications",
  className,
}: {
  used: number;
  max: number;
  label?: string;
  className?: string;
}): JSX.Element {
  const safeUsed = Math.max(0, Math.floor(used));
  const safeMax = Math.max(0, Math.floor(max));
  const pct = safeMax === 0 ? 0 : Math.min(100, Math.round((safeUsed / safeMax) * 100));
  const remaining = Math.max(0, safeMax - safeUsed);
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>{label}</Eyebrow>
        <p className="m-0 font-mono text-sm tabular-nums text-text">
          <span className="font-heavy">{safeUsed}</span>
          <span className="text-text-dim"> of {safeMax}</span>
        </p>
      </div>
      <Progress
        value={pct}
        aria-label={`${safeUsed} of ${safeMax} ${label} used`}
        className="h-2 bg-bg-inset"
      />
      <p className="m-0 text-xs text-text-dim">
        {safeMax === 0
          ? "no quota granted yet"
          : remaining === 0
            ? "quota used up — an invite code adds more"
            : `${remaining} remaining`}
      </p>
    </div>
  );
}
