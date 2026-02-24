// script/services/parallel/TraversalTree.mjs
import { parseRDLT } from "../convert/rdlt2pn/modules/parser.js";

const EPS = "ϵ";
const getL = (e) => Number(e.L ?? 1);
const edgeKey = (e, idx) => `${e.from}->${e.to}#${idx}`;

// ==========================================
// Utility & Merge Logic
// ==========================================

function link(parent, child) {
  if (!child.parents.includes(parent)) child.parents.push(parent);
  if (!parent.children.includes(child)) parent.children.push(child);
}

function isUnconstrained(e, inc, T) {
  const incoming = inc.get(e.to) ?? [];
  if (incoming.length <= 1) return true;
  const nX = (T.get(edgeKey(e, e.__idx)) ?? []).filter((t) => t > 0).length;

  return incoming.every((v) => {
    if (v.__idx === e.__idx) return true;
    const nV = (T.get(edgeKey(v, v.__idx)) ?? []).filter((t) => t > 0).length;
    return nV >= getL(v) || (v.C ?? EPS) === (e.C ?? EPS) || nX <= nV;
  });
}

function mergeT(T_list) {
  if (!T_list.length) return new Map();
  const baseT = new Map(Array.from(T_list[0]).map(([k, v]) => [k, [...v]]));
  for (let i = 1; i < T_list.length; i++) {
    for (const [k, v] of T_list[i]) {
      const baseV = baseT.get(k);
      v.forEach((val, j) => {
        if (val > baseV[j]) baseV[j] = val;
      });
    }
  }
  return baseT;
}

function areRealitiesCompatible(realities) {
  const merged = {};
  for (const r of realities) {
    for (const [k, v] of Object.entries(r)) {
      if (k in merged && merged[k] !== v) return null;
      merged[k] = v;
    }
  }
  return merged;
}

function cartesian(arrays) {
  if (!arrays.length) return [[]];
  const [first, ...rest] = arrays;
  const sub = cartesian(rest);
  return first.flatMap((val) => sub.map((s) => [val, ...s]));
}

function mergeHistories(histories) {
  if (!histories.length) return [];
  let i = 0;
  while (histories.every((h) => h[i] !== undefined && h[i] === histories[0][i])) i++;

  const merged = [...histories[0].slice(0, i)];
  histories.forEach((h) => {
    h.slice(i).forEach((tok) => {
      if (merged[merged.length - 1] !== tok) merged.push(tok);
    });
  });
  return merged;
}

// ==========================================
// Tarjan's Algorithm for Cycles
// ==========================================
function computeSCCs(vertices, out) {
  const indexMap = new Map(), lowlink = new Map(), onStack = new Set(), stack = [];
  let index = 0;
  const sccIdOf = new Map();
  const sccs = [];

  function strongconnect(v) {
    indexMap.set(v, index); lowlink.set(v, index); index++;
    stack.push(v); onStack.add(v);

    for (const e of (out.get(v) || [])) {
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
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      const sccId = sccs.length;
      for (const u of comp) sccIdOf.set(u, sccId);
      sccs.push(comp);
    }
  }

  for (const v of vertices) {
    if (!indexMap.has(v.id)) strongconnect(v.id);
  }
  return { sccIdOf, sccs };
}

// ==========================================
// Main Generator
// ==========================================

export function generateTraversalTreeFromJSON(input, { sourceId = null } = {}) {
  parseRDLT(input, false);
  const { vertices, edges } = input;

  const out = new Map(), inc = new Map();
  edges.forEach((e, idx) => {
    const edge = { ...e, __idx: idx };
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inc.has(e.to)) inc.set(e.to, []);
    out.get(e.from).push(edge);
    inc.get(e.to).push(edge);
  });

  // Identify Cycles and Critical Arcs (Arcs dictating L)
  const { sccIdOf, sccs } = computeSCCs(vertices, out);
  const cycleSCCs = new Set();
  const criticalArcsByScc = new Map();

  for (let i = 0; i < sccs.length; i++) {
    const comp = sccs[i];
    let isCycle = comp.length > 1;
    if (!isCycle) {
      const outs = out.get(comp[0]) || [];
      isCycle = outs.some(e => e.to === comp[0]);
    }
    
    if (isCycle) {
      cycleSCCs.add(i);
      let minL = Infinity;
      let cArcs = [];
      for (const vId of comp) {
        for (const e of (out.get(vId) || [])) {
          if (sccIdOf.get(e.to) === i) {
            const L = getL(e);
            if (L < minL) { minL = L; cArcs = [e]; }
            else if (L === minL) cArcs.push(e);
          }
        }
      }
      criticalArcsByScc.set(i, cArcs);
    }
  }

  const src = sourceId ?? vertices.find((v) => !inc.has(v.id))?.id;
  const nodeIndex = new Map();
  const allNodes = [];
  const joinBuffer = new Map();
  const mixBuffer = new Map();
  let idCounter = 1;

  function getOrCreateNode(v, S, time, reality, T) {
    const key = `${v}|${time}|${S.join(",")}|${JSON.stringify(reality)}`;
    if (nodeIndex.has(key)) return nodeIndex.get(key);

    const node = { id: idCounter++, v, S, time, reality, T, parents: [], children: [], processed: false };
    nodeIndex.set(key, node);
    allNodes.push(node);
    return node;
  }

  const initialT = new Map(edges.map((e, i) => [edgeKey(e, i), Array(getL(e)).fill(0)]));
  getOrCreateNode(src, [0], 0, {}, initialT); // Root starts at t=0

  while (true) {
    const current = allNodes.filter((n) => !n.processed);
    if (!current.length) break;

    for (const node of current) {
      node.processed = true;
      const outs = out.get(node.v) ?? [];

      // --- CYCLE ROUTING LOGIC ---
      const xScc = sccIdOf.get(node.v);
      const inCycle = xScc != null && cycleSCCs.has(xScc);
      let allowedOuts = outs;

      if (inCycle) {
        const cArcs = criticalArcsByScc.get(xScc);
        // A cycle is exhausted if ANY of its critical arcs have no 0s left in T
        const cycleExhausted = cArcs.some(e => {
          const vec = node.T.get(edgeKey(e, e.__idx));
          return !vec || vec.indexOf(0) === -1;
        });

        const cycleEdges = outs.filter((e) => sccIdOf.get(e.to) === xScc);
        const nonCycleEdges = outs.filter((e) => sccIdOf.get(e.to) !== xScc);

        if (!cycleExhausted) {
          allowedOuts = cycleEdges; // Stay in the cycle
        } else {
          allowedOuts = nonCycleEdges.length > 0 ? nonCycleEdges : cycleEdges; // Break out
        }
      }

      for (const e of allowedOuts) {
        if (!isUnconstrained(e, inc, node.T)) continue;

        const vec = node.T.get(edgeKey(e, e.__idx));
        const slot = vec?.indexOf(0);
        if (slot === -1 || slot === undefined) continue; // Skip if capacity is fully utilized

        const y = e.to;
        const C = e.C ?? EPS;
        const incoming = inc.get(y) ?? [];

        const isJoin = incoming.length > 1;
        const isAllEpsilon = isJoin && incoming.every((a) => (a.C ?? EPS) === EPS);

        const incomingToX = inc.get(node.v) ?? [];
        const timeAssigned = Math.max(0, ...incomingToX.flatMap((ie) => node.T.get(edgeKey(ie, ie.__idx)) ?? [])) + 1;

        const nextT = new Map(Array.from(node.T).map(([k, v]) => [k, [...v]]));
        nextT.get(edgeKey(e, e.__idx))[slot] = timeAssigned; // Consume 1 instance of L

        if (!isJoin || isAllEpsilon) {
          const child = getOrCreateNode(y, [...node.S, C], timeAssigned, node.reality, nextT);
          link(node, child);
        } else {
          const isMix = incoming.some((a) => (a.C ?? EPS) === EPS) && incoming.some((a) => (a.C ?? EPS) !== EPS);

          if (isMix) {
            if (!mixBuffer.has(y)) mixBuffer.set(y, new Map());
            if (!mixBuffer.get(y).has(slot)) mixBuffer.get(y).set(slot, { sigmas: [], epsilons: [] });

            const b = mixBuffer.get(y).get(slot);

            if (C !== EPS) {
              const s = { node, time: timeAssigned, C, S: [...node.S], reality: { ...node.reality, [y]: 1 }, nextT };
              b.sigmas.push(s);

              const zSigma = getOrCreateNode(y, [...node.S, C], timeAssigned, s.reality, nextT);
              link(node, zSigma);

              for (const p of b.epsilons) {
                const mergedR = areRealitiesCompatible([p.reality, s.reality]);
                if (mergedR) {
                  const newR = { ...mergedR, [y]: 2 };
                  const mergedT = mergeT([p.nextT, s.nextT]);
                  const zEps = getOrCreateNode(y, [...p.S, `(${EPS},${C})`], Math.max(p.time, s.time), newR, mergedT);
                  link(p.node, zEps);
                }
              }
            } else {
              const p = { node, time: timeAssigned, S: [...node.S], reality: node.reality, nextT };
              b.epsilons.push(p);

              for (const s of b.sigmas) {
                const mergedR = areRealitiesCompatible([p.reality, s.reality]);
                if (mergedR) {
                  const newR = { ...mergedR, [y]: 2 };
                  const mergedT = mergeT([p.nextT, s.nextT]);
                  const zEps = getOrCreateNode(y, [...p.S, `(${EPS},${s.C})`], Math.max(p.time, s.time), newR, mergedT);
                  link(p.node, zEps);
                }
              }
            }
          } else {
            // Standard AND Join
            if (!joinBuffer.has(y)) joinBuffer.set(y, new Map());
            if (!joinBuffer.get(y).has(slot)) joinBuffer.get(y).set(slot, new Map());

            const conditionBuffer = joinBuffer.get(y).get(slot);
            if (!conditionBuffer.has(C)) conditionBuffer.set(C, []);

            conditionBuffer.get(C).push({ node, time: timeAssigned, C, S: [...node.S], reality: node.reality, nextT });

            const requiredConditions = Array.from(new Set(incoming.map((a) => a.C ?? EPS))).sort();
            const hasAll = requiredConditions.every((cond) => conditionBuffer.has(cond) && conditionBuffer.get(cond).length > 0);

            if (hasAll) {
              const arrays = requiredConditions.map((cond) => conditionBuffer.get(cond));
              const combinations = cartesian(arrays);

              for (const combo of combinations) {
                const mergedR = areRealitiesCompatible(combo.map((a) => a.reality));
                if (!mergedR) continue;

                const sortedArcs = [...combo].sort((a, b) => b.time - a.time || b.C.localeCompare(a.C));
                const tMax = Math.max(...sortedArcs.map((a) => a.time));

                const joinToken = requiredConditions.length > 1 
                  ? `(${sortedArcs.map((a) => a.C).join(",")})` 
                  : sortedArcs[0].C;

                const baseS = mergeHistories(sortedArcs.map((a) => a.S));
                const mergedT = mergeT(combo.map((a) => a.nextT));

                const resolved = getOrCreateNode(y, [...baseS, joinToken], tMax, mergedR, mergedT);

                for (const arc of sortedArcs) {
                  link(arc.node, resolved);
                }
              }
            }
          }
        }
      }
    }
  }

  // --- LOGGING CODE ---
  const leaves = allNodes.filter((n) => n.children.length === 0);
  const byTime = new Map();

  for (const n of leaves) {
    if (!byTime.has(n.time)) byTime.set(n.time, []);
    byTime.get(n.time).push(n);
  }

  const fmtS = (S) => `S([${(S ?? []).join(",")}])`;
  const isParallel = leaves.length > 1;

  console.log(`\n${isParallel ? "🟢 PARALLEL" : "🟡 NON-PARALLEL"} BRANCHES:`);

  const sortedTimes = Array.from(byTime.keys()).sort((a, b) => a - b);

  for (const t of sortedTimes) {
    console.log(`  Time = ${t}:`);
    for (const b of byTime.get(t)) {
      console.log(`    -> Node: ${b.v} | Path: ${fmtS(b.S)}`);
    }
  }
  console.log("===========================\n");

  return { allNodes };
}