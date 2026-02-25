import { Graph } from "../models/Graph.js";
import { MASExtractor } from "./mas-extractor.js";

/**
 * Utility class for extracting Complete Activity Structures (CAS) from RDLTs.
 * Implements Algorithm 5 from the paper.
 */
export class CASExtractor {
    /**
     * Extracts all Complete Activity Structures from an RDLT.
     * @param {Graph} originalRDLT - The original RDLT (before vertex simplification).
     * @param {Graph} R1 - Level-1 vertex-simplified RDLT.
     * @param {Graph} R2 - Level-2 vertex-simplified RDLT (can be null if no RBS).
     * @param {Vertex} source - The source vertex.
     * @param {Vertex} sink - The sink vertex.
     * @returns {Array<Graph>} Array of CAS (each is a Graph object).
     */
    static extractAllCAS(originalRDLT, R1, R2, source, sink) {
        console.log("=== CAS EXTRACTOR DEBUG ===");
        console.log("R1 Edges:", R1?.edges?.map(e => `${e.from.id}→${e.to.id} (L=${e.maxTraversals})`));
        console.log("R2 Edges:", R2?.edges?.map(e => `${e.from.id}→${e.to.id} (L=${e.maxTraversals})`));
        console.log("Source:", source?.id, "Sink:", sink?.id);

        // Step 1: Extract MAS from R1 and R2
        const uMAS1 = this.extractUpdatedMAS(originalRDLT, R1, source, sink, "R1");
        console.log(`Extracted ${uMAS1.length} updated MAS from R1`);

        let uMAS2 = [];
        if (R2 && R2.vertices && R2.vertices.length > 0) {
            uMAS2 = this.extractUpdatedMAS(originalRDLT, R2, source, sink, "R2");
            console.log(`Extracted ${uMAS2.length} updated MAS from R2`);
        }

        // Step 2: Build CAS using the unified (fixed) logic
        return this.buildCASFromMAS(originalRDLT, R1, R2, uMAS1, uMAS2, source, sink);
    }

    // ---------------------------------------------------------------
    // Source / sink resolution helpers
    // ---------------------------------------------------------------

    /**
     * Finds the source of a simplified graph topologically —
     * the vertex that has no incoming edges.
     * @param {Graph} graph - A vertex-simplified RDLT (R1 or R2).
     * @returns {Vertex|null} The source vertex, or null if none found.
     */
    static findSimplifiedSource(graph) {
        if (!graph || !graph.vertices || graph.vertices.length === 0) return null;
        const hasIncoming = new Set(graph.edges.map(e => e.to.id));
        return graph.vertices.find(v => !hasIncoming.has(v.id)) ?? null;
    }

    /**
     * Finds the sink of a simplified graph topologically —
     * the vertex that has no outgoing edges.
     * @param {Graph} graph - A vertex-simplified RDLT (R1 or R2).
     * @returns {Vertex|null} The sink vertex, or null if none found.
     */
    static findSimplifiedSink(graph) {
        if (!graph || !graph.vertices || graph.vertices.length === 0) return null;
        const hasOutgoing = new Set(graph.edges.map(e => e.from.id));
        return graph.vertices.find(v => !hasOutgoing.has(v.id)) ?? null;
    }

    /**
     * Finds ALL sinks of a simplified graph topologically —
     * every vertex that has no outgoing edges.
     * This is needed for R2 graphs where the RBS has multiple
     * out-bridge vertices (e.g., an OR-split inside the RBS).
     * @param {Graph} graph - A vertex-simplified RDLT.
     * @returns {Array<Vertex>} Array of sink vertices.
     */
    static findAllSimplifiedSinks(graph) {
        if (!graph || !graph.vertices || graph.vertices.length === 0) return [];
        const hasOutgoing = new Set(graph.edges.map(e => e.from.id));
        return graph.vertices.filter(v => !hasOutgoing.has(v.id));
    }

    // ---------------------------------------------------------------

    /**
     * Extracts updated MAS with L-values from original RDLT or eRU values.
     *
     * FIX: source and sink are resolved against the simplified graph before
     * being forwarded to MASExtractor.  The original source/sink may be
     * boundary or entity objects that were removed during EVSA; the
     * topological fallbacks (findSimplifiedSource / findSimplifiedSink)
     * locate the correct vertices in that case.
     *
     * @param {Graph} originalRDLT - The original RDLT.
     * @param {Graph} simplifiedRDLT - The vertex-simplified RDLT (R1 or R2).
     * @param {Vertex} source - Source vertex (from the original RDLT).
     * @param {Vertex} sink - Sink vertex (from the original RDLT).
     * @param {string} level - "R1" or "R2".
     * @returns {Array<Graph>} Array of updated MAS.
     */
    static extractUpdatedMAS(originalRDLT, simplifiedRDLT, source, sink, level) {
        // Resolve source to a vertex that actually exists in the simplified graph.
        const resolvedSource = simplifiedRDLT.vertices.find(v => v.id === source.id)
            ?? this.findSimplifiedSource(simplifiedRDLT);

        if (!resolvedSource) {
            console.warn(`[extractUpdatedMAS] Could not resolve source in ${level}.`);
            return [];
        }

        // ── For R2: extract MAS to EVERY terminal vertex ──────────────
        // An RBS can have multiple out-bridge vertices (e.g., an OR-split
        // inside the RBS produces two endpoints like x4 and x5).  Each
        // out-bridge endpoint is a valid sink for R2 MAS extraction.
        // Using only findSimplifiedSink() picks ONE of them and silently
        // drops MAS paths to the others, causing missing CAS downstream.
        let allSinks;
        if (level === "R2") {
            allSinks = this.findAllSimplifiedSinks(simplifiedRDLT);
            if (allSinks.length === 0) {
                console.warn(`[extractUpdatedMAS] No sinks found in ${level}.`);
                return [];
            }
            console.log(`[extractUpdatedMAS] ${level} — resolved source: ${resolvedSource.id}, sinks: [${allSinks.map(s => s.id).join(', ')}]`);
        } else {
            // For R1: use single resolved sink as before
            const resolvedSink = simplifiedRDLT.vertices.find(v => v.id === sink.id)
                ?? this.findSimplifiedSink(simplifiedRDLT);
            if (!resolvedSink) {
                console.warn(`[extractUpdatedMAS] Could not resolve sink in ${level}.`);
                return [];
            }
            allSinks = [resolvedSink];
            console.log(`[extractUpdatedMAS] ${level} — resolved source: ${resolvedSource.id}, sink: ${resolvedSink.id}`);
        }

        // Extract MAS for each sink and collect them all
        let allMAS = [];
        for (const resolvedSink of allSinks) {
            const masSet = MASExtractor.extractAllMAS(simplifiedRDLT, resolvedSource, resolvedSink);
            console.log(`  → ${masSet.length} MAS found for sink ${resolvedSink.id}`);
            allMAS.push(...masSet);
        }

        // Deduplicate MAS across different sinks (in case paths overlap)
        const seen = new Set();
        allMAS = allMAS.filter(mas => {
            const key = MASExtractor.getStructureKey({
                vertices: mas.vertices,
                edges: mas.edges
            });
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Update L-values
        // The MAS extractor already applies Definition 8 L-value assignment:
        //   - L=1 for arcs in the MinCS that are NOT part of a cycle in Ri
        //   - Original L (from Ri) for cycle arcs
        // The L-values in Ri already include eRU values for abstract arcs
        // (computed by ProcessR1/EVSA), so no post-processing is needed.
        //
        // IMPORTANT: Do NOT override L-values with originalRDLT values here.
        const updatedMAS = allMAS.map(mas => {
            const updated = new Graph();
            updated.vertices = [...mas.vertices];
            updated.edges = mas.edges.map(edge => {
                const edgeCopy = { ...edge };

                if (level === "R2") {
                    // For R2: use eRU values if available
                    edgeCopy.maxTraversals = edge.eRU || edge.maxTraversals;
                }
                // For R1: keep MAS extractor's Definition 8 L-values as-is

                return edgeCopy;
            });

            return updated;
        });

        return updatedMAS;
    }

    /**
     * Builds the complete set of CAS from already-extracted MAS.
     * Mirrors the logic of extractAllCAS but operates on the MAS arrays
     * that were already computed, avoiding duplicate extraction.
     *
     * KEY FIX: R1 MAS that do not interact with any R2 vertex are valid
     * standalone CAS — they represent activities that bypass the RBS entirely.
     * Previously these were silently dropped because they had no abstract arcs
     * and no common vertex with R2.
     */
    static buildCASFromMAS(originalRDLT, R1, R2, uMAS1, uMAS2, source, sink) {
        const hasRBS = R2 && R2.vertices && R2.vertices.length > 0;

        if (!hasRBS) {
            // No RBS – each R1 MAS is itself a CAS.
            // Restore original R L-values (Definition 8 L=1 was for structure only).
            console.log("No RBS detected – returning R1 MAS as CAS");
            return uMAS1.map(mas => this.restoreCASLValues(originalRDLT, mas, null));
        }

        const r2VertexIds = new Set(R2.vertices.map(v => v.id));
        const allCAS = [];

        for (const mas1 of uMAS1) {
            const mas1VertexIds = new Set(mas1.vertices.map(v => v.id));

            // Check if this R1 MAS interacts with the RBS at all
            const interactsWithR2 = [...mas1VertexIds].some(id => r2VertexIds.has(id));

            if (!interactsWithR2) {
                // ── Standalone R1 MAS ──────────────────────────────────
                // This MAS bypasses the RBS entirely.  It is a valid CAS
                // on its own (no abstract arcs to expand, no R2 content
                // to merge).  Previously this case was silently dropped.
                console.log("R1 MAS does not interact with R2 – adding as standalone CAS");
                const restored = this.restoreCASLValues(originalRDLT, mas1, R2);
                if (!this.isDuplicateCAS(allCAS, restored)) {
                    allCAS.push(restored);
                }
                continue;
            }

            // ── R1 MAS touches the RBS ────────────────────────────────
            // Look for abstract arcs to replace with R2 MAS content.
            const abstractArcs = this.findAbstractArcs(mas1, R2);

            if (abstractArcs.length > 0) {
                console.log(`Found ${abstractArcs.length} abstract arc(s) in R1 MAS`);
                for (const mas2 of uMAS2) {
                    for (const abstractArc of abstractArcs) {
                        if (this.mas2MatchesAbstractArc(mas2, abstractArc)) {
                            const cas = this.replaceAbstractArcWithMAS2(
                                originalRDLT, mas1, mas2, abstractArc
                            );
                            if (cas) {
                                const restored = this.restoreCASLValues(originalRDLT, cas, R2);
                                if (!this.isDuplicateCAS(allCAS, restored)) {
                                    allCAS.push(restored);
                                }
                            }
                        }
                    }
                }
            } else {
                // No abstract arcs but shares vertices with R2.
                // Merge at common vertex, deduplicating shared arcs.
                console.log("No abstract arcs – merging R1 and R2 MAS at common vertex");
                for (const mas2 of uMAS2) {
                    const commonVertex = this.findCommonVertex(mas1, mas2);
                    if (commonVertex) {
                        const cas = this.mergeAtVertex(mas1, mas2, commonVertex);
                        if (cas) {
                            const restored = this.restoreCASLValues(originalRDLT, cas, R2);
                            if (!this.isDuplicateCAS(allCAS, restored)) {
                                allCAS.push(restored);
                            }
                        }
                    }
                }
            }
        }

        // If no CAS were produced from R1×R2 combinations but we have R1 MAS,
        // fall back to returning R1 MAS directly (handles edge cases where R2
        // MAS extraction returned nothing).
        if (allCAS.length === 0 && uMAS1.length > 0) {
            console.log("No R1×R2 CAS produced – falling back to R1 MAS");
            return uMAS1.map(mas => this.restoreCASLValues(originalRDLT, mas, R2));
        }

        console.log(`Built ${allCAS.length} CAS total`);
        return allCAS;
    }

    // ---------------------------------------------------------------
    // CAS L-value restoration (Afable's CAS properties)
    // ---------------------------------------------------------------

    /**
     * Restores the correct L-values on a CAS after construction.
     *
     * From Afable's CAS definition:
     *   1. Arcs OUTSIDE the RBS → original R L-values
     *   2. Arcs INSIDE the RBS  → eRU values
     *      (except when the sink is inside the RBS — handled by caller)
     *
     * Definition 8 assigns L=1 to non-cycle arcs for MAS *structure*
     * identification, but the CAS must reflect the real system constraints
     * for generalized impedance checking.
     *
     * @param {Graph} originalRDLT - The original RDLT with real L-values.
     * @param {Graph} cas - The CAS whose L-values need restoration.
     * @param {Graph|null} R2 - Level-2 graph (null if no RBS).
     * @returns {Graph} CAS with restored L-values.
     */
    static restoreCASLValues(originalRDLT, cas, R2) {
        const r2VertexIds = R2 && R2.vertices
            ? new Set(R2.vertices.map(v => v.id))
            : new Set();

        // Build a fast lookup for original RDLT edges.
        // The original RDLT uses UIDs for vertex.id, while R1/R2 (and therefore
        // the CAS) use identifier strings like "x1" for vertex.id.
        // We match on vertex.name (which is the identifier in both schemes).
        // Fallback: also try matching on vertex.id directly in case both
        // graphs happen to use the same ID scheme.
        const originalEdgeMap = new Map();
        if (originalRDLT && originalRDLT.edges) {
            for (const e of originalRDLT.edges) {
                // Primary key: by name (identifier)
                const nameKey = `${e.from.name}->${e.to.name}`;
                if (!originalEdgeMap.has(nameKey)) {
                    originalEdgeMap.set(nameKey, e);
                }
                // Secondary key: by id (in case both graphs share id scheme)
                const idKey = `${e.from.id}->${e.to.id}`;
                if (!originalEdgeMap.has(idKey)) {
                    originalEdgeMap.set(idKey, e);
                }
            }
        }

        const restored = new Graph();
        restored.vertices = [...cas.vertices];

        restored.edges = cas.edges.map(edge => {
            const edgeCopy = { ...edge };

            // Determine whether this arc is inside or outside the RBS
            // CAS edges use identifier-based vertex IDs (e.g. "x1")
            const fromId = edge.from.id;
            const toId = edge.to.id;
            const isInsideRBS = r2VertexIds.has(fromId) && r2VertexIds.has(toId);

            if (isInsideRBS) {
                // Inside RBS → keep eRU value (already correct from R2 MAS)
                console.log(`  CAS L-value: ${fromId}→${toId} INSIDE RBS, keeping L=${edgeCopy.maxTraversals} (eRU)`);
            } else {
                // Outside RBS → restore from original RDLT
                // Try matching by name first (handles UID vs identifier mismatch),
                // then fall back to matching by id.
                const nameKey = `${edge.from.name || fromId}->${edge.to.name || toId}`;
                const idKey = `${fromId}->${toId}`;
                const originalEdge = originalEdgeMap.get(nameKey)
                                  || originalEdgeMap.get(idKey);

                if (originalEdge) {
                    const oldL = edgeCopy.maxTraversals;
                    edgeCopy.maxTraversals = originalEdge.maxTraversals;
                    if (oldL !== edgeCopy.maxTraversals) {
                        console.log(`  CAS L-value: ${fromId}→${toId} OUTSIDE RBS, restored L=${oldL}→${edgeCopy.maxTraversals}`);
                    }
                } else {
                    console.warn(`  CAS L-value: ${fromId}→${toId} – no matching original edge found (keeping L=${edgeCopy.maxTraversals})`);
                }
            }

            return edgeCopy;
        });

        return restored;
    }

    /**
     * Checks if a MAS2 structure matches an abstract arc's endpoints.
     * @param {Graph} mas2 - The MAS from R2.
     * @param {Edge} abstractArc - The abstract arc.
     * @returns {boolean} True if mas2 connects the abstract arc endpoints.
     */
    static mas2MatchesAbstractArc(mas2, abstractArc) {
        const mas2VertexIds = new Set(mas2.vertices.map(v => v.id));
        return mas2VertexIds.has(abstractArc.from.id) &&
               mas2VertexIds.has(abstractArc.to.id);
    }

    /**
     * Finds abstract arcs in an R1 MAS.
     * An abstract arc is an edge in R1 whose BOTH endpoints also appear in R2.
     * EVSA creates these to represent internal RBS paths with eRU-derived L-values.
     *
     * KEY FIX: An arc (x,y) in R1 is abstract if both x,y are R2 vertices,
     * REGARDLESS of whether (x,y) also exists in R2.  When the same vertex pair
     * exists in both R1 and R2, the R1 version is the abstract (eRU-derived)
     * arc and the R2 version is the original internal arc.  The abstract arc
     * should be replaced with the R2 MAS content during CAS construction.
     *
     * @param {Graph} mas - The R1 MAS to check.
     * @param {Graph} R2 - The Level-2 vertex-simplified RDLT (or null).
     * @returns {Array<Edge>} Array of abstract arcs.
     */
    static findAbstractArcs(mas, R2) {
        if (!R2 || !R2.vertices || R2.vertices.length === 0) return [];

        const r2VertexIds = new Set(R2.vertices.map(v => v.id));

        return mas.edges.filter(edge => {
            // An edge is abstract when BOTH endpoints live in R2.
            // This covers both cases:
            //   - Arc does NOT exist in R2 (collapsed RBS path)
            //   - Arc DOES exist in R2 but with a different L-value (eRU-derived)
            return r2VertexIds.has(edge.from.id) && r2VertexIds.has(edge.to.id);
        });
    }

    /**
     * Replaces an abstract arc in MAS1 with the actual subgraph from MAS2.
     * Removes ALL R1 arcs between the abstract arc's endpoints (handles
     * the case where ProcessR1 includes both original and abstract versions),
     * then adds R2 edges.  Final edges are deduplicated with R2 taking priority.
     *
     * @param {Graph} originalRDLT - The original RDLT.
     * @param {Graph} mas1 - The MAS from R1.
     * @param {Graph} mas2 - The MAS from R2.
     * @param {Edge} abstractArc - The abstract arc to replace.
     * @returns {Graph} The resulting CAS.
     */
    static replaceAbstractArcWithMAS2(originalRDLT, mas1, mas2, abstractArc) {
        const cas = new Graph();

        // Remove ALL R1 edges between abstract arc endpoints
        // (catches both original and eRU-derived versions)
        const r1EdgesFiltered = mas1.edges.filter(
            e => !(e.from.id === abstractArc.from.id && e.to.id === abstractArc.to.id)
        );

        // Deduplicated union: R1 edges first, R2 edges overwrite on conflict
        const edgeMap = new Map();
        for (const e of r1EdgesFiltered) {
            edgeMap.set(`${e.from.id}->${e.to.id}`, e);
        }
        for (const e of mas2.edges) {
            edgeMap.set(`${e.from.id}->${e.to.id}`, e);
        }
        cas.edges = Array.from(edgeMap.values());

        // Union of vertices (deduplicated by id)
        const vertexMap = new Map();
        [...mas1.vertices, ...mas2.vertices].forEach(v => vertexMap.set(v.id, v));
        cas.vertices = Array.from(vertexMap.values());

        return cas;
    }

    /**
     * Merges two MAS structures into a single CAS with edge deduplication.
     * When the same arc (from,to) exists in both, the R2 (mas2) version
     * is preferred as it has the original internal L-value.
     * @param {Graph} originalRDLT - The original RDLT.
     * @param {Graph} mas1 - First MAS (typically R1).
     * @param {Graph} mas2 - Second MAS (typically R2).
     * @returns {Graph} The merged CAS.
     */
    static mergeMASStructures(originalRDLT, mas1, mas2) {
        const cas = new Graph();

        // Combine vertices
        const vertexMap = new Map();
        [...mas1.vertices, ...mas2.vertices].forEach(v => {
            vertexMap.set(v.id, v);
        });
        cas.vertices = Array.from(vertexMap.values());

        // Combine edges with deduplication (R2 takes priority)
        const edgeMap = new Map();
        for (const e of mas1.edges) {
            edgeMap.set(`${e.from.id}->${e.to.id}`, e);
        }
        for (const e of mas2.edges) {
            // R2 edges overwrite R1 edges for same vertex pair
            edgeMap.set(`${e.from.id}->${e.to.id}`, e);
        }
        cas.edges = Array.from(edgeMap.values());

        return cas;
    }

    /**
     * Updates MAS2 L-values to original RDLT values (not eRU).
     * @param {Graph} originalRDLT - The original RDLT.
     * @param {Graph} mas2 - The MAS from R2.
     * @returns {Graph} Updated MAS2.
     */
    static updateToOriginalLValues(originalRDLT, mas2) {
        const updated = new Graph();
        updated.vertices = [...mas2.vertices];
        updated.edges = mas2.edges.map(edge => {
            const edgeCopy = { ...edge };
            const originalEdge = originalRDLT.edges.find(
                e => e.from.id === edge.from.id && e.to.id === edge.to.id
            );
            if (originalEdge) {
                edgeCopy.maxTraversals = originalEdge.maxTraversals;
            }
            return edgeCopy;
        });
        return updated;
    }

    /**
     * Finds a common vertex between two MAS structures.
     * @param {Graph} mas1 - First MAS.
     * @param {Graph} mas2 - Second MAS.
     * @returns {Vertex|null} Common vertex or null if none found.
     */
    static findCommonVertex(mas1, mas2) {
        const mas1VertexIds = new Set(mas1.vertices.map(v => v.id));
        return mas2.vertices.find(v => mas1VertexIds.has(v.id)) || null;
    }

    /**
     * Merges two MAS at a common vertex with edge deduplication.
     * When the same arc (from,to) exists in both, the R2 (mas2) version
     * is preferred.
     * @param {Graph} mas1 - First MAS (R1).
     * @param {Graph} mas2 - Second MAS (R2).
     * @param {Vertex} commonVertex - The vertex to merge at.
     * @returns {Graph} The merged CAS.
     */
    static mergeAtVertex(mas1, mas2, commonVertex) {
        const cas = new Graph();

        // Combine all vertices
        const vertexMap = new Map();
        [...mas1.vertices, ...mas2.vertices].forEach(v => {
            vertexMap.set(v.id, v);
        });
        cas.vertices = Array.from(vertexMap.values());

        // Combine edges with deduplication (R2 takes priority)
        const edgeMap = new Map();
        for (const e of mas1.edges) {
            edgeMap.set(`${e.from.id}->${e.to.id}`, e);
        }
        for (const e of mas2.edges) {
            edgeMap.set(`${e.from.id}->${e.to.id}`, e);
        }
        cas.edges = Array.from(edgeMap.values());

        return cas;
    }

    /**
     * Checks if a CAS is a duplicate of any in the existing set.
     * @param {Array<Graph>} casSet - Existing CAS set.
     * @param {Graph} newCAS - New CAS to check.
     * @returns {boolean} True if duplicate.
     */
    static isDuplicateCAS(casSet, newCAS) {
        const newKey = MASExtractor.getStructureKey({
            vertices: newCAS.vertices,
            edges: newCAS.edges
        });

        return casSet.some(existingCAS => {
            const existingKey = MASExtractor.getStructureKey({
                vertices: existingCAS.vertices,
                edges: existingCAS.edges
            });
            return existingKey === newKey;
        });
    }

    /**
     * Extracts all CAS and returns detailed information including MAS.
     * This is the single entry-point used by checkLazySound.  It avoids
     * the duplicate MAS extraction that the old version suffered from.
     */
    static extractAllCASWithDetails(originalRDLT, R1, R2, source, sink) {
        console.log("Starting CAS extraction with details...");

        // Step 1: Extract MAS from R1 and R2 (done once)
        const masR1 = this.extractUpdatedMAS(originalRDLT, R1, source, sink, "R1");
        console.log(`Extracted ${masR1.length} updated MAS from R1`);

        let masR2 = [];
        if (R2 && R2.vertices && R2.vertices.length > 0) {
            masR2 = this.extractUpdatedMAS(originalRDLT, R2, source, sink, "R2");
            console.log(`Extracted ${masR2.length} updated MAS from R2`);
        }

        // Step 2: Build CAS directly from the already-extracted MAS
        const casSet = this.buildCASFromMAS(originalRDLT, R1, R2, masR1, masR2, source, sink);

        return { casSet, masR1, masR2 };
    }
}