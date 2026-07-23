// Times are local "HH:MM" (in the configured timezone), compared against the
// current local HH:MM. Assumes same-day shifts (no midnight crossing).
export type DayPlan =
  | { kind: "skip"; reason: string }
  | {
      kind: "active";
      targetIn: string; // jittered clock-in time, always before shiftStart
      targetOut: string; // jittered clock-out time, always after shiftEnd
      escalateInAt: string; // shiftStart − reactionBufferMin; urgent alert if not clocked in by then
      inDone: boolean;
      outDone: boolean;
      escalatedIn: boolean; // urgent "punch manually" email already sent this day
    };

const key = (dateKey: string) => `plan:${dateKey}`;

export async function getPlan(kv: KVNamespace, dateKey: string): Promise<DayPlan | null> {
  return kv.get<DayPlan>(key(dateKey), "json");
}

export async function savePlan(kv: KVNamespace, dateKey: string, plan: DayPlan): Promise<void> {
  // 3-day TTL: long enough to survive the day, short enough to self-clean.
  await kv.put(key(dateKey), JSON.stringify(plan), { expirationTtl: 60 * 60 * 24 * 3 });
}
