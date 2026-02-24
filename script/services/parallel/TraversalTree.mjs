// script/services/parallel/TraversalTree.mjs
import { parseRDLT } from "../convert/rdlt2pn/modules/parser.js";

const EPS = "ϵ";

// ==========================================
// Utility Functions
// ==========================================

function edgeKey(e, idx) {
  return `${e.from}->${e.to}#${idx}`;
}

function buildAdjacency(edges) {
  const out = new Map();
  const inc = new Map();
  edges.forEach((e, idx) => {
    const { from, to } = e;
    if (!out.has(from)) out.set(from, []);
    if (!inc.has(to)) inc.set(to, []);
    out.get(from).push({ ...e, __idx: idx });
    inc.get(to).push({ ...e, __idx: idx });
  });
  return { out, inc };
}

function initT(edges) {
  const T = new Map();
  edges.forEach((e, idx) => {
    const L = Number(e.L ?? 1);
    T.set(edgeKey(e, idx), Array(Math.max(0, L)).fill(0));
  });
  return T;
}

function cloneT(T) {
  const newT = new Map();
  for (const [k, v] of T.entries()) {
    newT.set(k, [...v]);
  }
  return newT;
}

function mergeT(T_list) {
  if (T_list.length === 0) return new Map();
  const baseT = cloneT(T_list[0]);
  for (let i = 1; i < T_list.length; i++) {
    const otherT = T_list[i];
    for (const [k, v] of otherT.entries()) {
      const baseV = baseT.get(k);
      for (let j = 0; j < v.length; j++) {
        if (v[j] > baseV[j]) baseV[j] = v[j];
      }
    }
  }
  return baseT;
}

function maxTime(vec) {
  let m = 0;
  for (const x of vec) if (x > m) m = x;
  return m;
}

function maxIncomingTime(v, inc, T) {
  const incoming = inc.get(v) ?? [];
  let m = 0;
  for (const e of incoming) {
    const vec = T.get(edgeKey(e, e.__idx));
    if (!vec) continue;
    const t = maxTime(vec);
    if (t > m) m = t;
  }
  return m;
}

function hasCapacity(T, e) {
  const vec = T.get(edgeKey(e, e.__idx));
  if (!vec) return false;
  return vec.indexOf(0) !== -1;
}

function checkArc(x, e, inc, T) {
  const vec = T.get(edgeKey(e, e.__idx));
  if (!vec) return { ok: false, timeAssigned: null, slot: -1 };

  const slot = vec.indexOf(0);
  if (slot === -1) return { ok: false, timeAssigned: null, slot: -1 };

  const t = maxIncomingTime(x, inc, T) + 1;
  return { ok: true, timeAssigned: t, slot };
}

function commitArc(x, e, inc, T, timeAssigned, slot) {
  const vec = T.get(edgeKey(e, e.__idx));
  if (vec && slot !== -1 && slot < vec.length) {
    vec[slot] = timeAssigned;
  }
}

function inSigma(c) {
  return c != null && c !== "" && c !== EPS;
}

function traversalsOnArc(T, e) {
  const vec = T.get(edgeKey(e, e.__idx)) ?? [];
  let n = 0;
  for (const t of vec) if (t > 0) n++;
  return n;
}

function hasBeenTraversed(T, e) {
  const vec = T.get(edgeKey(e, e.__idx)) ?? [];
  return vec.some((t) => t > 0);
}

/**
 * NOTE: This still uses the “all incoming arcs” view since your JSON input
 * doesn’t encode RBS membership / bridge type, so we can’t compute “type-alike”
 * exactly. But we *do* add the missing Ancestors + updateConstraints behavior
 * so the engine follows the algorithm’s intent much more closely.
 */
function isUnconstrained(e, inc, T) {
  const incoming = inc.get(e.to) ?? [];
  if (incoming.length <= 1) return true;

  const Cxy = e.C ?? EPS;

  for (const v of incoming) {
    if (v.__idx === e.__idx) continue;

    const LVY = Number.isInteger(v.L) ? v.L : Number(v.L ?? 1);
    const nVY = traversalsOnArc(T, v);

    if (nVY >= LVY) continue;

    const Cvy = v.C ?? EPS;
    if (Cvy === EPS || Cvy === Cxy) continue;

    const nXY = traversalsOnArc(T, e);

    if (nXY <= nVY && nVY <= LVY) continue;
    if (inSigma(Cvy) && Cxy === EPS && hasBeenTraversed(T, v)) continue;

    return false;
  }

  return true;
}

// ==========================================
// Reality (Lineage) Tracking Helpers
// ==========================================

function realityToString(r) {
  return Object.entries(r)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((x) => `${x[0]}:${x[1]}`)
    .join(",");
}

function areRealitiesCompatible(arr) {
  const merged = {};
  for (const r of arr) {
    for (const k in r) {
      if (k in merged && merged[k] !== r[k]) return null;
      merged[k] = r[k];
    }
  }
  return merged;
}

function createNode(id, v, S, time, reality, T, pending = false) {
  // `pathVertices` approximates Algorithm 1's `Ancestors` concept on a per-branch basis.
  // It stores the vertex lineage from the root to this node (inclusive).
  return {
    id,
    v,
    S,
    time,
    reality,
    T,
    pending,
    processed: false,
    parents: [],
    children: [],
    pathVertices: [v],
  };
}

function link(p, c) {
  if (!p.children.includes(c)) p.children.push(c);
  if (!c.parents.includes(p)) c.parents.push(p);
}

function leaves(nodes) {
  return nodes.filter((n) => n.children.length === 0);
}

function appendConstraint(S, e) {
  return [...S, e.C ?? "ϵ"];
}

function computeSourceSink(vertices, edges) {
  const incCount = Object.create(null);
  const outCount = Object.create(null);
  vertices.forEach((v) => {
    incCount[v.id] = 0;
    outCount[v.id] = 0;
  });
  edges.forEach((e) => {
    outCount[e.from] = (outCount[e.from] ?? 0) + 1;
    incCount[e.to] = (incCount[e.to] ?? 0) + 1;
  });
  const sources = Object.keys(incCount).filter((id) => incCount[id] === 0);
  const sinks = Object.keys(outCount).filter((id) => outCount[id] === 0);
  return { sources, sinks };
}

function classifySplit(out, x) {
  const outgoing = out.get(x) ?? [];
  if (outgoing.length < 2) return "NONE";

  const Cs = outgoing.map((a) => a.C ?? EPS);
  const distinct = new Set(Cs).size;
  const hasEps = Cs.some((c) => c === EPS);
  const sigmas = Cs.filter((c) => inSigma(c));
  const distinctSigmas = new Set(sigmas).size;

  if (distinct === 1) return "OR_SPLIT";
  if (!hasEps && distinctSigmas >= 2) return "AND_SPLIT";
  if (hasEps && sigmas.length > 0) return "MIX_SPLIT";

  return "NONE";
}

function classifyJoin(inc, y) {
  const incoming = inc.get(y) ?? [];
  if (incoming.length < 2) return "NONE";

  const Cs = incoming.map((a) => a.C ?? EPS);
  const distinct = new Set(Cs).size;
  const hasEps = Cs.some((c) => c === EPS);
  const sigmas = Cs.filter((c) => inSigma(c));
  const distinctSigmas = new Set(sigmas).size;

  if (distinct === 1) return "OR";
  if (!hasEps && distinctSigmas >= 2) return "AND";
  if (hasEps && sigmas.length > 0) return "MIX";

  return "NONE";
}

function cartesian(arrays) {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const sub = cartesian(rest);
  return first.flatMap((val) => sub.map((s) => [val, ...s]));
}

// ==========================================
// Main Traversal Tree Generator
// ==========================================

export function generateTraversalTreeFromJSON(
  input,
  { sourceId = null, sinkId = null } = {},
) {
  parseRDLT(input, false);

  const { vertices, edges } = input;
  const { sources, sinks } = computeSourceSink(vertices, edges);

  if (!sourceId) sourceId = sources[0];
  if (!sinkId) sinkId = sinks[0];
  if (!sourceId || !sinkId) return 0;

  let nodeIdCounter = 1;

  const { out, inc } = buildAdjacency(edges);

  const { sccIdOf, sccs } = computeSCCs(vertices, out);
  const cycleSCCs = computeCycleSCCSet(sccs, out, sccIdOf);

  const criticalArcsByScc = new Map();
  for (const sccId of cycleSCCs) {
    const comp = sccs[sccId];
    let minL = Infinity;
    let cArcs = [];
    for (const vId of comp) {
      const outs = out.get(vId) ?? [];
      for (const e of outs) {
        if (sccIdOf.get(e.to) === sccId) {
          const L = Number(e.L ?? 1);
          if (L < minL) {
            minL = L;
            cArcs = [e];
          } else if (L === minL) {
            cArcs.push(e);
          }
        }
      }
    }
    criticalArcsByScc.set(sccId, cArcs);
  }

  const all = [];
  const nodeIndex = new Map();
  const trByTime = new Map();

  const andJoinBuffer = new Map();
  const mixBuffer = new Map();

  const delayedEdges = [];

  function getOrCreateNode(v, S, time, reality, T, pending = false) {
    const key = `${v}|t${time}|${JSON.stringify(S)}|r${realityToString(reality)}|p${
      pending ? 1 : 0
    }`;
    const existing = nodeIndex.get(key);
    if (existing) return existing;

    const n = createNode(nodeIdCounter++, v, S, time, reality, T, pending);
    nodeIndex.set(key, n);
    all.push(n);
    return n;
  }

  // ==========================================
  // Algorithm 1 alignment helpers
  // ==========================================

  function isAncestorVertex(node, vId) {
    return (node.pathVertices ?? []).includes(vId);
  }

  function inheritPath(parent, child) {
    const p = parent?.pathVertices ?? [];
    child.pathVertices = [...p, child.v];
  }

  // Approximate Algorithm 1's constraint-propagation update when entering a merge/ancestor.
  // We stamp the same time into the first available slot of other incoming arcs to `y`.
  function stampSatisfiedIncomingArcs(y, chosenEdge, nextT, timeAssigned) {
    const incoming = inc.get(y) ?? [];
    if (incoming.length <= 1) return;

    for (const vEdge of incoming) {
      if (vEdge.__idx === chosenEdge.__idx) continue;
      const vec = nextT.get(edgeKey(vEdge, vEdge.__idx));
      if (!vec) continue;
      const slot = vec.indexOf(0);
      if (slot === -1) continue;
      vec[slot] = timeAssigned;
    }
  }

  function commonPrefix(arrays) {
    if (!arrays.length) return [];
    let i = 0;
    while (true) {
      const val = arrays[0][i];
      if (val === undefined) return arrays[0].slice(0, i);
      for (let k = 1; k < arrays.length; k++) {
        if (arrays[k][i] !== val) return arrays[0].slice(0, i);
      }
      i++;
    }
  }

  function mergeHistories(histories) {
    const prefix = commonPrefix(histories);
    const suffixes = histories.map((h) => h.slice(prefix.length));
    const merged = [...prefix];

    for (const suf of suffixes) {
      for (const tok of suf) {
        if (merged.length === 0 || merged[merged.length - 1] !== tok) {
          merged.push(tok);
        }
      }
    }
    return merged;
  }

  function formatTraversalResults(sinksToGroup, rootNode) {
    const byTime = new Map();
    for (const n of sinksToGroup) {
      if (!byTime.has(n.time)) byTime.set(n.time, []);
      byTime.get(n.time).push(n);
    }

    const parallelGroups = [];
    const nonParallelGroups = [];
    const isOverallParallel = sinksToGroup.length > 1;

    for (const [t, group] of byTime.entries()) {
      if (isOverallParallel) {
        parallelGroups.push({ time: t, branches: group });
      } else {
        nonParallelGroups.push({ time: t, branches: group });
      }
    }

    const joinTypeByV = Object.create(null);
    const splitTypeByV = Object.create(null);
    for (const v of vertices) {
      joinTypeByV[v.id] = classifyJoin(inc, v.id);
      splitTypeByV[v.id] = classifySplit(out, v.id);
    }

    console.log("Traversal Tree Generation Complete:");
    console.log(`- Total Traversals: ${sinksToGroup.length}`);
    console.log(`- Parallel Groups: ${parallelGroups.length}`);
    console.log(`- Non-Parallel Groups: ${nonParallelGroups.length}`);

    const printS = (S) => `S([${(S ?? []).join(",")}])`;

    if (parallelGroups.length > 0) {
      console.log("\n🟢 PARALLEL BRANCHES:");
      for (const group of parallelGroups) {
        console.log(`  Time = ${group.time}:`);
        for (const b of group.branches) {
          console.log(`    -> Node: ${b.v} | Path: ${printS(b.S)}`);
        }
      }
    }

    if (nonParallelGroups.length > 0) {
      console.log("\n🟡 NON-PARALLEL BRANCHES:");
      for (const group of nonParallelGroups) {
        console.log(`  Time = ${group.time}:`);
        for (const b of group.branches) {
          console.log(`    -> Node: ${b.v} | Path: ${printS(b.S)}`);
        }
      }
    }
    console.log("===========================\n");

    return {
      root: rootNode,
      allNodes: all,
      trByTime,
      parallelGroups,
      nonParallelGroups,
      sourceId,
      sinkId,
      joinTypeByV,
      splitTypeByV,
    };
  }

  // ✅ INITIALIZE: Base T mapping and Empty Reality
  const initialT = initT(edges);
  const root = getOrCreateNode(sourceId, [0], 1, {}, initialT, false);
  root.pathVertices = [sourceId];

  while (true) {
    let progressed = false;

    // Algorithm 1 tracks a set of already-visited/established vertices (Ancestors).
    // We approximate this as vertices that already exist somewhere in Tr.
    // Used to validate ancestral/back-edge traversals.
    const Ancestors = new Set(all.map((n) => n.v));

    const X = leaves(all).filter((n) => !n.pending && !n.processed);
    const continuing = X.filter(
      (n) => n.v !== sinkId && (out.get(n.v) ?? []).length > 0,
    );
    const sinksHere = X.filter((n) => n.v === sinkId);

    if (
      sinksHere.length > 0 &&
      continuing.length === 0 &&
      delayedEdges.length === 0
    ) {
      const allFinalLeaves = leaves(all).filter((n) => !n.pending);
      return formatTraversalResults(allFinalLeaves, root);
    }

    const edgesToProcess = [];

    // 1. Gather normal active leaves
    for (const xNode of X) {
      xNode.processed = true;
      const x = xNode.v;
      const outs = out.get(x) ?? [];

      const xScc = sccIdOf.get(x);
      const inCycle = xScc != null && cycleSCCs.has(xScc);

      let allowedOuts = outs;

      if (inCycle) {
        const cArcs = criticalArcsByScc.get(xScc);
        const cycleExhausted = cArcs.some((e) => !hasCapacity(xNode.T, e));

        const cycleEdges = outs.filter((e) => sccIdOf.get(e.to) === xScc);
        const nonCycleEdges = outs.filter((e) => sccIdOf.get(e.to) !== xScc);

        if (!cycleExhausted) {
          allowedOuts = cycleEdges;
        } else {
          allowedOuts =
            nonCycleEdges.length > 0 ? nonCycleEdges : cycleEdges;
        }
      }

      for (const e of allowedOuts) {
        edgesToProcess.push({ xNode, e });
      }
    }

    // 2. Gather unblocked delayed edges
    for (let i = delayedEdges.length - 1; i >= 0; i--) {
      const { xNode, e } = delayedEdges[i];
      if (isUnconstrained(e, inc, xNode.T)) {
        delayedEdges.splice(i, 1);
        edgesToProcess.push({ xNode, e });
      }
    }

    if (edgesToProcess.length === 0 && !progressed) {
      const allFinalLeaves = leaves(all).filter((n) => !n.pending);
      return formatTraversalResults(allFinalLeaves, root);
    }

    // ==========================================
    // TWO-PASS SYSTEM TO PREVENT CROSS-CONTAMINATION
    // ==========================================
    const touchedAndJoins = new Set();
    const touchedMixJoins = new Set();

    // PASS 1: Accumulate arrivals
    for (const { xNode, e } of edgesToProcess) {
      // If this edge points back to a vertex already on the current branch lineage,
      // treat it as an ancestral/back-edge and require that the target is already
      // established in the traversal tree (Algorithm 1's `yj is in Ancestors`).
      const isAncestral = isAncestorVertex(xNode, e.to);
      if (isAncestral && !Ancestors.has(e.to)) continue;

      const { ok, timeAssigned, slot } = checkArc(xNode.v, e, inc, xNode.T);
      if (!ok) continue;

      const y = e.to;
      const joinType = classifyJoin(inc, y);

      // ✅ AND JOIN: accumulate arrivals grouped by Condition (C)
      if (joinType === "AND") {
        progressed = true;
        const nextT = cloneT(xNode.T);
        commitArc(xNode.v, e, inc, nextT, timeAssigned, slot);

        if (!andJoinBuffer.has(y)) andJoinBuffer.set(y, new Map());
        const slotBuffer = andJoinBuffer.get(y);
        if (!slotBuffer.has(slot)) slotBuffer.set(slot, new Map());

        const conditionBuffer = slotBuffer.get(slot);
        const C = e.C ?? EPS;
        if (!conditionBuffer.has(C)) conditionBuffer.set(C, []);

        conditionBuffer.get(C).push({
          fromNode: xNode,
          time: timeAssigned,
          C: C,
          S: [...xNode.S],
          reality: xNode.reality,
          nextT,
        });

        touchedAndJoins.add(`${y}|${slot}`);
        continue;
      }

      // ✅ MIX JOIN buffering
      if (joinType === "MIX") {
        progressed = true;
        const nextT = cloneT(xNode.T);
        commitArc(xNode.v, e, inc, nextT, timeAssigned, slot);
        const C = e.C ?? EPS;

        if (!mixBuffer.has(y)) mixBuffer.set(y, new Map());
        const slotBuffer = mixBuffer.get(y);
        if (!slotBuffer.has(slot)) {
          slotBuffer.set(slot, {
            newSigmas: [],
            newEpsilons: [],
            processedSigmas: [],
            waitingEpsilons: [],
          });
        }

        const currentSlot = slotBuffer.get(slot);

        if (C !== EPS) {
          currentSlot.newSigmas.push({
            fromNode: xNode,
            time: timeAssigned,
            C,
            S: [...xNode.S],
            reality: xNode.reality,
            nextT,
          });
        } else {
          currentSlot.newEpsilons.push({
            fromNode: xNode,
            time: timeAssigned,
            S: [...xNode.S],
            reality: xNode.reality,
            nextT,
          });
        }
        touchedMixJoins.add(`${y}|${slot}`);
        continue;
      }

      // ✅ Unconstrained Arc Traversal
      if (isUnconstrained(e, inc, xNode.T)) {
        progressed = true;
        const nextT = cloneT(xNode.T);
        commitArc(xNode.v, e, inc, nextT, timeAssigned, slot);

        // Approximate Algorithm 1's "updatedConstraints" effect when entering
        // a merge point or following an ancestral/back-edge.
        const jt = classifyJoin(inc, y);
        if (isAncestral || jt === "AND" || jt === "MIX" || jt === "OR") {
          stampSatisfiedIncomingArcs(y, e, nextT, timeAssigned);
        }

        const child = getOrCreateNode(
          y,
          appendConstraint(xNode.S, e),
          timeAssigned,
          xNode.reality,
          nextT,
          false,
        );
        inheritPath(xNode, child);
        link(xNode, child);
      } else {
        delayedEdges.push({ xNode, e });
      }
    }

    // PASS 2: Resolve AND Joins safely via Condition grouping & lineage compatibility
    for (const key of touchedAndJoins) {
      const [y, slotStr] = key.split("|");
      const slot = Number(slotStr);
      const slotBuffer = andJoinBuffer.get(y);
      if (!slotBuffer || !slotBuffer.has(slot)) continue;

      const conditionBuffer = slotBuffer.get(slot);
      const incoming = inc.get(y) ?? [];

      // DISTINCT conditions required for AND firing
      const requiredConditions = Array.from(
        new Set(incoming.map((a) => a.C ?? EPS)),
      );
      requiredConditions.sort((a, b) => a.localeCompare(b));

      const hasAll = requiredConditions.every(
        (cond) => conditionBuffer.has(cond) && conditionBuffer.get(cond).length > 0,
      );

      if (hasAll) {
        const arrays = requiredConditions.map((cond) => conditionBuffer.get(cond));
        const combinations = cartesian(arrays);

        for (const combo of combinations) {
          const mergedR = areRealitiesCompatible(combo.map((a) => a.reality));
          if (!mergedR) continue;

          const sortedArcs = [...combo].sort(
            (a, b) => b.time - a.time || b.C.localeCompare(a.C),
          );
          const tMax = Math.max(...sortedArcs.map((a) => a.time));
          const joinToken = `(${sortedArcs.map((a) => a.C).join(",")})`;
          const baseS = mergeHistories(sortedArcs.map((a) => a.S));

          const mergedT = mergeT(combo.map((a) => a.nextT));
          const resolved = getOrCreateNode(
            y,
            [...baseS, joinToken],
            tMax,
            mergedR,
            mergedT,
            false,
          );

          // Inherit a stable lineage for the join node.
          // We approximate by taking the longest path among participating branches.
          const longest = combo.reduce((best, cur) => {
            const bp = best?.fromNode?.pathVertices?.length ?? 0;
            const cp = cur?.fromNode?.pathVertices?.length ?? 0;
            return cp > bp ? cur : best;
          }, null);
          if (longest?.fromNode) inheritPath(longest.fromNode, resolved);

          for (const a of sortedArcs) {
            link(a.fromNode, resolved);
          }
        }

        // Intentionally do NOT delete buffers; later arrivals can still pair.
      }
    }

    // PASS 2: Resolve MIX Joins
    for (const key of touchedMixJoins) {
      const [y, slotStr] = key.split("|");
      const slot = Number(slotStr);

      const slotBuffer = mixBuffer.get(y);
      if (!slotBuffer || !slotBuffer.has(slot)) continue;

      const currentSlot = slotBuffer.get(slot);
      const newSigmas = currentSlot.newSigmas;
      const newEpsilons = currentSlot.newEpsilons;

      if (newSigmas.length > 0) {
        for (const s of newSigmas) {
          const newR = { ...s.reality, [y]: 1 }; // Branch choice 1
          const zSigma = getOrCreateNode(
            y,
            [...s.S, s.C],
            s.time,
            newR,
            s.nextT,
            false,
          );
          if (s.fromNode) inheritPath(s.fromNode, zSigma);
          link(s.fromNode, zSigma);
          currentSlot.processedSigmas.push(s);
        }
      }

      if (currentSlot.processedSigmas.length > 0) {
        for (const p of newEpsilons) {
          for (const s of currentSlot.processedSigmas) {
            const mergedR = areRealitiesCompatible([p.reality, s.reality]);
            if (!mergedR) continue;

            const newR = { ...mergedR, [y]: 2 }; // Branch choice 2
            const mergedT = mergeT([p.nextT, s.nextT]);
            const zEps = getOrCreateNode(
              y,
              [...p.S, `(${EPS},${s.C})`],
              Math.max(p.time, s.time),
              newR,
              mergedT,
              false,
            );
            if (p.fromNode) inheritPath(p.fromNode, zEps);
            link(p.fromNode, zEps);
          }
        }
        for (const p of currentSlot.waitingEpsilons) {
          for (const s of newSigmas) {
            const mergedR = areRealitiesCompatible([p.reality, s.reality]);
            if (!mergedR) continue;

            const newR = { ...mergedR, [y]: 2 }; // Branch choice 2
            const mergedT = mergeT([p.nextT, s.nextT]);
            const zEps = getOrCreateNode(
              y,
              [...p.S, `(${EPS},${s.C})`],
              Math.max(p.time, s.time),
              newR,
              mergedT,
              false,
            );
            if (p.fromNode) inheritPath(p.fromNode, zEps);
            link(p.fromNode, zEps);
          }
        }
        currentSlot.waitingEpsilons = [];
      } else {
        currentSlot.waitingEpsilons.push(...newEpsilons);
      }

      currentSlot.newSigmas = [];
      currentSlot.newEpsilons = [];
    }
  }
}

// ==========================================
// Tarjan's Strongly Connected Components
// ==========================================
function computeSCCs(vertices, out) {
  const ids = vertices.map((v) => v.id);
  const indexMap = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  let index = 0;

  const sccIdOf = new Map();
  const sccs = [];

  function strongconnect(v) {
    indexMap.set(v, index);
    lowlink.set(v, index);
    index++;

    stack.push(v);
    onStack.add(v);

    const outs = out.get(v) ?? [];
    for (const e of outs) {
      const w = e.to;
      if (!indexMap.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indexMap.get(w)));
      }
    }

    if (lowlink.get(v) === indexMap.get(v)) {
      const comp = [];
      while (true) {
        const w = stack.pop();
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      const sccId = sccs.length;
      for (const u of comp) sccIdOf.set(u, sccId);
      sccs.push(comp);
    }
  }

  for (const v of ids) {
    if (!indexMap.has(v)) strongconnect(v);
  }

  return { sccIdOf, sccs };
}

function computeCycleSCCSet(sccs, out, sccIdOf) {
  const cycleSCCs = new Set();
  for (let sccId = 0; sccId < sccs.length; sccId++) {
    const comp = sccs[sccId];
    if (comp.length > 1) {
      cycleSCCs.add(sccId);
      continue;
    }
    const v = comp[0];
    const outs = out.get(v) ?? [];
    if (outs.some((e) => e.to === v)) cycleSCCs.add(sccId);
  }
  return cycleSCCs;
}