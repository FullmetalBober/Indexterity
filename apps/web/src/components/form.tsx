// The app's form vocabulary: TanStack Form bound once to shadcn's Field
// primitives, so a form is a list of what it asks for rather than a list of
// useState calls.
//
// Every field in this app repeats the same four things — a label, a control
// wired to some state, the description under it, and the error that replaces
// nothing when there is none. Written by hand that is ten lines per field and
// four chances to forget the `aria-invalid`; `createFormHook` lets each form say
// `<field.TextField label="Email" type="email" />` and get all of it.
//
// shadcn's own `form` component is not usable here: it is react-hook-form's
// Controller with a wrapper. `field` (Field/FieldLabel/FieldDescription/
// FieldError) is the form-library-agnostic half of the same design, and is what
// shadcn's TanStack Form guide composes against.
import { createFormHook, createFormHookContexts } from "@tanstack/react-form";
import type * as React from "react";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { field } from "~/lib/narrow";
import { cn } from "~/lib/utils";

const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts();

interface Chrome {
  readonly label: string;
  // Sits under the control. Left out entirely when absent — an empty <p> still
  // takes up the gap the layout reserved for it.
  readonly description?: React.ReactNode;
  // The label still exists for a screen reader, just not on screen. For fields
  // whose meaning comes from the one beside them (a window's end hour) or from
  // the thing they are sitting inside (an org's name, in its own title bar).
  readonly hideLabel?: boolean;
}

// Wrong is only worth saying once someone has been in the field: an "email is
// required" under an untouched empty box is a scolding rather than help. Submit
// touches every field, so a straight click still lights up whatever it must.
function invalidState(meta: { isTouched: boolean; isValid: boolean }): boolean {
  return meta.isTouched && !meta.isValid;
}

// A zod validator reports issue objects; a hand-written one (the two cross-field
// rules in this app) reports a plain string. FieldError only reads `.message`, so
// it would silently render nothing for the second kind.
//
// The key is omitted rather than set to undefined for anything that is not a
// string, because FieldError's own prop type is `{ message?: string }` — narrow,
// and not ours to widen. Which is the honest shape anyway: an issue object whose
// `message` is a number has no message, and that is the same answer as an issue
// object with no `message` at all.
function asMessages(errors: readonly unknown[]): Array<{ message?: string }> {
  return errors.map((error) => {
    if (typeof error === "string") return { message: error };
    const message = field(error, "message");
    return typeof message === "string" ? { message } : {};
  });
}

type ControlProps = Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onBlur">;

function TextField({ label, description, hideLabel, id, ...props }: Chrome & ControlProps) {
  const field = useFieldContext<string>();
  const invalid = invalidState(field.state.meta);
  const controlId = id ?? field.name;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={controlId} className={cn(hideLabel && "sr-only")}>
        {label}
      </FieldLabel>
      <Input
        id={controlId}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
        aria-invalid={invalid}
        {...props}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {invalid ? <FieldError errors={asMessages(field.state.meta.errors)} /> : null}
    </Field>
  );
}

// The same field for something that arrives as a whole file rather than as a
// value somebody types — a wg0.conf, pasted. Monospaced by default, because what
// goes in one is read back for a mistyped key, and spellcheck off for the same
// reason: every line of it is underlined otherwise.
function TextareaField({
  label,
  description,
  hideLabel,
  id,
  className,
  ...props
}: Chrome & Omit<React.ComponentProps<typeof Textarea>, "value" | "onChange" | "onBlur">) {
  const field = useFieldContext<string>();
  const invalid = invalidState(field.state.meta);
  const controlId = id ?? field.name;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={controlId} className={cn(hideLabel && "sr-only")}>
        {label}
      </FieldLabel>
      <Textarea
        id={controlId}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
        aria-invalid={invalid}
        spellCheck={false}
        className={cn("font-mono text-sm", className)}
        {...props}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {invalid ? <FieldError errors={asMessages(field.state.meta.errors)} /> : null}
    </Field>
  );
}

// Empty means null, not 0 and not NaN. Three of the four numbers in this app are
// nullable and the null is the interesting value — an empty auto-approve score
// is "nothing is approved without me", which a 0 would invert.
function NumberField({ label, description, hideLabel, id, ...props }: Chrome & ControlProps) {
  const field = useFieldContext<number | null>();
  const invalid = invalidState(field.state.meta);
  const controlId = id ?? field.name;
  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={controlId} className={cn(hideLabel && "sr-only")}>
        {label}
      </FieldLabel>
      <Input
        id={controlId}
        name={field.name}
        type="number"
        value={field.state.value ?? ""}
        onBlur={field.handleBlur}
        onChange={(event) =>
          field.handleChange(event.target.value === "" ? null : Number(event.target.value))
        }
        aria-invalid={invalid}
        {...props}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {invalid ? <FieldError errors={asMessages(field.state.meta.errors)} /> : null}
    </Field>
  );
}

function CheckboxField({ label, description }: Chrome) {
  const field = useFieldContext<boolean>();
  return (
    <Field orientation="horizontal">
      <Checkbox
        id={field.name}
        name={field.name}
        checked={field.state.value}
        onBlur={field.handleBlur}
        onCheckedChange={(checked) => field.handleChange(checked === true)}
      />
      <FieldContent>
        {/* The one label in this app that is a click target and nothing else.
            Nobody copies "Instant create"; they do double-click it to toggle,
            and a highlighted word flashing under the cursor on the way looks
            like a misfire. Labels are selectable by default (ui/label.tsx) —
            this is the exception, not the rule. */}
        <FieldLabel className="select-none" htmlFor={field.name}>
          {label}
        </FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </FieldContent>
    </Field>
  );
}

// Deliberately NOT disabled on `canSubmit`, which is the obvious wiring and the
// wrong one. handleSubmit already refuses an invalid form, and it does something
// a disabled button cannot: it touches every field on the way, which is what
// makes the errors appear. Gate the button on validity instead and a form can
// reach a state where the button is grey, nothing is highlighted, and no click
// will explain why — the change window's pair of hours does exactly that, since
// filling one invalidates the other before the reader has been anywhere near it.
//
// `pending` is the mutation's, not the form's: the mutation hooks own the request
// and its cache invalidation (see lib/queries/mutations), so the form does not
// await one and `isSubmitting` would read false throughout.
function SubmitButton({
  children,
  pending = false,
  ...props
}: React.ComponentProps<typeof Button> & { readonly pending?: boolean }) {
  const form = useFormContext();
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(isSubmitting) => (
        <Button type="submit" disabled={isSubmitting || pending} {...props}>
          {children}
        </Button>
      )}
    </form.Subscribe>
  );
}

export const { useAppForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { TextField, TextareaField, NumberField, CheckboxField },
  formComponents: { SubmitButton },
});
