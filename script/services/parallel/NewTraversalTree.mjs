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

  // --- NEW: DETECT RESET-BOUND SUBSYSTEMS (RBS) ---
  const rbsResetMap = new Map();

  vertices.forEach((v) => {
    // Check if the vertex is an RBS center (M == 1)
    if (v.M == 1 || v.m == 1 || v.M === "1") {
      const insideEdges = new Set();
      const insideNodes = new Set();

      // Step 1: Only the direct "" (epsilon) arcs from the center are "inside" edges
      const outgoingFromCenter = out.get(v.id) || [];
      for (let e of outgoingFromCenter) {
        let cVal = e.C === "" || e.C === "ϵ" ? EPS : e.C;
        if (cVal === EPS) {
          const edgeKey = `${e.from}->${e.to}`;
          insideEdges.add(edgeKey);
          insideNodes.add(e.to); // These are strictly the "inside" vertices
        }
      }

      // Step 2: Any arc exiting those inside vertices is an outbridge!
      // (Even if it is an epsilon arc itself, because it leaves the RBS boundary)
      insideNodes.forEach((nodeId) => {
        const outgoing = out.get(nodeId) || [];
        for (let e of outgoing) {
          const edgeKey = `${e.from}->${e.to}`;

          // If it's an edge exiting the inside node (and not an inside edge itself)
          if (!insideEdges.has(edgeKey)) {
            if (!rbsResetMap.has(edgeKey)) {
              rbsResetMap.set(edgeKey, new Set());
            }
            // Link this outbridge to all inside edges of this specific RBS
            insideEdges.forEach((ie) => rbsResetMap.get(edgeKey).add(ie));
          }
        }
      });
    }
  });
  // ------------------------------------------------

  // START ALGORITHM FOR GENERATING TRAVERSAL TREES
  let i = 1;
  let allNodes = [];

  const sourceVId = source[0];
  let rootNode = {
    id: `T_${i++}`,
    v: sourceVId,
    S: [0],
    parents: [],
    children: [],
    isPending: false,
    isCycleTerminal: false,
    edgeVisits: {},
    path: [sourceVId],
    triggerEdge: null,
    triggerC: null,
    choices: {},
  };

  allNodes.push(rootNode);

  let traversalActive = true;
  while (traversalActive) {
    // --- PHASE 2: FORWARD TRAVERSAL (Natural Unrolling) ---
    let X = allNodes.filter(
      (n) => n.children?.length === 0 && !n.isPending && !n.isCycleTerminal,
    );

    if (X.length === 1 && sink.includes(X[0].v)) {
      console.log("Reached the sink successfully.");
      break;
    }

    let progressedThisIteration = false;

    for (let nodeX of X) {
      const outgoingEdges = out.get(nodeX.v) || [];

      for (let edge of outgoingEdges) {
        const yj = edge.to;
        const edgeKey = `${nodeX.v}->${yj}`;

        const isAncestor = nodeX.path.includes(yj);
        const currentVisits = nodeX.edgeVisits[edgeKey] || 0;
        const maxVisits = edge.L !== undefined ? edge.L : 1;

        // Strictly respect the L-attributes
        if (currentVisits >= maxVisits) continue;

        let newEdgeVisits = {
          ...nodeX.edgeVisits,
          [edgeKey]: currentVisits + 1,
        };

        // --- NEW: RBS RESET MECHANIC ---
        // If this edge is an outbridge, reset the L-values for the RBS's internal edges
        if (rbsResetMap.has(edgeKey)) {
          const edgesToReset = rbsResetMap.get(edgeKey);
          edgesToReset.forEach((innerEdgeKey) => {
            newEdgeVisits[innerEdgeKey] = 0; // Restore capacity
          });
        }
        // -------------------------------

        let cVal = edge.C === "" || edge.C === "ϵ" ? EPS : edge.C;
        let newS = [...nodeX.S, cVal];

        let newNode = {
          id: `T_${i++}`,
          v: yj,
          S: newS,
          parents: [nodeX],
          children: [],
          isPending: false,
          isCycleTerminal: false,
          edgeVisits: newEdgeVisits,
          path: [...nodeX.path, yj],
          triggerEdge: edgeKey,
          triggerC: cVal,
          choices: { ...nodeX.choices },
        };

        if (isAncestor) {
          if (cVal === EPS && edge.L === undefined) {
            newNode.S.push(`cycle_resolved_${yj}`);
            newNode.isCycleTerminal = true;
            nodeX.children.push(newNode);
            allNodes.push(newNode);
          } else {
            nodeX.children.push(newNode);
            allNodes.push(newNode);
            const joinType = joinTypes.get(yj);
            if (joinType === "AND" || joinType === "MIX")
              newNode.isPending = true;
          }
        } else {
          nodeX.children.push(newNode);
          allNodes.push(newNode);
          const joinType = joinTypes.get(yj);
          if (joinType === "AND" || joinType === "MIX")
            newNode.isPending = true;
        }
        progressedThisIteration = true;
      }
    }

    // --- PHASE 3: RESOLVE PENDING JOINS ---
    if (!progressedThisIteration) {
      let pendingNodes = allNodes.filter((n) => n.isPending);

      if (pendingNodes.length > 0) {
        let pendingByVertex = new Map();
        for (let n of pendingNodes) {
          if (!pendingByVertex.has(n.v)) pendingByVertex.set(n.v, []);
          pendingByVertex.get(n.v).push(n);
        }

        for (let [joinV, nodesAtJoin] of pendingByVertex.entries()) {
          const requiredIncomingCount = inc.get(joinV).length;

          let nodesByEdge = new Map();
          for (let n of nodesAtJoin) {
            if (!nodesByEdge.has(n.triggerEdge))
              nodesByEdge.set(n.triggerEdge, []);
            nodesByEdge.get(n.triggerEdge).push(n);
          }

          if (nodesByEdge.size === requiredIncomingCount) {
            const branchArrays = Array.from(nodesByEdge.values());
            const combinations = branchArrays.reduce(
              (a, b) => a.flatMap((d) => b.map((e) => [d, e].flat())),
              [[]],
            );

            const isValidCombination = (pair) => {
              let mergedChoices = {};
              for (let n of pair) {
                for (let [nodeV, choiceVal] of Object.entries(n.choices)) {
                  if (
                    mergedChoices[nodeV] &&
                    mergedChoices[nodeV] !== choiceVal
                  )
                    return false;
                  mergedChoices[nodeV] = choiceVal;
                }
              }
              return true;
            };

            let validCombinations = combinations.filter(isValidCombination);
            let mergedNodesThisIteration = new Set();

            for (let pair of validCombinations) {
              const joinType = joinTypes.get(joinV);

              let longestNode = pair[0];
              for (let n of pair) {
                if (n.S.length > longestNode.S.length) longestNode = n;
              }
              let basePrefix = longestNode.S.slice(0, -1);

              let mergedChoices = {};
              for (let n of pair) Object.assign(mergedChoices, n.choices);

              if (joinType === "AND") {
                let conditions = pair.map((n) => n.triggerC);
                let groupedC = `(${conditions.join(",")})`;
                createMergedNode(
                  pair,
                  joinV,
                  [...basePrefix, groupedC],
                  mergedChoices,
                );
              } else if (joinType === "MIX") {
                let nodeEps = pair.find((n) => n.triggerC === EPS);
                let nodeC = pair.find((n) => n.triggerC !== EPS);

                if (nodeEps && nodeC) {
                  let mixAndChoices = { ...mergedChoices, [joinV]: "AND" };
                  createMergedNode(
                    pair,
                    joinV,
                    [...basePrefix, `(${EPS},${nodeC.triggerC})`],
                    mixAndChoices,
                  );

                  let mixOrChoices = { ...nodeC.choices, [joinV]: "OR" };
                  createMergedNode([nodeC], joinV, [...nodeC.S], mixOrChoices);
                }
              }
              for (let n of pair) mergedNodesThisIteration.add(n);
            }

            for (let n of mergedNodesThisIteration) n.isPending = false;
            progressedThisIteration = true;
          }
        }
      }

      if (!progressedThisIteration) {
        traversalActive = false;
      }
    }
  }

  function createMergedNode(parents, joinV, mergedS, choices) {
    let mergedVisits = {};
    for (let n of parents) {
      for (let [edge, count] of Object.entries(n.edgeVisits || {})) {
        mergedVisits[edge] = Math.max(mergedVisits[edge] || 0, count);
      }
    }
    let mergedPath = [...new Set(parents.flatMap((n) => n.path || []))];

    let mergedNode = {
      id: `T_${i++}`,
      v: joinV,
      S: mergedS,
      parents: parents,
      // NEW: Tell the renderer that all parents after the first one are "cross-links"
      crossParents: parents.slice(1).map((p) => p.id),
      children: [],
      isPending: false,
      isCycleTerminal: false,
      edgeVisits: mergedVisits,
      path: mergedPath,
      triggerEdge: null,
      triggerC: null,
      choices: choices,
    };

    for (let parent of parents) parent.children.push(mergedNode);
    allNodes.push(mergedNode);
  }

  // --- PHASE 4: EXTRACT UNIQUE MAXIMAL PATHS ---
  console.log("--- FINAL SPANNING TREE PATHS ---");

  // 1. Filter: Keep only the nodes that successfully reached the Sink
  let successfulPaths = allNodes.filter(
    (n) => n.children.length === 0 && !n.isPending && sink.includes(n.v),
  );

  // 2. Group by "Path Family" to extract maximal loops
  let pathFamilies = new Map();

  successfulPaths.forEach((n) => {
    // Sort the unique vertices so topological route variations match the same family
    const routeSignature = [...new Set(n.path)].sort().join("|");
    const choiceKey = JSON.stringify(n.choices || {});
    const familyKey = `${choiceKey}|${routeSignature}`;

    if (!pathFamilies.has(familyKey)) {
      pathFamilies.set(familyKey, []);
    }
    pathFamilies.get(familyKey).push(n);
  });

  // 3. For each family, keep ONLY the one with the longest S (the maximal loop execution)
  let maximalPaths = [];
  for (let familyNodes of pathFamilies.values()) {
    let maxNode = familyNodes[0];
    for (let node of familyNodes) {
      if (node.S.length > maxNode.S.length) {
        maxNode = node;
      }
    }
    maximalPaths.push(maxNode);
  }
  // 4. Final De-duplication: Store the actual Node (not just the string)
  let uniqueMaximalPaths = new Map();
  maximalPaths.forEach((n) => {
    const sString = n.S.join(",");
    if (!uniqueMaximalPaths.has(sString)) {
      uniqueMaximalPaths.set(sString, n); // <--- Store the whole node
    }
  });

  // 5. Output to Console
  uniqueMaximalPaths.forEach((node, pathS) => {
    console.log(`S([${pathS}])`);
  });

  // --- NEW: PHASE 5 - PRUNE DEAD-END BRANCHES FOR RENDERER ---
  // Backtrack from the 4 successful paths and keep ONLY their ancestors
  const survivingNodes = new Set();
  const queue = Array.from(uniqueMaximalPaths.values());

  while (queue.length > 0) {
    const curr = queue.shift();
    if (!survivingNodes.has(curr)) {
      survivingNodes.add(curr);
      if (curr.parents) {
        curr.parents.forEach((p) => queue.push(p));
      }
    }
  }

  // Filter out the noise and fix references
  allNodes = allNodes.filter((n) => survivingNodes.has(n));
  allNodes.forEach((n) => {
    n.children = n.children.filter((c) => survivingNodes.has(c));
    n.time = n.S.length; // Assign X-axis depth for renderer
  });

  return {
    allNodes: allNodes,
    maximalPaths: Array.from(uniqueMaximalPaths.values()),
  };
}
