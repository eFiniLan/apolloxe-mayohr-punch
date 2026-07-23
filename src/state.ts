export type DayPlan =
  | { kind: "skip"; reason: string }
  | { kind: "active"; targetIn: string; targetOut: string; inDone: boolean; outDone: boolean };

const key = (dateKey: string) => `plan:${dateKey}`;

export async function getPlan(kv: KVNamespace, dateKey: string): Promise<DayPlan | null> {
  return kv.get<DayPlan>(key(dateKey), "json");
}

export async function savePlan(kv: KVNamespace, dateKey: string, plan: DayPlan): Promise<void> {
  // 3-day TTL: long enough to survive the day, short enough to self-clean.
  await kv.put(key(dateKey), JSON.stringify(plan), { expirationTtl: 60 * 60 * 24 * 3 });
}
