import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "../Icon";

/**
 * Copies one string (an invite code, a link) and says so for a moment.
 * The confirmation is text, not just an icon swap, and the button's
 * accessible name changes with it — a screen-reader user hears "copied"
 * too. Clipboard access can be refused (insecure context, permissions);
 * then the button says "copy failed" and the value is still selectable
 * wherever it is rendered beside this.
 */
export function CopyButton({
  value,
  label = "copy",
  className,
}: {
  value: string;
  /** What the button says at rest. */
  label?: string;
  className?: string;
}): JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    if (state === "idle") return;
    // A failure stays up long enough to read its reason.
    const t = window.setTimeout(() => setState("idle"), state === "failed" ? 4000 : 1500);
    return () => window.clearTimeout(t);
  }, [state]);

  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable (needs https)");
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch (err) {
      setReason(err instanceof Error ? err.message : String(err));
      setState("failed");
    }
  };

  // The failure names its reason (QA 2026-09-02, D-23): "couldn't copy —
  // clipboard unavailable (needs https)" tells the user what to do.
  const text =
    state === "copied" ? "copied" : state === "failed" ? `couldn't copy — ${reason ?? "unknown"}` : label;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void copy()}
      aria-live="polite"
      className={className}
    >
      <Icon name={state === "copied" ? "check" : "copy"} />
      {text}
    </Button>
  );
}
