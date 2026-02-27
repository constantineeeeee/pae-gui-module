import { Graph } from "../models/Graph.js";
import { extractMASviaMatrixMCA, getStructureKey as bridgeGetStructureKey } from "./matrix-mca-bridge.js";

/**
 * Utility class for extracting Maximal Activity Structures (MAS) from RDLTs.
 *
 * INTEGRATION NOTE (Matrix MCA):
 * ──────────────────────────────
 * This class now delegates to the matrix-based Modified Contraction Algorithm
 * (MCA) for MinCS discovery and MAS construction, replacing the previous
 * DFS-path-enumeration approach.
 *
 * The matrix MCA is more faithful to Amancio's Algorithm 1:
 *   - MinCS structures emerge from contraction feasibility checks rather than
 *     DFS path enumeration with post-hoc join merging.
 *   - AND-joins are handled implicitly (contraction fails until all branches
 *     are absorbed) instead of requiring explicit post-processing.
 *   - Phase 2 backward weighting operates on adjacency/constraint matrices.
 *
 * The public API (extractAllMAS, getStructureKey) is unchanged, so
 * cas-extractor.js and soundness.js require NO modifications.
 */
export class MASExtractor {
    /**
     * Extracts all Maximal Activity Structures from a vertex-simplified RDLT.
     *
     * @param {Graph} rdlt - The vertex-simplified RDLT (R1 or R2).
     * @param {Vertex} source - The source vertex.
     * @param {Vertex} sink - The sink vertex.
     * @returns {Array<Graph>} Array of MAS (each is a Graph object).
     */
    static extractAllMAS(rdlt, source, sink) {
        console.log(`=== MAS EXTRACTOR (Matrix MCA) ===`);
        console.log(`Source: ${source.id}, Sink: ${sink.id}`);
        console.log(`RDLT: ${rdlt?.vertices?.length} vertices, ${rdlt?.edges?.length} edges`);

        // Delegate to the matrix-based MCA pipeline
        const allMAS = extractMASviaMatrixMCA(rdlt, source, sink);

        console.log(`Extracted ${allMAS.length} MAS via Matrix MCA`);
        console.log(`=========================`);
        return allMAS;
    }

    /**
     * Creates a unique key for a structure based on its vertices and edges.
     * Used by CASExtractor for deduplication.
     *
     * @param {Object} structure - Object with vertices and edges arrays.
     * @returns {string} A unique key for the structure.
     */
    static getStructureKey(structure) {
        return bridgeGetStructureKey(structure);
    }
}