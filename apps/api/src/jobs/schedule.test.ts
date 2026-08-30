import { describe, expect, it } from "vitest";
import type { Database } from "../db";
import { stub } from "../test-utils";
import type { ClusterTasksService } from "./cluster-tasks.service";
import { BURST_SCHEDULE, duePasses } from "./schedule";
import { createTaskList } from "./tasks";

const at = (iso: string): Date => new Date(iso);

describe("BURST_SCHEDULE", () => {
  // This list used to be held to the resident runner's CRONTAB; #232 removed
  // that runner, so this is the only schedule and the drift that can still rot
  // silently is the pairing with the task list itself: a pass naming a task
  // nobody registered is enqueued forever and executed never. createTaskList
  // only closes over its db, so a null stands in fine for reading the keys.
  it("schedules only tasks the task list registers", () => {
    const registered = new Set(
      Object.keys(createTaskList(stub<Database>({}), stub<ClusterTasksService>({}))),
    );
    for (const pass of BURST_SCHEDULE) expect(registered).toContain(pass.task);
  });

  it("carries the cron entry each pass stands for, so the two read side by side", () => {
    for (const pass of BURST_SCHEDULE) expect(pass.cron).toMatch(/[\d*]/);
  });
});

describe("occurrences", () => {
  const occurrenceOf = (task: string, now: string): string => {
    const pass = BURST_SCHEDULE.find((entry) => entry.task === task);
    if (pass === undefined) throw new Error(`no pass ${task}`);
    return pass.occurrenceAt(at(now)).toISOString();
  };

  it("floors a five-minute pass to its bucket", () => {
    expect(occurrenceOf("scheduleApply", "2026-08-15T10:07:31.500Z")).toBe(
      "2026-08-15T10:05:00.000Z",
    );
    expect(occurrenceOf("scheduleApply", "2026-08-15T10:00:00.000Z")).toBe(
      "2026-08-15T10:00:00.000Z",
    );
  });

  it("floors an hourly pass to the hour", () => {
    expect(occurrenceOf("scheduleCollect", "2026-08-15T10:59:59.999Z")).toBe(
      "2026-08-15T10:00:00.000Z",
    );
  });

  // The anchors are the reason occurrences are computed at all rather than
  // intervals measured: retention at 03:00 and the digest on Monday at 09:00
  // would otherwise drift to whenever the cron service first got round to it,
  // and the digest is a customer-facing email.
  it("keeps retention on 03:00, using yesterday's before the hour comes round", () => {
    expect(occurrenceOf("retention", "2026-08-15T04:00:00.000Z")).toBe("2026-08-15T03:00:00.000Z");
    expect(occurrenceOf("retention", "2026-08-15T02:59:00.000Z")).toBe("2026-08-14T03:00:00.000Z");
  });

  it("keeps the digest on Monday 09:00", () => {
    // 2026-08-17 is a Monday.
    expect(occurrenceOf("digest", "2026-08-17T09:00:00.000Z")).toBe("2026-08-17T09:00:00.000Z");
    expect(occurrenceOf("digest", "2026-08-17T08:59:00.000Z")).toBe("2026-08-10T09:00:00.000Z");
    expect(occurrenceOf("digest", "2026-08-19T12:00:00.000Z")).toBe("2026-08-17T09:00:00.000Z");
  });
});

describe("duePasses", () => {
  it("calls everything due on a fresh install, so the first tick starts the pipeline", () => {
    const due = duePasses(at("2026-08-15T10:07:00.000Z"), new Map());
    expect(due.map((entry) => entry.pass.task)).toEqual(BURST_SCHEDULE.map((pass) => pass.task));
  });

  // The property the whole design rests on: two ticks inside one bucket compute
  // the SAME occurrence, so the second one's claim fails and nothing dispatches
  // twice. An "has the interval elapsed" reading would have needed a lock.
  it("is idempotent inside a bucket", () => {
    const dispatched = new Map([["scheduleApply", at("2026-08-15T10:05:00.100Z")]]);
    const again = duePasses(at("2026-08-15T10:09:59.000Z"), dispatched);
    expect(again.map((entry) => entry.pass.task)).not.toContain("scheduleApply");
  });

  it("comes due again in the next bucket", () => {
    const dispatched = new Map([["scheduleApply", at("2026-08-15T10:05:00.100Z")]]);
    const next = duePasses(at("2026-08-15T10:10:00.000Z"), dispatched);
    expect(next.map((entry) => entry.pass.task)).toContain("scheduleApply");
  });

  // A host that slept through eleven buckets does not owe eleven runs. The
  // occurrence is the LATEST one, so catching up is one pass, not a backlog
  // that would dial every cluster eleven times over.
  it("collapses a long sleep into one run per pass", () => {
    const dispatched = new Map([["scheduleApply", at("2026-08-15T09:05:00.000Z")]]);
    const due = duePasses(at("2026-08-15T10:07:00.000Z"), dispatched).filter(
      (entry) => entry.pass.task === "scheduleApply",
    );
    expect(due).toHaveLength(1);
    expect(due[0]?.occurrence.toISOString()).toBe("2026-08-15T10:05:00.000Z");
  });
});
