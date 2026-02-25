// arc UID is already stored as edge.id in your soundness Graph mapping.

export function sharedResourcesCommonAcrossAllCAS(casSet) {
  if (!casSet || casSet.length === 0) return new Set();

  const sets = casSet.map((g) => new Set((g.edges ?? []).map((e) => Number(e.id))));
  const out = new Set(sets[0]);

  for (let i = 1; i < sets.length; i++) {
    for (const x of out) if (!sets[i].has(x)) out.delete(x);
  }
  return out;
}

export function sharedResourcesAtLeastTwoCAS(casSet) {
  const seenOnce = new Set();
  const shared = new Set();

  for (const g of (casSet ?? [])) {
    const arcs = new Set((g.edges ?? []).map((e) => Number(e.id)));
    for (const a of arcs) {
      if (seenOnce.has(a)) shared.add(a);
      else seenOnce.add(a);
    }
  }

  return shared;
}