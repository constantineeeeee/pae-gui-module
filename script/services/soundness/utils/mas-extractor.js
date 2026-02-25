import { Graph } from "../models/Graph.js";

/**
 * Utility class for extracting Maximal Activity Structures (MAS) from RDLTs.
 * Based on Definition 2.2.6 from the paper.
 */
export class MASExtractor {
    /**
     * Extracts all Maximal Activity Structures from a vertex-simplified RDLT.
     * For each MinCS, this produces:
     *   - A base MAS (looping arcs only where both endpoints are already in MinCS).
     *   - An expanded MAS (if cycle-completing paths through outside vertices exist),
     *     which pulls those outside-vertex cycle paths and their looping arcs in.
     *
     * @param {Graph} rdlt - The vertex-simplified RDLT (R1 or R2).
     * @param {Vertex} source - The source vertex.
     * @param {Vertex} sink - The sink vertex.
     * @returns {Array<Graph>} Array of MAS (each is a Graph object).
     */
    static extractAllMAS(rdlt, source, sink) {
        console.log(`=== MAS EXTRACTOR DEBUG ===`);
        console.log(`Extracting MAS from RDLT with source ${source.id} and sink ${sink.id}`);
        console.log("RDLT vertices:", rdlt?.vertices?.map(v => v.id));
        console.log("RDLT edges:", rdlt?.edges?.map(e => `${e.from.id}→${e.to.id}`));

        const allMAS = [];

        // Step 1: Get the MinCS (Minimal Contraction Structure) for each path
        const minimalStructures = this.extractMinimalContractionStructures(rdlt, source, sink);
        console.log(`Found ${minimalStructures.length} minimal contraction structures`);

        // Step 2: For each MinCS, create MAS variants (base + expanded if applicable)
        for (const minCS of minimalStructures) {
            const masVariants = this.createMASVariantsFromMinCS(rdlt, minCS);
            for (const mas of masVariants) {
                allMAS.push(mas);
            }
        }

        console.log(`Extracted ${allMAS.length} MAS total`);
        console.log("=========================");
        return allMAS;
    }

    /**
     * Extracts minimal contraction structures (MinCS) from the RDLT.
     * @param {Graph} rdlt - The RDLT graph.
     * @param {Vertex} source - The source vertex.
     * @param {Vertex} sink - The sink vertex.
     * @returns {Array<Object>} Array of minimal structures {vertices, edges}.
     */
    static extractMinimalContractionStructures(rdlt, source, sink) {
        console.log("=== EXTRACTING MINIMAL CONTRACTION STRUCTURES ===");
        console.log("Source:", source.id, source);
        console.log("Sink:", sink.id, sink);
        console.log("All vertices:", rdlt.vertices.map(v => ({ id: v.id, name: v.name })));
        console.log("All edges:", rdlt.edges.map(e => ({
            from: e.from.id,
            to: e.to.id,
            fromObj: e.from,
            toObj: e.to
        })));

        const minimalStructures = [];
        const visited = new Set();

        const sourceVertex = rdlt.vertices.find(v => v.id === source.id);
        if (!sourceVertex) {
            console.error("❌ Source vertex not found in graph vertices!");
            console.log("Looking for ID:", source.id);
            console.log("Available IDs:", rdlt.vertices.map(v => v.id));
            return [];
        }

        const sinkVertex = rdlt.vertices.find(v => v.id === sink.id);
        if (!sinkVertex) {
            console.error("❌ Sink vertex not found in graph vertices!");
            console.log("Looking for ID:", sink.id);
            console.log("Available IDs:", rdlt.vertices.map(v => v.id));
            return [];
        }

        console.log("✓ Source vertex found:", sourceVertex);
        console.log("✓ Sink vertex found:", sinkVertex);

        const dfs = (current, path, edges, visitedInPath) => {
            console.log(`  DFS at vertex ${current.id}, path so far:`, path.map(v => v.id));

            if (current.id === sink.id) {
                console.log("  ✓ Reached sink! Path:", path.map(v => v.id));
                const prunedStructure = this.pruneToMinimalStructure(rdlt, path, edges, sink);
                const structureKey = this.getStructureKey(prunedStructure);
                if (!visited.has(structureKey)) {
                    visited.add(structureKey);
                    minimalStructures.push(prunedStructure);
                    console.log(`  ✓ Added minimal structure with ${prunedStructure.vertices.length} vertices`);
                } else {
                    console.log("  ⊘ Duplicate structure, skipping");
                }
                return;
            }

            const outgoingEdges = rdlt.edges.filter(edge => {
                const matches = edge.from.id === current.id;
                if (matches) console.log(`  Found outgoing edge: ${edge.from.id} → ${edge.to.id}`);
                return matches;
            });

            console.log(`  Vertex ${current.id} has ${outgoingEdges.length} outgoing edge(s)`);
            if (outgoingEdges.length === 0) console.log(`  ✗ Dead end at vertex ${current.id}`);

            for (const edge of outgoingEdges) {
                const nextVertex = edge.to;
                console.log(`  Considering edge to ${nextVertex.id}, visited in path:`, visitedInPath.has(nextVertex.id));
                if (!visitedInPath.has(nextVertex.id)) {
                    const newPath = [...path, nextVertex];
                    const newEdges = [...edges, edge];
                    const newVisited = new Set(visitedInPath);
                    newVisited.add(nextVertex.id);
                    dfs(nextVertex, newPath, newEdges, newVisited);
                } else {
                    console.log(`  ⊘ Skipping ${nextVertex.id} (already visited in this path)`);
                }
            }
        };

        console.log("Starting DFS from source...");
        const initialVisited = new Set([source.id]);
        dfs(sourceVertex, [sourceVertex], [], initialVisited);

        console.log(`=== FOUND ${minimalStructures.length} MINIMAL STRUCTURES (before AND-join merging) ===`);

        const mergedStructures = this.mergeANDJoinStructures(minimalStructures, rdlt);

        console.log(`=== AFTER AND-JOIN MERGING: ${mergedStructures.length} MINIMAL STRUCTURES ===`);

        return mergedStructures;
    }

    /**
     * Returns the minimal contraction structure for a given path.
     * Looping arcs are excluded here and added back later by createMASVariantsFromMinCS.
     */
    static pruneToMinimalStructure(rdlt, path, edges, sink) {
        const keptEdges = edges.filter(edge => !this.isLoopingArc(rdlt, edge));

        const vertexMap = new Map();
        path.forEach(v => vertexMap.set(v.id, v));
        keptEdges.forEach(edge => {
            vertexMap.set(edge.from.id, edge.from);
            vertexMap.set(edge.to.id, edge.to);
        });

        return {
            vertices: Array.from(vertexMap.values()),
            edges: keptEdges
        };
    }

    /**
     * Creates MAS variants from a MinCS:
     *   1. Base MAS — looping arcs added only when BOTH endpoints are already
     *      inside the MinCS vertex set.
     *   2. Expanded MAS (only when cycle-completing paths exist) — same as
     *      base but with outside-vertex cycle paths pulled in, then their
     *      looping arcs attached.
     *
     * Returns an array of 1 Graph (no outside cycles) or 2 Graphs (with them).
     *
     * @param {Graph} rdlt - The original RDLT.
     * @param {Object} minCS - The minimal contraction structure {vertices, edges}.
     * @returns {Array<Graph>}
     */
    static createMASVariantsFromMinCS(rdlt, minCS) {
        // ---- Base MAS --------------------------------------------------
        const baseMAS = this.buildMASGraph(rdlt, minCS.vertices, minCS.edges);

        // ---- Collect cycle-completing paths through outside vertices ---
        const cycleCompletionPaths = this.collectCycleCompletionPaths(rdlt, minCS);

        if (cycleCompletionPaths.length === 0) {
            console.log(`  No cycle-completing paths found — producing 1 MAS`);
            return [baseMAS];
        }

        // ---- Expanded MAS ----------------------------------------------
        const expandedVertices = [...minCS.vertices];
        const expandedEdges = [...minCS.edges];
        const vertexIds = new Set(minCS.vertices.map(v => v.id));
        const edgeKeys = new Set(minCS.edges.map(e => `${e.from.id}->${e.to.id}`));

        for (const pathEdges of cycleCompletionPaths) {
            console.log(
                `  Adding cycle-completing path:`,
                pathEdges.map(e => `${e.from.id}→${e.to.id}`)
            );
            for (const e of pathEdges) {
                const key = `${e.from.id}->${e.to.id}`;
                if (!edgeKeys.has(key)) {
                    edgeKeys.add(key);
                    expandedEdges.push(e);
                }
                if (!vertexIds.has(e.from.id)) {
                    vertexIds.add(e.from.id);
                    expandedVertices.push(e.from);
                }
                if (!vertexIds.has(e.to.id)) {
                    vertexIds.add(e.to.id);
                    expandedVertices.push(e.to);
                }
            }
        }

        const expandedMAS = this.buildMASGraph(rdlt, expandedVertices, expandedEdges);

        console.log(`  Cycle-completing paths found — producing 2 MAS (base + expanded)`);
        return [baseMAS, expandedMAS];
    }

    /**
     * Builds a MAS Graph from a vertex/edge set by:
     *   1. Attaching looping arcs whose BOTH endpoints are in the vertex set.
     *   2. Setting L-values: non-cycle edges → 1, cycle edges → original.
     *
     * @param {Graph} rdlt - The original RDLT (source of all edges/L-values).
     * @param {Array<Vertex>} vertices
     * @param {Array<Edge>} edges
     * @returns {Graph}
     */
    static buildMASGraph(rdlt, vertices, edges) {
        const masVertices = [...vertices];
        const masEdges = [...edges];
        const vertexIds = new Set(vertices.map(v => v.id));
        const edgeKeys = new Set(edges.map(e => `${e.from.id}->${e.to.id}`));

        for (const edge of rdlt.edges) {
            if (this.isLoopingArc(rdlt, edge)) {
                if (vertexIds.has(edge.from.id) && vertexIds.has(edge.to.id)) {
                    const key = `${edge.from.id}->${edge.to.id}`;
                    if (!edgeKeys.has(key)) {
                        edgeKeys.add(key);
                        masEdges.push(edge);
                    }
                }
            }
        }

        const mas = new Graph();
        mas.vertices = masVertices;
        mas.edges = masEdges;

        mas.edges = mas.edges.map(edge => {
            const edgeCopy = { ...edge };
            if (!this.isPartOfCycle(mas, edge)) {
                edgeCopy.maxTraversals = 1;
            }
            return edgeCopy;
        });

        return mas;
    }

    /**
     * Collects all cycle-completing paths for a MinCS.
     *
     * A cycle-completing path starts from a MinCS vertex, travels through
     * one or more NON-MinCS vertices, and arrives back at a MinCS vertex.
     * It is only accepted when the return target can reach the departure
     * vertex in the FULL rdlt graph — confirming this is a genuine backward
     * (looping) cycle that the DFS cut off because those vertices were
     * already visited.
     *
     * IMPORTANT: The confirmation uses the FULL rdlt (not just minCS.edges)
     * because pruneToMinimalStructure strips looping arcs like x8→x9 and
     * x9→x10 out of minCS.edges, so a minCS-only hasPath check would
     * incorrectly reject valid cycles.
     *
     * @param {Graph} rdlt - The RDLT graph.
     * @param {Object} minCS - {vertices, edges}.
     * @returns {Array<Array<Edge>>}
     */
    static collectCycleCompletionPaths(rdlt, minCS) {
        const vertexIds = new Set(minCS.vertices.map(v => v.id));
        const found = [];
        const seenPathKeys = new Set();

        for (const startVertex of minCS.vertices) {
            const outgoingToOutside = rdlt.edges.filter(
                e => e.from.id === startVertex.id && !vertexIds.has(e.to.id)
            );

            for (const firstEdge of outgoingToOutside) {
                const pathEdges = this.findCycleCompletionPath(
                    rdlt,
                    firstEdge.to,
                    vertexIds,
                    [firstEdge],
                    new Set([startVertex.id, firstEdge.to.id])
                );

                if (pathEdges) {
                    const returnTarget = pathEdges[pathEdges.length - 1].to;

                    // Confirm this is a genuine backward cycle by checking
                    // if returnTarget can reach startVertex in the FULL rdlt.
                    // We deliberately use rdlt here (not minCS.edges) because
                    // looping arcs like x8→x9 are stripped from minCS.edges
                    // by pruneToMinimalStructure, which would cause a false
                    // rejection of valid cycles.
                    if (this.hasPath(rdlt, returnTarget, startVertex, new Set())) {
                        const pathKey = pathEdges.map(e => `${e.from.id}->${e.to.id}`).join('|');
                        if (!seenPathKeys.has(pathKey)) {
                            seenPathKeys.add(pathKey);
                            console.log(
                                `  Cycle-completing path: ${startVertex.id} →`,
                                pathEdges.map(e => `${e.from.id}→${e.to.id}`),
                                `→ back to ${returnTarget.id}`
                            );
                            found.push(pathEdges);
                        }
                    }
                }
            }
        }

        return found;
    }

    /**
     * Finds a path starting at 'current' (a non-MinCS vertex) that travels
     * exclusively through non-MinCS vertices and terminates when it reaches
     * a vertex that IS in the MinCS (targetVertexIds).
     *
     * Returns the edge array forming that path (including the final edge back
     * into the MinCS), or null if no such path exists.
     *
     * @param {Graph} rdlt
     * @param {Vertex} current - Current vertex (outside MinCS).
     * @param {Set<*>} targetVertexIds - MinCS vertex ID set (valid return targets).
     * @param {Array<Edge>} pathEdges - Accumulated edges so far.
     * @param {Set<*>} visitedInPath - IDs visited in this DFS branch.
     * @returns {Array<Edge>|null}
     */
    static findCycleCompletionPath(rdlt, current, targetVertexIds, pathEdges, visitedInPath) {
        const outgoing = rdlt.edges.filter(e => e.from.id === current.id);

        for (const edge of outgoing) {
            if (targetVertexIds.has(edge.to.id)) {
                // Arrived back at a MinCS vertex — path complete
                return [...pathEdges, edge];
            }

            if (!visitedInPath.has(edge.to.id)) {
                const newVisited = new Set(visitedInPath);
                newVisited.add(edge.to.id);
                const result = this.findCycleCompletionPath(
                    rdlt,
                    edge.to,
                    targetVertexIds,
                    [...pathEdges, edge],
                    newVisited
                );
                if (result) return result;
            }
        }

        return null;
    }

    /**
     * Checks if an edge is a looping arc.
     * An arc (x, y) is a looping arc if y is an ancestor of x in the graph,
     * i.e. there is a path from y back to x.
     */
    static isLoopingArc(rdlt, edge) {
        return this.hasPath(rdlt, edge.to, edge.from, new Set());
    }

    /**
     * Checks if there's a path from vertex 'from' to vertex 'to'.
     */
    static hasPath(graph, from, to, visited) {
        if (from.id === to.id) return true;
        if (visited.has(from.id)) return false;

        visited.add(from.id);

        const outgoingEdges = graph.edges.filter(edge => edge.from.id === from.id);
        for (const edge of outgoingEdges) {
            if (this.hasPath(graph, edge.to, to, visited)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Checks if an edge is part of a cycle in the graph.
     */
    static isPartOfCycle(graph, edge) {
        return this.hasPath(graph, edge.to, edge.from, new Set());
    }

    /**
     * Creates a unique key for a structure based on its vertices and edges.
     */
    static getStructureKey(structure) {
        const vertexIds = structure.vertices.map(v => v.id).sort().join(',');
        const edgeIds = structure.edges
            .map(e => `${e.from.id}->${e.to.id}`)
            .sort()
            .join('|');
        return `V:[${vertexIds}]E:[${edgeIds}]`;
    }

    /**
     * Classifies JOIN vertices in a graph by their type, considering only
     * non-looping incoming arcs. Looping arcs re-enter from a cycle and
     * must not influence AND/MIX/OR classification.
     *
     * - AND-join: all non-looping incoming arcs have distinct non-ε C-attributes.
     * - MIX-join: non-looping incoming arcs are a mix of ε and non-ε.
     * - OR-join: all share the same C-attribute (or all ε) — no action needed.
     */
    static classifyJoinVertices(rdlt) {
        const andJoins = [];
        const mixJoins = [];

        for (const vertex of rdlt.vertices) {
            const allIncoming = rdlt.edges.filter(e => e.to.id === vertex.id);
            const incomingEdges = allIncoming.filter(e => !this.isLoopingArc(rdlt, e));
            if (incomingEdges.length < 2) continue;

            const constraints = incomingEdges.map(e => e.constraint);
            const hasEpsilon = constraints.some(c => !c || c === '' || c === 'ε' || c === 'epsilon');
            const nonEpsilonConstraints = new Set();
            for (const c of constraints) {
                if (c && c !== '' && c !== 'ε' && c !== 'epsilon') {
                    nonEpsilonConstraints.add(c);
                }
            }

            if (!hasEpsilon && nonEpsilonConstraints.size >= 2) {
                console.log(`  AND-join detected at vertex ${vertex.id} with constraints: ${[...nonEpsilonConstraints].join(', ')}`);
                andJoins.push(vertex);
            } else if (hasEpsilon && nonEpsilonConstraints.size >= 1) {
                console.log(`  MIX-join detected at vertex ${vertex.id} with non-ε constraints: ${[...nonEpsilonConstraints].join(', ')} and ε arcs`);
                mixJoins.push(vertex);
            }
        }

        return { andJoins, mixJoins };
    }

    /**
     * Merges a set of structures into a single combined structure.
     */
    static combineStructures(structures) {
        const mergedVertices = new Map();
        const mergedEdges = [];
        const edgeKeys = new Set();

        for (const s of structures) {
            s.vertices.forEach(v => mergedVertices.set(v.id, v));
            s.edges.forEach(e => {
                const key = `${e.from.id}->${e.to.id}`;
                if (!edgeKeys.has(key)) {
                    edgeKeys.add(key);
                    mergedEdges.push(e);
                }
            });
        }

        return {
            vertices: Array.from(mergedVertices.values()),
            edges: mergedEdges
        };
    }

    /**
     * Handles AND-join and MIX-join vertices to produce the correct set of
     * minimal contraction structures for MAS extraction.
     *
     * - AND-join: MERGE all paths through the join into one.
     * - MIX-join: KEEP individual paths AND ADD a merged version.
     * - OR-join: no change needed.
     */
    static mergeANDJoinStructures(structures, rdlt) {
        const { andJoins, mixJoins } = this.classifyJoinVertices(rdlt);

        if (andJoins.length === 0 && mixJoins.length === 0) {
            console.log("  No AND-join or MIX-join vertices found - no merging needed");
            return structures;
        }

        let result = [...structures];

        for (const joinVertex of andJoins) {
            const passingThrough = result.filter(s =>
                s.vertices.some(v => v.id === joinVertex.id)
            );
            console.log(`  AND-join ${joinVertex.id}: ${passingThrough.length} structure(s) pass through it`);
            if (passingThrough.length > 1) {
                const combined = this.combineStructures(passingThrough);
                console.log(`  Merged ${passingThrough.length} structures into 1 (${combined.vertices.length} vertices, ${combined.edges.length} edges)`);
                result = result.filter(s => !passingThrough.includes(s));
                result.push(combined);
            }
        }

        for (const joinVertex of mixJoins) {
            const passingThrough = result.filter(s =>
                s.vertices.some(v => v.id === joinVertex.id)
            );
            console.log(`  MIX-join ${joinVertex.id}: ${passingThrough.length} structure(s) pass through it`);
            if (passingThrough.length > 1) {
                const combined = this.combineStructures(passingThrough);
                const combinedKey = this.getStructureKey(combined);
                const existingKeys = result.map(s => this.getStructureKey(s));
                if (!existingKeys.includes(combinedKey)) {
                    console.log(`  Added combined MIX-join structure (${combined.vertices.length} vertices, ${combined.edges.length} edges)`);
                    result.push(combined);
                } else {
                    console.log(`  Combined MIX-join structure already exists, skipping`);
                }
            }
        }

        return result;
    }
}