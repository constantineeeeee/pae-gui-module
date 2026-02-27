// matrix-mca-bridge.js
// ======================================================================
// Matrix-based Modified Contraction Algorithm (MCA) + MAS Construction
// Bridge module for Biscante Graph/Vertex/Edge integration
//
// This module implements:
//   - Conversion between Biscante Graph model ↔ flat RDLT model
//   - MCA Phase 1: Exhaustive contraction path enumeration (Algorithm 1)
//   - MCA Phase 2: Backward weighting & pruning for MinCS (Algorithm 2)
//   - MAS Construction: Definition 2.2.6 (re-add arcs + cycle L-values)
//
// References:
//   - Amancio (MCA): Modified Contraction Algorithm
//   - Afable (MAS/CAS): Lazy Soundness Verification
// ======================================================================

import { Graph } from '../models/Graph.js';

// ======================================================================
// SECTION 1: FLAT RDLT MODEL (internal representation)
// ======================================================================

function createFlatVertex(vuid, id = '', type = 'c', M = 0) {
    return {
        vuid: String(vuid),
        id: String(id),
        type: String(type),
        M: Number(M),
        role: null,
        isCenter: false
    };
}

function createFlatArc(auid, from, to, C = 'E', L = 0, In = 0, Out = 0) {
    return {
        auid: String(auid),
        from: String(from),
        to: String(to),
        C: String(C),
        L: Number(L),
        In: Number(In),
        Out: Number(Out),
        c: (C === 'E' || C === 'ε' || C === '' || C == null) ? 'E' : String(C),
        l: Number(L),
        inBridge: Number(In) === 1,
        outBridge: Number(Out) === 1
    };
}

function createFlatRDLT(vertices = [], arcs = [], hasRBS = false) {
    return {
        vertices: Array.from(vertices),
        arcs: Array.from(arcs),
        hasRBS: !!hasRBS
    };
}

function cloneFlatRDLT(rdlt) {
    return createFlatRDLT(
        rdlt.vertices.map(v => ({ ...v })),
        rdlt.arcs.map(a => ({ ...a })),
        rdlt.hasRBS
    );
}

// ======================================================================
// SECTION 2: BISCANTE ↔ FLAT CONVERSION
// ======================================================================

/**
 * Convert a Biscante Graph into the flat RDLT format used by matrix MCA.
 *
 * Biscante edges store Vertex objects at .from / .to, constraint strings,
 * and maxTraversals (L-values).  The flat model uses string vuid references.
 *
 * @param {Graph} biscGraph - Biscante Graph object (from EVSA R1 or R2).
 * @returns {{ flatRDLT: Object, vertexLookup: Map, edgeLookup: Map }}
 *   flatRDLT   – the converted graph in flat format
 *   vertexLookup – Map<vuid, BiscVertex> for back-conversion
 *   edgeLookup   – Map<"from->to", BiscEdge> for back-conversion
 */
export function graphToFlat(biscGraph) {
    const vertexLookup = new Map();
    const edgeLookup = new Map();

    // Build vertices – use vertex.id as vuid
    const flatVertices = biscGraph.vertices.map((v, idx) => {
        vertexLookup.set(v.id, v);
        return createFlatVertex(
            v.id,                           // vuid
            v.name || v.id,                 // logical id
            v.type || 'c',                  // type
            0                               // M (RBS center – not needed at this stage)
        );
    });

    // Build arcs – use "from->to" as auid for uniqueness
    const flatArcs = biscGraph.edges.map((e, idx) => {
        const key = `${e.from.id}->${e.to.id}`;
        edgeLookup.set(key, e);

        // Map constraint: Biscante uses '' or a string; flat uses 'E' for epsilon
        const constraint = e.constraint;
        const C = (!constraint || constraint === '' || constraint === 'ε' || constraint === 'epsilon')
            ? 'E'
            : constraint;

        return createFlatArc(
            key,                            // auid
            e.from.id,                      // from vuid
            e.to.id,                        // to vuid
            C,                              // C-attribute
            e.maxTraversals || 0,           // L-value
            0,                              // In-bridge
            0                               // Out-bridge
        );
    });

    const flatRDLT = createFlatRDLT(flatVertices, flatArcs, false);
    return { flatRDLT, vertexLookup, edgeLookup };
}

/**
 * Convert a flat MAS result back into a Biscante Graph.
 *
 * @param {Object} flatMAS - Flat RDLT representing a MAS.
 * @param {Map} vertexLookup - Map<vuid, BiscVertex> from the original conversion.
 * @param {Map} edgeLookup - Map<"from->to", BiscEdge> from the original conversion.
 * @param {Graph} sourceGraph - The original Biscante Graph (R1 or R2) for edge reference.
 * @returns {Graph} A Biscante Graph representing the MAS.
 */
export function flatToGraph(flatMAS, vertexLookup, edgeLookup, sourceGraph) {
    const mas = new Graph();

    // Reconstruct vertices
    const masVertexIds = new Set(flatMAS.vertices.map(v => v.vuid));
    for (const fv of flatMAS.vertices) {
        const biscVertex = vertexLookup.get(fv.vuid);
        if (biscVertex) {
            mas.vertices.push(biscVertex);
        } else {
            // Fallback: vertex was introduced during processing (shouldn't happen normally)
            console.warn(`[MatrixMCA] Vertex ${fv.vuid} not found in lookup – creating placeholder`);
            mas.vertices.push({ id: fv.vuid, name: fv.id, type: fv.type, attributes: {} });
        }
    }

    // Reconstruct edges with proper L-values from the MAS
    for (const fa of flatMAS.arcs) {
        const key = `${fa.from}->${fa.to}`;
        const biscEdge = edgeLookup.get(key);

        if (biscEdge) {
            // Clone the Biscante edge and update L-value from MAS
            const edgeCopy = { ...biscEdge };
            edgeCopy.maxTraversals = fa.l;
            mas.edges.push(edgeCopy);
        } else {
            // Edge exists in flat model but not in original lookup.
            // This can happen when MAS re-adds arcs from the source R_i.
            // Try to find it in the source graph.
            const sourceEdge = sourceGraph?.edges?.find(
                e => e.from.id === fa.from && e.to.id === fa.to
            );
            if (sourceEdge) {
                const edgeCopy = { ...sourceEdge };
                edgeCopy.maxTraversals = fa.l;
                mas.edges.push(edgeCopy);
            } else {
                // Last resort: create a minimal edge-like object
                console.warn(`[MatrixMCA] Edge ${key} not found in lookup or source – creating placeholder`);
                const fromV = vertexLookup.get(fa.from) || { id: fa.from, name: fa.from };
                const toV = vertexLookup.get(fa.to) || { id: fa.to, name: fa.to };
                mas.edges.push({
                    id: fa.auid,
                    from: fromV,
                    to: toV,
                    constraint: fa.c === 'E' ? '' : fa.c,
                    maxTraversals: fa.l
                });
            }
        }
    }

    return mas;
}

// ======================================================================
// SECTION 3: GRAPH UTILITIES
// ======================================================================

function buildAdjacencyList(vertices, arcs) {
    const adj = {};
    vertices.forEach(v => { adj[v.vuid] = []; });
    arcs.forEach(a => {
        if (adj[a.from]) adj[a.from].push(a.to);
    });
    return adj;
}

/**
 * Find all elementary cycles using simplified Johnson-style DFS.
 * Returns array of cycles, each cycle is an array of arc objects.
 */
function findCycles(vertices, arcs) {
    const adj = buildAdjacencyList(vertices, arcs);
    const cycles = [];
    const stack = [];
    const blocked = new Set();

    function dfs(start, v) {
        stack.push(v);
        blocked.add(v);

        for (const w of adj[v] || []) {
            if (w === start) {
                const cycleVertices = [...stack, start];
                cycles.push(verticesToArcs(cycleVertices, arcs));
            } else if (!blocked.has(w)) {
                dfs(start, w);
            }
        }

        stack.pop();
        blocked.delete(v);
    }

    vertices.forEach(v => {
        dfs(v.vuid, v.vuid);
        blocked.clear();
        stack.length = 0;
    });

    return cycles;
}

function verticesToArcs(vertexPath, arcs) {
    const arcList = [];
    for (let i = 0; i < vertexPath.length - 1; i++) {
        const from = vertexPath[i];
        const to = vertexPath[i + 1];
        const arc = arcs.find(a => a.from === from && a.to === to);
        if (arc) arcList.push(arc);
    }
    return arcList;
}

function findSourceAndSink(rdlt) {
    const indeg = new Map();
    const outdeg = new Map();
    rdlt.vertices.forEach(v => { indeg.set(v.vuid, 0); outdeg.set(v.vuid, 0); });
    rdlt.arcs.forEach(a => {
        if (indeg.has(a.to)) indeg.set(a.to, indeg.get(a.to) + 1);
        if (outdeg.has(a.from)) outdeg.set(a.from, outdeg.get(a.from) + 1);
    });

    let source = null, sink = null;
    indeg.forEach((d, v) => { if (d === 0) source = v; });
    outdeg.forEach((d, v) => { if (d === 0) sink = v; });
    return { source, sink };
}

// ======================================================================
// SECTION 4: MCA PHASE 1 — CONTRACTION PATH ENUMERATION
// ======================================================================

/**
 * Build adjacency matrix RV_adj and constraint matrix RV_C from flat RDLT.
 */
function buildMatrices(rdlt) {
    const RV_adj = {};
    const RV_C = {};

    rdlt.vertices.forEach(v => {
        RV_adj[v.vuid] = {};
        RV_C[v.vuid] = {};
        rdlt.vertices.forEach(w => {
            RV_adj[v.vuid][w.vuid] = 0;
            RV_C[v.vuid][w.vuid] = new Set();
        });
    });

    rdlt.arcs.forEach(a => {
        RV_adj[a.from][a.to] += 1;
        const label = a.c === 'E' ? 'ε' : a.c;
        RV_C[a.from][a.to].add(label);
    });

    return { RV_adj, RV_C };
}

function matrixNeighbors(x, RV_adj) {
    return Object.keys(RV_adj[x] || {}).filter(y => RV_adj[x][y] > 0);
}

function matrixIncomingExcept(x, y, RV_adj) {
    return Object.keys(RV_adj).filter(
        u => u !== x && u !== y && RV_adj[u]?.[y] > 0
    );
}

function detectSource(RV_adj) {
    return Object.keys(RV_adj).find(v =>
        Object.values(RV_adj).every(row => (row[v] || 0) === 0)
    );
}

function detectSink(RV_adj) {
    return Object.keys(RV_adj).find(v =>
        Object.values(RV_adj[v] || {}).every(c => c === 0)
    );
}

function hasAbsorbedSink(P, sink) {
    return P[P.length - 1].split('∧').includes(sink);
}

function unionAll(sets) {
    const out = new Set();
    sets.forEach(s => s.forEach(v => out.add(v)));
    return out;
}

function isSuperset(A, B) {
    for (const b of B) if (!A.has(b)) return false;
    return true;
}

function deepCloneAdj(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function deepCloneLabels(C) {
    const out = {};
    for (const u in C) {
        out[u] = {};
        for (const v in C[u]) {
            out[u][v] = new Set(C[u][v]);
        }
    }
    return out;
}

function reachable(start, target, RV_adj) {
    const visited = new Set();
    const stack = [start];
    while (stack.length) {
        const u = stack.pop();
        if (u === target) return true;
        for (const v in RV_adj[u]) {
            if (RV_adj[u][v] > 0 && !visited.has(v)) {
                visited.add(v);
                stack.push(v);
            }
        }
    }
    return false;
}

function updatePathHead(pathHead, y, atomMap, RV_adj) {
    if (!atomMap[y] || atomMap[y].length === 1) return y;
    for (const a of atomMap[y]) {
        if (reachable(pathHead, a, RV_adj)) return a;
    }
    return null;
}

/**
 * Contract vertices x and y into composite vertex z = x∧y.
 * Updates adjacency and constraint matrices.
 *
 * CRITICAL: The adjacency/label patches must iterate over [x, y]
 * (the current matrix keys) to aggregate edges, NOT over atomsZ
 * (the split atomic names). After the first contraction, previous
 * composites like "x1∧x2" replace individual atoms in the matrix.
 * Splitting by ∧ and looking up "x1" or "x2" would return undefined
 * because those keys no longer exist — only "x1∧x2" does.
 *
 * atomsZ is still computed for the final output (tracking which
 * original vertices are in the composite), but never used for
 * matrix lookups.
 */
function contract(x, y, RV_adj, RV_C) {
    const z = `${x}∧${y}`;

    // atomsZ tracks original vertex membership (for output only)
    const atomsX = x.split('∧');
    const atomsY = y.split('∧');
    const atomsZ = [...new Set([...atomsX, ...atomsY])];

    // mergeSources = the actual current keys in the matrix
    const mergeSources = [x, y];

    const oldV = Object.keys(RV_adj);
    const V = oldV.filter(v => v !== x && v !== y);
    V.push(z);

    const RV_adj2 = {};
    const RV_C2 = {};

    V.forEach(v => {
        RV_adj2[v] = {};
        RV_C2[v] = {};
        V.forEach(w => {
            RV_adj2[v][w] = 0;
            RV_C2[v][w] = new Set();
        });
    });

    // Copy unaffected edges (between non-merged vertices)
    for (const u of V) {
        for (const w of V) {
            if (u === z || w === z) continue;
            RV_adj2[u][w] = RV_adj[u]?.[w] ?? 0;
            RV_C2[u][w] = new Set(RV_C[u]?.[w] ?? []);
        }
    }

    // Adjacency patch for composite vertex z
    // Uses mergeSources [x, y] — the CURRENT matrix keys
    for (const w of V) {
        if (w === z) continue;  // skip self-loops
        let outSum = 0, inSum = 0;
        for (const u of mergeSources) {
            outSum += RV_adj[u]?.[w] ?? 0;
            inSum += RV_adj[w]?.[u] ?? 0;
        }
        RV_adj2[z][w] = outSum;
        RV_adj2[w][z] = inSum;
    }

    // Label patch for composite vertex z
    for (const w of V) {
        if (w === z) continue;  // skip self-loops
        const outLabels = new Set();
        const inLabels = new Set();
        for (const u of mergeSources) {
            (RV_C[u]?.[w] ?? []).forEach(c => outLabels.add(c));
            (RV_C[w]?.[u] ?? []).forEach(c => inLabels.add(c));
        }
        RV_C2[z][w] = outLabels;
        RV_C2[w][z] = inLabels;
    }

    return { RV_adj: RV_adj2, RV_C: RV_C2, z };
}

/**
 * Exhaustive recursive enumeration of all valid contraction paths.
 * Implements Algorithm 1 from Amancio's MCA.
 */
function tryContractAll(RV_adj, RV_C, x, sink, P, steps, pathHead, atomMap) {
    const results = [];

    // Termination: sink has been absorbed
    if (hasAbsorbedSink(P, sink)) {
        results.push({ P: [...P], steps: [...steps] });
        return results;
    }

    // Candidate neighbors of x
    const rawNeighbors = matrixNeighbors(x, RV_adj);
    const Y = rawNeighbors.filter(y => reachable(pathHead, y, RV_adj));

    for (const y of Y) {
        // Clone state
        const adjCopy = deepCloneAdj(RV_adj);
        const CCopy = deepCloneLabels(RV_C);
        const PCopy = [...P];
        const stepsCopy = [...steps];
        const atomMapCopy = structuredClone(atomMap);

        // Competing parents
        const U = matrixIncomingExcept(x, y, adjCopy);

        // Join feasibility check (Algorithm 1)
        const LHS = new Set([
            ...(CCopy[x]?.[y] ?? []),
            'ε'
        ]);
        const RHS = unionAll(
            U.map(u => CCopy[u]?.[y] ?? new Set())
        );

        if (!isSuperset(LHS, RHS)) {
            continue; // Join rejected
        }

        // Reset competing incoming labels
        U.forEach(u => { CCopy[u][y] = new Set(['ε']); });

        // Perform contraction
        const { RV_adj: newAdj, RV_C: newC, z } = contract(x, y, adjCopy, CCopy);

        // Update atom map
        atomMapCopy[z] = [
            ...(atomMap[x] ?? [x]),
            ...(atomMap[y] ?? [y])
        ];

        // Update path head
        let newPathHead = updatePathHead(pathHead, y, atomMapCopy, adjCopy);
        if (!newPathHead) continue;
        if (atomMapCopy[z]?.includes(newPathHead)) newPathHead = z;

        // Record
        PCopy.push(z);
        stepsCopy.push({ from: x, with: y, result: z });

        // Recurse
        const subResults = tryContractAll(
            newAdj, newC, z, sink, PCopy, stepsCopy, newPathHead, atomMapCopy
        );
        results.push(...subResults);
    }

    return results;
}

/**
 * Generate all contraction paths for a flat RDLT.
 * Returns array of { atomicVertices, contractionSequence, steps }.
 */
function generateContractionPaths(flatRDLT) {
    const { RV_adj, RV_C } = buildMatrices(flatRDLT);
    const source = detectSource(RV_adj);
    const sink = detectSink(RV_adj);

    if (!source || !sink) {
        console.warn('[MatrixMCA] No source or sink detected');
        return [];
    }

    console.log(`[MatrixMCA] Phase 1: source=${source}, sink=${sink}`);

    const atomMap = {};
    flatRDLT.vertices.forEach(v => { atomMap[v.vuid] = [v.vuid]; });

    const results = tryContractAll(
        RV_adj, RV_C, source, sink, [source], [], source, atomMap
    );

    console.log(`[MatrixMCA] Phase 1: Found ${results.length} contraction path(s)`);

    return results.map(r => {
        const finalMerged = r.P[r.P.length - 1];
        const atomicVertices = finalMerged.split('∧');
        return {
            atomicVertices,
            contractionSequence: r.P,
            steps: r.steps
        };
    });
}

// ======================================================================
// SECTION 5: MCA PHASE 2 — MINIMIZATION (backward weighting + pruning)
// ======================================================================

/**
 * Induce R_min from R_i using the atomic vertices of a contraction path.
 */
function induceRmin(flatRDLT, atomicVertices) {
    const atomSet = new Set(atomicVertices);
    return {
        vertices: flatRDLT.vertices.filter(v => atomSet.has(v.vuid)),
        arcs: flatRDLT.arcs.filter(a => atomSet.has(a.from) && atomSet.has(a.to)),
        hasRBS: flatRDLT.hasRBS
    };
}

function buildAdjMatrix(Rmin) {
    const RV_adj = {};
    for (const v of Rmin.vertices) {
        RV_adj[v.vuid] = {};
        for (const w of Rmin.vertices) {
            RV_adj[v.vuid][w.vuid] = 0;
        }
    }
    for (const arc of Rmin.arcs) {
        RV_adj[arc.from][arc.to] += 1;
    }
    return RV_adj;
}

function buildCMatrix(Rmin) {
    const RV_C = {};
    for (const v of Rmin.vertices) {
        RV_C[v.vuid] = {};
        for (const w of Rmin.vertices) {
            RV_C[v.vuid][w.vuid] = new Set();
        }
    }
    for (const arc of Rmin.arcs) {
        const label = arc.c === 'E' ? 'ε' : arc.c;
        RV_C[arc.from][arc.to].add(label);
    }
    return RV_C;
}

function initWeightMatrix(Rmin) {
    const W = {};
    for (const v of Rmin.vertices) {
        W[v.vuid] = {};
        for (const w of Rmin.vertices) {
            W[v.vuid][w.vuid] = 0;
        }
    }
    return W;
}

function findRminSource(Rmin) {
    const inCount = {};
    Rmin.vertices.forEach(v => { inCount[v.vuid] = 0; });
    Rmin.arcs.forEach(a => { inCount[a.to] += 1; });
    return Object.keys(inCount).find(v => inCount[v] === 0);
}

function findMergePoints(RV_adj) {
    const mp = new Set();
    for (const from in RV_adj) {
        for (const to in RV_adj[from]) {
            if (RV_adj[from][to] > 0) mp.add(to);
        }
    }
    return Array.from(mp);
}

function dfsPath(RV_adj, source, target) {
    const visited = new Set();
    const path = [];

    function dfs(u) {
        visited.add(u);
        path.push(u);
        if (u === target) return true;
        for (const v in RV_adj[u]) {
            if (RV_adj[u][v] > 0 && !visited.has(v)) {
                if (dfs(v)) return true;
            }
        }
        path.pop();
        return false;
    }

    return dfs(source) ? [...path] : null;
}

function incomingVertices(v, RV_adj) {
    const incoming = [];
    for (const u in RV_adj) {
        if (RV_adj[u][v] > 0) incoming.push(u);
    }
    return incoming;
}

/**
 * Backward traversal and constraint-sensitive weighting (Algorithm 2).
 */
function applyBackwardWeighting(RV_adj, RV_C, W, source, mergePoints) {
    const visitedMP = new Set();

    for (const y of mergePoints) {
        const Q = dfsPath(RV_adj, source, y);
        if (!Q || Q.length < 2) continue;

        for (let j = Q.length - 1; j >= 1; j--) {
            const v = Q[j];
            const u = Q[j - 1];

            const distinct = new Set(RV_C[u][v]);
            W[u][v] += 1;

            const incoming = incomingVertices(v, RV_adj);
            for (const k of incoming) {
                if (k === u) continue;
                const labels = RV_C[k][v];
                let contributes = false;
                for (const c of labels) {
                    if (!distinct.has(c)) {
                        contributes = true;
                        distinct.add(c);
                    }
                }
                if (contributes) W[k][v] += 1;
            }

            visitedMP.add(v);
            if (u === source || visitedMP.has(u)) break;
        }
    }
}

/**
 * Source-sink reachability cleanup for R_min.
 *
 * The exhaustive contraction enumeration in Phase 1 can absorb vertices
 * that become dead ends in the induced R_min (e.g. OR-split branches
 * absorbed early but whose outgoing targets are not in the atomic set).
 *
 * Amancio's Phase 2 backward weighting (Algorithm 4) assigns positive
 * weight to these dead-end arcs because its merge-point definition
 * (Line 5: "any vertex with in-degree ≥ 1") treats them as valid
 * targets. This is correct for single deterministic contraction but
 * produces dangling branches under exhaustive enumeration.
 *
 * This cleanup removes vertices/arcs not on any real source→sink path:
 *   1. Forward pass: vertices reachable from the REAL source
 *   2. Backward pass: vertices that can reach the REAL sink
 *   3. Intersection: vertices on an actual source→sink path
 *
 * IMPORTANT: Uses the known global source and sink of the RDLT, NOT
 * the topological source/sink of the pruned R_min. After Phase 2
 * pruning, fragments like {x1, x6} with one arc would have x6 as
 * their topological "sink" — but x6 is not the real sink (x14 is).
 * Using the real sink ensures these fragments are correctly identified
 * as disconnected.
 *
 * @param {Object} Rmin - Flat RDLT { vertices, arcs }
 * @param {string} realSourceId - The vuid of the RDLT's real source vertex.
 * @param {string} realSinkId - The vuid of the RDLT's real sink vertex.
 * @returns {Object|null} Cleaned { vertices, arcs } or null if disconnected.
 */
function reachabilityCleanup(Rmin, realSourceId, realSinkId) {
    if (Rmin.arcs.length === 0) return null;

    // Verify the real source and sink are in this R_min
    const hasSource = Rmin.vertices.some(v => v.vuid === realSourceId);
    const hasSink = Rmin.vertices.some(v => v.vuid === realSinkId);
    if (!hasSource || !hasSink) {
        console.log(`[MatrixMCA] Reachability cleanup: missing source or sink — discarding`);
        return null;
    }

    // Forward BFS from real source
    const forwardAdj = {};
    Rmin.vertices.forEach(v => { forwardAdj[v.vuid] = []; });
    Rmin.arcs.forEach(a => { forwardAdj[a.from]?.push(a.to); });

    const forwardReachable = new Set();
    const fQueue = [realSourceId];
    forwardReachable.add(realSourceId);
    while (fQueue.length) {
        const u = fQueue.shift();
        for (const w of forwardAdj[u] || []) {
            if (!forwardReachable.has(w)) {
                forwardReachable.add(w);
                fQueue.push(w);
            }
        }
    }

    // If the real sink isn't reachable from source, this MinCS is disconnected
    if (!forwardReachable.has(realSinkId)) {
        console.log(`[MatrixMCA] Reachability cleanup: sink ${realSinkId} unreachable from source — discarding`);
        return null;
    }

    // Backward BFS from real sink
    const backwardAdj = {};
    Rmin.vertices.forEach(v => { backwardAdj[v.vuid] = []; });
    Rmin.arcs.forEach(a => { backwardAdj[a.to]?.push(a.from); });

    const backwardReachable = new Set();
    const bQueue = [realSinkId];
    backwardReachable.add(realSinkId);
    while (bQueue.length) {
        const u = bQueue.shift();
        for (const w of backwardAdj[u] || []) {
            if (!backwardReachable.has(w)) {
                backwardReachable.add(w);
                bQueue.push(w);
            }
        }
    }

    // Intersection: vertices on a real source→sink path
    const onPath = new Set(
        [...forwardReachable].filter(v => backwardReachable.has(v))
    );

    const cleanedVertices = Rmin.vertices.filter(v => onPath.has(v.vuid));
    const cleanedArcs = Rmin.arcs.filter(a => onPath.has(a.from) && onPath.has(a.to));

    const removed = Rmin.vertices.length - cleanedVertices.length;
    if (removed > 0) {
        console.log(`[MatrixMCA] Reachability cleanup: removed ${removed} dead-end vertex(es)`);
    }

    return { vertices: cleanedVertices, arcs: cleanedArcs, hasRBS: Rmin.hasRBS };
}

/**
 * Run MCA Phase 2 for a single contraction path → produces a MinCS.
 * Returns null if the MinCS is degenerate (disconnected from real sink).
 *
 * @param {Object} flatRDLT - The full flat RDLT.
 * @param {Object} contractionPath - { atomicVertices, contractionSequence, steps }
 * @param {string} realSourceId - The vuid of the RDLT's real source vertex.
 * @param {string} realSinkId - The vuid of the RDLT's real sink vertex.
 * @returns {Object|null} MinCS or null if degenerate.
 */
function runMCAPhase2(flatRDLT, contractionPath, realSourceId, realSinkId) {
    const { atomicVertices } = contractionPath;
    const Rmin = induceRmin(flatRDLT, atomicVertices);
    const RV_adj = buildAdjMatrix(Rmin);
    const RV_C = buildCMatrix(Rmin);
    const W = initWeightMatrix(Rmin);

    const mergePoints = findMergePoints(RV_adj);
    const source = findRminSource(Rmin);

    if (source) {
        applyBackwardWeighting(RV_adj, RV_C, W, source, mergePoints);
    }

    // Prune zero-weight arcs
    Rmin.arcs = Rmin.arcs.filter(a => W[a.from]?.[a.to] > 0);

    // Reachability cleanup: remove dead-end vertices/arcs that were
    // absorbed during exhaustive contraction but don't participate
    // in any source→sink path within the induced R_min.
    // Uses the REAL source/sink of the RDLT, not topological detection.
    const cleaned = reachabilityCleanup(Rmin, realSourceId, realSinkId);

    // If cleanup returned null, this MinCS is degenerate (disconnected)
    if (!cleaned) {
        console.log(`[MatrixMCA] Phase 2: MinCS discarded (degenerate after cleanup)`);
        return null;
    }

    console.log(`[MatrixMCA] Phase 2: MinCS has ${cleaned.vertices.length} vertices, ${cleaned.arcs.length} arcs`);

    return {
        vertices: cleaned.vertices,
        arcs: cleaned.arcs,
        _sourceRDLT: flatRDLT
    };
}

// ======================================================================
// SECTION 6: MAS CONSTRUCTION (Definition 2.2.6)
// ======================================================================

/**
 * Build a base MAS from a MinCS per Definition 8 (Afable/MinCS paper).
 *
 * Definition 8: A MAS is a projection of R_i induced by the components
 * of its MinCS R_min AND every looping arc (x,y) of R_i where x and y
 * are vertices found in R_min.
 *
 * "Looping arc" = an arc that participates in a cycle within the
 * subgraph of R_i restricted to MinCS vertices.
 *
 * L-values per Definition 8:
 *   L(x',y') = 1        if (x',y') appears in R_min AND (x,y) is NOT
 *                        part of a cycle
 *   L(x',y') = L(x,y)   otherwise (cycle arcs keep original L)
 *
 * @param {Object} minCS - { vertices, arcs, _sourceRDLT }
 * @returns {Object} Flat RDLT for the base MAS.
 */
function constructBaseMAS(minCS) {
    const Vset = new Set(minCS.vertices.map(v => v.vuid));
    const sourceRDLT = minCS._sourceRDLT;

    // Collect ALL arcs from R_i between MinCS vertices
    const allCandidateArcs = [];
    if (sourceRDLT?.arcs) {
        for (const a of sourceRDLT.arcs) {
            if (Vset.has(a.from) && Vset.has(a.to)) {
                allCandidateArcs.push({ ...a });
            }
        }
    }

    // Also include MinCS arcs (some might not be in source R_i if they
    // were created during contraction, though typically they are)
    const arcKey = a => `${a.from}->${a.to}:${a.c}`;
    const candidateKeys = new Set(allCandidateArcs.map(arcKey));
    for (const a of minCS.arcs) {
        const key = arcKey(a);
        if (!candidateKeys.has(key)) {
            allCandidateArcs.push({ ...a });
            candidateKeys.add(key);
        }
    }

    // Detect cycles among all candidate arcs
    const masVertices = minCS.vertices.map(v => ({ ...v }));
    const cycleEdgeKeys = findCycleEdgeKeys(masVertices, allCandidateArcs);

    // Build MAS arc set: MinCS arcs + looping (cycle) arcs
    const minCSArcKeys = new Set(minCS.arcs.map(arcKey));
    const masArcs = [];
    const addedKeys = new Set();

    for (const a of allCandidateArcs) {
        const key = arcKey(a);
        if (addedKeys.has(key)) continue;

        const inMinCS = minCSArcKeys.has(key);
        const isCycleArc = cycleEdgeKeys.has(`${a.from}->${a.to}`);

        if (inMinCS || isCycleArc) {
            addedKeys.add(key);
            const arcCopy = { ...a };

            // Apply Definition 8 L-values
            if (inMinCS && !isCycleArc) {
                // In MinCS and NOT a cycle → L = 1
                arcCopy.l = 1;
                arcCopy.L = 1;
            }
            // else: cycle arc (whether in MinCS or not) → keep original L

            masArcs.push(arcCopy);
        }
    }

    return createFlatRDLT(masVertices, masArcs, sourceRDLT?.hasRBS || false);
}

/**
 * Find all edges that participate in at least one cycle.
 * Returns a Set of "from->to" keys for cycle-participating arcs.
 *
 * Uses Johnson-style DFS to detect back edges.
 */
function findCycleEdgeKeys(vertices, arcs) {
    const cycleKeys = new Set();

    // Build adjacency
    const adj = {};
    vertices.forEach(v => { adj[v.vuid] = []; });
    arcs.forEach(a => { adj[a.from]?.push(a.to); });

    // DFS-based cycle detection: for each vertex, find if it's on a cycle
    // by checking if any descendant can reach back to it
    const vids = vertices.map(v => v.vuid);
    const reachableFrom = {};

    for (const startV of vids) {
        // BFS/DFS from startV to see which vertices are reachable
        const visited = new Set();
        const stack = [startV];
        visited.add(startV);
        while (stack.length) {
            const u = stack.pop();
            for (const w of adj[u] || []) {
                if (!visited.has(w)) {
                    visited.add(w);
                    stack.push(w);
                }
            }
        }
        reachableFrom[startV] = visited;
    }

    // An arc (u, v) is on a cycle if v can reach u
    for (const a of arcs) {
        if (reachableFrom[a.to]?.has(a.from)) {
            cycleKeys.add(`${a.from}->${a.to}`);
        }
    }

    return cycleKeys;
}

/**
 * Apply Definition 8 L-value assignment for an EXPANDED MAS
 * (which includes cycle-completing paths through outside vertices).
 *
 * All cycle arcs keep original L. Non-cycle MinCS arcs get L=1.
 * Non-cycle non-MinCS arcs are removed.
 *
 * @param {Array} masVertices - Vertex array for the MAS.
 * @param {Array} masArcs - Arc array for the MAS.
 * @param {Object} minCS - The MinCS { vertices, arcs, _sourceRDLT }.
 * @returns {Object} Flat RDLT with correct L-values.
 */
function applyExpandedMASLValues(masVertices, masArcs, minCS) {
    // Detect cycles in the expanded MAS
    const cycleKeys = findCycleEdgeKeys(masVertices, masArcs);

    const minCSArcKeys = new Set(
        minCS.arcs.map(a => `${a.from}->${a.to}:${a.c}`)
    );

    for (const a of masArcs) {
        const isCycle = cycleKeys.has(`${a.from}->${a.to}`);
        const inMinCS = minCSArcKeys.has(`${a.from}->${a.to}:${a.c}`);

        if (!isCycle && inMinCS) {
            // Non-cycle MinCS arc → L = 1
            a.l = 1;
            a.L = 1;
        } else if (!isCycle && !inMinCS) {
            // Non-cycle, non-MinCS arc → should not be in MAS
            a.l = 0;
            a.L = 0;
        }
        // else: cycle arc → keep original L
    }

    const filteredArcs = masArcs.filter(a => a.l > 0);
    return createFlatRDLT(masVertices, filteredArcs, minCS._sourceRDLT?.hasRBS || false);
}

/**
 * Search for cycle-completing paths that travel through vertices
 * OUTSIDE the MinCS.
 *
 * A cycle-completing path starts at a MinCS vertex, exits to a
 * non-MinCS vertex, travels exclusively through non-MinCS vertices,
 * and arrives back at a (different) MinCS vertex — where a path
 * from the return vertex back to the departure vertex exists within
 * the MinCS, confirming a genuine backward cycle.
 *
 * Example: MinCS = {x1..x10, x11, x14}, source R_i has x10→x12→x13→x8.
 *   x10 is in MinCS, x12 and x13 are NOT.
 *   Path x10→x12→x13→x8 exits at x10, returns at x8.
 *   Within MinCS: x8→x9→x10 exists → genuine cycle confirmed.
 *
 * @param {Object} minCS - { vertices, arcs, _sourceRDLT }
 * @returns {Array<Array<Object>>} Array of arc-path arrays.
 */
function findCycleCompletionPathsFlat(minCS) {
    const sourceRDLT = minCS._sourceRDLT;
    if (!sourceRDLT?.arcs || !sourceRDLT?.vertices) return [];

    const minCSVertexIds = new Set(minCS.vertices.map(v => v.vuid));
    const found = [];
    const seenPathKeys = new Set();

    // Build adjacency for the source R_i (full graph)
    const fullAdj = {};
    sourceRDLT.vertices.forEach(v => { fullAdj[v.vuid] = []; });
    sourceRDLT.arcs.forEach(a => { fullAdj[a.from]?.push(a); });

    // Build adjacency for the MinCS subgraph (for reachability checks)
    const minCSAdj = {};
    minCS.vertices.forEach(v => { minCSAdj[v.vuid] = []; });
    minCS.arcs.forEach(a => {
        if (minCSAdj[a.from]) minCSAdj[a.from].push(a.to);
    });
    // Also include re-added arcs from source restricted to MinCS
    if (sourceRDLT.arcs) {
        for (const a of sourceRDLT.arcs) {
            if (minCSVertexIds.has(a.from) && minCSVertexIds.has(a.to)) {
                if (minCSAdj[a.from] && !minCSAdj[a.from].includes(a.to)) {
                    minCSAdj[a.from].push(a.to);
                }
            }
        }
    }

    /**
     * Check if target is reachable from start within the MinCS subgraph.
     */
    function reachableInMinCS(start, target) {
        if (start === target) return true;
        const visited = new Set();
        const stack = [start];
        while (stack.length) {
            const u = stack.pop();
            if (u === target) return true;
            if (visited.has(u)) continue;
            visited.add(u);
            for (const w of minCSAdj[u] || []) {
                if (!visited.has(w)) stack.push(w);
            }
        }
        return false;
    }

    /**
     * DFS through non-MinCS vertices, looking for a return to MinCS.
     */
    function dfsOutside(current, pathArcs, visitedInPath) {
        const results = [];
        for (const arc of fullAdj[current] || []) {
            // Reached a MinCS vertex → cycle completion candidate
            if (minCSVertexIds.has(arc.to)) {
                results.push([...pathArcs, arc]);
                continue;
            }

            // Continue through non-MinCS vertices only
            if (!visitedInPath.has(arc.to)) {
                visitedInPath.add(arc.to);
                const sub = dfsOutside(arc.to, [...pathArcs, arc], visitedInPath);
                results.push(...sub);
                visitedInPath.delete(arc.to);
            }
        }
        return results;
    }

    // For each MinCS vertex, look for edges going to non-MinCS vertices
    for (const startV of minCS.vertices) {
        const outgoingToOutside = (fullAdj[startV.vuid] || []).filter(
            arc => !minCSVertexIds.has(arc.to)
        );

        for (const firstArc of outgoingToOutside) {
            const visitedInPath = new Set([startV.vuid, firstArc.to]);
            const candidatePaths = dfsOutside(
                firstArc.to,
                [firstArc],
                visitedInPath
            );

            for (const pathArcs of candidatePaths) {
                const returnTarget = pathArcs[pathArcs.length - 1].to;

                // Confirm genuine backward cycle: returnTarget must reach
                // startV within the MinCS subgraph
                if (reachableInMinCS(returnTarget, startV.vuid)) {
                    const pathKey = pathArcs.map(a => `${a.from}->${a.to}`).join('|');
                    if (!seenPathKeys.has(pathKey)) {
                        seenPathKeys.add(pathKey);
                        found.push(pathArcs);
                    }
                }
            }
        }
    }

    return found;
}

/**
 * Construct all MAS variants from a single MinCS:
 *   1. Base MAS — looping arcs only where both endpoints are in MinCS.
 *   2. Expanded MAS (if cycle-completing paths exist through outside
 *      vertices) — base + outside-vertex cycle paths and their arcs.
 *
 * @param {Object} minCS - { vertices, arcs, _sourceRDLT }
 * @returns {Array<Object>} One or two flat RDLTs representing MAS.
 */
function constructMASVariants(minCS) {
    // ---- Build the BASE MAS ----
    const baseMAS = constructBaseMAS(minCS);

    // ---- Find cycle-completing paths through outside vertices ----
    const cycleCompletionPaths = findCycleCompletionPathsFlat(minCS);

    if (cycleCompletionPaths.length === 0) {
        console.log(`[MatrixMCA]   No cycle-completing paths — 1 MAS variant`);
        return [baseMAS];
    }

    console.log(`[MatrixMCA]   Found ${cycleCompletionPaths.length} cycle-completing path(s) — 2 MAS variants`);

    // ---- Build the EXPANDED MAS ----
    // Start from the MinCS and pull in every cycle-completing path
    const expandedVertices = minCS.vertices.map(v => ({ ...v }));
    const expandedArcs = minCS.arcs.map(a => ({ ...a }));
    const vertexIds = new Set(minCS.vertices.map(v => v.vuid));
    const arcKeys = new Set(minCS.arcs.map(a => `${a.from}->${a.to}:${a.c}`));

    // Also re-add arcs from source R_i between existing MinCS vertices
    if (minCS._sourceRDLT?.arcs) {
        for (const a of minCS._sourceRDLT.arcs) {
            if (vertexIds.has(a.from) && vertexIds.has(a.to)) {
                const key = `${a.from}->${a.to}:${a.c}`;
                if (!arcKeys.has(key)) {
                    arcKeys.add(key);
                    expandedArcs.push({ ...a });
                }
            }
        }
    }

    // Pull in outside vertices and arcs from cycle-completing paths
    for (const pathArcs of cycleCompletionPaths) {
        for (const arc of pathArcs) {
            const key = `${arc.from}->${arc.to}:${arc.c}`;
            if (!arcKeys.has(key)) {
                arcKeys.add(key);
                expandedArcs.push({ ...arc });
            }

            // Add outside vertices
            if (!vertexIds.has(arc.from)) {
                vertexIds.add(arc.from);
                const srcVertex = minCS._sourceRDLT?.vertices?.find(v => v.vuid === arc.from);
                expandedVertices.push(srcVertex ? { ...srcVertex } : createFlatVertex(arc.from, arc.from));
            }
            if (!vertexIds.has(arc.to)) {
                vertexIds.add(arc.to);
                const srcVertex = minCS._sourceRDLT?.vertices?.find(v => v.vuid === arc.to);
                expandedVertices.push(srcVertex ? { ...srcVertex } : createFlatVertex(arc.to, arc.to));
            }
        }
    }

    // Apply Definition 8 L-values to the expanded MAS (keep ALL cycle arcs)
    const expandedMAS = applyExpandedMASLValues(expandedVertices, expandedArcs, minCS);

    return [baseMAS, expandedMAS];
}

/**
 * Generate all MAS from a list of MinCS results.
 * Each MinCS can produce 1 or 2 MAS variants (base + expanded if cycles exist).
 */
function generateMaximalStructures(minimalStructures) {
    if (!Array.isArray(minimalStructures) || minimalStructures.length === 0) {
        console.warn('[MatrixMCA] No minimal structures to generate MAS from');
        return [];
    }
    console.log(`[MatrixMCA] Generating MAS from ${minimalStructures.length} MinCS`);

    const allMAS = [];
    for (const mincs of minimalStructures) {
        const variants = constructMASVariants(mincs);
        allMAS.push(...variants);
    }

    console.log(`[MatrixMCA] Total MAS produced: ${allMAS.length}`);
    return allMAS;
}

// ======================================================================
// SECTION 7: PUBLIC API — Full Pipeline
// ======================================================================

/**
 * Run the complete matrix-based MCA + MAS pipeline on a Biscante Graph.
 *
 * This is the primary entry point. Given a Biscante Graph (R1 or R2 from EVSA),
 * it produces an array of MAS as Biscante Graph objects — drop-in compatible
 * with what MASExtractor.extractAllMAS() previously returned.
 *
 * @param {Graph} biscGraph - Biscante Graph (vertex-simplified R1 or R2).
 * @param {Vertex} source - Source vertex.
 * @param {Vertex} sink - Sink vertex.
 * @returns {Array<Graph>} Array of MAS, each as a Biscante Graph.
 */
export function extractMASviaMatrixMCA(biscGraph, source, sink) {
    console.log(`[MatrixMCA] === Starting Matrix MCA Pipeline ===`);
    console.log(`[MatrixMCA] Source: ${source.id}, Sink: ${sink.id}`);
    console.log(`[MatrixMCA] Graph: ${biscGraph.vertices.length} vertices, ${biscGraph.edges.length} edges`);

    // Step 1: Convert to flat model
    const { flatRDLT, vertexLookup, edgeLookup } = graphToFlat(biscGraph);

    console.log(`[MatrixMCA] Flat model: ${flatRDLT.vertices.length} vertices, ${flatRDLT.arcs.length} arcs`);

    // Step 2: MCA Phase 1 — enumerate all contraction paths
    const contractionPaths = generateContractionPaths(flatRDLT);

    if (contractionPaths.length === 0) {
        console.warn('[MatrixMCA] No contraction paths found — returning empty MAS set');
        return [];
    }

    // Step 3: MCA Phase 2 — produce MinCS for each contraction path
    // Pass the real source/sink IDs so reachability cleanup uses them
    // instead of topological detection (which fails on disconnected fragments).
    const realSourceId = source.id;
    const realSinkId = sink.id;

    const minimalStructures = contractionPaths
        .map(path => runMCAPhase2(flatRDLT, path, realSourceId, realSinkId))
        .filter(mincs => mincs !== null);  // Discard degenerate MinCS

    // Deduplicate MinCS by vertex+arc signature
    const seenMinCS = new Set();
    const uniqueMinCS = minimalStructures.filter(mincs => {
        const key = getMinCSKey(mincs);
        if (seenMinCS.has(key)) return false;
        seenMinCS.add(key);
        return true;
    });

    console.log(`[MatrixMCA] Unique MinCS: ${uniqueMinCS.length} (from ${minimalStructures.length} total)`);

    // Step 4: MAS Construction — expand each MinCS into a MAS
    const flatMASList = generateMaximalStructures(uniqueMinCS);

    // Deduplicate MAS
    const seenMAS = new Set();
    const uniqueFlatMAS = flatMASList.filter(mas => {
        const key = getFlatStructureKey(mas);
        if (seenMAS.has(key)) return false;
        seenMAS.add(key);
        return true;
    });

    console.log(`[MatrixMCA] Unique MAS: ${uniqueFlatMAS.length}`);

    // Step 5: Convert back to Biscante Graph objects
    const biscanteMAS = uniqueFlatMAS.map(flatMAS =>
        flatToGraph(flatMAS, vertexLookup, edgeLookup, biscGraph)
    );

    console.log(`[MatrixMCA] === Pipeline Complete: ${biscanteMAS.length} MAS ===`);
    return biscanteMAS;
}

// ======================================================================
// SECTION 8: UTILITY HELPERS
// ======================================================================

function getMinCSKey(mincs) {
    const vids = mincs.vertices.map(v => v.vuid).sort().join(',');
    const aids = mincs.arcs.map(a => `${a.from}->${a.to}`).sort().join('|');
    return `V:[${vids}]A:[${aids}]`;
}

function getFlatStructureKey(flatRDLT) {
    const vids = flatRDLT.vertices.map(v => v.vuid).sort().join(',');
    const aids = flatRDLT.arcs.map(a => `${a.from}->${a.to}`).sort().join('|');
    return `V:[${vids}]A:[${aids}]`;
}

/**
 * Get a structure key compatible with the format used by CASExtractor.
 * Works with both Biscante Graph objects and plain {vertices, edges} objects.
 */
export function getStructureKey(structure) {
    const vertexIds = (structure.vertices || [])
        .map(v => v.id || v.vuid)
        .sort()
        .join(',');
    const edgeIds = (structure.edges || [])
        .map(e => {
            const fromId = e.from?.id || e.from;
            const toId = e.to?.id || e.to;
            return `${fromId}->${toId}`;
        })
        .sort()
        .join('|');
    return `V:[${vertexIds}]E:[${edgeIds}]`;
}