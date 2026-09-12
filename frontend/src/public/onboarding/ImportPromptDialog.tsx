import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "../../components/Icon";
import { CopyButton } from "../../components/public/CopyButton";
import { Eyebrow } from "../../components/public/Eyebrow";
import type { ProfileDraft } from "../contract";
import { IMPORT_PROMPT, importDraft, type ImportOutcome } from "../importPrompt";

/**
 * The bring-your-own-LLM fast path (importPrompt.ts): copy the prompt,
 * paste the reply, see exactly which fields it filled and which keys it
 * volunteered that were ignored, then merge into the DRAFT. Merging never
 * saves — each step saves when the user continues past it, after reading
 * what the model wrote.
 */
export function ImportPromptDialog({
  draft,
  onMerge,
}: {
  draft: ProfileDraft;
  onMerge: (merged: ProfileDraft) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (!next) setOutcome(null);
      }}
    >
      <div className="flex flex-col gap-3 rounded-md border border-border bg-bg-inset p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="m-0 text-sm text-text-dim">
          Have a resume? Your own AI assistant can fill most of this in — you still read
          every step before anything is saved.
        </p>
        <DialogTrigger asChild>
          <Button type="button" variant="outline">
            <Icon name="sparkle" size={14} />
            import from your resume
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent className="max-h-screen overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-heavy">Import with your own assistant</DialogTitle>
          <DialogDescription>
            Copy the prompt into whatever assistant you use, add your resume, and paste the
            JSON reply here. Dispatch never sees your resume, and nothing is saved until you
            continue past each step.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <Eyebrow>1 · the prompt</Eyebrow>
            <CopyButton value={IMPORT_PROMPT} label="copy prompt" />
          </div>
          <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg-inset p-3 font-mono text-xs text-text-dim">
            {IMPORT_PROMPT}
          </pre>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="import-reply">2 · paste the reply</Label>
          <Textarea
            id="import-reply"
            rows={6}
            className="font-mono text-xs"
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
              setOutcome(null);
            }}
            placeholder="{ … }"
          />
        </div>

        {outcome && !outcome.ok ? (
          <Alert variant="destructive" role="alert">
            <Icon name="alert" size={14} />
            <AlertDescription>
              <p className="m-0">{outcome.reason}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        {outcome && outcome.ok ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="m-0 text-sm text-text">
              Filled {outcome.filled.length} {outcome.filled.length === 1 ? "field" : "fields"} —
              check each step before you continue:
            </p>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {outcome.filled.map((k) => (
                <li key={k}>
                  <Badge variant="secondary">{k}</Badge>
                </li>
              ))}
            </ul>
            {outcome.ignored.length > 0 ? (
              <>
                <p className="m-0 text-sm text-text-dim">
                  Ignored — never imported (you answer these yourself, or we do not ask):
                </p>
                <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                  {outcome.ignored.map((k) => (
                    <li key={k}>
                      <Badge variant="outline">{k}</Badge>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOutcome(importDraft(pasted, draft))}
          >
            read it
          </Button>
          <Button
            type="button"
            disabled={!outcome?.ok}
            onClick={() => {
              if (!outcome?.ok) return;
              onMerge(outcome.draft);
              setOpen(false);
              setPasted("");
              setOutcome(null);
            }}
          >
            <Icon name="check" size={14} />
            use these answers
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
