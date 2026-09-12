import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Icon } from "../Icon";
import { PanelState } from "./PanelState";

/**
 * The remote browser the user drives during a handoff (sign in to
 * JobRight, clear a captcha). A TITLED, sandboxed iframe — the a11y
 * hygiene test refuses an untitled one — with an open-in-tab fallback
 * for the phone, where a 1280px browser in a 390px frame is unusable.
 * `url === null` is the provisioning state and renders the wait, never
 * an empty frame.
 */
export function LiveView({
  url,
  title,
  expiresAt,
  className,
}: {
  url: string | null;
  /** What the user is doing in there — becomes the iframe's accessible name. */
  title: string;
  expiresAt?: string | null;
  className?: string;
}): JSX.Element {
  if (url === null) {
    return (
      <PanelState
        kind="loading"
        className={className}
      />
    );
  }
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <iframe
        src={url}
        title={title}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        allow="clipboard-read; clipboard-write"
        className="aspect-video w-full rounded-lg border border-border bg-bg-inset"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-xs text-text-dim">
          {expiresAt ? `this browser closes at ${new Date(expiresAt).toLocaleTimeString()}` : ""}
        </p>
        <Button asChild variant="outline" size="sm">
          <a href={url} target="_blank" rel="noopener noreferrer">
            <Icon name="external" />
            open in a new tab
          </a>
        </Button>
      </div>
    </div>
  );
}
