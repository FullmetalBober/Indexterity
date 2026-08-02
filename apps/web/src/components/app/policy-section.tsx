import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Separator } from "~/components/ui/separator";
import { savePolicy } from "~/lib/app-server";

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

// The engine knobs, owner-editable. Checkbox changes stage locally; Save PUTs.
export function PolicySection({ policy, onSaved }: { policy: PolicyView; onSaved: () => void }) {
  const [workloadAnalysis, setWorkloadAnalysis] = useState(policy.workloadAnalysis);
  const [instantCreate, setInstantCreate] = useState(policy.instantCreate);
  const [observeDays, setObserveDays] = useState(policy.observeWindowDays);
  const [autoScore, setAutoScore] = useState(policy.autoApplyScore);
  const [windowStart, setWindowStart] = useState(policy.changeWindowStartHour);
  const [windowEnd, setWindowEnd] = useState(policy.changeWindowEndHour);

  async function onSave() {
    const result = await savePolicy({
      data: {
        clusterId: policy.clusterId,
        workloadAnalysis,
        instantCreate,
        observeWindowDays: observeDays,
        autoApplyScore: autoScore,
        // Half-set windows are meaningless — persist only a complete pair.
        changeWindowStartHour: windowEnd === null ? null : windowStart,
        changeWindowEndHour: windowStart === null ? null : windowEnd,
      },
    }).catch(() => ({ ok: false }));
    if (result.ok) {
      toast.success("Policy saved");
      onSaved();
    } else {
      toast.error("Policy not saved (owner only)");
    }
  }

  const toggles: Array<{
    id: string;
    label: string;
    hint: string;
    value: boolean;
    set: (v: boolean) => void;
  }> = [
    {
      id: "policy-workload",
      label: "Workload analysis",
      hint: "propose CREATE/UPDATE/MERGE from query shapes",
      value: workloadAnalysis,
      set: setWorkloadAnalysis,
    },
    {
      id: "policy-instant-create",
      label: "Instant create",
      hint: "auto-build critical missing indexes",
      value: instantCreate,
      set: setInstantCreate,
    },
  ];

  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle className="text-base">Policy</CardTitle>
        <CardDescription>
          The engine knobs for this cluster. Owner-only; the safety gates apply regardless.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-wrap gap-6">
          {toggles.map((toggle) => (
            <div key={toggle.label} className="flex items-start gap-2">
              <Checkbox
                id={toggle.id}
                checked={toggle.value}
                onCheckedChange={(checked) => toggle.set(checked === true)}
              />
              <div className="grid gap-0.5 leading-none">
                <Label htmlFor={toggle.id}>{toggle.label}</Label>
                <p className="text-muted-foreground text-xs">{toggle.hint}</p>
              </div>
            </div>
          ))}
        </div>

        <Separator />

        <div className="flex flex-wrap items-end gap-6">
          <div className="grid gap-1.5">
            <Label htmlFor="observe-days">Observe window (days)</Label>
            <Input
              id="observe-days"
              type="number"
              min={1}
              max={365}
              className="w-24"
              value={observeDays}
              onChange={(event) => setObserveDays(Number(event.target.value))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="auto-score">Auto-approve score ≥</Label>
            <Input
              id="auto-score"
              type="number"
              min={0}
              max={100}
              placeholder="off"
              className="w-24"
              value={autoScore ?? ""}
              onChange={(event) =>
                setAutoScore(event.target.value === "" ? null : Number(event.target.value))
              }
            />
            <p className="text-muted-foreground text-xs">
              {autoScore === null
                ? "Empty: nothing is approved without you. 70 is a good starting point."
                : autoScore === 0
                  ? "0: every recommendation is approved automatically."
                  : `Only recommendations scoring ${autoScore} or above.${
                      autoScore > 70 ? " Above ~85 very little qualifies." : ""
                    }`}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="window-start">Change window (UTC hours)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="window-start"
                type="number"
                min={0}
                max={23}
                placeholder="–"
                className="w-20"
                value={windowStart ?? ""}
                onChange={(event) =>
                  setWindowStart(event.target.value === "" ? null : Number(event.target.value))
                }
              />
              <span className="text-muted-foreground">→</span>
              <Input
                aria-label="Change window end hour"
                type="number"
                min={0}
                max={23}
                placeholder="–"
                className="w-20"
                value={windowEnd ?? ""}
                onChange={(event) =>
                  setWindowEnd(event.target.value === "" ? null : Number(event.target.value))
                }
              />
            </div>
            {windowStart === null || windowEnd === null ? (
              <p className="text-muted-foreground text-xs">
                {policy.inferredWindowReason ??
                  "Not enough traffic history yet to pick one — changes run at any hour until there is."}
              </p>
            ) : null}
          </div>
          <Button onClick={() => void onSave()}>Save policy</Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Elective changes (hide, build, drop) run only inside the change window; safety rollbacks
          never wait. Leave it empty and Indexterity picks the cluster's quietest six hours itself —
          a start after the end wraps midnight.
        </p>
      </CardContent>
    </Card>
  );
}
