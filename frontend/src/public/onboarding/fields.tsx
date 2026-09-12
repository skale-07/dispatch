import { useFormContext, useWatch } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { ScreenerQuestion } from "../contract";

/**
 * The wizard's field vocabulary, bound to the surrounding react-hook-form
 * context. Every field is a shadcn Form primitive (label ↔ control ↔
 * description ↔ message wired by id), 16px/44px on a phone via the
 * restyled Input. Text controls forward RHF's `ref` (Input/Textarea are
 * forwardRef'd) so Next focuses the first invalid field; Radix radios and
 * checkboxes take no ref — their errors are shown in place instead.
 */

type Option = { value: string; label: string };

const htmlId = (name: string, suffix = ""): string =>
  `f-${name.replace(/[^a-zA-Z0-9]+/g, "-")}${suffix ? `-${suffix}` : ""}`;

function OptionalMark(): JSX.Element {
  return <span className="font-regular text-text-faint"> (optional)</span>;
}

export function TextField({
  name,
  label,
  hint,
  optional,
  placeholder,
  type = "text",
  autoComplete,
  inputMode,
  suggestions,
}: {
  name: string;
  label: string;
  hint?: string | undefined;
  optional?: boolean | undefined;
  placeholder?: string | undefined;
  type?: "text" | "email" | "tel" | "url" | undefined;
  autoComplete?: string | undefined;
  inputMode?: "text" | "numeric" | "tel" | "email" | "url" | undefined;
  suggestions?: readonly string[] | undefined;
}): JSX.Element {
  const { control } = useFormContext();
  const listId = suggestions && suggestions.length > 0 ? htmlId(name, "suggestions") : null;
  return (
    <FormField
      control={control}
      name={name}
      render={({ field: { value, ...field } }) => (
        <FormItem>
          <FormLabel>
            {label}
            {optional ? <OptionalMark /> : null}
          </FormLabel>
          <FormControl>
            <Input
              {...field}
              value={typeof value === "string" ? value : ""}
              type={type}
              {...(autoComplete ? { autoComplete } : {})}
              {...(inputMode ? { inputMode } : {})}
              {...(placeholder ? { placeholder } : {})}
              {...(listId ? { list: listId } : {})}
            />
          </FormControl>
          {listId && suggestions ? (
            <datalist id={listId}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          ) : null}
          {hint ? <FormDescription className="text-xs text-text-dim">{hint}</FormDescription> : null}
          <FormMessage className="text-xs" />
        </FormItem>
      )}
    />
  );
}

export function LongTextField({
  name,
  label,
  hint,
  max,
  min,
  rows = 8,
  optional,
}: {
  name: string;
  label: string;
  hint?: string | undefined;
  max: number;
  min?: number | undefined;
  rows?: number | undefined;
  optional?: boolean | undefined;
}): JSX.Element {
  const { control } = useFormContext();
  const current: unknown = useWatch({ control, name });
  const length = typeof current === "string" ? current.trim().length : 0;
  return (
    <FormField
      control={control}
      name={name}
      render={({ field: { value, ...field } }) => (
        <FormItem>
          <FormLabel>
            {label}
            {optional ? <OptionalMark /> : null}
          </FormLabel>
          <FormControl>
            <Textarea
              {...field}
              value={typeof value === "string" ? value : ""}
              rows={rows}
              maxLength={max}
            />
          </FormControl>
          <FormDescription className="text-xs text-text-dim">
            {hint ? <>{hint} </> : null}
            <span className="font-mono">
              {length}/{max}
              {min ? ` · at least ${min}` : ""}
            </span>
          </FormDescription>
          <FormMessage className="text-xs" />
        </FormItem>
      )}
    />
  );
}

/** Radix radio values must be non-empty; "" (unanswered) rides this token. */
const UNSET = "unset";

export function ChoiceField({
  name,
  label,
  options,
  hint,
  unsetLabel,
}: {
  name: string;
  label: string;
  options: readonly Option[];
  hint?: string | undefined;
  /** When given, "" is offered as its own choice with this label. */
  unsetLabel?: string | undefined;
}): JSX.Element {
  const { control } = useFormContext();
  const all: Option[] = unsetLabel ? [...options, { value: "", label: unsetLabel }] : [...options];
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <RadioGroup
              aria-label={label}
              value={field.value === "" || typeof field.value !== "string" ? UNSET : field.value}
              onValueChange={(v: string) => {
                field.onChange(v === UNSET ? "" : v);
                field.onBlur();
              }}
              className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-6"
            >
              {all.map((o) => {
                const id = htmlId(name, o.value || UNSET);
                return (
                  <div key={id} className="flex min-h-11 items-center gap-3">
                    <RadioGroupItem value={o.value || UNSET} id={id} />
                    <Label htmlFor={id} className="font-regular">
                      {o.label}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
          </FormControl>
          {hint ? <FormDescription className="text-xs text-text-dim">{hint}</FormDescription> : null}
          <FormMessage className="text-xs" />
        </FormItem>
      )}
    />
  );
}

export function CheckboxGroupField({
  name,
  label,
  options,
}: {
  name: string;
  label: string;
  options: readonly Option[];
}): JSX.Element {
  const { control } = useFormContext();
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const chosen: string[] = Array.isArray(field.value) ? (field.value as string[]) : [];
        return (
          <FormItem>
            <p className="m-0 text-sm text-text">{label}</p>
            <div role="group" aria-label={label} className="flex flex-wrap gap-x-6">
              {options.map((o) => {
                const id = htmlId(name, o.value);
                return (
                  <div key={id} className="flex min-h-11 items-center gap-3">
                    <Checkbox
                      id={id}
                      checked={chosen.includes(o.value)}
                      onCheckedChange={(c: boolean | "indeterminate") => {
                        field.onChange(
                          c === true ? [...chosen, o.value] : chosen.filter((x) => x !== o.value),
                        );
                        field.onBlur();
                      }}
                    />
                    <Label htmlFor={id} className="font-regular">
                      {o.label}
                    </Label>
                  </div>
                );
              })}
            </div>
            <FormMessage className="text-xs" />
          </FormItem>
        );
      }}
    />
  );
}

export function CheckField({ name, label }: { name: string; label: string }): JSX.Element {
  const { control } = useFormContext();
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="flex min-h-11 flex-row items-center gap-3">
          <FormControl>
            <Checkbox
              checked={field.value === true}
              onCheckedChange={(c: boolean | "indeterminate") => {
                field.onChange(c === true);
                field.onBlur();
              }}
            />
          </FormControl>
          <FormLabel className="font-regular">{label}</FormLabel>
        </FormItem>
      )}
    />
  );
}

const YES_NO: readonly Option[] = [
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" },
];

/**
 * A registry screener question. Answers are stored VERBATIM ("Yes", a
 * city, "Two weeks") and the engine places them by choosing from each
 * page's own options; blank means "ask me per application".
 */
export function ScreenerField({ question }: { question: ScreenerQuestion }): JSX.Element {
  const name = `screeners.${question.key}`;
  if (question.kind === "yes_no") {
    return (
      <ChoiceField
        name={name}
        label={question.prompt}
        hint={question.hint}
        options={YES_NO}
        unsetLabel="ask me per application"
      />
    );
  }
  return (
    <TextField
      name={name}
      label={question.prompt}
      hint={question.hint}
      optional
      type={question.kind === "url" ? "url" : "text"}
      {...(question.kind === "url" ? { inputMode: "url" as const, placeholder: "https://…" } : {})}
      suggestions={question.suggestions}
    />
  );
}
