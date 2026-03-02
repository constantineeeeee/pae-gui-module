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

  // ---- IMPORTANT: keep only MAXIMAL activities (remove strict subsets) ----
  const maximalActivities = keepOnlyMaximalCAS(normalizedCAS);

  // If still 0/1, reset-safeness is trivially satisfied (no pair to compare)
  if (maximalActivities.length === 1) {
    return singleActivityResetSafeResult(maximalActivities, {
      vertexMap,
      arcMap,
    });
  }

  // ---- Reset-safeness check per RBS ----
  const rbsList = rdltGraph.resetBoundSubsystems ?? [];
  const check = checkResetSafeness({
    rdltGraph,
    rbsList,
    maximalActivities,
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

  // Optional: show the maximal activities in the results panel (like your impedance-freeness UI)
  const casInstances = buildCASInstances(maximalActivities, {
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

  // Precompute per activity: ordered edge list (time = edge index)
  const orderedActivities = maximalActivities.map((cas) =>
    orderCASEdgesAsPath(cas),
  );

  // For each RBS G, check every pair of maximal activities
  for (let gIndex = 0; gIndex < rbsList.length; gIndex++) {
    const G = rbsList[gIndex];

    const gVertices = new Set(
      (G.members ?? []).map((v) => v?.id ?? v).filter((x) => x != null),
    );
    const gCenter = G.center?.id ?? G.center;
    if (gCenter != null) gVertices.add(gCenter);

    // Build internal/out-bridge arc key sets for quick checks
    const internalKeys = new Set();
    const outBridgeKeys = new Set();

    for (const e of rdltGraph.edges ?? []) {
      const fromId = e.from?.id ?? e.from;
      const toId = e.to?.id ?? e.to;
      const inFrom = gVertices.has(fromId);
      const inTo = gVertices.has(toId);

      const k = `${fromId}->${toId}`;
      if (inFrom && inTo) internalKeys.add(k);
      if (inFrom && !inTo) outBridgeKeys.add(k);
    }

    // If no out-bridge exists, simultaneous use cannot be safely reset (practically fail if overlap occurs)
    const gHasOutBridge = outBridgeKeys.size > 0;

    for (let i = 0; i < orderedActivities.length; i++) {
      for (let j = i + 1; j < orderedActivities.length; j++) {
        const A = orderedActivities[i];
        const B = orderedActivities[j];

        const aIn = timelineInG(A, internalKeys);
        const bIn = timelineInG(B, internalKeys);

        const aUses = aIn.some(Boolean);
        const bUses = bIn.some(Boolean);

        // Case (3): both do not use G at all
        if (!aUses && !bUses) {
          criteria.push({
            pass: true,
            description: `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${
              j + 1
            } do not use this RBS.`,
          });
          continue;
        }

        // Compute overlap times where both are inside G at the same time
        const overlaps = overlapIntervals(aIn, bIn);

        // Case (2): they do not use G at the same time
        if (overlaps.length === 0) {
          criteria.push({
            pass: true,
            description: `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${
              j + 1
            } do not use this RBS at the same time.`,
          });
          continue;
        }

        // Case (1): if overlap, must exit out-bridge at same timestep
        const aExitTimes = exitTimes(A, outBridgeKeys);
        const bExitTimes = exitTimes(B, outBridgeKeys);

        let pairOK = true;

        for (const [tStart, tEnd] of overlaps) {
          const exitA = firstExitAtOrAfter(aExitTimes, tStart);
          const exitB = firstExitAtOrAfter(bExitTimes, tStart);

          // If G has no outbridge, any overlap is a failure
          if (!gHasOutBridge) {
            pairOK = false;
            pass = false;
            // mark internal overlap edges (best effort) as violating
            markOverlapInternalEdgesAsViolating(A, internalKeys, tStart, tEnd, violatingArcKeys);
            markOverlapInternalEdgesAsViolating(B, internalKeys, tStart, tEnd, violatingArcKeys);
            break;
          }

          if (exitA == null || exitB == null || exitA !== exitB) {
            pairOK = false;
            pass = false;

            // Mark the out-bridge edges used at those exits as violating (best effort)
            if (exitA != null) {
              const kA = edgeKeyAt(A, exitA);
              if (kA) violatingArcKeys.add(kA);
            }
            if (exitB != null) {
              const kB = edgeKeyAt(B, exitB);
              if (kB) violatingArcKeys.add(kB);
            }

            // Also mark overlap internal edges as violating context (helps user see where the overlap happens)
            markOverlapInternalEdgesAsViolating(A, internalKeys, tStart, tEnd, violatingArcKeys);
            markOverlapInternalEdgesAsViolating(B, internalKeys, tStart, tEnd, violatingArcKeys);
          }
        }

        criteria.push({
          pass: pairOK,
          description: pairOK
            ? `RBS ${labelRBS(G, gIndex)} — Activities ${i + 1} and ${
                j + 1
              } overlap inside RBS but exit at the same timestep (reset-safe for this pair).`
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

function timelineInG(orderedEdges, internalKeys) {
  // inG[t] = whether edge at time t is an internal edge of G
  return orderedEdges.map((e) => {
    const fromId = e.from?.id ?? e.from;
    const toId = e.to?.id ?? e.to;
    return internalKeys.has(`${fromId}->${toId}`);
  });
}

function exitTimes(orderedEdges, outBridgeKeys) {
  const times = [];
  for (let t = 0; t < orderedEdges.length; t++) {
    const fromId = orderedEdges[t].from?.id ?? orderedEdges[t].from;
    const toId = orderedEdges[t].to?.id ?? orderedEdges[t].to;
    const k = `${fromId}->${toId}`;
    if (outBridgeKeys.has(k)) times.push(t);
  }
  return times;
}

function overlapIntervals(inA, inB) {
  const n = Math.min(inA.length, inB.length);
  const intervals = [];
  let start = null;

  for (let t = 0; t < n; t++) {
    const both = !!inA[t] && !!inB[t];
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

function markOverlapInternalEdgesAsViolating(orderedEdges, internalKeys, tStart, tEnd, violatingArcKeys) {
  for (let t = tStart; t <= tEnd; t++) {
    const e = orderedEdges[t];
    if (!e) continue;
    const fromId = e.from?.id ?? e.from;
    const toId = e.to?.id ?? e.to;
    const k = `${fromId}->${toId}`;
    if (internalKeys.has(k)) violatingArcKeys.add(k);
  }
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