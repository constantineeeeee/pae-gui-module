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
    choices: {}, // <--- NEW: Tracks the "universe" this path belongs to
  };

  allNodes.push(rootNode);

  let traversalActive = true;

  while (traversalActive) {
    // --- PHASE 2: FORWARD TRAVERSAL ---
    let X = allNodes.filter(
      (n) => n.children?.length === 0 && !n.isPending && !n.isCycleTerminal,
    );

    if (X.length === 1 && X[0].v === sink[0]) {
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
          choices: { ...nodeX.choices }, // Inherit universe choices
        };

        if (isAncestor) {
          if (cVal === EPS) {
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

            // NEW: Filter out combinations from colliding universes!
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
                  // Behavior 1: MIX/AND
                  let mixAndChoices = { ...mergedChoices, [joinV]: "AND" };
                  createMergedNode(
                    pair,
                    joinV,
                    [...basePrefix, `(${EPS},${nodeC.triggerC})`],
                    mixAndChoices,
                  );

                  // Behavior 2: MIX/OR
                  let mixOrChoices = { ...nodeC.choices, [joinV]: "OR" };
                  createMergedNode([nodeC], joinV, [...nodeC.S], mixOrChoices);
                }
              }

              // Track which nodes successfully merged so we can unlock them
              for (let n of pair) mergedNodesThisIteration.add(n);
            }

            for (let n of mergedNodesThisIteration) {
              n.isPending = false;
            }
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
      choices: choices, // Apply the new universe tracking
    };

    for (let parent of parents) {
      parent.children.push(mergedNode);
    }
    allNodes.push(mergedNode);
  }

  // --- PHASE 4: EXTRACT FINAL PATHS ---
  console.log("--- FINAL SPANNING TREE PATHS ---");
  let leafNodes = allNodes.filter(
    (n) => n.children.length === 0 && !n.isPending,
  ); // Ignore stalled invalid universes

  leafNodes.forEach((n) => {
    const formattedS = `S([${n.S.join(",")}])`;
    console.log(formattedS);
  });
}
