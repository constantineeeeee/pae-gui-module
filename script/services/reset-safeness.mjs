/*
Service Module for Reset-Safeness Verification
Developed for RDLT Soundness Verification (2025)

This module verifies reset-safeness of an RDLT model by:
  1. Extracting all Cyclic-Arc Subgraphs (CAS) using CASExtractor,
     following the same pipeline as impedance-freeness verification.
  2. Retaining only MAXIMAL activities (removing strict edge-set subsets).
  3. For every pair of maximal activities and every Reset-Bound Subsystem (RBS),
     checking that simultaneous traversal of the RBS always exits via its
     out-bridge at the same timestep.

Also exports checkInterruptingActivities, which performs the same reset-safeness
pair check over PAE-generated activity profiles.
*/

import {
  isInbridge,
  isOutbridge,
  buildArcMap,
  buildRBSMatrix,
  buildVertexMap,
} from "../utils.mjs";
import { Vertex } from "./soundness/models/Vertex.js";
import { VertexType } from "./soundness/models/VertexType.js";
import { Edge } from "./soundness/models/Edge.js";
import { ResetBoundSubsystem } from "./soundness/models/ResetBoundSubsystem.js";
import { InputRDLT } from "./soundness/utils/input-rdlt.mjs";
import { Graph } from "./soundness/models/Graph.js";
import { ProcessR1 } from "./soundness/utils/create_r1.mjs";
import { processR2 } from "./soundness/utils/create_r2.mjs";
import { CASExtractor } from "./soundness/utils/cas-extractor.js";

/**
 * @typedef {number} ArcUID
 * @typedef {number} VertexUID
 *
 * @typedef {{ uid: ArcUID, fromVertexUID: VertexUID, toVertexUID: VertexUID, C: string, L: number }} Arc
 * @typedef {{ uid: VertexUID, identifier: string, isRBSCenter: boolean }} Vertex
 *
 * @typedef {{ [arcUID: ArcUID]: Arc }}       ArcMap
 * @typedef {{ [vertexUID: VertexUID]: Vertex }} VertexMap
 * @typedef {{ [vertexUID: VertexUID]: VertexUID }} RBSMatrix
 *
 * @typedef {{ vertices: object[], edges: object[] }} CASGraph
 *   A graph object produced by CASExtractor, where each edge carries
 *   from/to vertex references and an optional maxTraversals (L) value.
 *
 * @typedef {{ pass: boolean, description: string }} Criterion
 *
 * @typedef {{
 *   pass: boolean,
 *   criteria: Criterion[],
 *   violatingArcKeys: string[]
 * }} ResetSafenessCheckResult
 *
 * @typedef {{
 *   title: string,
 *   instances: object[]
 * }} VerificationResult
 *   GUI-ready result object consumed by the soundness renderer.
 *
 * @typedef {{
 *   processId: number,
 *   activityProfile: { [timestep: number]: Set<ArcUID> }
 * }} PAEActivity
 *   An activity produced by Parallel Activity Extraction, keyed by timestep.
 */



/**
 * Verifies reset-safeness of the given model and returns a GUI-ready result object.
 *
 * The following steps are performed:
 *  1. Build arc/vertex maps and resolve in-/out-bridges.
 *  2. Run InputRDLT evaluation to obtain R1 and R2 arc sets.
 *  3. Map everything into Graph objects (rdltGraph, r1Graph, r2Graphs).
 *  4. Resolve the source and sink vertices; return early if either is missing.
 *  5. Merge all R2 sub-graphs into a single combined R2Graph.
 *  6. Extract all CAS candidates via CASExtractor.
 *  7. Normalize L-values on each CAS edge for consistency with impedance-freeness.
 *  8. Return early (reset-safe) if only one or zero activities were derived.
 *  9. Run the pairwise reset-safeness check over all RBSs.
 * 10. Map violating arc keys back to GUI arc UIDs and assemble the result.
 *
 * @param {object} simpleModel - The parsed RDLT model (components + arcs).
 * @param {VertexUID} source   - UID of the source vertex.
 * @param {VertexUID} sink     - UID of the sink vertex.
 * @returns {VerificationResult}
 */
export function verifyResetSafeness(simpleModel, source, sink) {
  // 1. Build arc/vertex maps and resolve bridges
  const arcMap = buildArcMap(simpleModel.arcs);
  const vertexMap = buildVertexMap(simpleModel.components);

  const inVertices = getInBridges(simpleModel, arcMap, vertexMap);
  const outVertices = getOutBridges(simpleModel, arcMap, vertexMap);

  // 2. Run InputRDLT evaluation to obtain R1 and R2
  const inputRDLT = new InputRDLT(simpleModel, inVertices, outVertices);
  const evsa = inputRDLT.evaluate();

  let R2;
  if (inputRDLT.centersList.length === 0) {
    R2 = [];
  } else {
    R2 = processR2(evsa.Rs);
  }

  const R1 = ProcessR1(
    inputRDLT.model.arcs,
    evsa.R1.R1,
    inputRDLT.centersList,
    inputRDLT.in_list,
    inputRDLT.out_list,
    R2,
  );

  // 3. Map everything into Graph objects
  const { rdltGraph, r2Graphs, r1Graph } = mapToGraphs(inputRDLT, R2, R1);

  // 4. Resolve source/sink (UI select may pass strings, so normalize to string)
  const srcKey = String(source);
  const snkKey = String(sink);

  const sourceVertex = rdltGraph.vertices.find((v) => String(v.id) === srcKey);
  const sinkVertex   = rdltGraph.vertices.find((v) => String(v.id) === snkKey);

  if (!sourceVertex || !sinkVertex) {
    return unresolvedSourceSinkResult();
  }

  // 5. Merge all R2 sub-graphs into one combined R2Graph
  let R2Graph = null;
  if (r2Graphs.length > 0) {
    R2Graph = new Graph();
    for (const { graph } of r2Graphs) {
      graph.vertices.forEach((v) => {
        if (!R2Graph.vertices.some((e) => e.id === v.id)) R2Graph.addVertex(v);
      });
      graph.edges.forEach((e) => {
        if (!R2Graph.edges.some((ex) => ex.from.id === e.from.id && ex.to.id === e.to.id)) {
          R2Graph.addEdge(e);
        }
      });
    }
  }

  // 6. Extract all CAS candidates
  const { casSet } = CASExtractor.extractAllCASWithDetails(
    rdltGraph,
    r1Graph,
    R2Graph,
    source,
    sink,
  );

  // 7. Normalize L-values on each CAS edge for consistency with impedance-freeness
  const normalizedCAS = normalizeCASLValues(casSet, rdltGraph, R2Graph);

  if (!normalizedCAS || normalizedCAS.length === 0) {
    return unreachableResultResetSafe();
  }

  // 8. Return early if only one activity — reset-safeness holds trivially (no pair)
  if (normalizedCAS.length === 1) {
    return singleActivityResetSafeResult(normalizedCAS, { vertexMap, arcMap });
  }

  // 9. Run pairwise reset-safeness check over all RBSs
  const rbsList = rdltGraph.resetBoundSubsystems ?? [];
  const check = checkResetSafeness({ rdltGraph, rbsList, maximalActivities: normalizedCAS });

  // 10. Map violating arc keys back to GUI arc UIDs and assemble the result
  const transformedArcMap = transformArcMapLocal(arcMap);

  const violatingArcUIDs = check.violatingArcKeys
    .map((key) => {
      const [fromId, toId] = key.split("->");
      const arcUID = findArcUIDByIdentifiers({ fromId, toId, vertexMap, arcMap, transformedArcMap });
      return arcUID ? Number(arcUID) : null;
    })
    .filter(Boolean);

  const mainInstance = {
    name: "Main Model",
    evaluation: {
      conclusion: {
        pass: check.pass,
        title: check.pass ? "Reset-safe" : "Not Reset-safe",
        description: check.pass
          ? `All pairs of maximal activities satisfy reset-safeness for every RBS.`
          : `Some pair(s) simultaneously traverse an RBS but do not exit its out-bridge at the same timestep.`,
      },
      criteria: check.criteria,
      violating: { arcs: violatingArcUIDs, vertices: [] },
    },
  };

  const casInstances = buildCASInstances(normalizedCAS, { vertexMap, arcMap, transformedArcMap });

  return {
    title: "Reset-safeness",
    instances: [mainInstance, ...casInstances],
  };
}



/**
 * Performs the pairwise reset-safeness check over all RBSs.
 *
 * For each RBS G and every pair of maximal activities (A, B), the following
 * three cases are evaluated:
 *  (3) Neither activity uses G → reset-safe for this pair/RBS.
 *  (3) Only one activity uses G → no interference possible → reset-safe.
 *  (2) Both use G but never at the same timestep → reset-safe.
 *  (1) Both use G at overlapping timesteps → they MUST exit an out-bridge of G
 *      at the same timestep; otherwise the pair is NOT reset-safe.
 *      If G has no out-bridge at all, any overlap is automatically a failure.
 *
 * The "active-in-G" window for each activity is defined by arcs whose FROM
 * vertex belongs to G (internal arcs and out-bridge arcs), so the exit moment
 * is correctly captured inside the timeline.
 *
 * @param {{ rdltGraph: Graph, rbsList: object[], maximalActivities: CASGraph[] }} params
 * @returns {ResetSafenessCheckResult}
 */
function checkResetSafeness({ rdltGraph, rbsList, maximalActivities }) {
  const criteria = [];
  const violatingArcKeys = new Set();
  let pass = true;

  // Precompute an ordered edge path for each activity (timestep = edge index)
  const orderedActivities = maximalActivities.map((cas) => orderCASEdgesAsPath(cas));

  for (let gIndex = 0; gIndex < rbsList.length; gIndex++) {
    const G = rbsList[gIndex];

    // Collect all vertex IDs and names belonging to G so that arc-key lookups
    // work regardless of whether edges use UIDs (rdltGraph) or name strings (CAS).
    const gVertices = new Set();
    for (const v of G.members ?? []) {
      if (v?.id   != null) gVertices.add(String(v.id));
      if (v?.name != null) gVertices.add(String(v.name));
    }
    const gCenter = G.center;
    if (gCenter?.id   != null) gVertices.add(String(gCenter.id));
    if (gCenter?.name != null) gVertices.add(String(gCenter.name));

    // Build arc key sets in both UID-based and name-based forms so they match
    // regardless of whether edges originate from rdltGraph (UIDs) or CAS (names).
    const internalKeys   = new Set(); // arcs with both endpoints inside G
    const outBridgeKeys  = new Set(); // arcs exiting G (from inside, to outside)
    const activeInGKeys  = new Set(); // internalKeys ∪ outBridgeKeys

    for (const e of rdltGraph.edges ?? []) {
      const fromUID  = e.from?.id   != null ? String(e.from.id)   : null;
      const fromName = e.from?.name != null ? String(e.from.name) : null;
      const toUID    = e.to?.id     != null ? String(e.to.id)     : null;
      const toName   = e.to?.name   != null ? String(e.to.name)   : null;

      const inFrom = (fromUID  && gVertices.has(fromUID))  || (fromName && gVertices.has(fromName));
      const inTo   = (toUID    && gVertices.has(toUID))    || (toName   && gVertices.has(toName));

      const uidKey  = fromUID  && toUID  ? `${fromUID}->${toUID}`   : null;
      const nameKey = fromName && toName ? `${fromName}->${toName}` : null;

      if (inFrom && inTo) {
        if (uidKey)  { internalKeys.add(uidKey);  activeInGKeys.add(uidKey);  }
        if (nameKey) { internalKeys.add(nameKey); activeInGKeys.add(nameKey); }
      }
      if (inFrom && !inTo) {
        if (uidKey)  { outBridgeKeys.add(uidKey);  activeInGKeys.add(uidKey);  }
        if (nameKey) { outBridgeKeys.add(nameKey); activeInGKeys.add(nameKey); }
      }
    }

    const gHasOutBridge = outBridgeKeys.size > 0;

    for (let i = 0; i < orderedActivities.length; i++) {
      for (let j = i + 1; j < orderedActivities.length; j++) {
        const A = orderedActivities[i];
        const B = orderedActivities[j];

        // Build a boolean timeline: true at timestep t if the activity is
        // executing an arc whose FROM vertex is inside G at that moment.
        const aIn = timelineActiveInG(A, activeInGKeys);
        const bIn = timelineActiveInG(B, activeInGKeys);

        const aUses = aIn.some(Boolean);
        const bUses = bIn.some(Boolean);

        // Case (3): neither activity uses G → automatically reset-safe
        if (!aUses && !bUses) {
          criteria.push({
            pass: true,
            description:
              `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${j + 1} ` +
              `do not use this RBS at all.`,
          });
          continue;
        }

        // Case (3) asymmetric: only one uses G → no interference possible
        if (!aUses || !bUses) {
          criteria.push({
            pass: true,
            description:
              `RBS ${labelRBS(G, gIndex)} — Only one of Activities ${i + 1} and ${j + 1} ` +
              `uses this RBS; the other does not enter it at all.`,
          });
          continue;
        }

        // Find intervals [tStart, tEnd] where both are simultaneously inside G.
        // Both timelines may have different lengths; pad shorter one with false.
        const overlaps = overlapIntervals(aIn, bIn);

        // Case (2): both use G but never at the same time → reset-safe
        if (overlaps.length === 0) {
          criteria.push({
            pass: true,
            description:
              `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${j + 1} ` +
              `both use this RBS but never at the same time.`,
          });
          continue;
        }

        // Case (1): both use G at overlapping timesteps.
        // No out-bridge → activities can never satisfy the simultaneous-exit
        // condition → automatically not reset-safe.
        if (!gHasOutBridge) {
          pass = false;
          collectViolatingArcs(A, B, internalKeys, outBridgeKeys, overlaps, violatingArcKeys);
          criteria.push({
            pass: false,
            description:
              `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${j + 1} ` +
              `overlap inside RBS but no out-bridge exists to exit from (NOT reset-safe).`,
          });
          continue;
        }

        // For each overlap interval, the first out-bridge exit of A and B
        // at-or-after the interval start must occur at the same timestep index.
        const aExitTimes = exitTimesFromActivity(A, outBridgeKeys);
        const bExitTimes = exitTimesFromActivity(B, outBridgeKeys);

        let pairOK = true;
        const pairViolatingKeys = new Set();

        for (const [tStart, tEnd] of overlaps) {
          const exitA = firstExitAtOrAfter(aExitTimes, tStart);
          const exitB = firstExitAtOrAfter(bExitTimes, tStart);

          if (exitA == null || exitB == null || exitA !== exitB) {
            pairOK = false;

            // Highlight the out-bridge arcs each activity actually traverses (if any)
            if (exitA != null) { const kA = edgeKeyAt(A, exitA); if (kA) pairViolatingKeys.add(kA); }
            if (exitB != null) { const kB = edgeKeyAt(B, exitB); if (kB) pairViolatingKeys.add(kB); }

            // Also highlight the overlapping internal arcs so the user can see
            // where the conflicting simultaneous traversal occurs.
            for (let t = tStart; t <= tEnd; t++) {
              const kA = edgeKeyAt(A, t); if (kA && internalKeys.has(kA)) pairViolatingKeys.add(kA);
              const kB = edgeKeyAt(B, t); if (kB && internalKeys.has(kB)) pairViolatingKeys.add(kB);
            }
          }
        }

        if (!pairOK) {
          pass = false;
          for (const k of pairViolatingKeys) violatingArcKeys.add(k);
        }

        criteria.push({
          pass: pairOK,
          description: pairOK
            ? `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${j + 1} ` +
              `overlap inside RBS and exit its out-bridge at the same timestep (reset-safe).`
            : `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${j + 1} ` +
              `overlap inside RBS but do NOT exit its out-bridge at the same timestep (NOT reset-safe).`,
        });
      }
    }
  }

  return { pass, criteria, violatingArcKeys: [...violatingArcKeys] };
}

/**
 * Returns a human-readable label for an RBS, preferring the center vertex name.
 *
 * @param {object} G     - The RBS object (has a .center property).
 * @param {number} idx   - Zero-based index of G in the RBS list (used as fallback).
 * @returns {string}
 */
function labelRBS(G, idx) {
  const center = G?.center?.name ?? G?.center?.id ?? G?.center;
  if (center != null) return `with center ${center}`;
  return `#${idx + 1}`;
}

/**
 * Collects all internal arc keys touched during overlap intervals into
 * violatingArcKeys. Used only in the no-out-bridge failure case.
 *
 * @param {object[]} A               - Ordered edge list for activity A.
 * @param {object[]} B               - Ordered edge list for activity B.
 * @param {Set<string>} internalKeys - Arc keys for arcs internal to G.
 * @param {Set<string>} outBridgeKeys - Arc keys for out-bridge arcs of G.
 * @param {number[][]} overlaps       - List of [tStart, tEnd] overlap intervals.
 * @param {Set<string>} violatingArcKeys - Accumulator set mutated in place.
 */
function collectViolatingArcs(A, B, internalKeys, outBridgeKeys, overlaps, violatingArcKeys) {
  for (const [tStart, tEnd] of overlaps) {
    for (let t = tStart; t <= tEnd; t++) {
      const kA = edgeKeyAt(A, t); if (kA && internalKeys.has(kA)) violatingArcKeys.add(kA);
      const kB = edgeKeyAt(B, t); if (kB && internalKeys.has(kB)) violatingArcKeys.add(kB);
    }
  }
}



/**
 * Filters a list of CAS graphs, keeping only those that are not a strict
 * edge-set subset of any other CAS in the list.
 *
 * Two CAS are compared by their sets of "fromId->toId" arc keys.
 * If CAS i is a strict subset of CAS j, CAS i is discarded.
 *
 * @param {CASGraph[]} casSet
 * @returns {CASGraph[]}
 */
function keepOnlyMaximalCAS(casSet) {
  const sets = casSet.map((cas) => {
    const s = new Set();
    for (const e of cas?.edges ?? []) {
      const fromId = e.from?.id ?? e.from;
      const toId   = e.to?.id   ?? e.to;
      s.add(`${fromId}->${toId}`);
    }
    return s;
  });

  const keep = new Array(casSet.length).fill(true);

  for (let i = 0; i < casSet.length; i++) {
    if (!keep[i]) continue;
    for (let j = 0; j < casSet.length; j++) {
      if (i === j || !keep[i]) continue;
      if (isStrictSubset(sets[i], sets[j])) keep[i] = false;
    }
  }

  return casSet.filter((_, idx) => keep[idx]);
}

/**
 * Returns true if set a is a strict subset of set b
 * (i.e. every element of a is in b, and a is smaller than b).
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {boolean}
 */
function isStrictSubset(a, b) {
  if (a.size >= b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}



/**
 * Converts a CAS graph into an ordered array of edges that forms a path,
 * so that the index of each edge can serve as its timestep.
 *
 * The ordering algorithm:
 *  1. Compute in-degrees for all vertices.
 *  2. Start from the vertex with in-degree 0 (or fall back to the first edge's source).
 *  3. Greedily follow outgoing edges until all edges are consumed.
 *  4. Append any remaining unvisited edges (guards against non-simple-path CAS).
 *
 * @param {CASGraph} casGraph
 * @returns {object[]} Ordered array of edge objects.
 */
function orderCASEdgesAsPath(casGraph) {
  const edges = Array.isArray(casGraph?.edges) ? [...casGraph.edges] : [];
  if (edges.length <= 1) return edges;

  const out    = new Map(); // fromId → Edge[]
  const indeg  = new Map(); // vertexId → in-degree count
  const verts  = new Set();

  for (const e of edges) {
    const fromId = e.from?.id ?? e.from;
    const toId   = e.to?.id   ?? e.to;
    verts.add(fromId);
    verts.add(toId);

    if (!out.has(fromId)) out.set(fromId, []);
    out.get(fromId).push(e);

    indeg.set(toId, (indeg.get(toId) ?? 0) + 1);
    if (!indeg.has(fromId)) indeg.set(fromId, indeg.get(fromId) ?? 0);
  }

  // 1. Find a start vertex: prefer in-degree 0
  let start = null;
  for (const v of verts) {
    if ((indeg.get(v) ?? 0) === 0) { start = v; break; }
  }

  // 2. Fallback: use the source of the first edge
  if (start == null) start = edges[0].from?.id ?? edges[0].from;

  // 3. Greedily follow outgoing edges
  const used    = new Set();
  const ordered = [];
  let cur = start;

  while (ordered.length < edges.length) {
    const next = (out.get(cur) ?? []).find((e) => !used.has(e));
    if (!next) break;
    ordered.push(next);
    used.add(next);
    cur = next.to?.id ?? next.to;
  }

  // 4. Append any leftover edges
  for (const e of edges) {
    if (!used.has(e)) ordered.push(e);
  }

  return ordered;
}

/**
 * Returns the "fromId->toId" arc key for the edge at position t in an
 * ordered edge list, or null if t is out of range.
 *
 * @param {object[]} orderedEdges
 * @param {number} t - Timestep index.
 * @returns {string|null}
 */
function edgeKeyAt(orderedEdges, t) {
  const e = orderedEdges[t];
  if (!e) return null;
  const fromId = e.from?.id ?? e.from;
  const toId   = e.to?.id   ?? e.to;
  return `${fromId}->${toId}`;
}

/**
 * Builds a boolean timeline over an ordered edge list.
 * Element t is true if the activity executes an arc at timestep t whose
 * FROM vertex is inside G (i.e. the arc key is in activeInGKeys).
 *
 * This captures the full window during which the activity is "inside" the RBS,
 * including the moment it exits via an out-bridge.
 *
 * @param {object[]} orderedEdges
 * @param {Set<string>} activeInGKeys - Internal ∪ out-bridge arc keys for G.
 * @returns {boolean[]}
 */
function timelineActiveInG(orderedEdges, activeInGKeys) {
  return orderedEdges.map((e) => {
    const fromId = e.from?.id ?? e.from;
    const toId   = e.to?.id   ?? e.to;
    return activeInGKeys.has(`${fromId}->${toId}`);
  });
}

/**
 * Collects the timestep indices at which an activity traverses an out-bridge of G.
 *
 * @param {object[]} orderedEdges
 * @param {Set<string>} outBridgeKeys
 * @returns {number[]}
 */
function exitTimesFromActivity(orderedEdges, outBridgeKeys) {
  const times = [];
  for (let t = 0; t < orderedEdges.length; t++) {
    const fromId = orderedEdges[t].from?.id ?? orderedEdges[t].from;
    const toId   = orderedEdges[t].to?.id   ?? orderedEdges[t].to;
    if (outBridgeKeys.has(`${fromId}->${toId}`)) times.push(t);
  }
  return times;
}

/**
 * Finds contiguous intervals [tStart, tEnd] where both boolean timelines
 * are simultaneously true. Timelines may have different lengths; the shorter
 * one is treated as false beyond its end (no silent truncation).
 *
 * @param {boolean[]} inA
 * @param {boolean[]} inB
 * @returns {number[][]} Array of [tStart, tEnd] pairs.
 */
function overlapIntervals(inA, inB) {
  const n = Math.max(inA.length, inB.length);
  const intervals = [];
  let start = null;

  for (let t = 0; t < n; t++) {
    const both = !!(inA[t] ?? false) && !!(inB[t] ?? false);
    if ( both && start == null) start = t;
    if (!both && start != null) { intervals.push([start, t - 1]); start = null; }
  }
  if (start != null) intervals.push([start, n - 1]);
  return intervals;
}

/**
 * Returns the first value in exitTimesList that is >= tStart, or null if none.
 *
 * @param {number[]} exitTimesList - Sorted ascending list of exit timesteps.
 * @param {number} tStart
 * @returns {number|null}
 */
function firstExitAtOrAfter(exitTimesList, tStart) {
  for (const t of exitTimesList) if (t >= tStart) return t;
  return null;
}



/**
 * Returns a failure result indicating the source or sink vertex could not be
 * resolved from the model (e.g. because the UI passed an unrecognized ID).
 *
 * @returns {VerificationResult}
 */
function unresolvedSourceSinkResult() {
  return {
    title: "Reset-safeness",
    instances: [{
      name: "Main Model",
      evaluation: {
        conclusion: {
          pass: false,
          title: "Not Reset-safe",
          description: "Source or sink vertex could not be resolved.",
        },
        criteria: [],
        violating: { arcs: [], vertices: [] },
      },
    }],
  };
}

/**
 * Returns a failure result indicating that no maximal activities could be
 * derived — typically because the sink is unreachable from the source.
 *
 * @returns {VerificationResult}
 */
function unreachableResultResetSafe() {
  return {
    title: "Reset-safeness",
    instances: [{
      name: "Main Model",
      evaluation: {
        conclusion: {
          pass: false,
          title: "Not Reset-safe",
          description: "No maximal activities could be derived — sink is unreachable.",
        },
        criteria: [],
        violating: { arcs: [], vertices: [] },
      },
    }],
  };
}

/**
 * Returns a passing result for the degenerate case where only one activity
 * exists. Reset-safeness requires a pair comparison, so a single activity
 * is reset-safe by definition.
 *
 * @param {CASGraph[]} singleSet     - Array containing the one derived activity.
 * @param {{ vertexMap: VertexMap, arcMap: ArcMap }} maps
 * @returns {VerificationResult}
 */
function singleActivityResetSafeResult(singleSet, { vertexMap, arcMap }) {
  const transformedArcMap = transformArcMapLocal(arcMap);
  const casInstances = buildCASInstances(singleSet, { vertexMap, arcMap, transformedArcMap });

  return {
    title: "Reset-safeness",
    instances: [
      {
        name: "Main Model",
        evaluation: {
          conclusion: {
            pass: true,
            title: "Reset-safe",
            description: "Only one activity exists — no pair to compare for reset-safeness.",
          },
          criteria: [{ pass: true, description: "Single activity — reset-safe by definition." }],
          violating: { arcs: [], vertices: [] },
        },
      },
      ...casInstances,
    ],
  };
}



/**
 * Resolves the set of in-bridge identifiers for the model.
 * Each in-bridge is returned as "fromIdentifier, toIdentifier".
 *
 * @param {object}    model
 * @param {ArcMap}    arcMap
 * @param {VertexMap} vertexMap
 * @returns {Set<string>}
 */
function getInBridges(model, arcMap, vertexMap) {
  const rbsMatrix    = buildRBSMatrix(vertexMap, model.arcs);
  const inBridgesUIDs = new Set();
  const inBridges    = new Set();

  for (const arc of model.arcs) {
    if (isInbridge(arc.uid, arcMap, rbsMatrix)) inBridgesUIDs.add(arc.uid);
  }

  for (const uid of inBridgesUIDs) {
    const arc        = arcMap[uid];
    const fromVertex = vertexMap[arc.fromVertexUID];
    const toVertex   = vertexMap[arc.toVertexUID];
    if (fromVertex && toVertex) inBridges.add(`${fromVertex.identifier}, ${toVertex.identifier}`);
  }

  return inBridges;
}

/**
 * Resolves the set of out-bridge identifiers for the model.
 * Each out-bridge is returned as "fromIdentifier, toIdentifier".
 *
 * @param {object}    model
 * @param {ArcMap}    arcMap
 * @param {VertexMap} vertexMap
 * @returns {Set<string>}
 */
function getOutBridges(model, arcMap, vertexMap) {
  const rbsMatrix     = buildRBSMatrix(vertexMap, model.arcs);
  const outBridgesUIDs = new Set();
  const outBridges    = new Set();

  for (const arc of model.arcs) {
    if (isOutbridge(arc.uid, arcMap, rbsMatrix)) outBridgesUIDs.add(arc.uid);
  }

  for (const uid of outBridgesUIDs) {
    const arc        = arcMap[uid];
    const fromVertex = vertexMap[arc.fromVertexUID];
    const toVertex   = vertexMap[arc.toVertexUID];
    if (fromVertex && toVertex) outBridges.add(`${fromVertex.identifier}, ${toVertex.identifier}`);
  }

  return outBridges;
}

/**
 * Maps the InputRDLT evaluation output and the R1/R2 arc sets into three
 * Graph objects: the full RDLT graph (with RBS annotations), the combined
 * R2 sub-graph set, and the R1 graph.
 *
 * The following steps are performed:
 *  1. Build rdltGraph vertices and edges from the model's components/arcs.
 *  2. Attach ResetBoundSubsystem objects to rdltGraph for each center.
 *  3. Build one Graph per R2 group, keyed by the leading r-number.
 *  4. Build r1Graph from the R1 arc list.
 *
 * @param {InputRDLT} rdlt - Evaluated InputRDLT instance.
 * @param {object[]}  R2   - R2 arc list produced by processR2.
 * @param {object[]}  R1   - R1 arc list produced by ProcessR1.
 * @returns {{ rdltGraph: Graph, r2Graphs: { rNumber: string, graph: Graph }[], r1Graph: Graph }}
 */
function mapToGraphs(rdlt, R2, R1) {
  const rdltGraph = new Graph();
  const r1Graph   = new Graph();
  let   r2Graphs;

  if (rdlt && rdlt.model && rdlt.model.components && rdlt.model.arcs) {
    // 1. Build rdltGraph vertices
    rdlt.model.components.forEach((component) => {
      const vertex = new Vertex(component.uid, VertexType.ENTITY_OBJECT, {}, component.identifier || "");
      rdltGraph.addVertex(vertex);
    });

    // 1. Build rdltGraph edges
    rdlt.model.arcs.forEach((arc) => {
      const fromVertex = rdltGraph.vertices.find((v) => v.id === arc.fromVertexUID);
      const toVertex   = rdltGraph.vertices.find((v) => v.id === arc.toVertexUID);
      rdltGraph.addEdge(new Edge(arc.uid, fromVertex, toVertex, arc.C, arc.L, []));
    });

    // 2. Attach RBS objects for each center
    if (rdlt.centersList && rdlt.centersList.length > 0) {
      rdlt.centersList.forEach((centerId) => {
        const centerVertex = rdltGraph.vertices.find((v) => v.id === centerId.uid);
        if (!centerVertex) return;

        const members = rdltGraph.edges
          .filter((edge) => edge.from.id === centerId.uid)
          .map((edge) => (edge.from.id === centerId.uid ? edge.to : edge.from));

        const inBridges = rdlt.in_list
          .map((entry) => {
            const [fromId, toId] = entry.split(", ");
            const fromVertex = rdltGraph.vertices.find((v) => v.name === fromId);
            const toVertex   = rdltGraph.vertices.find((v) => v.name === toId);
            return rdltGraph.edges.find((edge) => edge.from === fromVertex && edge.to === toVertex);
          })
          .filter((edge) => edge && (members.includes(edge.to) || centerVertex === edge.to));

        const outBridges = rdlt.out_list
          .map((entry) => {
            const [fromId, toId] = entry.split(", ");
            const fromVertex = rdltGraph.vertices.find((v) => v.name === fromId);
            const toVertex   = rdltGraph.vertices.find((v) => v.name === toId);
            return rdltGraph.edges.find((edge) => edge.from === fromVertex && edge.to === toVertex);
          })
          .filter((edge) => edge && members.includes(edge.from));

        rdltGraph.addResetBoundSubsystem(
          new ResetBoundSubsystem(centerVertex, members, inBridges, outBridges),
        );
      });
    }
  }

  // 3. Build one Graph per R2 group
  if (R2 && R2.length > 0) {
    const r2Groups = R2.reduce((groups, arc) => {
      const rNumber = arc["r-id"].split("-")[0];
      if (!groups[rNumber]) groups[rNumber] = [];
      groups[rNumber].push(arc);
      return groups;
    }, {});

    r2Graphs = Object.entries(r2Groups).map(([rNumber, arcs]) => {
      const graph = new Graph();
      arcs.forEach((arc) => {
        const [fromId, toId] = arc.arc.split(", ");
        const fromVertex =
          graph.vertices.find((v) => v.id === fromId) ||
          new Vertex(fromId, VertexType.ENTITY_OBJECT, {}, fromId);
        const toVertex =
          graph.vertices.find((v) => v.id === toId) ||
          new Vertex(toId, VertexType.ENTITY_OBJECT, {}, toId);

        if (!graph.vertices.find((v) => v.id === fromId)) graph.addVertex(fromVertex);
        if (!graph.vertices.find((v) => v.id === toId))   graph.addVertex(toVertex);

        graph.addEdge(new Edge(
          arc["r-id"], fromVertex, toVertex,
          arc["c-attribute"], parseInt(arc["l-attribute"], 10), [],
        ));
      });
      return { rNumber, graph };
    });
  } else {
    r2Graphs = [];
  }

  // 4. Build r1Graph
  if (R1 && R1.length > 0) {
    R1.forEach((arc) => {
      const [fromId, toId] = arc.arc.split(", ");
      const fromVertex =
        r1Graph.vertices.find((v) => v.id === fromId) ||
        new Vertex(fromId, VertexType.ENTITY_OBJECT, {}, fromId);
      const toVertex =
        r1Graph.vertices.find((v) => v.id === toId) ||
        new Vertex(toId, VertexType.ENTITY_OBJECT, {}, toId);

      if (!r1Graph.vertices.find((v) => v.id === fromId)) r1Graph.addVertex(fromVertex);
      if (!r1Graph.vertices.find((v) => v.id === toId))   r1Graph.addVertex(toVertex);

      r1Graph.addEdge(new Edge(
        arc["r-id"], fromVertex, toVertex,
        arc["c-attribute"], parseInt(arc["l-attribute"], 10), [],
      ));
    });
  }

  return { rdltGraph, r2Graphs, r1Graph };
}

/**
 * Normalizes L-values on each edge of every CAS graph so they reflect the
 * actual L-attributes from the original RDLT (for external arcs) or from
 * the R2 graph (for arcs internal to an RBS).
 *
 * Lookup keys are built in both name-based and UID-based forms to handle
 * the mixed identifier schemes used by rdltGraph and CASExtractor.
 *
 * @param {CASGraph[]} casSet
 * @param {Graph}      originalRDLT - The full rdltGraph with original L-values.
 * @param {Graph|null} R2Graph      - The combined R2 graph (may be null).
 * @returns {CASGraph[]}
 */
function normalizeCASLValues(casSet, originalRDLT, R2Graph) {
  const r2VertexIds = new Set((R2Graph?.vertices ?? []).map((v) => v.id));

  // Build a lookup from both name-based and UID-based arc keys → L value
  const originalL = new Map();
  for (const e of originalRDLT?.edges ?? []) {
    const kName = `${e.from?.name ?? e.from?.id}->${e.to?.name ?? e.to?.id}`;
    const kId   = `${e.from?.id}->${e.to?.id}`;
    const L = e.maxTraversals ?? e.l ?? e.L ?? e.lAttribute;
    if (L != null) {
      if (!originalL.has(kName)) originalL.set(kName, L);
      if (!originalL.has(kId))   originalL.set(kId,   L);
    }
  }

  const r2L = new Map();
  for (const e of R2Graph?.edges ?? []) {
    const k = `${e.from?.id}->${e.to?.id}`;
    const L = e.maxTraversals ?? e.l ?? e.L ?? e.lAttribute;
    if (L != null) r2L.set(k, L);
  }

  return (casSet ?? []).map((cas) => {
    const out = new Graph();
    out.vertices = [...(cas.vertices ?? [])];
    out.edges = (cas.edges ?? []).map((edge) => {
      const edgeCopy = { ...edge };
      const fromId   = edge.from?.id;
      const toId     = edge.to?.id;
      const fromName = edge.from?.name ?? fromId;
      const toName   = edge.to?.name   ?? toId;

      // Arcs inside the RBS use the R2 L-value; external arcs use the original RDLT value
      if (r2VertexIds.has(fromId) && r2VertexIds.has(toId)) {
        const L = r2L.get(`${fromId}->${toId}`);
        if (L != null) edgeCopy.maxTraversals = L;
      } else {
        const L = originalL.get(`${fromName}->${toName}`) ?? originalL.get(`${fromId}->${toId}`);
        if (L != null) edgeCopy.maxTraversals = L;
      }

      return edgeCopy;
    });

    return out;
  });
}

/**
 * Builds a reverse-lookup map from "fromUID, toUID" to the array of arc
 * objects that connect those two vertices. Mirrors the structure used by
 * the soundness-service for arc UID resolution.
 *
 * @param {ArcMap} arcMap
 * @returns {{ [key: string]: Arc[] }}
 */
function transformArcMapLocal(arcMap) {
  const out = Object.create(null);
  for (const uidStr of Object.keys(arcMap || {})) {
    const arc = arcMap[uidStr];
    if (!arc) continue;
    const k = `${arc.fromVertexUID}, ${arc.toVertexUID}`;
    (out[k] ||= []).push(arc);
  }
  return out;
}

/**
 * Finds the UID of the vertex whose identifier string matches the given value.
 * Returns null if no match is found.
 *
 * @param {VertexMap} vertexMap
 * @param {string}    identifier
 * @returns {string|null}
 */
function findVertexUIDByIdentifier(vertexMap, identifier) {
  for (const uid of Object.keys(vertexMap || {})) {
    if (vertexMap[uid]?.identifier === identifier) return uid;
  }
  return null;
}

/**
 * Resolves a GUI arc UID from a pair of vertex identifier strings.
 * Returns null if either vertex or the arc cannot be found.
 *
 * @param {{ fromId: string, toId: string, vertexMap: VertexMap, arcMap: ArcMap, transformedArcMap: object }} params
 * @returns {string|null}
 */
function findArcUIDByIdentifiers({ fromId, toId, vertexMap, arcMap, transformedArcMap }) {
  const fromUID = findVertexUIDByIdentifier(vertexMap, fromId);
  const toUID   = findVertexUIDByIdentifier(vertexMap, toId);
  if (!fromUID || !toUID) return null;

  const candidates = transformedArcMap[`${fromUID}, ${toUID}`];
  if (!candidates || candidates.length === 0) return null;

  return candidates[0].uid;
}

/**
 * Builds a map of arc UID → { C, L } override values from a CAS graph,
 * used by the renderer to display correct arc attributes for each activity.
 *
 * @param {CASGraph} casGraph
 * @param {{ vertexMap: VertexMap, arcMap: ArcMap, transformedArcMap: object }} maps
 * @returns {{ [arcUID: string]: { C: string, L: number } }}
 */
function buildArcOverridesFromCAS(casGraph, { vertexMap, arcMap, transformedArcMap }) {
  const arcOverrides = {};
  for (const edge of casGraph?.edges ?? []) {
    const fromId = edge.from?.id ?? edge.from;
    const toId   = edge.to?.id   ?? edge.to;

    const arcUID = findArcUIDByIdentifiers({ fromId, toId, vertexMap, arcMap, transformedArcMap });
    if (!arcUID) continue;

    const originalArc = arcMap[arcUID];
    arcOverrides[arcUID] = {
      C: originalArc?.C ?? "ϵ",
      L: edge.maxTraversals ?? edge.L ?? edge.l ?? 1,
    };
  }
  return arcOverrides;
}

/**
 * Converts a CAS graph into arrays of GUI vertex UIDs and arc UIDs.
 * Vertices are matched by identifier string; arcs are matched by endpoint UIDs.
 *
 * @param {CASGraph} graph
 * @param {{ vertexMap: VertexMap, arcMap: ArcMap, transformedArcMap: object }} maps
 * @returns {{ vertices: number[], arcs: number[] }}
 */
function graphToUIDsLocal(graph, { vertexMap, arcMap, transformedArcMap }) {
  const vertexUIDs = [];
  const arcUIDs    = [];

  for (const v of graph?.vertices ?? []) {
    const id  = v?.id ?? v;
    const uid = findVertexUIDByIdentifier(vertexMap, id);
    if (uid) vertexUIDs.push(Number(uid));
  }

  for (const e of graph?.edges ?? []) {
    const fromId = e.from?.id ?? e.from;
    const toId   = e.to?.id   ?? e.to;
    const arcUID = findArcUIDByIdentifiers({ fromId, toId, vertexMap, arcMap, transformedArcMap });
    if (arcUID) arcUIDs.push(Number(arcUID));
  }

  return { vertices: vertexUIDs, arcs: arcUIDs };
}

/**
 * Converts a list of CAS graphs into GUI-ready instance objects for the
 * results panel, one per activity. Each instance includes the arc override
 * map, a per-arc criteria list, and the resolved vertex/arc UID sets.
 *
 * @param {CASGraph[]} casSet
 * @param {{ vertexMap: VertexMap, arcMap: ArcMap, transformedArcMap: object }} maps
 * @returns {object[]}
 */
function buildCASInstances(casSet, { vertexMap, arcMap, transformedArcMap }) {
  return casSet.map((cas, i) => {
    const arcOverrides = buildArcOverridesFromCAS(cas, { vertexMap, arcMap, transformedArcMap });

    const criteria = (cas?.edges ?? []).map((e) => {
      const fromId = e.from?.id ?? e.from;
      const toId   = e.to?.id   ?? e.to;
      const L = e.maxTraversals ?? e.L ?? e.l ?? 1;
      return { pass: true, description: `Arc ${fromId}→${toId} (L=${L})` };
    });

    return {
      name: `Maximal Activity ${i + 1}`,
      evaluation: {
        conclusion: {
          pass: true,
          title: `Generated Maximal Activity ${i + 1}`,
          description: "Maximal Activity derived from the model.",
        },
        criteria,
        violating: { arcs: [], vertices: [] },
        violatingRemarks: { arcs: {}, vertices: {} },
      },
      model:   graphToUIDsLocal(cas, { vertexMap, arcMap, transformedArcMap }),
      options: {
        suppressRBS:         true,
        forceControllerType: true,
        useModelStyling:     true,
        arcOverrides,
      },
    };
  });
}



/**
 * Checks PAE-generated activities for process interruptions caused by
 * reset-safeness violations.
 *
 * Two activities INTERRUPT each other if they both traverse arcs inside the
 * same RBS at overlapping timesteps but do NOT exit via the same out-bridge
 * at the same timestep. This mirrors checkCompetingProcesses in
 * impedance-freeness.mjs but applies the reset-safeness condition instead
 * of L-attribute exhaustion.
 *
 * The following steps are performed:
 *  1. Build arc/vertex maps and identify all RBS centers via the RBS matrix.
 *  2. For each activity and each RBS, collect the timesteps at which the
 *     activity is inside the RBS and the timesteps at which it exits via
 *     an out-bridge.
 *  3. For each pair of activities and each RBS, find overlapping inside-timesteps.
 *  4. If overlap exists, check whether the first out-bridge exits at or after
 *     the overlap start are equal; if not, record a violation.
 *
 * @param {PAEActivity[]} activities - Activities produced by PAE.
 * @param {object}        simpleModel
 * @returns {{
 *   hasInterruption: boolean,
 *   interruptingActivityIds: number[][],
 *   interruptionLog: object[],
 *   violatingArcUIDs: number[]
 * }}
 */
export function checkInterruptingActivities(activities, simpleModel) {
  // 1. Build helper maps and identify all RBS centers
  const arcMap    = buildArcMap(simpleModel.arcs);
  const vertexMap = buildVertexMap(simpleModel.components);
  const rbsMatrix = buildRBSMatrix(vertexMap, simpleModel.arcs);

  const rbsCenters = new Set(Object.values(rbsMatrix));
  if (rbsCenters.size === 0) {
    return { hasInterruption: false, interruptingActivityIds: [], interruptionLog: [], violatingArcUIDs: [] };
  }

  /**
   * Classifies a single arc relative to a given RBS center:
   *  "inside"   — both endpoints belong to the RBS
   *  "outbridge" — FROM is inside, TO is outside
   *  "inbridge"  — TO is inside, FROM is outside
   *  null        — arc does not touch this RBS
   *
   * @param {ArcUID}    arcUID
   * @param {VertexUID} centerUID
   * @returns {"inside"|"outbridge"|"inbridge"|null}
   */
  function classifyArc(arcUID, centerUID) {
    const arc = arcMap[arcUID];
    if (!arc) return null;
    const fromIn = rbsMatrix[arc.fromVertexUID] === centerUID;
    const toIn   = rbsMatrix[arc.toVertexUID]   === centerUID;
    if  (fromIn &&  toIn) return "inside";
    if  (fromIn && !toIn) return "outbridge";
    if (!fromIn &&  toIn) return "inbridge";
    return null;
  }

  // 2. For each activity and each RBS, collect inside-timesteps and exit-timesteps
  const activityRBSData = new Map();
  // activityIdx → centerUID → { inside: Set<t>, exits: Set<t>, insideArcs: Set<arcUID>, outBridgeArcs: Set<arcUID> }

  activities.forEach((activity, idx) => {
    const perRBS = new Map();
    for (const center of rbsCenters) {
      perRBS.set(center, { inside: new Set(), exits: new Set(), insideArcs: new Set(), outBridgeArcs: new Set() });
    }

    const sortedTimesteps = Object.keys(activity.activityProfile).map(Number).sort((a, b) => a - b);

    for (const t of sortedTimesteps) {
      for (const arcUID of activity.activityProfile[t] ?? []) {
        for (const center of rbsCenters) {
          const cls  = classifyArc(arcUID, center);
          const data = perRBS.get(center);
          if (cls === "inside" || cls === "inbridge") {
            data.inside.add(t);
            data.insideArcs.add(arcUID);
          } else if (cls === "outbridge") {
            data.exits.add(t);
            data.outBridgeArcs.add(arcUID);
          }
        }
      }
    }

    activityRBSData.set(idx, perRBS);
  });

  // 3 & 4. Pairwise check: for each (i, j) and each RBS, find overlap and verify exit alignment
  const interruptionLog          = [];
  const violatingArcUIDs         = new Set();
  const interruptingActivityIds  = [];

  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      const A = activityRBSData.get(i);
      const B = activityRBSData.get(j);

      for (const center of rbsCenters) {
        const a = A.get(center);
        const b = B.get(center);

        // Skip if either activity does not enter this RBS
        if (a.inside.size === 0 || b.inside.size === 0) continue;

        // Find overlapping inside-timesteps
        const overlap = [...a.inside].filter((t) => b.inside.has(t));
        if (overlap.length === 0) continue;

        // Check whether the first exit at-or-after the overlap start is the same for both
        const tStart = Math.min(...overlap);
        const aExit  = [...a.exits].filter((t) => t >= tStart).sort((x, y) => x - y)[0];
        const bExit  = [...b.exits].filter((t) => t >= tStart).sort((x, y) => x - y)[0];

        const isViolation = aExit === undefined || bExit === undefined || aExit !== bExit;

        if (isViolation) {
          const aId = activities[i].processId;
          const bId = activities[j].processId;

          // Collect overlapping internal arcs and any unmatched out-bridge arcs as violating
          const violatingForPair = new Set();
          for (const t of overlap) {
            for (const arcUID of activities[i].activityProfile[t] ?? []) {
              if (a.insideArcs.has(arcUID)) violatingForPair.add(arcUID);
            }
            for (const arcUID of activities[j].activityProfile[t] ?? []) {
              if (b.insideArcs.has(arcUID)) violatingForPair.add(arcUID);
            }
          }
          if (aExit !== undefined) {
            for (const arcUID of activities[i].activityProfile[aExit] ?? []) {
              if (a.outBridgeArcs.has(arcUID)) violatingForPair.add(arcUID);
            }
          }
          if (bExit !== undefined) {
            for (const arcUID of activities[j].activityProfile[bExit] ?? []) {
              if (b.outBridgeArcs.has(arcUID)) violatingForPair.add(arcUID);
            }
          }
          for (const uid of violatingForPair) violatingArcUIDs.add(uid);

          const centerLabel = vertexMap[center]?.identifier ?? center;
          interruptingActivityIds.push([aId, bId]);
          interruptionLog.push({
            rbsCenter:        centerLabel,
            activityIds:      [aId, bId],
            overlapTimesteps: overlap,
            aExitTimestep:    aExit ?? null,
            bExitTimestep:    bExit ?? null,
            violatingArcUIDs: [...violatingForPair],
            reason:
              `Activities ${aId} and ${bId} both traverse RBS '${centerLabel}' ` +
              `at overlapping timesteps [${overlap.join(", ")}] ` +
              (aExit === undefined || bExit === undefined
                ? `but at least one does not exit via an out-bridge — process interruption.`
                : `but exit at different timesteps (t=${aExit} vs t=${bExit}) — process interruption.`),
          });
        }
      }
    }
  }

  return {
    hasInterruption:         interruptionLog.length > 0,
    interruptingActivityIds,
    interruptionLog,
    violatingArcUIDs:        [...violatingArcUIDs],
  };
}