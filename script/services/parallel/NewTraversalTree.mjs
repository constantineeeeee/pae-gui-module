import { parseRDLT } from "../convert/rdlt2pn/modules/parser.js";

const EPS = "ϵ";

function buildAdjacency(vertices, edges) {
  const out = new Map();
  const inc = new Map();

  for (const v of vertices) {
    out.set(v.id, []);
    inc.set(v.id, []);
  }

  edges.forEach((e, idx) => {
    out.get(e.from).push({ ...e, __idx: idx });
    inc.get(e.to).push({ ...e, __idx: idx });
  });

  return { out, inc };
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
  const source = Object.keys(incCount).filter((id) => incCount[id] === 0);
  const sink = Object.keys(outCount).filter((id) => outCount[id] === 0);

  return { source, sink };
}

function classifyJoin(inc) {
  const joinTypes = new Map();

  inc.forEach((edges, vertexId) => {
    if (edges.length > 1) {
      const cValues = edges.map((e) =>
        e.C === "" || e.C === "ϵ" ? "EPS" : e.C,
      );

      const uniqueC = new Set(cValues);
      const hasEpsilon = cValues.some((v) => v === "EPS");
      const hasNonEpsilon = cValues.some((v) => v !== "EPS");

      if (hasEpsilon && hasNonEpsilon) {
        joinTypes.set(vertexId, "MIX");
      } else if (uniqueC.size === 1) {
        joinTypes.set(vertexId, "OR");
      } else if (uniqueC.size === edges.length) {
        joinTypes.set(vertexId, "AND");
      } else {
        joinTypes.set(vertexId, "MIX");
      }
    }
  });

  console.log("Join Types:", joinTypes);

  return joinTypes;
}

export function generateTraversalTreeFromJSON(
  input,
  { sourceId = null, sinkId = null } = {},
) {
  parseRDLT(input, false);

  const vertices = input.vertices;
  const edges = input.edges;
  const { source, sink } = computeSourceSink(vertices, edges);
  const { out, inc } = buildAdjacency(input.vertices, input.edges);

  const joinTypes = classifyJoin(inc);

  // START ALGORITHM FOR GENERATING TRAVERSAL TREES

  let i = 1;
  let ancestors = new Set();
  let allNodes = [];

  const sourceVId = source[0];

  let rootNode = {
    id: `node_${i++}`,
    v: sourceVId,
    S: [0],
    parents: [],
    children: [],
    isPending: false,
    edgeVisits: {},
    path: [sourceVId],
  };

  allNodes.push(rootNode);
  console.log(allNodes);

  // --- COMBINED TRAVERSAL LOOP ---
  let traversalActive = true;

  while (traversalActive) {
    // 1. Find all active leaf nodes
    let X = allNodes.filter((n) => n.children?.length === 0 && !n.isPending);

    // 2. Termination Check: Are we strictly at the sink?
    if (X.length === 1 && X[0].v === sink[0]) {
      console.log("Reached the sink successfully.");
      break;
    }

    // 3. Dead end check
    if (X.length === 0) {
      console.log("No active branches left. Checking pending nodes...");
      // If we have pending nodes (AND/MIX joins waiting), we handle them in Phase 3
      // For now, if everything is stuck, we break.
      break;
    }

    let progressedThisIteration = false;

    for (let nodeX of X) {
      const outgoingEdges = out.get(nodeX.v) || [];

      for (let edge of outgoingEdges) {
        const yj = edge.to;
        const edgeKey = `${nodeX.v}->${yj}`;
        const currentVisits = nodeX.edgeVisits[edgeKey] || 0;

        // 1. Check if yj is an ancestor IN THE CURRENT PATH
        const isAncestor = nodeX.path.includes(yj);

        if (isAncestor) {
          // --- CYCLE EXHAUSTION CHECK ---
          const cycleStartIndex = nodeX.path.indexOf(yj);
          const cycleVertices = nodeX.path.slice(cycleStartIndex);
          cycleVertices.push(yj); // Close the loop

          let cycleExhausted = false;

          // Check every edge in the prospective cycle
          for (let k = 0; k < cycleVertices.length - 1; k++) {
            const fromV = cycleVertices[k];
            const toV = cycleVertices[k + 1];
            const cycleEdgeKey = `${fromV}->${toV}`;

            // Retrieve the L-value directly (fallback to 1 if undefined)
            const cycleEdgeDef = out.get(fromV)?.find((e) => e.to === toV);
            const lVal = cycleEdgeDef?.L !== undefined ? cycleEdgeDef.L : 1;

            const visits = nodeX.edgeVisits[cycleEdgeKey] || 0;

            // If ANY arc in the cycle has hit its integer limit, block the backward arc!
            if (visits >= lVal) {
              console.log(
                `Cycle blocked at ${edgeKey}: Arc ${cycleEdgeKey} is exhausted (Visits: ${visits}, Max L: ${lVal}).`,
              );
              cycleExhausted = true;
              break;
            }
          }

          // If the cycle is blocked, skip this backward arc entirely
          if (cycleExhausted) {
            continue;
          }
        } else {
          // --- STANDARD FORWARD ARC LIMIT ---
          const maxVisits = edge.L !== undefined ? edge.L : 1;
          if (currentVisits >= maxVisits) {
            continue;
          }
        }

        // --- UPDATE PATH AND VISITS FOR THE NEW NODE ---
        let newEdgeVisits = { ...nodeX.edgeVisits };
        newEdgeVisits[edgeKey] = currentVisits + 1;

        // Clone the parent's S array and append this edge's Condition (C value)
        let newS = [...(nodeX.S || [])];
        newS.push(edge.C); // Appends 'ϵ' or the specific condition string

        let newNode = {
          id: `node_${i}`,
          v: yj,
          S: newS, // Use the updated condition path
          parents: [nodeX],
          children: [],
          isPending: false,
          edgeVisits: newEdgeVisits,
          path: [...nodeX.path, yj]
        };

        // --- CYCLE APPENDING (Lines 15-27) & FORWARD APPENDING (Lines 47-66) ---
        if (isAncestor) {
          if (edge.C === "ϵ" || edge.C === "EPS") {
            newNode.S.push(`cycle_resolved_${yj}`);
            nodeX.children.push(newNode);
            allNodes.push(newNode);
          } else {
            nodeX.children.push(newNode);
            allNodes.push(newNode);
            if (joinTypes.get(yj) === "AND" || joinTypes.get(yj) === "MIX") {
              newNode.isPending = true;
            }
          }
        } else {
          nodeX.children.push(newNode);
          allNodes.push(newNode);

          const joinType = joinTypes.get(yj);
          if (joinType === "AND" || joinType === "MIX") {
            newNode.isPending = true;
          }
        }

        i++;
        progressedThisIteration = true;
      }
      ancestors.add(nodeX.v);
    }

    if (!progressedThisIteration) {
      traversalActive = false;
    }

    if (!progressedThisIteration) {
      // Find all nodes currently waiting at a join
      let pendingNodes = allNodes.filter(n => n.isPending);

      if (pendingNodes.length > 0) {
        // Group them by their vertex 'v' (the join component)
        let pendingByVertex = new Map();
        for (let n of pendingNodes) {
          if (!pendingByVertex.has(n.v)) pendingByVertex.set(n.v, []);
          pendingByVertex.get(n.v).push(n);
        }

        for (let [joinV, nodesToMerge] of pendingByVertex.entries()) {
          // 1. Combine the S sets (Union of conditions from all parallel branches)
          let mergedS = [...new Set(nodesToMerge.flatMap(n => n.S || []))];

          // 2. Combine edge visits (Take the max of each edge visited to respect loops safely)
          let mergedVisits = {};
          for (let n of nodesToMerge) {
            for (let [edge, count] of Object.entries(n.edgeVisits || {})) {
              mergedVisits[edge] = Math.max(mergedVisits[edge] || 0, count);
            }
          }

          // 3. Combine paths
          let mergedPath = [...new Set(nodesToMerge.flatMap(n => n.path || []))];

          // 4. Create the Merged Node!
          let mergedNode = {
            id: `node_${i}`,
            v: joinV,
            S: mergedS,
            parents: nodesToMerge,  // Notice it has MULTIPLE parents now!
            children: [],
            isPending: false,       // Unlocked and ready to traverse forward
            isCycleTerminal: false,
            edgeVisits: mergedVisits,
            path: mergedPath
          };

          // 5. Update relationships: link the old branches to this new merged node
          for (let parent of nodesToMerge) {
            parent.children.push(mergedNode);
            parent.isPending = false; // Remove their pending status
          }

          allNodes.push(mergedNode);
          i++;
          progressedThisIteration = true; // We made progress, keep the while-loop alive!
        }
      }
    }
  }

  

  console.log("Final allNodes:", allNodes);
  console.log(`Final allNodes: (${allNodes.length})`, allNodes);

  console.log("--- NODE PATHS (CONDITIONS) ---");
  allNodes.forEach(n => {
    const formattedS = `S([${(n.S || []).join(", ")}])`;
    console.log(`${n.id} (${n.v}): ${formattedS}`);
  });
}
