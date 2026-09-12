import type { ReactNode } from "react";
import { PanelState } from "./PanelState";

/**
 * A feature that REFUSED, and says exactly why — "Refused: Gmail not
 * connected", "Refused: JobRight Premium not detected". The word Refused
 * is deliberate: the engine did not fail, it declined by rule, and the
 * fix is a user action, which `action` offers. Never a greyed-out
 * mystery.
 */
export function LockedPanel({
  title,
  reason,
  action,
  className,
}: {
  title: ReactNode;
  /** The rule, in the user's terms. Rendered after "Refused:". */
  reason: ReactNode;
  action?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <PanelState
      kind="locked"
      title={title}
      body={
        <>
          <span className="font-mono font-heavy text-warn">Refused:</span> {reason}
        </>
      }
      action={action}
      className={className}
    />
  );
}
