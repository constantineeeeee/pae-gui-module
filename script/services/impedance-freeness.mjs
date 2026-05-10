/*
Service Module for Impedance-Freeness Verification
Developed for RDLT Soundness Verification (2025)

This module verifies impedance-freeness of an RDLT model by:
  1. Extracting all Cyclic-Arc Subgraphs (CAS) using CASExtractor,
     following the same pipeline shared with reset-safeness verification.
  2. Normalizing L-values on each CAS edge against the original RDLT and R2 graph.
  3. For every arc shared across two or more activities, checking that the number
     of activities using that arc does not exceed its L-value.
     If it does, the composite activity would be blocked at that arc (impedance).

Also exports checkCompetingProcesses, which performs the same L-exhaustion check
over PAE-generated activity profiles (activityProfile format).
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
 * @typedef {{ [arcUID: ArcUID]: Arc }}         ArcMap
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
 *   violatingArcKeys: string[],
 *   criteria: Criterion[]
 * }} ImpedanceFreenessCheckResult
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
 *
 * @typedef {{
 *   key: string,
 *   from: string,
 *   to: string,
 *   L: number,
 *   usedBy: number[]
 * }} SharedArc
 *   An arc that appears in two or more derived activities.
 */



/**
 * Verifies impedance-freeness of the given model and returns a GUI-ready result object.
 *
 * The following steps are performed:
 *  1. Build arc/vertex maps and resolve in-/out-bridges.
 *  2. Run InputRDLT evaluation to obtain R1 and R2 arc sets.
 *  3. Map everything into Graph objects (rdltGraph, r1Graph, r2Graphs).
 *  4. Resolve the source and sink vertices.
 *  5. Merge all R2 sub-graphs into a single combined R2Graph.
 *  6. Extract all CAS candidates via CASExtractor.
 *  7. Normalize L-values on each CAS edge for consistency with the original model.
 *  8. Return early if zero or one activities were derived (trivially impedance-free).
 *  9. Run the arc-usage check to find impedance violations.
 * 10. Resolve shared arc UIDs and violating arc UIDs for the renderer.
 * 11. Assemble and return the GUI result object.
 *
 * @param {object}    simpleModel - The parsed RDLT model (components + arcs).
 * @param {VertexUID} source      - UID of the source vertex.
 * @param {VertexUID} sink        - UID of the sink vertex.
 * @returns {VerificationResult}
 */
export function verifyImpedanceFreeness(simpleModel, source, sink) {
  // 1. Build arc/vertex maps and resolve bridges
  const arcMap    = buildArcMap(simpleModel.arcs);
  const vertexMap = buildVertexMap(simpleModel.components);

  const inVertices  = getInBridges(simpleModel, arcMap, vertexMap);
  const outVertices = getOutBridges(simpleModel, arcMap, vertexMap);

  // 2. Run InputRDLT evaluation to obtain R1 and R2
  const inputRDLT = new InputRDLT(simpleModel, inVertices, outVertices);
  const evsa      = inputRDLT.evaluate();

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

  // 4. Resolve source/sink vertices (UI select may pass strings, so check both)
  const sourceVertex = rdltGraph.vertices.find((v) => v.id === source || v.id === String(source));
  const sinkVertex   = rdltGraph.vertices.find((v) => v.id === sink   || v.id === String(sink));

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

  // 7. Normalize L-values on each CAS edge
  const normalizedMAS = normalizeCASLValues(casSet, rdltGraph, R2Graph);

  // 8. Return early for degenerate cases
  if (normalizedMAS.length === 0) return unreachableResult();
  if (normalizedMAS.length === 1) return singleCASResult();

  // 9. Run the arc-usage check
  const { pass, violatingArcKeys, criteria } = checkImpedanceFreeness(normalizedMAS);

  const sharedArcs = computeSharedArcs(normalizedMAS);

  // 10. Resolve shared arc UIDs and violating arc UIDs for the renderer
  const sharedArcUIDs = sharedArcs
    .map((a) => {
      const arc = simpleModel.arcs.find((raw) => {
        const from = vertexMap[raw.fromVertexUID];
        const to   = vertexMap[raw.toVertexUID];
        return from?.identifier === a.from && to?.identifier === a.to;
      });
      return arc ? arc.uid : null;
    })
    .filter(Boolean);

  const violatingArcUIDs = violatingArcKeys
    .map((key) => {
      const [fromId, toId] = key.split("->");
      const arc = simpleModel.arcs.find((a) => {
        const from = vertexMap[a.fromVertexUID];
        const to   = vertexMap[a.toVertexUID];
        return from && to && from.identifier === fromId && to.identifier === toId;
      });
      return arc ? arc.uid : null;
    })
    .filter(Boolean);

  // 11. Assemble the GUI result object
  const transformedArcMap = transformArcMapLocal(arcMap);

  const mainInstance = {
    name: "Main Model",
    evaluation: {
      conclusion: {
        pass,
        title: pass ? "Impedance-Free" : "Not Impedance-Free",
        description: ``,
      },
      criteria,
      violating: { arcs: violatingArcUIDs, vertices: [] },
    },
  };

  const sharedArcInstance = buildSharedArcInstance(sharedArcs, sharedArcUIDs);
  const casInstances      = buildCASInstances(normalizedMAS, { vertexMap, arcMap, transformedArcMap });

  return {
    title: "Impedance-Freeness",
    instances: [mainInstance, sharedArcInstance, ...casInstances],
  };
}



/**
 * Checks a set of normalized CAS graphs for impedance violations.
 *
 * An arc is impedance-violating if the number of activities that traverse it
 * exceeds its L-value. In that case, a composite activity attempting to use
 * all of those activities simultaneously would be blocked at that arc.
 *
 * The following steps are performed:
 *  1. Build an arc usage map: for each arc key, record the L-value and which
 *     activity indices (1-based) traverse it.
 *  2. For each arc, compare usage count against L.
 *     If usage > L, the arc is violating; otherwise it is clear.
 *
 * @param {CASGraph[]} casSet - Normalized CAS graphs (one per derived activity).
 * @returns {ImpedanceFreenessCheckResult}
 */
function checkImpedanceFreeness(casSet) {
  // 1. Build arc usage map
  const arcUsageMap = new Map();

  for (let i = 0; i < casSet.length; i++) {
    for (const edge of casSet[i].edges) {
      const key = `${edge.from.id}->${edge.to.id}`;
      if (!arcUsageMap.has(key)) {
        arcUsageMap.set(key, {
          fromId:     edge.from.id,
          toId:       edge.to.id,
          L:          edge.maxTraversals ?? 1,
          casIndices: [],
        });
      }
      arcUsageMap.get(key).casIndices.push(i + 1);
    }
  }

  // 2. Compare usage count against L for each arc
  const violatingArcKeys = [];
  const criteria         = [];

  for (const [key, { fromId, toId, L, casIndices }] of arcUsageMap.entries()) {
    const usageCount = casIndices.length;

    if (usageCount > L) {
      // More activities use this arc than its L-value permits —
      // the composite activity would be blocked here (impedance).
      violatingArcKeys.push(key);
      criteria.push({
        pass: false,
        description:
          `Arc ${fromId}→${toId} (L=${L}) is shared by ${usageCount} Activities: ` +
          `[${casIndices.join(", ")}] — composite activity blocked (impedance)`,
      });
    } else {
      criteria.push({
        pass: true,
        description: `Arc ${fromId}→${toId} (L=${L}), used by ${usageCount} Activities — no impedance`,
      });
    }
  }

  return {
    pass: violatingArcKeys.length === 0,
    violatingArcKeys,
    criteria,
  };
}



/**
 * Returns a failure result indicating that no activities could be derived
 * because the sink is unreachable from the source.
 *
 * @returns {VerificationResult}
 */
function unreachableResult() {
  return {
    title: "Impedance-Freeness",
    instances: [{
      name: "Main Model",
      evaluation: {
        conclusion: {
          pass: false,
          title: "Not Impedance-Free",
          description: "No activities could be derived — sink is unreachable.",
        },
        criteria: [],
        violating: { arcs: [], vertices: [] },
      },
    }],
  };
}

/**
 * Returns a passing result for the degenerate case where only one activity
 * exists. Impedance-freeness requires a pair of activities to potentially
 * impede each other, so a single activity is impedance-free by definition.
 *
 * @returns {VerificationResult}
 */
function singleCASResult() {
  return {
    title: "Impedance-Freeness",
    instances: [{
      name: "Main Model",
      evaluation: {
        conclusion: {
          pass: true,
          title: "Impedance-Free",
          description: "Only one activity exists — no pair to impede each other.",
        },
        criteria: [{ pass: true, description: "Single activity — impedance-free by definition." }],
        violating: { arcs: [], vertices: [] },
      },
    }],
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
  const rbsMatrix     = buildRBSMatrix(vertexMap, model.arcs);
  const inBridgesUIDs = new Set();
  const inBridges     = new Set();

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
  const rbsMatrix      = buildRBSMatrix(vertexMap, model.arcs);
  const outBridgesUIDs = new Set();
  const outBridges     = new Set();

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
 * Graph objects: the full RDLT graph (with RBS annotations), the set of
 * R2 sub-graphs (one per RBS group), and the R1 graph.
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

        // Get members of the RBS (vertices directly connected to the center)
        const members = rdltGraph.edges
          .filter((edge) => edge.from.id === centerId.uid)
          .map((edge) => (edge.from.id === centerId.uid ? edge.to : edge.from));

        // Get in-bridges (arcs in in_list whose target is a member or the center)
        const inBridges = rdlt.in_list
          .map((entry) => {
            const [fromId, toId] = entry.split(", ");
            const fromVertex = rdltGraph.vertices.find((v) => v.name === fromId);
            const toVertex   = rdltGraph.vertices.find((v) => v.name === toId);
            return rdltGraph.edges.find((edge) => edge.from === fromVertex && edge.to === toVertex);
          })
          .filter((edge) => edge && (members.includes(edge.to) || centerVertex === edge.to));

        // Get out-bridges (arcs in out_list whose source is a member)
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
 * Converts a CAS graph's edges into a stable, flat array of plain edge objects.
 * Each edge carries from/to as identifier strings and the resolved C/L values.
 *
 * Edges are sorted lexicographically by their "from→to" key to ensure a
 * consistent ordering across calls regardless of the CASExtractor's output order.
 *
 * @param {CASGraph} casGraph
 * @returns {{ from: string, to: string, C: string, L: number }[]}
 */
function casToActivityEdges(casGraph) {
  const edges = Array.isArray(casGraph?.edges) ? [...casGraph.edges] : [];

  edges.sort((a, b) => {
    const aKey = `${a.from?.name ?? a.from?.id}->${a.to?.name ?? a.to?.id}`;
    const bKey = `${b.from?.name ?? b.from?.id}->${b.to?.name ?? b.to?.id}`;
    return aKey.localeCompare(bKey);
  });

  return edges.map((e) => ({
    from: e.from?.name ?? String(e.from?.id),
    to:   e.to?.name   ?? String(e.to?.id),
    C:    e.constraint ?? e.cAttribute ?? e.C ?? "",
    L:    e.maxTraversals ?? e.l ?? e.L ?? e.lAttribute ?? 1,
  }));
}

/**
 * Summarizes each CAS graph as a human-readable activity record containing
 * its 1-based index, a "x1→x2 x2→x3 …" label, and the flat edge list.
 *
 * @param {CASGraph[]} casSet
 * @returns {{ index: number, label: string, edges: object[] }[]}
 */
function summarizeActivities(casSet) {
  return casSet.map((casGraph, i) => {
    const edges = casToActivityEdges(casGraph);
    const label = edges.length ? edges.map((e) => `${e.from}→${e.to}`).join(" ") : "(empty)";
    return { index: i + 1, label, edges };
  });
}

/**
 * Finds all arcs that appear in two or more derived activities and returns
 * them sorted lexicographically by their "from→to" key.
 *
 * @param {CASGraph[]} casSet
 * @returns {SharedArc[]}
 */
function computeSharedArcs(casSet) {
  const usage = new Map();

  for (let i = 0; i < casSet.length; i++) {
    const edges = casToActivityEdges(casSet[i]);
    for (const e of edges) {
      const key = `${e.from}->${e.to}`;
      if (!usage.has(key)) {
        usage.set(key, { key, from: e.from, to: e.to, L: e.L ?? 1, usedBy: [] });
      }
      usage.get(key).usedBy.push(i + 1);
    }
  }

  // Keep only arcs used by 2+ activities and sort for a stable UI order
  const shared = [...usage.values()].filter((x) => x.usedBy.length >= 2);
  shared.sort((a, b) => a.key.localeCompare(b.key));
  return shared;
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
 * If multiple arcs exist between the same endpoints, the first is returned.
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
 * used by the renderer to display the correct arc attributes for each activity.
 * Without these overrides the renderer would fall back to L=1 for all arcs.
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
 * This produces the model subset used to render a single activity in the UI.
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
 * Builds the "Shared Arcs" instance shown in the results panel.
 * Each shared arc is highlighted and annotated with a remark listing
 * which activities use it and its L-value.
 *
 * @param {SharedArc[]} sharedArcs
 * @param {ArcUID[]}    sharedArcUIDs - Resolved GUI arc UIDs, parallel to sharedArcs.
 * @returns {object} A GUI instance object.
 */
function buildSharedArcInstance(sharedArcs, sharedArcUIDs) {
  const remarks = {};
  for (let i = 0; i < sharedArcUIDs.length; i++) {
    const arcUID = sharedArcUIDs[i];
    const meta   = sharedArcs[i];
    if (!meta) continue;
    remarks[arcUID] = `Used by Activities ${meta.usedBy.join(", ")} (L=${meta.L})`;
  }

  return {
    name: "Shared Arcs",
    evaluation: {
      conclusion: {
        pass: false,
        title: "Shared Arc(s)",
        description: "Arcs shared across 2+ generated activities.",
      },
      criteria: [],
      violating: { arcs: sharedArcUIDs, vertices: [] },
      violatingRemarks: { arcs: remarks, vertices: {} },
    },
  };
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
      return { pass: true, description: `${fromId}→${toId} (L=${L})` };
    });

    return {
      name: `Activity ${i + 1}`,
      evaluation: {
        conclusion: {
          pass: true,
          title: `Generated Activity ${i + 1}`,
          description: "Activity derived from the model.",
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
 * Checks PAE-generated activities for competing processes caused by
 * impedance violations.
 *
 * A competing process exists when two or more activities share an arc whose
 * total usage count across those activities exceeds the arc's L-value. This
 * mirrors checkImpedanceFreeness above but operates on activityProfile maps
 * instead of CAS graphs.
 *
 * The following steps are performed:
 *  1. Build a arcUID → L lookup from simpleModel.
 *  2. For each activity, count unique arc usages (deduplicated per activity)
 *     and record which process IDs use each arc.
 *  3. Find all arcs where usage count > L (competing arcs).
 *  4. Return the competing arc records, process ID pairs, and a competition log.
 *
 * @param {PAEActivity[]} activities
 * @param {object}        simpleModel - The raw model (arcs array with uid and L).
 * @returns {{
 *   hasCompetition: boolean,
 *   competingActivityIds: number[][],
 *   competitionLog: object[],
 *   arcUsage: { arcUID: ArcUID, L: number, usedByProcessIds: number[] }[]
 * }}
 */
export function checkCompetingProcesses(activities, simpleModel) {
  // 1. Build arcUID → L lookup
  const arcLMap = new Map();
  for (const arc of simpleModel.arcs) {
    arcLMap.set(arc.uid, arc.L ?? 1);
  }

  // 2. Count unique arc usages per activity and record which process IDs use each arc
  const arcUsageMap = new Map(); // arcUID → { L, usedByProcessIds: number[] }

  // Nondeterministic activity ordering: shuffle once at the start so all
  // competing arcs see the same process order. This ensures winner/loser
  // sets are consistent across arcs (a process cannot win on one arc and
  // lose on another simply because the per-arc shuffles diverged).
  const shuffledActivities = [...activities];
  for (let i = shuffledActivities.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledActivities[i], shuffledActivities[j]] = [shuffledActivities[j], shuffledActivities[i]];
  }

  for (const activity of shuffledActivities) {
    const seen = new Set(); // avoid double-counting the same arc within one activity
    for (const arcSet of Object.values(activity.activityProfile)) {
      for (const arcUID of arcSet) {
        if (seen.has(arcUID)) continue;
        seen.add(arcUID);

        if (!arcUsageMap.has(arcUID)) {
          arcUsageMap.set(arcUID, { arcUID, L: arcLMap.get(arcUID) ?? 1, usedByProcessIds: [] });
        }
        arcUsageMap.get(arcUID).usedByProcessIds.push(activity.processId);
      }
    }
  }

  // 3. Find arcs where usage count > L
  const competingArcs = [...arcUsageMap.values()].filter(
    ({ L, usedByProcessIds }) => usedByProcessIds.length > L,
  );

  // 4. Assemble the competition log and return
  const competingActivityIds = competingArcs.map(({ usedByProcessIds }) => usedByProcessIds);

  // Winners/losers per arc come directly from the shuffled usedByProcessIds
  // built above. Because activities were shuffled once globally, a process
  // that lands at position < L on its competing arcs is consistently a winner
  // across all arcs (and similarly for losers).
  const competitionLog = competingArcs.map(({ arcUID, L, usedByProcessIds }) => {
    const winnerIds = usedByProcessIds.slice(0, L);
    const loserIds  = usedByProcessIds.slice(L);
    return {
      arcUID,
      arcL:            L,
      usedByProcessIds,
      winnerProcessId: winnerIds[0] ?? null,
      winnerProcessIds: winnerIds,
      loserProcessIds: loserIds,
      totalTraversals: usedByProcessIds.length,
      reason:
        `Arc uid=${arcUID} (L=${L}) used by ${usedByProcessIds.length} activities ` +
        `[process IDs: ${usedByProcessIds.join(", ")}] — exceeds L-attribute. ` +
        `Winners: [${winnerIds.join(", ")}]; losers: [${loserIds.join(", ")}].`,
    };
  });

  return {
    hasCompetition:     competingArcs.length > 0,
    competingActivityIds,
    competitionLog,
    arcUsage:           [...arcUsageMap.values()],
  };
}