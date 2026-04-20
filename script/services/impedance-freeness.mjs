// import { mapGUIModelToSoundness } from "./soundness/soundness-service.mjs";
// import { VertexType } from "./models/VertexType.js";
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
// import { Activity } from "./models/Activity.js";
import { Graph } from "./soundness/models/Graph.js";
// import { Soundness } from "./utils/soundness.js";
// import { GraphOperations } from "./utils/graph-operations.js";
import { ProcessR1 } from "./soundness/utils/create_r1.mjs";
import { processR2 } from "./soundness/utils/create_r2.mjs";
// import { utils } from "./utils/rdlt-utils.mjs";
import { CASExtractor } from "./soundness/utils/cas-extractor.js";

export function verifyImpedanceFreeness(simpleModel, source, sink) {
  console.log(source, sink);
  const arcMap = buildArcMap(simpleModel.arcs);
  const vertexMap = buildVertexMap(simpleModel.components);

  const inVertices = getInBridges(simpleModel, arcMap, vertexMap);
  const outVertices = getOutBridges(simpleModel, arcMap, vertexMap);

  //   console.log("simpleModel:", simpleModel);
  //   console.log("inVertices:", inVertices);
  //   console.log("outVertices:", outVertices);

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

  // console.log("R1:", R1);
  // console.log("R2:", R2);
  // console.log("EVSA:", evsa);

  const { rdltGraph, r2Graphs, r1Graph } = mapToGraphs(inputRDLT, R2, R1);
  const sourceVertex = rdltGraph.vertices.find(
    (v) => v.id === source || v.id === String(source),
  );
  const sinkVertex = rdltGraph.vertices.find(
    (v) => v.id === sink || v.id === String(sink),
  );

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
        )
          R2Graph.addEdge(e);
      });
    }
  }

  //   console.log("rdltGraph:", rdltGraph);
  //   console.log("r2Graphs:", r2Graphs);
  //   console.log("r1Graph:", r1Graph);

  //   let combinedEvsa;
  //   if (r2Graphs.length > 0) {
  //     combinedEvsa = [r1Graph, ...r2Graphs.map((item) => item.graph)];
  //   } else {
  //     combinedEvsa = [r1Graph];
  //   }

  //   console.log("Combined EVSA Graphs:", combinedEvsa);

  const { casSet } = CASExtractor.extractAllCASWithDetails(
    rdltGraph,
    r1Graph,
    R2Graph,
    source,
    sink,
  );

  const normalizedMAS = normalizeCASLValues(casSet, rdltGraph, R2Graph);

  if (normalizedMAS.length === 0) {
    return unreachableResult();
  }

  if (normalizedMAS.length === 1) {
    return singleCASResult();
  }

  const { pass, violatingArcKeys, criteria } =
    checkImpedanceFreeness(normalizedMAS);

  const generatedActivities = summarizeActivities(normalizedMAS);
  const sharedArcs = computeSharedArcs(normalizedMAS);

  // Convert shared arcs to highlightable arc UIDs too (optional)
  const sharedArcUIDs = sharedArcs
    .map((a) => {
      const arc = simpleModel.arcs.find((raw) => {
        const from = vertexMap[raw.fromVertexUID];
        const to = vertexMap[raw.toVertexUID];
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
        const to = vertexMap[a.toVertexUID];
        return (
          from && to && from.identifier === fromId && to.identifier === toId
        );
      });
      return arc ? arc.uid : null;
    })
    .filter(Boolean);

  // Build transformedArcMap once
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
  const casInstances = buildCASInstances(normalizedMAS, {
    vertexMap,
    arcMap,
    transformedArcMap,
  });

  return {
    title: "Impedance-Freeness",
    instances: [mainInstance, sharedArcInstance, ...casInstances],
  };
}

function checkImpedanceFreeness(casSet) {
  const arcUsageMap = new Map();

  for (let i = 0; i < casSet.length; i++) {
    for (const edge of casSet[i].edges) {
      const key = `${edge.from.id}->${edge.to.id}`;
      if (!arcUsageMap.has(key)) {
        arcUsageMap.set(key, {
          fromId: edge.from.id,
          toId: edge.to.id,
          L: edge.maxTraversals ?? 1,
          casIndices: [],
        });
      }
      arcUsageMap.get(key).casIndices.push(i + 1);
    }
  }

  const violatingArcKeys = [];
  const criteria = [];

  for (const [key, { fromId, toId, L, casIndices }] of arcUsageMap.entries()) {
    const usageCount = casIndices.length;

    if (usageCount > L) {
      // More CAS use this arc than its L-value allows:
      // the composite activity would be blocked here.
      violatingArcKeys.push(key);
      criteria.push({
        pass: false,
        description:
          `Arc ${fromId}→${toId} (L=${L}) is shared by ${usageCount} Activities: [` +
          `${casIndices.join(", ")}] — composite activity blocked (impedance)`,
      });
    } else {
      criteria.push({
        pass: true,
        description: `${fromId}→${toId} — no impedance`,
      });
    }
  }

  return {
    pass: violatingArcKeys.length === 0,
    violatingArcKeys,
    criteria,
  };
}

function unreachableResult() {
  return {
    title: "Impedance-Freeness",
    instances: [
      {
        name: "Main Model",
        evaluation: {
          conclusion: {
            pass: false,
            title: "Not Impedance-Free",
            description:
              "No activities could be derived — sink is unreachable.",
          },
          criteria: [],
          violating: { arcs: [], vertices: [] },
        },
      },
    ],
  };
}

function singleCASResult() {
  return {
    title: "Impedance-Freeness",
    instances: [
      {
        name: "Main Model",
        evaluation: {
          conclusion: {
            pass: true,
            title: "Impedance-Free",
            description:
              "Only one activity exists — no pair to impede each other.",
          },
          criteria: [
            {
              pass: true,
              description:
                "Single activity — impedance-free by definition.",
            },
          ],
          violating: { arcs: [], vertices: [] },
        },
      },
    ],
  };
}

function getInBridges(model, arcMap, vertexMap) {
  //   console.log("arcMap:", arcMap);
  //   console.log("vertexMap:", vertexMap);

  const rbsMatrix = buildRBSMatrix(vertexMap, model.arcs);

  //   console.log("rbsMatrix:", rbsMatrix);

  const inBridgesUIDs = new Set();
  const inBridges = new Set(); // Set to collect "fromVertexIdentifier, toVertexIdentifier" strings

  for (const arc of model.arcs) {
    if (isInbridge(arc.uid, arcMap, rbsMatrix)) {
      inBridgesUIDs.add(arc.uid); // Collect UIDs of in-bridge arcs
    }
  }

  //   console.log("UIDs of in-bridge arcs:", inBridgesUIDs);

  // Map UIDs to their corresponding "fromVertexIdentifier, toVertexIdentifier" and add to inBridges
  for (const uid of inBridgesUIDs) {
    const arc = arcMap[uid]; // Retrieve the arc using the UID
    const fromVertex = vertexMap[arc.fromVertexUID]; // Retrieve the "from" vertex
    const toVertex = vertexMap[arc.toVertexUID]; // Retrieve the "to" vertex

    if (fromVertex && toVertex) {
      const entry = `${fromVertex.identifier}, ${toVertex.identifier}`;
      inBridges.add(entry); // Add the formatted string to the inBridges set
    }
  }

  return inBridges;
}

function getOutBridges(model, arcMap, vertexMap) {
  const rbsMatrix = buildRBSMatrix(vertexMap, model.arcs);
  const outBridgesUIDs = new Set();
  const outBridges = new Set(); // Set to collect "fromVertexIdentifier, toVertexIdentifier" strings

  for (const arc of model.arcs) {
    if (isOutbridge(arc.uid, arcMap, rbsMatrix)) {
      outBridgesUIDs.add(arc.uid); // Collect UIDs of out-bridge arcs
    }
  }

  //   console.log("UIDs of out-bridge arcs:", outBridgesUIDs);

  // Map UIDs to their corresponding "fromVertexIdentifier, toVertexIdentifier" and add to outBridges
  for (const uid of outBridgesUIDs) {
    const arc = arcMap[uid]; // Retrieve the arc using the UID
    const fromVertex = vertexMap[arc.fromVertexUID]; // Retrieve the "from" vertex
    const toVertex = vertexMap[arc.toVertexUID]; // Retrieve the "to" vertex

    if (fromVertex && toVertex) {
      const entry = `${fromVertex.identifier}, ${toVertex.identifier}`;
      outBridges.add(entry); // Add the formatted string to the outBridges set
    }
  }

  return outBridges;
}

function mapToGraphs(rdlt, R2, R1) {
  const rdltGraph = new Graph();
  let r2Graphs; // Array to hold multiple R2 graphs
  const r1Graph = new Graph();

  // Map RDLT to Graph
  if (rdlt && rdlt.model && rdlt.model.components && rdlt.model.arcs) {
    console.log("Mapping RDLT to Graph...");

    // Add vertices with UIDs
    rdlt.model.components.forEach((component) => {
      const vertex = new Vertex(
        component.uid, // Use the UID from the original model
        VertexType.ENTITY_OBJECT,
        {}, // Additional attributes can be added here
        component.identifier || "", // Use the identifier
      );
      rdltGraph.addVertex(vertex);
    });

    // Add edges with UIDs
    rdlt.model.arcs.forEach((arc) => {
      const fromVertex = rdltGraph.vertices.find(
        (v) => v.id === arc.fromVertexUID,
      );
      const toVertex = rdltGraph.vertices.find((v) => v.id === arc.toVertexUID);
      const edge = new Edge(
        arc.uid, // Use the UID from the original model
        fromVertex,
        toVertex,
        arc.C,
        arc.L,
        [], // Additional attributes can be added here
      );
      rdltGraph.addEdge(edge);
    });

    // Map Reset-Bound Subsystems (RBS)
    if (rdlt.centersList && rdlt.centersList.length > 0) {
      console.log("Mapping Reset-Bound Subsystems...");
      rdlt.centersList.forEach((centerId) => {
        const centerVertex = rdltGraph.vertices.find(
          (v) => v.id === centerId.uid,
        );
        if (!centerVertex) {
          console.error(
            `Center vertex with ID ${centerId.uid} not found in the graph.`,
          );
          return;
        }

        // Get members of the RBS (vertices connected to the center)
        const members = rdltGraph.edges
          .filter((edge) => edge.from.id === centerId.uid)
          .map((edge) => (edge.from.id === centerId.uid ? edge.to : edge.from));

        // Get in-bridges (arcs in in_list connected to members)
        const inBridges = rdlt.in_list
          .map((entry) => {
            const [fromId, toId] = entry.split(", ");
            const fromVertex = rdltGraph.vertices.find(
              (v) => v.name === fromId,
            );
            const toVertex = rdltGraph.vertices.find((v) => v.name === toId);

            // Find the edge in the graph
            return rdltGraph.edges.find(
              (edge) => edge.from === fromVertex && edge.to === toVertex,
            );
          })
          .filter(
            (edge) =>
              edge && (members.includes(edge.to) || centerVertex === edge.to),
          );

        // Get out-bridges (arcs in out_list connected to members)
        const outBridges = rdlt.out_list
          .map((entry) => {
            const [fromId, toId] = entry.split(", ");
            const fromVertex = rdltGraph.vertices.find(
              (v) => v.name === fromId,
            );
            const toVertex = rdltGraph.vertices.find((v) => v.name === toId);
            return rdltGraph.edges.find(
              (edge) => edge.from === fromVertex && edge.to === toVertex,
            );
          })
          .filter((edge) => edge && members.includes(edge.from));

        // Create and add the ResetBoundSubsystem
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

  // Map R2 to Graphs
  if (R2 && R2.length > 0) {
    console.log("Mapping R2 to Graphs...");

    // Group R2 entries by r_number
    const r2Groups = R2.reduce((groups, arc) => {
      const rNumber = arc["r-id"].split("-")[0]; // Extract r_number from r-id
      if (!groups[rNumber]) {
        groups[rNumber] = [];
      }
      groups[rNumber].push(arc);
      return groups;
    }, {});

    // Create a Graph for each group
    r2Graphs = Object.entries(r2Groups).map(([rNumber, arcs]) => {
      const graph = new Graph();
      console.log(`Creating Graph for R2 group: ${rNumber}`);

      arcs.forEach((arc) => {
        const [fromId, toId] = arc.arc.split(", ");
        const fromVertex =
          graph.vertices.find((v) => v.id === fromId) ||
          new Vertex(fromId, VertexType.ENTITY_OBJECT, {}, fromId);
        const toVertex =
          graph.vertices.find((v) => v.id === toId) ||
          new Vertex(toId, VertexType.ENTITY_OBJECT, {}, toId);

        // Add vertices if not already present
        if (!graph.vertices.find((v) => v.id === fromId))
          graph.addVertex(fromVertex);
        if (!graph.vertices.find((v) => v.id === toId))
          graph.addVertex(toVertex);

        const edge = new Edge(
          arc["r-id"], // Use the UID from the processed R2
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

    console.log("Mapped R2 Graphs:", r2Graphs);
  } else {
    r2Graphs = [];
  }

  // Map R1 to Graph
  if (R1 && R1.length > 0) {
    console.log("Mapping R1 to Graph...");
    R1.forEach((arc, index) => {
      const [fromId, toId] = arc.arc.split(", ");
      const fromVertex =
        r1Graph.vertices.find((v) => v.id === fromId) ||
        new Vertex(fromId, VertexType.ENTITY_OBJECT, {}, fromId);
      const toVertex =
        r1Graph.vertices.find((v) => v.id === toId) ||
        new Vertex(toId, VertexType.ENTITY_OBJECT, {}, toId);

      if (!r1Graph.vertices.find((v) => v.id === fromId))
        r1Graph.addVertex(fromVertex);
      if (!r1Graph.vertices.find((v) => v.id === toId))
        r1Graph.addVertex(toVertex);

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

function casToActivityEdges(casGraph) {
  // casGraph is expected to be a Graph with .edges
  // Return a stable ordered list (best-effort).
  // If CASExtractor already orders edges, keep that; else we sort by from/to names.
  const edges = Array.isArray(casGraph?.edges) ? [...casGraph.edges] : [];

  // Try to preserve original order; only sort if order seems arbitrary
  // (optional: comment out sort if CASExtractor guarantees order)
  edges.sort((a, b) => {
    const aKey = `${a.from?.name ?? a.from?.id}->${a.to?.name ?? a.to?.id}`;
    const bKey = `${b.from?.name ?? b.from?.id}->${b.to?.name ?? b.to?.id}`;
    return aKey.localeCompare(bKey);
  });

  return edges.map((e) => ({
    from: e.from?.name ?? String(e.from?.id),
    to: e.to?.name ?? String(e.to?.id),
    C: e.constraint ?? e.cAttribute ?? e.C ?? "",
    L: e.maxTraversals ?? e.l ?? e.L ?? e.lAttribute ?? 1,
  }));
}

function summarizeActivities(casSet) {
  // returns [{ index, label, edges:[{from,to,C,L}] }]
  return casSet.map((casGraph, i) => {
    const edges = casToActivityEdges(casGraph);

    // “x1→x6, x6→x9, …” label
    const label = edges.length
      ? edges.map((e) => `${e.from}→${e.to}`).join(" ")
      : "(empty)";

    return { index: i + 1, label, edges };
  });
}

function computeSharedArcs(casSet) {
  // Keyed by "x1->x2"
  const usage = new Map();

  for (let i = 0; i < casSet.length; i++) {
    const edges = casToActivityEdges(casSet[i]);
    for (const e of edges) {
      const key = `${e.from}->${e.to}`;
      if (!usage.has(key)) {
        usage.set(key, {
          key,
          from: e.from,
          to: e.to,
          L: e.L ?? 1,
          usedBy: [],
        });
      }
      usage.get(key).usedBy.push(i + 1);
    }
  }

  // Keep only arcs used by 2+ CAS
  const shared = [...usage.values()].filter((x) => x.usedBy.length >= 2);

  // Sort for stable UI
  shared.sort((a, b) => a.key.localeCompare(b.key));

  return shared;
}

function normalizeCASLValues(casSet, originalRDLT, R2Graph) {
  // R2 vertex IDs (identifier scheme like "x2", "x4")
  const r2VertexIds = new Set((R2Graph?.vertices ?? []).map((v) => v.id));

  // Build L lookup for original RDLT edges by NAME (identifier) and by ID
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

  // Build L lookup for R2Graph edges by ID (already identifier scheme)
  const r2L = new Map();
  for (const e of R2Graph?.edges ?? []) {
    const k = `${e.from?.id}->${e.to?.id}`;
    const L = e.maxTraversals ?? e.l ?? e.L ?? e.lAttribute;
    if (L != null) r2L.set(k, L);
  }

  // Rewrite CAS edges' maxTraversals
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
        // Prefer R2Graph's L (this fixes x2→x4)
        const k = `${fromId}->${toId}`;
        const L = r2L.get(k);
        if (L != null) edgeCopy.maxTraversals = L;
      } else {
        // Outside: restore from original RDLT by name-key (handles UID mismatch)
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
  // vertexMap is keyed by UID (string/number), each entry has .identifier
  for (const uid of Object.keys(vertexMap || {})) {
    if (vertexMap[uid]?.identifier === identifier) return uid;
  }
  return null;
}

function findArcUIDByIdentifiers({
  fromId,
  toId,
  vertexMap,
  arcMap,
  transformedArcMap,
}) {
  const fromUID = findVertexUIDByIdentifier(vertexMap, fromId);
  const toUID = findVertexUIDByIdentifier(vertexMap, toId);
  if (!fromUID || !toUID) return null;

  const arcKey = `${fromUID}, ${toUID}`;
  const candidates = transformedArcMap[arcKey];
  if (!candidates || candidates.length === 0) return null;

  // If multiple arcs exist between same endpoints, pick the first.
  // (If you later need constraint-aware matching, we can refine this.)
  return candidates[0].uid;
}

/**
 * Build arcOverrides to force the UI to display the CAS L-values.
 * This is the missing piece causing "L=1" in UI even when CAS has L=2.
 */
function buildArcOverridesFromCAS(
  casGraph,
  { vertexMap, arcMap, transformedArcMap },
) {
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
      // Force the CAS edge L-value into the renderer
      L: edge.maxTraversals ?? edge.L ?? edge.l ?? 1,
    };
  }
  return arcOverrides;
}

/**
 * Optional: limit the drawn model to only vertices/arcs used by a CAS.
 * This gives you a clean "generated activity" view.
 */
function graphToUIDsLocal(graph, { vertexMap, arcMap, transformedArcMap }) {
  const vertexUIDs = [];
  const arcUIDs = [];

  // vertices: CAS vertex IDs are identifiers like "x2"
  for (const v of graph?.vertices ?? []) {
    const id = v?.id ?? v;
    const uid = findVertexUIDByIdentifier(vertexMap, id);
    if (uid) vertexUIDs.push(Number(uid));
  }

  // arcs: map CAS edges to GUI arc UIDs
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

function buildSharedArcInstance(sharedArcs, sharedArcUIDs) {
  // sharedArcs: [{from,to,L,usedBy:[...]}]
  const remarks = {};
  for (let i = 0; i < sharedArcUIDs.length; i++) {
    const arcUID = sharedArcUIDs[i];
    const meta = sharedArcs[i];
    if (!meta) continue;
    remarks[arcUID] = `Used by Activities ${meta.usedBy.join(", ")}`;
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

function buildCASInstances(casSet, { vertexMap, arcMap, transformedArcMap }) {
  return casSet.map((cas, i) => {
    const arcOverrides = buildArcOverridesFromCAS(cas, {
      vertexMap,
      arcMap,
      transformedArcMap,
    });

    // Put edges in criteria so they appear in the Result panel table
    const criteria = (cas?.edges ?? []).map((e) => {
      const fromId = e.from?.id ?? e.from;
      const toId = e.to?.id ?? e.to;
      const L = e.maxTraversals ?? e.L ?? e.l ?? 1;
      return {
        pass: true,
        description: `${fromId}→${toId} (L=${L})`,
      };
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
