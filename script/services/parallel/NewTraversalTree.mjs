/*
Service Module for the Traversal Tree Generation Algorithm
Developed for the PAE GUI Module (2025)

Generates a traversal tree from an RDLT graph.
The tree records every maximal activity that the RDLT model can produce,
including cycle-aware loop unrolling, AND/OR/MIX join resolution.
*/

import { parseRDLT } from "../convert/rdlt2pn/modules/parser.js";

const EPS = "ϵ";

/**
 * @typedef {string} VertexId
 * @typedef {string} EdgeKey  - "fromId->toId"
 *
 * @typedef {{
 *   id:   string | number,
 *   [key: string]: any
 * }} Vertex
 *
 * @typedef {{
 *   from: string | number,
 *   to:   string | number,
 *   C:    string,
 *   L?:   number,
 *   [key: string]: any
 * }} Edge
 *
 * @typedef {{
 *   out: Map<VertexId, Edge[]>,
 *   inc: Map<VertexId, Edge[]>
 * }} Adjacency
 *
 * @typedef {"OR" | "AND" | "MIX"} JoinType
 *
 * @typedef {{
 *   id:              string,
 *   v:               VertexId,
 *   S:               (string | number)[],
 *   parents:         TTNode[],
 *   children:        TTNode[],
 *   isPending:       boolean,
 *   isCycleTerminal: boolean,
 *   edgeVisits:      { [edgeKey: EdgeKey]: number },
 *   path:            VertexId[],
 *   triggerEdge:     EdgeKey | null,
 *   triggerC:        string | null,
 *   choices:         { [vertexId: VertexId]: string },
 *   isPlaceholder?:  boolean,
 *   joinGroupId?:    string,
 *   isOrSubgroupMember?: boolean,
 *   _orChildOfPh?:   TTNode
 * }} TTNode
 *
 * @typedef {{
 *   allNodes:     TTNode[],
 *   counter:      number,
 *   joinGroupByVertex: Map<VertexId, string>
 * }} TTContext
 *
 * @typedef {{
 *   allNodes:     TTNode[],
 *   maximalPaths: TTNode[],
 *   joinTypes:    Map<VertexId, JoinType>
 * }} TTResult
 */



/**
 * Coerces a vertex/edge id to a string for use as a map key.
 *
 * @param {string | number} x
 * @returns {string}
 */
function normId(x) {
    return String(x);
}

/**
 * Builds outgoing and incoming adjacency maps for the given graph.
 *
 * @param {Vertex[]} vertices
 * @param {Edge[]}   edges
 * @returns {Adjacency}
 */
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
        const to   = normId(e.to);
        const edge = { ...e, from, to, __idx: idx };
        out.get(from).push(edge);
        inc.get(to).push(edge);
    });

    return { out, inc };
}

/**
 * Identifies source and sink.
 *
 * @param {Vertex[]} vertices
 * @param {Edge[]}   edges
 * @returns {{ source: VertexId[], sink: VertexId[] }}
 */
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
        const to   = String(e.to);
        outCount[from] = (outCount[from] ?? 0) + 1;
        incCount[to]   = (incCount[to]   ?? 0) + 1;
    });

    const source = Object.keys(incCount).filter((id) => incCount[id] === 0);
    const sink   = Object.keys(outCount).filter((id) => outCount[id] === 0);

    return { source, sink };
}

/**
 * Identifies edges that participate in at least one cycle.
 *
 * @param {Vertex[]}               vertices
 * @param {Edge[]}                 edges
 * @param {Map<VertexId, Edge[]>}  out       - outgoing adjacency map
 * @returns {Set<EdgeKey>}
 */
function buildCycleArcs(vertices, edges, out) {
    const reachFrom = new Map();

    for (const v of vertices) {
        const startId  = String(v.id);
        const reachable = new Set();
        const queue    = [startId];

        while (queue.length > 0) {
            const cur    = queue.shift();
            const oedges = out.get(cur) || [];
            for (const e of oedges) {
                if (!reachable.has(e.to)) {
                    reachable.add(e.to);
                    queue.push(e.to);
                }
            }
        }
        reachFrom.set(startId, reachable);
    }

    const cycleArcs = new Set();
    for (const e of edges) {
        const from = String(e.from);
        const to   = String(e.to);
        if (reachFrom.get(to)?.has(from)) {
            cycleArcs.add(`${from}->${to}`);
        }
    }
    return cycleArcs;
}

/**
 * Sorts outgoing edges so loop-continuation arcs (cycle arcs whose L-budget
 * still permits another traversal for this branch) come first, then non-cycle
 * arcs, then L-exhausted cycle arcs.
 *
 * For maximal-activity extraction we want the loop to keep iterating until
 * the L-attribute is consumed; only then do we yield to non-cycle exits.
 *
 * @param {Edge[]}               outgoingEdges
 * @param {{ [key: EdgeKey]: number }} edgeVisits
 * @param {Set<EdgeKey>}         cycleArcs
 * @returns {Edge[]}
 */
function sortEdgesLoopFirst(outgoingEdges, edgeVisits, cycleArcs) {
    const unexhaustedCycle = [];
    const nonCycle         = [];
    const exhaustedCycle   = [];

    for (const e of outgoingEdges) {
        const ek = `${e.from}->${e.to}`;
        if (!cycleArcs.has(ek)) {
            nonCycle.push(e);
            continue;
        }
        const traversals = edgeVisits[ek] || 0;
        const L = e.L !== undefined ? e.L : 1;
        if (traversals < L) unexhaustedCycle.push(e);
        else exhaustedCycle.push(e);
    }

    return [...unexhaustedCycle, ...nonCycle, ...exhaustedCycle];
}

/**
 * Classifies every incoming vertex as an OR, AND, or MIX join based on
 * the C-values of its incoming arcs.
 *
 * @param {Map<VertexId, Edge[]>} inc  - incoming adjacency map
 * @returns {Map<VertexId, JoinType>}
 */
function classifyJoin(inc) {
    const joinTypes = new Map();

    inc.forEach((edges, vertexId) => {
        if (edges.length > 1) {
            const cValues = edges.map((e) =>
                e.C === "" || e.C === "ϵ" ? "EPS" : e.C,
            );

            const hasEpsilon    = cValues.some((v) => v === "EPS");
            const hasNonEpsilon = cValues.some((v) => v !== "EPS");

            if (hasEpsilon && hasNonEpsilon) {
                joinTypes.set(vertexId, "MIX");
            } else if (hasEpsilon && !hasNonEpsilon) {
                // OR-join (same C-value)
                joinTypes.set(vertexId, "OR");
            } else {
                // AND if C-values differ, OR if all the same
                const uniqueC = new Set(cValues);
                if (uniqueC.size === 1) {
                    joinTypes.set(vertexId, "OR");
                } else {
                    // Two or more different Σ C-values → AND-join (must synchronize)
                    joinTypes.set(vertexId, "AND");
                }
            }
        }
    });

    return joinTypes;
}

/**
 * Returns a stable group-id string for `v`. All placeholder nodes feeding the same join
 * vertex share this id so the renderer can draw a single sync bar.
 *
 * @param {VertexId}                    v
 * @param {Map<VertexId, string>}       joinGroupByVertex
 * @returns {string}
 */
function getJoinGroup(v, joinGroupByVertex) {
    if (!joinGroupByVertex.has(v)) joinGroupByVertex.set(v, `JG_${v}`);
    return joinGroupByVertex.get(v);
}

/**
 * Produces a string signature for a tree state so that
 * structurally identical states can be deduplicated.
 *
 * @param {VertexId}                         v
 * @param {{ [edgeKey: EdgeKey]: number }}   visitsMap
 * @param {{ [vertexId: VertexId]: string }} choices
 * @returns {string}
 */
function getStateSignature(v, visitsMap, choices) {
    const keys     = Object.keys(visitsMap).sort();
    const visitStr = keys.map(k => `${k}:${visitsMap[k]}`).join("|");
    const choiceStr = JSON.stringify(choices || {});
    return `${v}::${visitStr}::${choiceStr}`;
}

/**
 * Inserts one placeholder node between each parent in `parents` and a
 * downstream join target `joinV`. All placeholders share the same
 * `joinGroupId` so the renderer can draw a vertical synchronization bar
 * between them.
 *
 * @param {TTNode[]}  parents
 * @param {VertexId}  joinV
 * @param {TTContext} ctx
 * @returns {TTNode[]}  the created placeholder nodes (one per parent)
 */
function insertJoinPlaceholders(parents, joinV, ctx) {
    const groupId    = getJoinGroup(joinV, ctx.joinGroupByVertex);
    const placeholders = [];

    for (const p of parents) {
        const ph = {
            id:              `T_${ctx.counter++}`,
            v:               joinV,
            S:               [...p.S],            // carries through the parent's current state
            parents:         [p],
            children:        [],
            isPending:       false,
            isCycleTerminal: false,
            edgeVisits:      { ...(p.edgeVisits || {}) },
            path:            [...(p.path || [])],
            triggerEdge:     null,
            triggerC:        null,
            choices:         { ...(p.choices || {}) },
            // Placeholder flags — recognized by the renderer
            isPlaceholder:   true,
            joinGroupId:     groupId,
        };
        // Splice placeholder between parent and downstream:
        //   parent.children should keep parent → ph; the merged target will be
        //   created by the caller and link from ph rather than from p directly.
        // We don't remove p.children here because the caller (createMergedNode
        //   etc.) will be passed `placeholders` as the new parents instead of `pair`.
        p.children.push(ph);
        ctx.allNodes.push(ph);
        placeholders.push(ph);
    }
    return placeholders;
}

/**
 * Creates a merged (join-output) node whose parents are the provided nodes,
 * merges their edge-visit counts, and links parent → mergedNode edges.
 *
 * @param {TTNode[]}                         parents
 * @param {VertexId}                         joinV
 * @param {(string | number)[]}              mergedS
 * @param {{ [vertexId: VertexId]: string }} choices
 * @param {TTContext}                        ctx
 * @returns {TTNode}
 */
function createMergedNode(parents, joinV, mergedS, choices, ctx) {
    let mergedVisits = {};
    for (let n of parents) {
        for (let [edge, count] of Object.entries(n.edgeVisits || {})) {
            mergedVisits[edge] = Math.max(mergedVisits[edge] || 0, count);
        }
    }

    // Build a chronologically-coherent merged path: union of parents' paths
    // with the join vertex pinned at the END. The dedup-into-Set above can
    // reorder entries (insertion order from the first occurrence in the
    // flatMap), which would put `joinV` in the middle if a later parent's
    // path is appended after it. That breaks the `isRevisit` check in the
    // forward loop (it relies on `path.slice(0,-1)` to exclude the current
    // vertex and look only at earlier entries).
    let mergedPath = [
        ...new Set(parents.flatMap((n) => n.path || []).filter((p) => p !== joinV)),
        joinV,
    ];

    let mergedNode = {
        id:              `T_${ctx.counter++}`,
        v:               joinV,
        S:               mergedS,
        parents:         parents,
        children:        [],
        isPending:       false,
        isCycleTerminal: false,
        edgeVisits:      mergedVisits,
        path:            mergedPath,
        triggerEdge:     null,
        triggerC:        null,
        choices:         choices,
    };

    for (let parent of parents) parent.children.push(mergedNode);
    ctx.allNodes.push(mergedNode);
    return mergedNode;
}


/**
 * Generates the traversal tree for a given RDLT graph.
 *
 * The algorithm proceeds in three phases per outer iteration:
 *  1. **Forward traversal** — expand every leaf node that has unvisited
 *     outgoing arcs, applying PAE-style cycle-aware spawn rules.
 *  2. **Join resolution** — when no forward progress is possible, collect
 *     pending nodes at AND/MIX join vertices and produce merged outputs for
 *     every valid incoming-branch combination.
 *  3. **Termination** — stop when a single leaf at the sink is left, or when
 *     neither phase produces progress.
 *
 * After construction the result is post-processed to:
 *  - Extract maximal S-sequence paths (one per distinct route + choice set).
 *  - Assign semantic `time` and visual `col` coordinates to every node via
 *    Kahn's topological ordering.
 *
 * @param {object}  input            - RDLT graph as produced by `parseRDLT`.
 * @param {Vertex[]} input.vertices
 * @param {Edge[]}   input.edges
 * @param {object}  [opts]
 * @param {string}  [opts.sourceId]  - override auto-detected source vertex id
 * @param {string}  [opts.sinkId]    - override auto-detected sink vertex id
 * @returns {TTResult}
 */
export function generateTraversalTreeFromJSON(
    input,
    { sourceId = null, sinkId = null } = {},
) {
    parseRDLT(input, false);

    const vertices = input.vertices;
    const edges    = input.edges;
    const { source, sink } = computeSourceSink(vertices, edges);
    const { out, inc }     = buildAdjacency(input.vertices, input.edges);

    const joinTypes = classifyJoin(inc);

    // --- DETECT CYCLE ARCS (graph-level) ---
    // Used by sortEdgesLoopFirst and the cycle-aware spawn rules below to
    // prioritize loop continuation, defer cycle exits, and suppress respawning
    // at OR/MIX splits during cycle iteration.
    const cycleArcs = buildCycleArcs(vertices, edges, out);

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

    // Per-join-vertex group registry — reuses one group id per joinV so all
    // placeholders feeding into the same join vertex share a sync bar.
    /** @type {TTContext} */
    const ctx = {
        allNodes:         [],
        counter:          1,
        joinGroupByVertex: new Map(),
    };

    // START ALGORITHM FOR GENERATING TRAVERSAL TREES
    const sourceVId = String(source[0]);
    let rootNode = {
        id:              `T_${ctx.counter++}`,
        v:               sourceVId,
        S:               [0],
        parents:         [],
        children:        [],
        isPending:       false,
        isCycleTerminal: false,
        edgeVisits:      {},
        path:            [sourceVId],
        triggerEdge:     null,
        triggerC:        null,
        choices:         {},
    };

    ctx.allNodes.push(rootNode);

    let traversalActive = true;
    while (traversalActive) {
        // --- PHASE 2: FORWARD TRAVERSAL (Natural Unrolling) ---
        let X = ctx.allNodes.filter(
            (n) => n.children?.length === 0 && !n.isPending && !n.isCycleTerminal,
        );

        if (X.length === 1 && sink.includes(X[0].v)) {
            break;
        }

        let progressedThisIteration = false;

        for (let nodeX of X) {
            const rawOutgoing = out.get(nodeX.v) || [];

            const outgoingEdges = sortEdgesLoopFirst(rawOutgoing, nodeX.edgeVisits, cycleArcs);
            const isRevisit = nodeX.path.slice(0, -1).includes(nodeX.v);
            const hasUnexhaustedCycleEpsilon = outgoingEdges.some((e) => {
                const ek = `${e.from}->${e.to}`;
                if (!cycleArcs.has(ek)) return false;
                const cV = e.C === "" || e.C === "ϵ" ? EPS : e.C;
                if (cV !== EPS) return false;
                const trav = nodeX.edgeVisits[ek] || 0;
                const L = e.L !== undefined ? e.L : 1;
                return trav < L;
            });

            let mainTaken = false;

            for (let edge of outgoingEdges) {
                const yj      = edge.to;
                const edgeKey = `${nodeX.v}->${yj}`;

                const isAncestor    = nodeX.path.includes(yj);
                const currentVisits = nodeX.edgeVisits[edgeKey] || 0;
                const maxVisits     = edge.L !== undefined ? edge.L : 1;

                if (currentVisits >= maxVisits) {
                    continue;
                }

                if (mainTaken) {
                    if (isRevisit) {
                        continue;
                    }
                    const eIsCycle  = cycleArcs.has(edgeKey);
                    const cV        = edge.C === "" || edge.C === "ϵ" ? EPS : edge.C;
                    const eIsEpsilon = cV === EPS;
                    if (!eIsCycle && !eIsEpsilon && hasUnexhaustedCycleEpsilon) {
                        continue;
                    }
                }
                mainTaken = true;

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
                let sig = `${getStateSignature(yj, newEdgeVisits, nodeX.choices)}|p:${nodeX.id}`;
                if (stateRegistry.has(sig)) {
                    let existingNode = stateRegistry.get(sig);
                    if (!existingNode.parents.find(p => p.id === nodeX.id)) {
                        existingNode.parents.push(nodeX);
                        nodeX.children.push(existingNode);
                    }
                    progressedThisIteration = true;
                    continue;
                }

                let cVal = edge.C === "" || edge.C === "ϵ" ? EPS : edge.C;
                let newS = [...nodeX.S, cVal];

                let newNode = {
                    id:              `T_${ctx.counter++}`,
                    v:               yj,
                    S:               newS,
                    parents:         [nodeX],
                    children:        [],
                    isPending:       false,
                    isCycleTerminal: false,
                    edgeVisits:      newEdgeVisits,
                    path:            [...nodeX.path, yj],
                    triggerEdge:     edgeKey,
                    triggerC:        cVal,
                    choices:         { ...nodeX.choices },
                };

                // For OR-joins (and any vertex with multiple incoming arcs whose
                // type is OR), splice a placeholder between nodeX and newNode so
                // the renderer can show a (yj) intermediary plus a sync bar shared
                // by all incoming branches arriving at yj.
                const yjJoinType = joinTypes.get(yj);
                if (yjJoinType === "OR" && (inc.get(yj)?.length ?? 0) > 1) {
                    const groupId = getJoinGroup(yj, ctx.joinGroupByVertex);
                    const ph = {
                        id:              `T_${ctx.counter++}`,
                        v:               yj,
                        S:               [...nodeX.S],
                        parents:         [nodeX],
                        children:        [newNode],
                        isPending:       false,
                        isCycleTerminal: false,
                        edgeVisits:      { ...nodeX.edgeVisits },
                        path:            [...nodeX.path],
                        triggerEdge:     null,
                        triggerC:        null,
                        choices:         { ...nodeX.choices },
                        isPlaceholder:   true,
                        joinGroupId:     groupId,
                    };
                    // Re-link: nodeX → ph → newNode
                    newNode.parents = [ph];
                    ctx.allNodes.push(ph);
                    // nodeX.children push of ph happens below in the existing logic
                    // (it currently pushes newNode to nodeX.children — replace with ph)
                    // We mark newNode so the existing push logic treats it correctly:
                    newNode._orChildOfPh = ph; // signal to push ph instead of newNode below
                }

                stateRegistry.set(sig, newNode); // Register the new unique state

                if (isAncestor) {
                    if (cVal === EPS && edge.L === undefined) {
                        newNode.S.push(`cycle_resolved_${yj}`);
                        newNode.isCycleTerminal = true;
                        nodeX.children.push(newNode._orChildOfPh ?? newNode);
                        ctx.allNodes.push(newNode);
                    } else {
                        nodeX.children.push(newNode._orChildOfPh ?? newNode);
                        ctx.allNodes.push(newNode);
                        const joinType = joinTypes.get(yj);
                        if (joinType === "AND" || joinType === "MIX")
                            newNode.isPending = true;
                    }
                } else {
                    nodeX.children.push(newNode._orChildOfPh ?? newNode);
                    ctx.allNodes.push(newNode);
                    const joinType = joinTypes.get(yj);
                    if (joinType === "AND" || joinType === "MIX")
                        newNode.isPending = true;
                }
                progressedThisIteration = true;
            }
        }

        // --- PHASE 3: RESOLVE PENDING JOINS ---
        if (!progressedThisIteration) {
            let pendingNodes = ctx.allNodes.filter((n) => n.isPending);

            if (pendingNodes.length > 0) {
                let pendingByVertex = new Map();
                for (let n of pendingNodes) {
                    if (!pendingByVertex.has(n.v)) pendingByVertex.set(n.v, []);
                    pendingByVertex.get(n.v).push(n);
                }

                for (let [joinV, nodesAtJoin] of pendingByVertex.entries()) {
                    const requiredIncomingCount = inc.get(joinV).length;

                    // Group pending nodes by their C-condition (not by triggerEdge).
                    // Two incoming arcs sharing the same C contribute the same condition
                    // to the merged state, so they're interchangeable for the merge —
                    // the algorithm should enumerate combinations across DISTINCT
                    // C-values, not across edges.
                    let nodesByCondition = new Map();
                    for (let n of nodesAtJoin) {
                        const key = n.triggerC;
                        if (!nodesByCondition.has(key)) nodesByCondition.set(key, []);
                        nodesByCondition.get(key).push(n);
                    }

                    // The required number of distinct conditions equals the number of
                    // distinct C-values across the join's incoming arcs.
                    const incomingCs = new Set(
                        inc.get(joinV).map((e) => (e.C === "" || e.C === "ϵ" ? EPS : e.C))
                    );
                    const requiredConditionCount = incomingCs.size;

                    // Keep the original edge-grouping for reference (still useful for
                    // checking that every required edge has at least one pending node).
                    let nodesByEdge = new Map();
                    for (let n of nodesAtJoin) {
                        if (!nodesByEdge.has(n.triggerEdge))
                            nodesByEdge.set(n.triggerEdge, []);
                        nodesByEdge.get(n.triggerEdge).push(n);
                    }

                    if (nodesByCondition.size === requiredConditionCount) {
                        const branchArrays = Array.from(nodesByCondition.values());
                        const combinations = branchArrays.reduce(
                            (a, b) => a.flatMap((d) => b.map((e) => [d, e].flat())),
                            [[]],
                        );

                        const isValidCombination = (pair) => {
                            // Check 1: no conflicting explicit choices (original check)
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

                            // Check 2 (AND-joins only): source-level OR-choice must match.
                            // At an AND-join, nodes that came through DIFFERENT source-
                            // level OR-split branches must not merge — they belong to
                            // separate activities. We compare ONLY S[1] (the first C-value
                            // taken from the source), not the full S prefix, because two
                            // branches taking the SAME source-level C-value via DIFFERENT
                            // arcs (e.g. arcs 2 and 22 both labelled `b`) — or via paths
                            // with different ε counts — are still the same activity from
                            // the OR-split perspective and are PAE-eligible to synchronize
                            // at this AND-join.
                            //
                            // MIX-joins are intentionally excluded: the ε and Σ branches
                            // always have different S prefixes (they arrived via different
                            // OR-split choices), but they are SUPPOSED to merge.
                            //
                            // Note: this only enforces the source-level choice. Nested
                            // OR-splits could in principle over-merge; the explicit
                            // `choices`-conflict check (Check 1) provides partial
                            // coverage there since MIX-AND/MIX-OR splits record their
                            // choice in `choices`.
                            const joinType = joinTypes.get(joinV);
                            if (joinType === "AND" && pair.length > 1) {
                                const firstChoices = pair.map(n => n.S[1]);
                                const first = firstChoices[0];
                                if (!firstChoices.every(c => c === first)) return false;
                            }

                            return true;
                        };

                        let validCombinations = combinations.filter(isValidCombination);

                        // For each C-value bucket with > 1 node (OR-subgroup within an AND-join),
                        // tag all those arrival nodes with a shared joinGroupId so the renderer can
                        // draw a vertical sync bar between them. We do NOT insert extra placeholder
                        // nodes — that would perturb the D3 layout. The sync bar is purely visual.
                        for (const [cVal, bucket] of nodesByCondition.entries()) {
                            if (bucket.length > 1) {
                                const orGroupId = `JG_OR_${joinV}_${cVal}`;
                                for (const bNode of bucket) {
                                    bNode.joinGroupId = orGroupId;
                                    bNode.isOrSubgroupMember = true;
                                }
                            }
                        }

                        let mergedNodesThisIteration = new Set();
                        // Track which S-ancestry prefixes have already spawned a MIX-OR
                        // independent clone. One clone per distinct ancestry is correct —
                        // the MIX-OR independent activity is unique per OR-split branch,
                        // not unique per join vertex. Using a flat boolean would suppress
                        // the MIX-OR clone for the second OR-split branch (e.g. the 'b'
                        // branch at x6 would lose its MIX-OR clone because the 'a' branch
                        // already set the flag).
                        const spawnedMixOrByPrefix = new Set();

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
                                // AND-join merge.
                                //
                                // When multiple incoming arcs share the same C-value (Structure 8),
                                // those nodes form an OR-subgroup. We tagged them above with a shared
                                // joinGroupId so the renderer draws a sync bar between them. The merge
                                // itself uses the pair as-is — one node per distinct C-value.

                                const conditions = [...new Set(pair.map((n) => n.triggerC))];
                                let groupedC     = `(${conditions.join(",")})`;

                                let tempVisits = {};
                                for (let n of pair) {
                                    for (let [edge, count] of Object.entries(n.edgeVisits || {})) {
                                        tempVisits[edge] = Math.max(tempVisits[edge] || 0, count);
                                    }
                                }
                                // Include the sorted parent IDs in the signature so different
                                // ancestor combinations produce DISTINCT merged nodes.
                                // Without this, two different (a,b)-merges that happen to have
                                // overlapping edge-visit counts would dedupe into one node and
                                // their paths would visually overlap.
                                const parentSigPart = pair
                                    .map(p => p.id)
                                    .sort()
                                    .join(",");
                                const baseSig = getStateSignature(joinV, tempVisits, mergedChoices);
                                const sig = `${baseSig}|parents:${parentSigPart}`;

                                if (stateRegistry.has(sig)) {
                                    let existingNode = stateRegistry.get(sig);
                                    for (let p of pair) {
                                        if (!existingNode.parents.find(ep => ep.id === p.id)) {
                                            existingNode.parents.push(p);
                                            p.children.push(existingNode);
                                        }
                                    }
                                } else {
                                    let mergedNode = createMergedNode(pair, joinV, [...basePrefix, groupedC], mergedChoices, ctx);
                                    stateRegistry.set(sig, mergedNode);
                                }

                            } else if (joinType === "MIX") {
                                let nodeEps = pair.find((n) => n.triggerC === EPS);
                                let nodeC   = pair.find((n) => n.triggerC !== EPS);

                                if (nodeEps && nodeC) {
                                    // MIX-AND merged path: ε waited for Σ; both fire together at
                                    // this i-step. Per the manuscript, the merged S-encoding
                                    // takes the ε-branch's prefix (the activity that was carried
                                    // along) and replaces its last element with the synchronized
                                    // pair (ε, c). This preserves each ε-branch's distinct
                                    // ancestry instead of collapsing all merge variants onto the
                                    // Σ-branch's prefix.
                                    //
                                    //   ε branch S = [..., last]   →   merged = [..., (ε, c)]
                                    //
                                    // Example with Path B reaching x6 via x4 (S=[0,b,ε,ε,ε])
                                    // merging with Path A's f-arc (S=[0,a,ε,ε,ε,f]):
                                    //   merged S = [0,b,ε,ε,(ε,f)]   ✓ keeps Path B's ancestry
                                    //
                                    // The placeholders are shared between the merged output and
                                    // the MIX-OR independent so the renderer draws ONE sync bar
                                    // for both at this join vertex.
                                    const phPair = insertJoinPlaceholders(pair, joinV, ctx);
                                    const phEps  = phPair[pair.indexOf(nodeEps)];
                                    const phC    = phPair[pair.indexOf(nodeC)];

                                    // MIX-AND merged: ε branch's prefix + (ε, c) at the merge step
                                    const epsBasePrefix = nodeEps.S.slice(0, -1);
                                    let mixAndChoices   = { ...mergedChoices, [joinV]: "AND" };
                                    createMergedNode(
                                        [phEps, phC],
                                        joinV,
                                        [...epsBasePrefix, `(${EPS},${nodeC.triggerC})`],
                                        mixAndChoices,
                                        ctx
                                    );

                                    // MIX-OR independent path: Σ arc passes through alone. This
                                    // is ONE activity choice per OR-split ancestry — produce it
                                    // once per distinct Σ-node ancestry prefix. A MIX-join with N
                                    // ε partners from the SAME ancestry should only emit ONE
                                    // Σ-only path, but a MIX-join where ε partners come from
                                    // DIFFERENT OR-split branches (different S prefixes) must emit
                                    // one Σ-only path per distinct ancestry, because each is an
                                    // independent activity.
                                    const mixOrKey = nodeC.S.slice(0, -1).join(",");
                                    if (!spawnedMixOrByPrefix.has(mixOrKey)) {
                                        let mixOrChoices = { ...nodeC.choices, [joinV]: "OR" };
                                        createMergedNode([phC], joinV, [...nodeC.S], mixOrChoices, ctx);
                                        spawnedMixOrByPrefix.add(mixOrKey);
                                    }
                                }
                            }
                            for (let n of pair) mergedNodesThisIteration.add(n);
                            // Also clear all OR-subgroup members so they don't stay pending.
                            for (const [, bucket] of nodesByCondition.entries()) {
                                for (const bNode of bucket) mergedNodesThisIteration.add(bNode);
                            }
                        }

                        for (let n of mergedNodesThisIteration) n.isPending = false;
                        if (mergedNodesThisIteration.size > 0) {
                            progressedThisIteration = true;
                        }
                    }
                }
            }

            if (!progressedThisIteration) {
                traversalActive = false;
            }
        }
    }

    // --- PHASE 4: EXTRACT MAXIMAL PATHS ---

    let successfulPaths = ctx.allNodes.filter(
        (n) => n.children.length === 0 && !n.isPending && sink.includes(n.v),
    );

    let pathFamilies = new Map();

    successfulPaths.forEach((n) => {
        const routeSignature = [...new Set(n.path)].sort().join("|");
        const choiceKey      = JSON.stringify(n.choices || {});
        const familyKey      = `${choiceKey}|${routeSignature}`;

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

    // Dedup by (S, vertex path): two leaves with the same S but different
    // vertex paths through the graph are DISTINCT activities (e.g. an
    // OR-subgroup at an AND-join produces two paths with identical S encoding
    // but going through different vertices). Only true duplicates (same S AND
    // same path) collapse.
    let uniqueMaximalPaths = new Map();
    maximalPaths.forEach((n) => {
        const sString    = n.S.join(",");
        const pathString = (n.path ?? []).join(",");
        const key        = `${sString}::${pathString}`;
        if (!uniqueMaximalPaths.has(key)) {
            uniqueMaximalPaths.set(key, n);
        }
    });

    const allNodes = ctx.allNodes;
    const indeg = new Map();
    for (const n of allNodes) indeg.set(n.id, n.parents.length);
    const ready = allNodes.filter((n) => (indeg.get(n.id) ?? 0) === 0);
    const order = [];
    while (ready.length) {
        const n = ready.shift();
        order.push(n);
        for (const c of n.children) {
            indeg.set(c.id, (indeg.get(c.id) ?? 1) - 1);
            if (indeg.get(c.id) === 0) ready.push(c);
        }
    }

    for (const n of order) {
        if (n.parents.length === 0) {
            n.time = 0;
            n.col  = 0;
            continue;
        }
        const parentMaxTime = Math.max(...n.parents.map((p) => p.time ?? 0));
        const parentMaxCol  = Math.max(...n.parents.map((p) => p.col  ?? 0));
        const isArcFiring   = n.triggerEdge !== null && n.triggerEdge !== undefined;
        const isPlaceholder = !!(n.isPlaceholder || n.placeholder || n.isJoinProxy);

        if (isArcFiring) {
            n.time = parentMaxTime + 1;
        } else {
            n.time = parentMaxTime;
        }

        n.col = parentMaxCol + 1;
    }

    return {
        allNodes:     allNodes,
        maximalPaths: Array.from(uniqueMaximalPaths.values()),
        joinTypes:    joinTypes,
    };
}
