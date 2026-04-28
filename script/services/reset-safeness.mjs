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
 * Reset-safeness verification (GUI-friendly result object)
 * - Extract candidate CAS via CASExtractor (same pipeline as impedance-freeness).
 * - Keep only MAXIMAL activities (remove strict subsets).
 * - Check reset-safeness per RBS.
 */
export function verifyResetSafeness(simpleModel, source, sink) {
  const arcMap = buildArcMap(simpleModel.arcs);
  const vertexMap = buildVertexMap(simpleModel.components);

  const inVertices = getInBridges(simpleModel, arcMap, vertexMap);
  const outVertices = getOutBridges(simpleModel, arcMap, vertexMap);

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

  const { rdltGraph, r2Graphs, r1Graph } = mapToGraphs(inputRDLT, R2, R1);

  // ---- FIX: normalize id comparisons (UI select gives strings) ----
  const srcKey = String(source);
  const snkKey = String(sink);

  const sourceVertex = rdltGraph.vertices.find((v) => String(v.id) === srcKey);
  const sinkVertex = rdltGraph.vertices.find((v) => String(v.id) === snkKey);

  if (!sourceVertex || !sinkVertex) {
    return unresolvedSourceSinkResult();
  }

  // ---- Build combined R2Graph (as you already do in impedance-freeness) ----
  let R2Graph = null;
  if (r2Graphs.length > 0) {
    R2Graph = new Graph();
    for (const { graph } of r2Graphs) {
      graph.vertices.forEach((v) => {
        if (!R2Graph.vertices.some((e) => e.id === v.id)) R2Graph.addVertex(v);
      });
      graph.edges.forEach((e) => {
        if (
          !R2Graph.edges.some(
            (ex) => ex.from.id === e.from.id && ex.to.id === e.to.id,
          )
        ) {
          R2Graph.addEdge(e);
        }
      });
    }
  }

  // ---- Extract CAS candidates ----
  const { casSet } = CASExtractor.extractAllCASWithDetails(
    rdltGraph,
    r1Graph,
    R2Graph,
    source,
    sink,
  );

  // Normalize L values (optional, but keeps consistency with your other verifier)
  const normalizedCAS = normalizeCASLValues(casSet, rdltGraph, R2Graph);

  if (!normalizedCAS || normalizedCAS.length === 0) {
    return unreachableResultResetSafe();
  }

  // All extracted activities are checked as pairs. A naive edge-set subset
  // filter would incorrectly drop one activity when two activities share the
  // same RBS sub-path but enter via different in-bridges — exactly the case
  // that needs a reset-safeness check.
  if (normalizedCAS.length === 1) {
    return singleActivityResetSafeResult(normalizedCAS, {
      vertexMap,
      arcMap,
    });
  }

  // ---- Reset-safeness check per RBS ----
  const rbsList = rdltGraph.resetBoundSubsystems ?? [];
  const check = checkResetSafeness({
    rdltGraph,
    rbsList,
    maximalActivities: normalizedCAS,
  });

  // Convert violating arc keys to GUI arc UIDs so the renderer can highlight them
  const transformedArcMap = transformArcMapLocal(arcMap);

  const violatingArcUIDs = check.violatingArcKeys
    .map((key) => {
      const [fromId, toId] = key.split("->");
      const arcUID = findArcUIDByIdentifiers({
        fromId,
        toId,
        vertexMap,
        arcMap,
        transformedArcMap,
      });
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

  // Show ALL normalized activities in the UI (same as impedance-freeness),
  // not just the maximal subset used for the check.
  const casInstances = buildCASInstances(normalizedCAS, {
    vertexMap,
    arcMap,
    transformedArcMap,
  });

  return {
    title: "Reset-safeness",
    instances: [mainInstance, ...casInstances],
  };
}

/* ====================================================================== */
/* Reset-safeness checker                                                  */
/* ====================================================================== */

function checkResetSafeness({ rdltGraph, rbsList, maximalActivities }) {
  const criteria = [];
  const violatingArcKeys = new Set();
  let pass = true;

  // Precompute per activity: ordered edge list (time = edge index along the path)
  const orderedActivities = maximalActivities.map((cas) =>
    orderCASEdgesAsPath(cas),
  );

  // For each RBS G, check every pair of maximal activities
  for (let gIndex = 0; gIndex < rbsList.length; gIndex++) {
    const G = rbsList[gIndex];

    // Collect all vertex IDs AND names that belong to G (center + members).
    // IMPORTANT: rdltGraph vertex IDs are UIDs (e.g. "5"), but CAS edges from
    // CASExtractor use identifier strings (e.g. "x", "c1") as their vertex IDs.
    // We must build gVertices covering BOTH schemes so that arc key lookups work
    // regardless of which ID scheme an edge uses.
    const gVertices = new Set();
    for (const v of G.members ?? []) {
      if (v?.id != null) gVertices.add(String(v.id));       // UID
      if (v?.name != null) gVertices.add(String(v.name));   // identifier string
    }
    const gCenter = G.center;
    if (gCenter?.id != null) gVertices.add(String(gCenter.id));
    if (gCenter?.name != null) gVertices.add(String(gCenter.name));

    // Build arc key sets in BOTH UID-based and name-based forms so they match
    // regardless of whether the edges come from rdltGraph (UIDs) or CAS (names).
    const internalKeys = new Set();
    const outBridgeKeys = new Set();
    const activeInGKeys = new Set(); // internal ∪ out-bridge — "from inside G"

    for (const e of rdltGraph.edges ?? []) {
      // Each rdltGraph edge has UID-based vertex IDs; its vertices also carry .name
      const fromUID = e.from?.id != null ? String(e.from.id) : null;
      const fromName = e.from?.name != null ? String(e.from.name) : null;
      const toUID = e.to?.id != null ? String(e.to.id) : null;
      const toName = e.to?.name != null ? String(e.to.name) : null;

      const inFrom = (fromUID && gVertices.has(fromUID)) || (fromName && gVertices.has(fromName));
      const inTo = (toUID && gVertices.has(toUID)) || (toName && gVertices.has(toName));

      // Add BOTH the UID-based key and the name-based key so CAS edges match
      const uidKey = fromUID && toUID ? `${fromUID}->${toUID}` : null;
      const nameKey = fromName && toName ? `${fromName}->${toName}` : null;

      if (inFrom && inTo) {
        if (uidKey) { internalKeys.add(uidKey); activeInGKeys.add(uidKey); }
        if (nameKey) { internalKeys.add(nameKey); activeInGKeys.add(nameKey); }
      }
      if (inFrom && !inTo) {
        if (uidKey) { outBridgeKeys.add(uidKey); activeInGKeys.add(uidKey); }
        if (nameKey) { outBridgeKeys.add(nameKey); activeInGKeys.add(nameKey); }
      }
    }

    // If no out-bridge exists, any simultaneous use of G is automatically a failure
    // because neither activity can ever safely exit G and trigger a clean reset.
    const gHasOutBridge = outBridgeKeys.size > 0;

    for (let i = 0; i < orderedActivities.length; i++) {
      for (let j = i + 1; j < orderedActivities.length; j++) {
        const A = orderedActivities[i];
        const B = orderedActivities[j];

        // Build bitmaps: does the activity "use G" at each timestep?
        // Using activeInGKeys (from-inside-G) correctly captures the window
        // during which the activity is executing inside the RBS.
        const aIn = timelineActiveInG(A, activeInGKeys);
        const bIn = timelineActiveInG(B, activeInGKeys);

        const aUses = aIn.some(Boolean);
        const bUses = bIn.some(Boolean);

        // Case (3): neither activity uses G at all → reset-safe for this pair/RBS
        if (!aUses && !bUses) {
          criteria.push({
            pass: true,
            description: `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${
              j + 1
            } do not use this RBS at all.`,
          });
          continue;
        }

        // Case (3) asymmetric: only one uses G → the other never enters,
        // so they cannot interfere with each other inside G.
        if (!aUses || !bUses) {
          criteria.push({
            pass: true,
            description: `RBS ${labelRBS(G, gIndex)} — Only one of Activities ${
              i + 1
            } and ${j + 1} uses this RBS; the other does not enter it at all.`,
          });
          continue;
        }

        // Both use G. Find intervals where both are SIMULTANEOUSLY inside G.
        // We must not truncate by Math.min — pad the shorter timeline with false.
        const overlaps = overlapIntervals(aIn, bIn);

        // Case (2): they never use G at the same time → reset-safe for this pair/RBS
        if (overlaps.length === 0) {
          criteria.push({
            pass: true,
            description: `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${
              j + 1
            } both use this RBS but never at the same time.`,
          });
          continue;
        }

        // Case (1): they DO overlap inside G.
        // Per the formal definition, they must BOTH exit an out-bridge of G
        // at the same timestep (i.e. the same number of steps from the start
        // of the activity, which corresponds to equal path-lengths from the
        // looping-arc source to the out-bridge vertex).
        //
        // We check: for each overlap interval, the first out-bridge exit of A
        // at-or-after the overlap start equals the first out-bridge exit of B
        // at-or-after the overlap start.

        if (!gHasOutBridge) {
          // No out-bridge → activities can never satisfy the simultaneous-exit
          // condition → automatically not reset-safe.
          pass = false;
          collectViolatingArcs(A, B, internalKeys, outBridgeKeys, overlaps, violatingArcKeys);
          criteria.push({
            pass: false,
            description: `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${
              j + 1
            } overlap inside RBS but no out-bridge exists to exit from (NOT reset-safe).`,
          });
          continue;
        }

        const aExitTimes = exitTimesFromActivity(A, outBridgeKeys);
        const bExitTimes = exitTimesFromActivity(B, outBridgeKeys);

        let pairOK = true;
        const pairViolatingKeys = new Set();

        for (const [tStart, tEnd] of overlaps) {
          const exitA = firstExitAtOrAfter(aExitTimes, tStart);
          const exitB = firstExitAtOrAfter(bExitTimes, tStart);

          // Both must exit, and they must exit at the same timestep index.
          if (exitA == null || exitB == null || exitA !== exitB) {
            pairOK = false;

            // Collect the out-bridge arcs they actually traverse (if any)
            if (exitA != null) {
              const kA = edgeKeyAt(A, exitA);
              if (kA) pairViolatingKeys.add(kA);
            }
            if (exitB != null) {
              const kB = edgeKeyAt(B, exitB);
              if (kB) pairViolatingKeys.add(kB);
            }

            // Also highlight the overlapping internal arcs so the user can
            // see WHERE the conflicting simultaneous traversal occurs.
            for (let t = tStart; t <= tEnd; t++) {
              const kA = edgeKeyAt(A, t);
              if (kA && internalKeys.has(kA)) pairViolatingKeys.add(kA);
              const kB = edgeKeyAt(B, t);
              if (kB && internalKeys.has(kB)) pairViolatingKeys.add(kB);
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
            ? `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${
                j + 1
              } overlap inside RBS and exit its out-bridge at the same timestep (reset-safe).`
            : `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${
                j + 1
              } overlap inside RBS but do NOT exit its out-bridge at the same timestep (NOT reset-safe).`,
        });
      }
    }
  }

  return {
    pass,
    criteria,
    violatingArcKeys: [...violatingArcKeys],
  };
}

function labelRBS(G, idx) {
  const center = G?.center?.name ?? G?.center?.id ?? G?.center;
  if (center != null) return `with center ${center}`;
  return `#${idx + 1}`;
}

/**
 * Collect violating arc keys for the no-out-bridge failure case.
 */
function collectViolatingArcs(A, B, internalKeys, outBridgeKeys, overlaps, violatingArcKeys) {
  for (const [tStart, tEnd] of overlaps) {
    for (let t = tStart; t <= tEnd; t++) {
      const kA = edgeKeyAt(A, t);
      if (kA && internalKeys.has(kA)) violatingArcKeys.add(kA);
      const kB = edgeKeyAt(B, t);
      if (kB && internalKeys.has(kB)) violatingArcKeys.add(kB);
    }
  }
}

/* ====================================================================== */
/* Maximal activities selection                                             */
/* ====================================================================== */

function keepOnlyMaximalCAS(casSet) {
  // Represent each CAS as a set of "from->to" keys
  const sets = casSet.map((cas) => {
    const s = new Set();
    for (const e of cas?.edges ?? []) {
      const fromId = e.from?.id ?? e.from;
      const toId = e.to?.id ?? e.to;
      s.add(`${fromId}->${toId}`);
    }
    return s;
  });

  const keep = new Array(casSet.length).fill(true);

  for (let i = 0; i < casSet.length; i++) {
    if (!keep[i]) continue;
    for (let j = 0; j < casSet.length; j++) {
      if (i === j || !keep[i]) continue;

      // if i is a strict subset of j, drop i
      if (isStrictSubset(sets[i], sets[j])) {
        keep[i] = false;
      }
    }
  }

  return casSet.filter((_, idx) => keep[idx]);
}

function isStrictSubset(a, b) {
  if (a.size >= b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/* ====================================================================== */
/* Timeline helpers (time = edge index along the path)                      */
/* ====================================================================== */

function orderCASEdgesAsPath(casGraph) {
  // We need an ordered path to define timesteps.
  // CAS edges are often already “path-like” but may not be stored in order.
  // We'll try to build a path: pick a start vertex with indeg 0, then follow outgoing edges.

  const edges = Array.isArray(casGraph?.edges) ? [...casGraph.edges] : [];
  if (edges.length <= 1) return edges;

  const out = new Map(); // fromId -> Edge[]
  const indeg = new Map(); // vertexId -> count
  const vertices = new Set();

  for (const e of edges) {
    const fromId = e.from?.id ?? e.from;
    const toId = e.to?.id ?? e.to;
    vertices.add(fromId);
    vertices.add(toId);

    if (!out.has(fromId)) out.set(fromId, []);
    out.get(fromId).push(e);

    indeg.set(toId, (indeg.get(toId) ?? 0) + 1);
    if (!indeg.has(fromId)) indeg.set(fromId, indeg.get(fromId) ?? 0);
  }

  // Find a start: indeg 0 if possible
  let start = null;
  for (const v of vertices) {
    if ((indeg.get(v) ?? 0) === 0) {
      start = v;
      break;
    }
  }

  // Fallback: use the fromId of the first edge
  if (start == null) start = edges[0].from?.id ?? edges[0].from;

  const used = new Set();
  const ordered = [];

  let cur = start;
  while (ordered.length < edges.length) {
    const candidates = out.get(cur) ?? [];
    const next = candidates.find((e) => !used.has(e));
    if (!next) break;

    ordered.push(next);
    used.add(next);
    cur = next.to?.id ?? next.to;
  }

  // Append any leftover edges (shouldn't happen for simple path CAS, but safe)
  for (const e of edges) {
    if (!used.has(e)) ordered.push(e);
  }

  return ordered;
}

function edgeKeyAt(orderedEdges, t) {
  const e = orderedEdges[t];
  if (!e) return null;
  const fromId = e.from?.id ?? e.from;
  const toId = e.to?.id ?? e.to;
  return `${fromId}->${toId}`;
}

/**
 * Build a boolean timeline: activeInGKeys[t] = true if at timestep t the
 * activity is executing an arc whose FROM vertex is inside G (internal arc
 * or out-bridge). This correctly captures the window where the activity is
 * "inside" the RBS — including the moment it exits via an out-bridge.
 */
function timelineActiveInG(orderedEdges, activeInGKeys) {
  return orderedEdges.map((e) => {
    const fromId = e.from?.id ?? e.from;
    const toId = e.to?.id ?? e.to;
    return activeInGKeys.has(`${fromId}->${toId}`);
  });
}

/**
 * Collect timestep indices where the activity traverses an out-bridge of G.
 */
function exitTimesFromActivity(orderedEdges, outBridgeKeys) {
  const times = [];
  for (let t = 0; t < orderedEdges.length; t++) {
    const fromId = orderedEdges[t].from?.id ?? orderedEdges[t].from;
    const toId = orderedEdges[t].to?.id ?? orderedEdges[t].to;
    if (outBridgeKeys.has(`${fromId}->${toId}`)) times.push(t);
  }
  return times;
}

/**
 * Find intervals [tStart, tEnd] where BOTH activities are simultaneously
 * inside G. The two timelines may have different lengths; we iterate over
 * the full length of both (treating out-of-bounds as false) to avoid
 * silently truncating the overlap search.
 */
function overlapIntervals(inA, inB) {
  const n = Math.max(inA.length, inB.length);
  const intervals = [];
  let start = null;

  for (let t = 0; t < n; t++) {
    const both = !!(inA[t] ?? false) && !!(inB[t] ?? false);
    if (both && start == null) start = t;
    if (!both && start != null) {
      intervals.push([start, t - 1]);
      start = null;
    }
  }
  if (start != null) intervals.push([start, n - 1]);
  return intervals;
}

function firstExitAtOrAfter(exitTimesList, tStart) {
  for (const t of exitTimesList) if (t >= tStart) return t;
  return null;
}

/* ====================================================================== */
/* Result helpers                                                          */
/* ====================================================================== */

function unresolvedSourceSinkResult() {
  return {
    title: "Reset-safeness",
    instances: [
      {
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
      },
    ],
  };
}

function unreachableResultResetSafe() {
  return {
    title: "Reset-safeness",
    instances: [
      {
        name: "Main Model",
        evaluation: {
          conclusion: {
            pass: false,
            title: "Not Reset-safe",
            description:
              "No maximal activities could be derived — sink is unreachable.",
          },
          criteria: [],
          violating: { arcs: [], vertices: [] },
        },
      },
    ],
  };
}

function singleActivityResetSafeResult(singleSet, { vertexMap, arcMap }) {
  const transformedArcMap = transformArcMapLocal(arcMap);
  const casInstances = buildCASInstances(singleSet, {
    vertexMap,
    arcMap,
    transformedArcMap,
  });

  return {
    title: "Reset-safeness",
    instances: [
      {
        name: "Main Model",
        evaluation: {
          conclusion: {
            pass: true,
            title: "Reset-safe",
            description:
              "Only one activity exists — no pair to compare for reset-safeness.",
          },
          criteria: [
            {
              pass: true,
              description: "Single activity — reset-safe by definition.",
            },
          ],
          violating: { arcs: [], vertices: [] },
        },
      },
      ...casInstances,
    ],
  };
}

/* ====================================================================== */
/* Existing helpers from your file (kept as-is where possible)             */
/* ====================================================================== */

function getInBridges(model, arcMap, vertexMap) {
  const rbsMatrix = buildRBSMatrix(vertexMap, model.arcs);
  const inBridgesUIDs = new Set();
  const inBridges = new Set();

  for (const arc of model.arcs) {
    if (isInbridge(arc.uid, arcMap, rbsMatrix)) inBridgesUIDs.add(arc.uid);
  }

  for (const uid of inBridgesUIDs) {
    const arc = arcMap[uid];
    const fromVertex = vertexMap[arc.fromVertexUID];
    const toVertex = vertexMap[arc.toVertexUID];
    if (fromVertex && toVertex) inBridges.add(`${fromVertex.identifier}, ${toVertex.identifier}`);
  }

  return inBridges;
}

function getOutBridges(model, arcMap, vertexMap) {
  const rbsMatrix = buildRBSMatrix(vertexMap, model.arcs);
  const outBridgesUIDs = new Set();
  const outBridges = new Set();

  for (const arc of model.arcs) {
    if (isOutbridge(arc.uid, arcMap, rbsMatrix)) outBridgesUIDs.add(arc.uid);
  }

  for (const uid of outBridgesUIDs) {
    const arc = arcMap[uid];
    const fromVertex = vertexMap[arc.fromVertexUID];
    const toVertex = vertexMap[arc.toVertexUID];
    if (fromVertex && toVertex) outBridges.add(`${fromVertex.identifier}, ${toVertex.identifier}`);
  }

  return outBridges;
}

function mapToGraphs(rdlt, R2, R1) {
  const rdltGraph = new Graph();
  let r2Graphs;
  const r1Graph = new Graph();

  if (rdlt && rdlt.model && rdlt.model.components && rdlt.model.arcs) {
    rdlt.model.components.forEach((component) => {
      const vertex = new Vertex(
        component.uid,
        VertexType.ENTITY_OBJECT,
        {},
        component.identifier || "",
      );
      rdltGraph.addVertex(vertex);
    });

    rdlt.model.arcs.forEach((arc) => {
      const fromVertex = rdltGraph.vertices.find((v) => v.id === arc.fromVertexUID);
      const toVertex = rdltGraph.vertices.find((v) => v.id === arc.toVertexUID);
      const edge = new Edge(
        arc.uid,
        fromVertex,
        toVertex,
        arc.C,
        arc.L,
        [],
      );
      rdltGraph.addEdge(edge);
    });

    // Map Reset-Bound Subsystems (RBS)
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
            const toVertex = rdltGraph.vertices.find((v) => v.name === toId);
            return rdltGraph.edges.find((edge) => edge.from === fromVertex && edge.to === toVertex);
          })
          .filter((edge) => edge && (members.includes(edge.to) || centerVertex === edge.to));

        const outBridges = rdlt.out_list
          .map((entry) => {
            const [fromId, toId] = entry.split(", ");
            const fromVertex = rdltGraph.vertices.find((v) => v.name === fromId);
            const toVertex = rdltGraph.vertices.find((v) => v.name === toId);
            return rdltGraph.edges.find((edge) => edge.from === fromVertex && edge.to === toVertex);
          })
          .filter((edge) => edge && members.includes(edge.from));

        const resetBoundSubsystem = new ResetBoundSubsystem(
          centerVertex,
          members,
          inBridges,
          outBridges,
        );
        rdltGraph.addResetBoundSubsystem(resetBoundSubsystem);
      });
    }
  }

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
        if (!graph.vertices.find((v) => v.id === toId)) graph.addVertex(toVertex);

        const edge = new Edge(
          arc["r-id"],
          fromVertex,
          toVertex,
          arc["c-attribute"],
          parseInt(arc["l-attribute"], 10),
          [],
        );
        graph.addEdge(edge);
      });
      return { rNumber, graph };
    });
  } else {
    r2Graphs = [];
  }

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
      if (!r1Graph.vertices.find((v) => v.id === toId)) r1Graph.addVertex(toVertex);

      const edge = new Edge(
        arc["r-id"],
        fromVertex,
        toVertex,
        arc["c-attribute"],
        parseInt(arc["l-attribute"], 10),
        [],
      );
      r1Graph.addEdge(edge);
    });
  }

  return { rdltGraph, r2Graphs, r1Graph };
}

function normalizeCASLValues(casSet, originalRDLT, R2Graph) {
  const r2VertexIds = new Set((R2Graph?.vertices ?? []).map((v) => v.id));

  const originalL = new Map();
  for (const e of originalRDLT?.edges ?? []) {
    const kName = `${e.from?.name ?? e.from?.id}->${e.to?.name ?? e.to?.id}`;
    const kId = `${e.from?.id}->${e.to?.id}`;
    const L = e.maxTraversals ?? e.l ?? e.L ?? e.lAttribute;
    if (L != null) {
      if (!originalL.has(kName)) originalL.set(kName, L);
      if (!originalL.has(kId)) originalL.set(kId, L);
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

      const fromId = edge.from?.id;
      const toId = edge.to?.id;
      const fromName = edge.from?.name ?? fromId;
      const toName = edge.to?.name ?? toId;

      const insideRBS = r2VertexIds.has(fromId) && r2VertexIds.has(toId);

      if (insideRBS) {
        const k = `${fromId}->${toId}`;
        const L = r2L.get(k);
        if (L != null) edgeCopy.maxTraversals = L;
      } else {
        const kName = `${fromName}->${toName}`;
        const kId = `${fromId}->${toId}`;
        const L = originalL.get(kName) ?? originalL.get(kId);
        if (L != null) edgeCopy.maxTraversals = L;
      }

      return edgeCopy;
    });

    return out;
  });
}

// --- helper: build "fromUID, toUID" -> [arcObj...] like soundness-service does ---
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

function findVertexUIDByIdentifier(vertexMap, identifier) {
  for (const uid of Object.keys(vertexMap || {})) {
    if (vertexMap[uid]?.identifier === identifier) return uid;
  }
  return null;
}

function findArcUIDByIdentifiers({ fromId, toId, vertexMap, arcMap, transformedArcMap }) {
  const fromUID = findVertexUIDByIdentifier(vertexMap, fromId);
  const toUID = findVertexUIDByIdentifier(vertexMap, toId);
  if (!fromUID || !toUID) return null;

  const arcKey = `${fromUID}, ${toUID}`;
  const candidates = transformedArcMap[arcKey];
  if (!candidates || candidates.length === 0) return null;

  return candidates[0].uid;
}

/* ---------------------------------------------------------------------- */
/* Keep your existing CAS renderer blocks so the UI can show activities    */
/* ---------------------------------------------------------------------- */

function buildArcOverridesFromCAS(casGraph, { vertexMap, arcMap, transformedArcMap }) {
  const arcOverrides = {};
  for (const edge of casGraph?.edges ?? []) {
    const fromId = edge.from?.id ?? edge.from;
    const toId = edge.to?.id ?? edge.to;

    const arcUID = findArcUIDByIdentifiers({
      fromId,
      toId,
      vertexMap,
      arcMap,
      transformedArcMap,
    });

    if (!arcUID) continue;

    const originalArc = arcMap[arcUID];
    arcOverrides[arcUID] = {
      C: originalArc?.C ?? "ϵ",
      L: edge.maxTraversals ?? edge.L ?? edge.l ?? 1,
    };
  }
  return arcOverrides;
}

function graphToUIDsLocal(graph, { vertexMap, arcMap, transformedArcMap }) {
  const vertexUIDs = [];
  const arcUIDs = [];

  for (const v of graph?.vertices ?? []) {
    const id = v?.id ?? v;
    const uid = findVertexUIDByIdentifier(vertexMap, id);
    if (uid) vertexUIDs.push(Number(uid));
  }

  for (const e of graph?.edges ?? []) {
    const fromId = e.from?.id ?? e.from;
    const toId = e.to?.id ?? e.to;
    const arcUID = findArcUIDByIdentifiers({
      fromId,
      toId,
      vertexMap,
      arcMap,
      transformedArcMap,
    });
    if (arcUID) arcUIDs.push(Number(arcUID));
  }

  return { vertices: vertexUIDs, arcs: arcUIDs };
}

function buildCASInstances(casSet, { vertexMap, arcMap, transformedArcMap }) {
  return casSet.map((cas, i) => {
    const arcOverrides = buildArcOverridesFromCAS(cas, {
      vertexMap,
      arcMap,
      transformedArcMap,
    });

    const criteria = (cas?.edges ?? []).map((e) => {
      const fromId = e.from?.id ?? e.from;
      const toId = e.to?.id ?? e.to;
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
      model: graphToUIDsLocal(cas, { vertexMap, arcMap, transformedArcMap }),
      options: {
        suppressRBS: true,
        forceControllerType: true,
        useModelStyling: true,
        arcOverrides,
      },
    };
  });
}

/* ====================================================================== */
/* Process interruption check for PAE-generated activities                 */
/* ====================================================================== */

/**
 * Takes activities generated by PAE and checks for process interruptions.
 * Two activities INTERRUPT each other if they both traverse arcs inside
 * the same RBS at overlapping timesteps but do NOT exit via the same
 * out-bridge at the same timestep.
 *
 * This mirrors checkCompetingProcesses in impedance-freeness.mjs but
 * checks reset-safeness instead of L-attribute exhaustion.
 *
 * @param {{ processId: number, activityProfile: { [timestep: number]: Set<number> } }[]} activities
 * @param {object} simpleModel
 * @returns {{
 *   hasInterruption: boolean,
 *   interruptingActivityIds: number[][],
 *   interruptionLog: object[],
 *   violatingArcUIDs: number[]
 * }}
 */
export function checkInterruptingActivities(activities, simpleModel) {
  // Build helper maps
  const arcMap = buildArcMap(simpleModel.arcs);
  const vertexMap = buildVertexMap(simpleModel.components);
  const rbsMatrix = buildRBSMatrix(vertexMap, simpleModel.arcs);

  // Collect all RBS centers
  const rbsCenters = new Set(Object.values(rbsMatrix));
  if (rbsCenters.size === 0) {
    return {
      hasInterruption: false,
      interruptingActivityIds: [],
      interruptionLog: [],
      violatingArcUIDs: [],
    };
  }

  // For each activity and each RBS, build:
  //   insideTimesteps:    Set<number>   timesteps when the activity is inside this RBS
  //   outBridgeExitTimes: Set<number>   timesteps at which the activity exits via an out-bridge
  // An arc is "inside" RBS G if BOTH its endpoints are inside G (rbsMatrix[from]=center && rbsMatrix[to]=center)
  // An arc is an "out-bridge" if rbsMatrix[from]=center && rbsMatrix[to]!==center (exits the RBS)
  function classifyArc(arcUID, centerUID) {
    const arc = arcMap[arcUID];
    if (!arc) return null;
    const fromIn = rbsMatrix[arc.fromVertexUID] === centerUID;
    const toIn = rbsMatrix[arc.toVertexUID] === centerUID;
    if (fromIn && toIn)  return "inside";
    if (fromIn && !toIn) return "outbridge";
    if (!fromIn && toIn) return "inbridge";
    return null;
  }

  // Per-activity, per-RBS classification
  const activityRBSData = new Map(); // activityIdx → centerUID → { inside: Set<t>, exits: Set<t>, insideArcs: Set<arcUID>, outBridgeArcs: Set<arcUID> }

  activities.forEach((activity, idx) => {
    const perRBS = new Map();
    for (const center of rbsCenters) {
      perRBS.set(center, {
        inside: new Set(),
        exits: new Set(),
        insideArcs: new Set(),
        outBridgeArcs: new Set(),
      });
    }

    const sortedTimesteps = Object.keys(activity.activityProfile)
      .map(Number)
      .sort((a, b) => a - b);

    for (const t of sortedTimesteps) {
      for (const arcUID of activity.activityProfile[t] ?? []) {
        for (const center of rbsCenters) {
          const cls = classifyArc(arcUID, center);
          const data = perRBS.get(center);
          if (cls === "inside" || cls === "inbridge") {
            // Process is inside the RBS at this timestep
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

  // Pair-wise check: for each (i, j) with i<j, for each RBS:
  //   If both have inside-timesteps, find overlap.
  //   If overlap exists, check if both exit at same timestep.
  const interruptionLog = [];
  const violatingArcUIDs = new Set();
  const interruptingActivityIds = [];

  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      const A = activityRBSData.get(i);
      const B = activityRBSData.get(j);

      for (const center of rbsCenters) {
        const a = A.get(center);
        const b = B.get(center);

        if (a.inside.size === 0 || b.inside.size === 0) continue;

        // Find overlapping timesteps
        const overlap = [...a.inside].filter(t => b.inside.has(t));
        if (overlap.length === 0) continue;

        // Compute first exit at-or-after the earliest overlap timestep for each
        const tStart = Math.min(...overlap);
        const aExit = [...a.exits].filter(t => t >= tStart).sort((x, y) => x - y)[0];
        const bExit = [...b.exits].filter(t => t >= tStart).sort((x, y) => x - y)[0];

        const isViolation =
          aExit === undefined || bExit === undefined || aExit !== bExit;

        if (isViolation) {
          const aId = activities[i].processId;
          const bId = activities[j].processId;

          // Highlight overlapping internal arcs and any unmatched outbridge arcs
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

          const centerVertex = vertexMap[center];
          const centerLabel = centerVertex?.identifier ?? center;
          interruptingActivityIds.push([aId, bId]);
          interruptionLog.push({
            rbsCenter: centerLabel,
            activityIds: [aId, bId],
            overlapTimesteps: overlap,
            aExitTimestep: aExit ?? null,
            bExitTimestep: bExit ?? null,
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
    hasInterruption: interruptionLog.length > 0,
    interruptingActivityIds,
    interruptionLog,
    violatingArcUIDs: [...violatingArcUIDs],
  };
}