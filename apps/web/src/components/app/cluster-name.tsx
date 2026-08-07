import { renameClusterInput } from "@repo/contracts";
import { useAppForm } from "~/components/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useRenameCluster } from "~/lib/queries/mutations/cluster";

// The api's rule, not a second copy of it — the same object the connect form
// validates its Name field against.
const NAME = renameClusterInput.shape.name;

// A cluster's name, and the only way to change it.
//
// It used to be set once, at connect time, for the life of the cluster: the sole
// route to a different one was disconnect and reconnect, which deletes every
// snapshot, recommendation, ROI figure and audit row that cluster ever had. So a
// typo in a name cost three months of history, and a cluster connected as "test"
// during an evaluation kept announcing itself as "test" in production alert mail
// forever (#96).
//
// Keyed by the cluster in the caller, so switching clusters resets the field
// rather than carrying the previous one's name into it.
export function ClusterName({ cluster }: { cluster: { id: string; name: string } }) {
  const rename = useRenameCluster(cluster.id, {
    // The list refetches on success, and this component is re-keyed by the row it
    // draws — so nothing to do but leave the field showing what was saved.
    onRenamed: () => {},
  });

  const form = useAppForm({
    defaultValues: { name: cluster.name },
    onSubmit: ({ value }) => rename.mutate(value.name.trim()),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Name</CardTitle>
        <CardDescription>
          What this cluster is called in the sidebar, in its heading, and in the subject line of
          every alert about it. Renaming keeps all of its history — unlike disconnecting and
          connecting again. Two clusters in one organization cannot share a name.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.AppField name="name" validators={{ onChange: NAME }}>
            {(field) => <field.TextField label="Cluster name" className="w-64" hideLabel />}
          </form.AppField>
          {/* Disabled only when there is nothing to save — a request that sets a
              name to itself would raise a toast saying it changed. NOT disabled on
              validity: an empty field is refused by handleSubmit, which touches
              the field on the way and is what makes the message appear (see
              components/form.tsx). */}
          <form.Subscribe selector={(state) => state.values.name}>
            {(name) => (
              <form.AppForm>
                <form.SubmitButton disabled={rename.isPending || name.trim() === cluster.name}>
                  {rename.isPending ? "Saving…" : "Rename"}
                </form.SubmitButton>
              </form.AppForm>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  );
}
