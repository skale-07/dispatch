import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Icon } from "../../components/Icon";
import { Eyebrow } from "../../components/public/Eyebrow";
import { FieldHint } from "../../components/public/FieldHint";
import { PanelState } from "../../components/public/PanelState";
import type { DocumentKind, DocumentRow } from "../contract";
import { listMyDocuments, removeDocument, setDefaultDocument, uploadDocument } from "../data";
import { StepActions, type StepProps } from "./StepChrome";

/**
 * Step 5: resumes (named variants) and a transcript, each a
 * user_documents row the moment its upload succeeds. The engine attaches
 * the default resume, or the variant matching a role family; the server's
 * completeness check needs at least one resume. Every failure shows the
 * storage service's own message.
 */
export function DocumentsStep(props: StepProps): JSX.Element {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variant, setVariant] = useState("general");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setDocs(await listMyDocuments());
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setError(null);
    try {
      await run();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const upload = (kind: DocumentKind, file: File | undefined): void => {
    if (!file) return;
    void act(`upload-${kind}`, () =>
      uploadDocument({ kind, variant: kind === "resume" ? variant : "general", file }),
    );
  };

  const resumes = docs?.filter((d) => d.kind === "resume") ?? [];
  const transcripts = docs?.filter((d) => d.kind === "transcript") ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Card className="py-6">
        <CardContent className="flex flex-col gap-6 px-5 sm:px-8">
          {error ? (
            <Alert variant="destructive" role="alert">
              <Icon name="alert" size={14} />
              <AlertDescription>
                <p className="m-0">{error}</p>
              </AlertDescription>
            </Alert>
          ) : null}

          <section className="flex flex-col gap-4" aria-labelledby="docs-resumes">
            <Eyebrow as="h2" className="scroll-mt-4">
              <span id="docs-resumes">resumes</span>
            </Eyebrow>
            {docs === null && !listError ? <PanelState kind="loading" /> : null}
            {listError ? (
              <PanelState
                kind="error"
                title="Could not list your documents"
                body={listError}
                action={
                  <Button type="button" variant="outline" onClick={() => void refresh()}>
                    <Icon name="refresh" size={14} />
                    try again
                  </Button>
                }
              />
            ) : null}
            {docs !== null && resumes.length === 0 ? (
              <FieldHint tone="warn">
                No resume yet — Dispatch cannot apply without one.
              </FieldHint>
            ) : null}
            {resumes.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {resumes.map((d) => (
                  <DocumentLine
                    key={d.id}
                    doc={d}
                    busy={busy !== null}
                    onDefault={() => void act(`default-${d.id}`, () => setDefaultDocument(d.id))}
                    onRemove={() => void act(`remove-${d.id}`, () => removeDocument(d.id))}
                  />
                ))}
              </ul>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="resume-variant">variant</Label>
                <Input
                  id="resume-variant"
                  className="font-mono"
                  value={variant}
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => setVariant(e.target.value.toLowerCase())}
                />
                <FieldHint>
                  general for most roles; ds_ai for data science and ML roles. Uploading the
                  same variant again replaces it.
                </FieldHint>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="resume-file">resume PDF, 5 MB max</Label>
                <Input
                  id="resume-file"
                  type="file"
                  accept="application/pdf"
                  disabled={busy !== null}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    upload("resume", file);
                  }}
                />
              </div>
            </div>
          </section>

          <Separator />

          <section className="flex flex-col gap-4" aria-labelledby="docs-transcript">
            <Eyebrow as="h2">
              <span id="docs-transcript">transcript</span>
            </Eyebrow>
            {transcripts.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {transcripts.map((d) => (
                  <DocumentLine
                    key={d.id}
                    doc={d}
                    busy={busy !== null}
                    onRemove={() => void act(`remove-${d.id}`, () => removeDocument(d.id))}
                  />
                ))}
              </ul>
            ) : (
              <FieldHint>
                Optional. Some employers require an unofficial transcript; without one those
                applications become a to-do.
              </FieldHint>
            )}
            <div className="flex flex-col gap-2 sm:max-w-sm">
              <Label htmlFor="transcript-file">transcript PDF, 10 MB max</Label>
              <Input
                id="transcript-file"
                type="file"
                accept="application/pdf"
                disabled={busy !== null}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  upload("transcript", file);
                }}
              />
            </div>
          </section>
        </CardContent>
      </Card>
      <StepActions
        goBack={props.goBack}
        onNext={() => void props.goNext()}
        busy={busy !== null}
        status={
          <p className="m-0 font-mono text-xs text-text-dim" role="status" aria-live="polite">
            {busy?.startsWith("upload") ? "uploading…" : "uploads save the moment they finish"}
          </p>
        }
      />
    </div>
  );
}

function DocumentLine({
  doc,
  busy,
  onDefault,
  onRemove,
}: {
  doc: DocumentRow;
  busy: boolean;
  onDefault?: (() => void) | undefined;
  onRemove: () => void;
}): JSX.Element {
  return (
    <li className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-mono text-sm text-text">{doc.filename}</span>
        <span className="flex flex-wrap gap-2">
          <Badge variant="outline">{doc.variant}</Badge>
          {doc.is_default ? <Badge variant="secondary">default</Badge> : null}
        </span>
      </div>
      <div className="flex gap-2">
        {onDefault && !doc.is_default ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onDefault}>
            make default
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRemove}>
          <Icon name="x" size={14} />
          remove
        </Button>
      </div>
    </li>
  );
}
