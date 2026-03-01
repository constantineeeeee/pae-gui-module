import { mapGUIModelToSoundness } from "./soundness/soundness-service.mjs";
import { CASExtractor } from "./soundness/utils/cas-extractor.js";
import { Graph } from "./soundness/models/Graph.js";
import { utils } from "./soundness/utils/rdlt-utils.mjs";

export function verifyImpedanceFreeness(simpleModel, source, sink) {
    const { rdltGraph, combinedEvsa } = mapGUIModelToSoundness(simpleModel, source, sink);

    const R1Graph = combinedEvsa[0];
    let R2Graph = null;
    if (combinedEvsa.length > 1) {
        R2Graph = new Graph();
        for (let i = 1; i < combinedEvsa.length; i++) {
            combinedEvsa[i]?.vertices?.forEach(v => {
                if (!R2Graph.vertices.some(e => e.id === v.id)) R2Graph.addVertex(v);
            });
            combinedEvsa[i]?.edges?.forEach(e => {
                if (!R2Graph.edges.some(ex => ex.from.id === e.from.id && ex.to.id === e.to.id)) R2Graph.addEdge(e);
            });
        }
    }

    const { source: src, sink: snk } = utils.getSourceAndSinkVertices(rdltGraph);
    const { casSet } = CASExtractor.extractAllCASWithDetails(rdltGraph, R1Graph, R2Graph, src, snk);

    console.log(`Got ${casSet.length} CAS`, casSet);

    if (casSet.length === 0) {
        return {
            title: "Impedance-Freeness",
            instances: [{
                name: "Main Model",
                evaluation: {
                    conclusion: {
                        pass: false,
                        title: "Not Impedance-Free",
                        description: "No CAS found — sink is unreachable."
                    },
                    criteria: [],
                    violating: { arcs: [], vertices: [] }
                }
            }]
        };
    }

    if (casSet.length === 1) {
        return {
            title: "Impedance-Freeness",
            instances: [{
                name: "Main Model",
                evaluation: {
                    conclusion: {
                        pass: true,
                        title: "Impedance-Free",
                        description: "Only one CAS exists — no competition between activities."
                    },
                    criteria: [{ pass: true, description: "No competing activities." }],
                    violating: { arcs: [], vertices: [] }
                }
            }]
        };
    }

    // Count how many CAS use each arc
    // Impedance occurs when usage count > L-value of that arc
    const arcUsageMap = new Map();

    for (let i = 0; i < casSet.length; i++) {
        for (const edge of casSet[i].edges) {
            const key = `${edge.from.id}->${edge.to.id}`;
            if (!arcUsageMap.has(key)) {
                arcUsageMap.set(key, { edge, casIndices: [] });
            }
            arcUsageMap.get(key).casIndices.push(i + 1);
        }
    }

    const violatingArcIds = new Set();
    const criteria = [];

    for (const [key, { edge, casIndices }] of arcUsageMap.entries()) {
        const usageCount = casIndices.length;
        const lValue = edge.maxTraversals;

        if (usageCount > lValue) {
            violatingArcIds.add(key);
            criteria.push({
                pass: false,
                description: `Arc ${edge.from.id}→${edge.to.id} (L=${lValue}) is used by ${usageCount} CAS (CAS ${casIndices.join(", ")}) — impedance occurs`
            });
        } else {
            criteria.push({
                pass: true,
                description: `Arc ${edge.from.id}→${edge.to.id} (L=${lValue}), used by ${usageCount} CAS — no impedance`
            });
        }
    }

    const pass = violatingArcIds.size === 0;

    return {
        title: "Impedance-Freeness",
        instances: [{
            name: "Main Model",
            evaluation: {
                conclusion: {
                    pass,
                    title: pass ? "Impedance-Free" : "Not Impedance-Free",
                    description: pass
                        ? `All ${casSet.length} CAS are impedance-free — no arc is overloaded.`
                        : `${violatingArcIds.size} arc(s) are used by more CAS than their L-value allows.`
                },
                criteria,
                violating: { arcs: [...violatingArcIds], vertices: [] }
            }
        }]
    };
}