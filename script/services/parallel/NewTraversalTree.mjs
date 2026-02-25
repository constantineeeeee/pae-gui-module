import { parseRDLT } from "../convert/rdlt2pn/modules/parser.js";
const EPS = "ϵ";

function normId(x) {
  return String(x);
}

function buildAdjacency(vertices, edges) {
  const out = new Map();
  const inc = new Map();

  for (const v of vertices) {
    const id = normId(v.id);
    out.set(id, []);
    inc.set(id, []);
  }

  edges.forEach((e, idx) => {
    const from = normId(e.from);
    const to = normId(e.to);

    const edge = { ...e, from, to, __idx: idx };
    out.get(from).push(edge);
    inc.get(to).push(edge);
  });

  return { out, inc };
}

function computeSourceSink(vertices, edges) {
  const incCount = Object.create(null);
  const outCount = Object.create(null);

  vertices.forEach((v) => {
    const id = String(v.id);
    incCount[id] = 0;
    outCount[id] = 0;
  });

  edges.forEach((e) => {
    const from = String(e.from);
    const to = String(e.to);
    outCount[from] = (outCount[from] ?? 0) + 1;
    incCount[to] = (incCount[to] ?? 0) + 1;
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

  // --- DETECT RESET-BOUND SUBSYSTEMS (RBS) ---
  const rbsResetMap = new Map();

  vertices.forEach((v) => {
    if (v.M == 1 || v.m == 1 || v.M === "1") {
      const insideEdges = new Set();
      const insideNodes = new Set();

      const outgoingFromCenter = out.get(v.id) || [];
      for (let e of outgoingFromCenter) {
        let cVal = e.C === "" || e.C === "ϵ" ? EPS : e.C;
        if (cVal === EPS) {
          const edgeKey = `${e.from}->${e.to}`;
          insideEdges.add(edgeKey);
          insideNodes.add(e.to); 
        }
      }

      insideNodes.forEach((nodeId) => {
        const outgoing = out.get(nodeId) || [];
        for (let e of outgoing) {
          const edgeKey = `${e.from}->${e.to}`;
          if (!insideEdges.has(edgeKey)) {
            if (!rbsResetMap.has(edgeKey)) {
              rbsResetMap.set(edgeKey, new Set());
            }
            insideEdges.forEach((ie) => rbsResetMap.get(edgeKey).add(ie));
          }
        }
      });
    }
  });

  // --- NEW: GLOBAL STATE REGISTRY TO PREVENT DUPLICATE INTERLEAVINGS ---
  const stateRegistry = new Map();

  function getStateSignature(v, visitsMap, choices) {
    const keys = Object.keys(visitsMap).sort();
    const visitStr = keys.map(k => `${k}:${visitsMap[k]}`).join("|");
    const choiceStr = JSON.stringify(choices || {});
    // Signature includes visits, meaning LOOPS will naturally bypass this and duplicate correctly!
    return `${v}::${visitStr}::${choiceStr}`;
  }

  // START ALGORITHM FOR GENERATING TRAVERSAL TREES
  let i = 1;
  let allNodes = [];

  const sourceVId = String(source[0]);
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

        if (currentVisits >= maxVisits) continue;

        let newEdgeVisits = {
          ...nodeX.edgeVisits,
          [edgeKey]: currentVisits + 1,
        };

        if (rbsResetMap.has(edgeKey)) {
          const edgesToReset = rbsResetMap.get(edgeKey);
          edgesToReset.forEach((innerEdgeKey) => {
            newEdgeVisits[innerEdgeKey] = 0; 
          });
        }

        // --- STATE DEDUPLICATION CHECK ---
        let sig = getStateSignature(yj, newEdgeVisits, nodeX.choices);
        if (stateRegistry.has(sig)) {
          let existingNode = stateRegistry.get(sig);
          if (!existingNode.parents.find(p => p.id === nodeX.id)) {
            existingNode.parents.push(nodeX);
            nodeX.children.push(existingNode);
          }
          progressedThisIteration = true;
          continue; // Block duplicate branch creation
        }

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

        stateRegistry.set(sig, newNode); // Register the new unique state

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

                // MERGE AND-JOINS TO PREVENT EXPLOSION
                let tempVisits = {};
                for (let n of pair) {
                  for (let [edge, count] of Object.entries(n.edgeVisits || {})) {
                    tempVisits[edge] = Math.max(tempVisits[edge] || 0, count);
                  }
                }
                const sig = getStateSignature(joinV, tempVisits, mergedChoices);

                if (stateRegistry.has(sig)) {
                  let existingNode = stateRegistry.get(sig);
                  for (let p of pair) {
                    if (!existingNode.parents.find(ep => ep.id === p.id)) {
                      existingNode.parents.push(p);
                      p.children.push(existingNode);
                    }
                  }
                } else {
                  let mergedNode = createMergedNode(pair, joinV, [...basePrefix, groupedC], mergedChoices);
                  stateRegistry.set(sig, mergedNode);
                }

              } else if (joinType === "MIX") {
                let nodeEps = pair.find((n) => n.triggerC === EPS);
                let nodeC = pair.find((n) => n.triggerC !== EPS);

                if (nodeEps && nodeC) {
                  let mixAndChoices = { ...mergedChoices, [joinV]: "AND" };
                  createMergedNode(pair, joinV, [...basePrefix, `(${EPS},${nodeC.triggerC})`], mixAndChoices);

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
    return mergedNode;
  }

  console.log("--- FINAL SPANNING TREE PATHS ---");

  let successfulPaths = allNodes.filter(
    (n) => n.children.length === 0 && !n.isPending && sink.includes(n.v),
  );

  let pathFamilies = new Map();

  successfulPaths.forEach((n) => {
    const routeSignature = [...new Set(n.path)].sort().join("|");
    const choiceKey = JSON.stringify(n.choices || {});
    const familyKey = `${choiceKey}|${routeSignature}`;

    if (!pathFamilies.has(familyKey)) {
      pathFamilies.set(familyKey, []);
    }
    pathFamilies.get(familyKey).push(n);
  });

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

  let uniqueMaximalPaths = new Map();
  maximalPaths.forEach((n) => {
    const sString = n.S.join(",");
    if (!uniqueMaximalPaths.has(sString)) {
      uniqueMaximalPaths.set(sString, n); 
    }
  });

  uniqueMaximalPaths.forEach((node, pathS) => {
    console.log(`S([${pathS}])`);
  });

  // --- PHASE 5: MAP DAG CAREFULLY TO FIX THE 'TIME' BUG ---
  const survivingNodes = new Set();
  const survivingEdges = new Set();
  const queue = Array.from(uniqueMaximalPaths.values());

  // Deep recursive trace backwards to build the perfect DAG map
  function traceBack(node) {
    if (!survivingNodes.has(node.id)) {
      survivingNodes.add(node.id);
    }
    if (node.parents) {
      node.parents.forEach((p) => {
        const edgeKey = `${p.id}->${node.id}`;
        if (!survivingEdges.has(edgeKey)) {
          survivingEdges.add(edgeKey);
          traceBack(p); 
        }
      });
    }
  }

  queue.forEach((leaf) => traceBack(leaf));

  // Purge dead nodes
  allNodes = allNodes.filter((n) => survivingNodes.has(n.id));
  
  // Re-link surviving edges and strictly assign time based on string length
  allNodes.forEach((n) => {
    n.parents = n.parents.filter((p) => survivingEdges.has(`${p.id}->${n.id}`));
    n.children = n.children.filter((c) => survivingEdges.has(`${n.id}->${c.id}`));
    n.time = n.S.length - 1; // <--- Perfectly sets X-axis placement safely!
  });

  return {
    allNodes: allNodes,
    maximalPaths: Array.from(uniqueMaximalPaths.values()),
  };
}