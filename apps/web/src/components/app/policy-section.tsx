import { policyKnobsInput } from "@repo/contracts";
import { ArrowRightIcon } from "lucide-react";
import { useAppForm } from "~/components/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Field, FieldDescription, FieldGroup } from "~/components/ui/field";
import { Separator } from "~/components/ui/separator";
import { Skeleton } from "~/components/ui/skeleton";
import { useSavePolicy } from "~/lib/queries/mutations/policy";

interface PolicyView {
  readonly clusterId: string;
  readonly workloadAnalysis: boolean;
  readonly instantCreate: boolean;
  readonly observeWindowDays: number;
  readonly autoApplyScore: number | null;
  readonly changeWindowStartHour: number | null;
  readonly changeWindowEndHour: number | null;
  readonly inferredWindowReason: string | null;
}

// Each knob's bounds come off the api's own policy schema, so a day count this
// form accepts is one updatePolicy accepts. The form does not offer a
// collection-size ceiling, so that knob is dropped from the payload shape here
// and sent as "no ceiling" by the mutation.
const KNOBS = policyKnobsInput.shape;
const PAYLOAD = policyKnobsInput.omit({ maxCollectionSizeBytes: true });

// What the number under the auto-approve box means, which is the whole reason
// the field is worth a sentence: empty and 0 are opposites, and neither reads
// that way as a digit in a box.
function autoScoreHint(score: number | null): string {
  if (score === null) return "Empty: nothing is approved without you. 70 is a good starting point.";
  if (score === 0) return "0: every recommendation is approved automatically.";
  return `Only recommendations scoring ${score} or above.${
    score > 70 ? " Above ~85 very little qualifies." : ""
  }`;
}

// One hour of the change window: in range, and set only if the other one is too.
// Half a window is meaningless, and used to be silently completed by nulling the
// hour the reader had just typed — a number vanishing out of a box with no reason
// given. Refused instead, on whichever box is the empty one. Both hours carry the
// same bounds, so one schema checks either.
function hourError(hour: number | null, sibling: number | null): string | undefined {
  const range = KNOBS.changeWindowStartHour.safeParse(hour);
  if (!range.success) return range.error.issues[0]?.message;
  return hour === null && sibling !== null ? "Set both hours, or neither" : undefined;
}

// What the boxes hold, which is not quite what the api stores: every number can
// be cleared, and a cleared box is null. Three of them mean something as null;
// observeWindowDays does not, so the schema on the field refuses it and the save
// never happens — an empty observe window is an error rather than a value.
interface PolicyDraft {
  readonly workloadAnalysis: boolean;
  readonly instantCreate: boolean;
  readonly observeWindowDays: number | null;
  readonly autoApplyScore: number | null;
  readonly changeWindowStartHour: number | null;
  readonly changeWindowEndHour: number | null;
}

// The section's outline while the policy read is still out.
//
// It draws nothing that could be read as a value — no zeroes in the number
// boxes, no unticked checkboxes — because every knob here says what the engine
// is allowed to do on somebody's production cluster, and an unticked
// "Instant create" is a factual claim. What it does keep is the card, the title
// and the two rows of controls, so the page below it does not jump when the real
// form arrives (#72).
export function PolicySectionSkeleton() {
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="text-base">Policy</CardTitle>
        <CardDescription>
          The engine knobs for this cluster. Owner-only; the safety gates apply regardless.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5" aria-hidden="true">
        <div className="flex flex-wrap gap-6">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-5 w-44" />
        </div>
        <Separator />
        <div className="flex flex-wrap items-end gap-6">
          <Skeleton className="h-14 w-24" />
          <Skeleton className="h-14 w-24" />
          <Skeleton className="h-14 w-44" />
        </div>
        <Skeleton className="h-9 w-28" />
      </CardContent>
    </Card>
  );
}

// The engine knobs, owner-editable. Field changes stage locally; Save PUTs.
export function PolicySection({ policy }: { policy: PolicyView }) {
  const save = useSavePolicy();

  const draft: PolicyDraft = {
    workloadAnalysis: policy.workloadAnalysis,
    instantCreate: policy.instantCreate,
    observeWindowDays: policy.observeWindowDays,
    autoApplyScore: policy.autoApplyScore,
    changeWindowStartHour: policy.changeWindowStartHour,
    changeWindowEndHour: policy.changeWindowEndHour,
  };

  const form = useAppForm({
    defaultValues: draft,
    // Parsed rather than cast: the schema is what narrows the cleared-to-null
    // numbers back to numbers, and it cannot throw here because a value it would
    // reject never reaches submit — the same schema is on the field.
    onSubmit: ({ value }) => save.mutate({ clusterId: policy.clusterId, ...PAYLOAD.parse(value) }),
  });

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="text-base">Policy</CardTitle>
        <CardDescription>
          The engine knobs for this cluster. Owner-only; the safety gates apply regardless.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <div className="flex flex-wrap gap-6">
            <form.AppField name="workloadAnalysis">
              {(field) => (
                <field.CheckboxField
                  label="Workload analysis"
                  description="propose CREATE/UPDATE/MERGE/REORDER from query shapes"
                />
              )}
            </form.AppField>
            <form.AppField name="instantCreate">
              {(field) => (
                <field.CheckboxField
                  label="Instant create"
                  description="auto-build critical missing indexes"
                />
              )}
            </form.AppField>
          </div>

          <Separator />

          <FieldGroup className="flex-row flex-wrap items-end gap-6">
            <form.AppField
              name="observeWindowDays"
              validators={{ onChange: KNOBS.observeWindowDays }}
            >
              {(field) => (
                <field.NumberField
                  label="Observe window (days)"
                  className="w-24"
                  min={1}
                  max={365}
                />
              )}
            </form.AppField>

            <form.AppField name="autoApplyScore" validators={{ onChange: KNOBS.autoApplyScore }}>
              {(field) => (
                <field.NumberField
                  label="Auto-approve score ≥"
                  className="w-24"
                  min={0}
                  max={100}
                  placeholder="off"
                  description={autoScoreHint(field.state.value)}
                />
              )}
            </form.AppField>

            {/* The pair reads as one setting: the first box carries the label,
                the second only announces itself to a screen reader. */}
            <Field className="w-auto">
              <div className="flex items-end gap-2">
                <form.AppField
                  name="changeWindowStartHour"
                  validators={{
                    onChangeListenTo: ["changeWindowEndHour"],
                    onChange: ({ value, fieldApi }) =>
                      hourError(value, fieldApi.form.getFieldValue("changeWindowEndHour")),
                  }}
                >
                  {(field) => (
                    <field.NumberField
                      label="Change window (UTC hours)"
                      className="w-20"
                      min={0}
                      max={23}
                      placeholder="–"
                    />
                  )}
                </form.AppField>
                <ArrowRightIcon
                  aria-hidden="true"
                  className="mb-2.5 size-4 text-muted-foreground"
                />
                <form.AppField
                  name="changeWindowEndHour"
                  validators={{
                    onChangeListenTo: ["changeWindowStartHour"],
                    onChange: ({ value, fieldApi }) =>
                      hourError(value, fieldApi.form.getFieldValue("changeWindowStartHour")),
                  }}
                >
                  {(field) => (
                    <field.NumberField
                      label="Change window end hour"
                      hideLabel
                      className="w-20"
                      min={0}
                      max={23}
                      placeholder="–"
                    />
                  )}
                </form.AppField>
              </div>
              <form.Subscribe
                selector={(state) =>
                  state.values.changeWindowStartHour === null &&
                  state.values.changeWindowEndHour === null
                }
              >
                {(unset) =>
                  unset ? (
                    <FieldDescription>
                      {policy.inferredWindowReason ??
                        "Not enough traffic history yet to pick one — changes run at any hour until there is."}
                    </FieldDescription>
                  ) : null
                }
              </form.Subscribe>
            </Field>
          </FieldGroup>

          {/* Outside the FieldGroup, which is what every other card form here
              does (account-section) and what this card's own skeleton has always
              drawn. Inside it, the button was a fourth item in an `items-end`
              row of inputs — so it bottom-aligned against the change-window
              boxes and read as a control belonging to them rather than as the
              form's action. */}
          <form.AppForm>
            <form.SubmitButton pending={save.isPending}>Save policy</form.SubmitButton>
          </form.AppForm>
        </form>
        <p className="text-muted-foreground text-xs">
          Elective changes (hide, build, drop) run only inside the change window; safety rollbacks
          never wait. Leave it empty and Indexterity picks the cluster's quietest six hours itself —
          a start after the end wraps midnight.
        </p>
      </CardContent>
    </Card>
  );
}
