import { Injectable } from "@nestjs/common";
import type { IndexSpec } from "../engine/types";

// The indexes this pipeline never touches (#354). A leaf: it reads nothing else
// here, which is why `workload`, `reorder` and `recommend` can all depend on it.
@Injectable()
export class SafetyUtils {
  // Indexes that must never be auto-dropped regardless of usage, because
  // dropping one does something no latency gate can detect:
  //
  //   _id_      mandatory.
  //   unique    enforces a constraint; removing it permits duplicate data, and
  //             recreating the index afterwards will not undo them. This also
  //             covers unique partial/sparse indexes, the "unique among active
  //             documents" pattern.
  //   TTL       expires documents; low query usage is the normal state for one.
  //   shard key the cluster does not work without it.
  //
  // Partial and sparse indexes are NOT on this list. They used to be, on the
  // argument that low usage is expected for a deliberately narrow index — but
  // that is a statement about reading counters, and the pipeline does not rely on
  // counters alone: it hides, measures, and un-hides on regression. Taxonomy is
  // the wrong tool when the safety net is measurement. They still carry the usual
  // requirement of a trustworthy history, and a unique one is still protected
  // above.
  isNeverDrop(index: IndexSpec): boolean {
    if (index.name === "_id_") return true;
    if (index.unique) return true;
    if (index.ttl) return true;
    if (index.isShardKey) return true;
    return false;
  }
}
