import { createOrgInput } from "@repo/contracts";
import { useAppForm } from "~/components/form";
import { useCreateOrg } from "~/lib/queries/mutations/org";

// Making an organization, in the two places it can be done: the screen someone
// with none lands on, and the organization page, where somebody who already has
// one makes their next.
//
// One component rather than two copies of the same field, because the second
// place did not exist at first and the limit it has to respect is the reason it
// does now — a plan that allows five orgs and a dashboard that only offers the
// first is an entitlement nobody can spend.
//
// `label` differs because the two readings differ: the first is the only thing
// on the page, the second sits under a heading that has already said it.
export function CreateOrgForm({
  label = "Organization name",
  submitLabel = "Create",
}: {
  readonly label?: string;
  readonly submitLabel?: string;
}) {
  const create = useCreateOrg();

  const form = useAppForm({
    defaultValues: { name: "" },
    onSubmit: ({ value }) => {
      create.mutate(value.name, { onSuccess: () => form.reset() });
    },
  });

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.AppField name="name" validators={{ onChange: createOrgInput.shape.name }}>
        {(field) => <field.TextField label={label} className="w-64" placeholder="Acme" />}
      </form.AppField>
      <form.AppForm>
        <form.SubmitButton pending={create.isPending}>{submitLabel}</form.SubmitButton>
      </form.AppForm>
    </form>
  );
}
