/**
 * Utility class for checking generalized impedance in RDLTs.
 * Based on Theorem 3.3.3 from the paper.
 */
export class GeneralizedImpedance {
    /**
     * Checks if a set of CAS exhibits generalized impedance.
     * @param {Array<Graph>} casSet - Array of Complete Activity Structures.
     * @returns {Object} Result object with pass status and violations.
     */
    static checkGeneralizedImpedance(casSet) {
        console.log(`Checking generalized impedance for ${casSet.length} CAS...`);
        
        // Special case: single CAS automatically satisfies (no competition)
        if (casSet.length <= 1) {
            console.log("Single or no CAS - generalized impedance not applicable");
            return {
                pass: true,
                sharedArcs: [],
                violations: [],
                message: casSet.length === 1 
                    ? "Only one CAS exists - no impedance needed"
                    : "No CAS found"
            };
        }
        
        // Find all arcs with L=1 that appear in ALL CAS
        const sharedArcs = this.findSharedArcsWithL1(casSet);
        
        if (sharedArcs.length > 0) {
            console.log(`Found ${sharedArcs.length} shared arc(s) with L=1:`, sharedArcs);
            return {
                pass: true,
                sharedArcs: sharedArcs,
                violations: [],
                message: `All CAS share ${sharedArcs.length} common arc(s) with L=1`
            };
        } else {
            console.log("No shared arc with L=1 found across all CAS");
            const violations = this.identifyViolations(casSet);
            return {
                pass: false,
                sharedArcs: [],
                violations: violations,
                message: "CAS do not exhibit generalized impedance - no shared constrained resource"
            };
        }
    }
    
    /**
     * Finds arcs with L=1 that appear in ALL CAS.
     * @param {Array<Graph>} casSet - Array of CAS.
     * @returns {Array<Object>} Array of shared arc objects.
     */
    static findSharedArcsWithL1(casSet) {
        if (casSet.length === 0) return [];
        
        // Map to track arc occurrences: arcId -> { count, edge }
        const arcOccurrences = new Map();
        
        // For each CAS, find unique arcs with L=1
        casSet.forEach((cas, casIndex) => {
            const arcsInThisCAS = new Set(); // Track unique arcs in this CAS
            
            cas.edges.forEach(edge => {
                if (edge.maxTraversals === 1) {
                    const arcId = this.getArcId(edge);
                    arcsInThisCAS.add(arcId);
                    
                    if (!arcOccurrences.has(arcId)) {
                        arcOccurrences.set(arcId, {
                            count: 0,
                            edge: edge,
                            casIndices: []
                        });
                    }
                }
            });
            
            // Increment count for each unique arc found in this CAS
            arcsInThisCAS.forEach(arcId => {
                const entry = arcOccurrences.get(arcId);
                entry.count++;
                entry.casIndices.push(casIndex);
            });
        });
        
        // Find arcs that appear in ALL CAS
        const sharedArcs = [];
        arcOccurrences.forEach((value, arcId) => {
            if (value.count === casSet.length) {
                sharedArcs.push({
                    id: arcId,
                    from: value.edge.from.id,
                    to: value.edge.to.id,
                    edge: value.edge,
                    casIndices: value.casIndices
                });
            }
        });
        
        return sharedArcs;
    }
    
    /**
     * Identifies which CAS violate generalized impedance and why.
     * @param {Array<Graph>} casSet - Array of CAS.
     * @returns {Array<Object>} Array of violation objects.
     */
    static identifyViolations(casSet) {
        const violations = [];
        
        // Analyze each CAS to understand why they don't share a common arc
        casSet.forEach((cas, index) => {
            const arcsWithL1 = cas.edges.filter(e => e.maxTraversals === 1);
            
            if (arcsWithL1.length === 0) {
                violations.push({
                    casIndex: index,
                    type: "no-constrained-arcs",
                    message: `CAS ${index + 1} has no arcs with L=1`,
                    vertices: cas.vertices.map(v => v.id)
                });
            } else {
                // Check which arcs with L=1 are NOT in other CAS
                const arcIds = arcsWithL1.map(e => this.getArcId(e));
                const uniqueArcs = this.findUniqueArcsNotInOthers(
                    arcIds, 
                    casSet, 
                    index
                );
                
                if (uniqueArcs.length > 0) {
                    violations.push({
                        casIndex: index,
                        type: "unique-constrained-arcs",
                        message: `CAS ${index + 1} has ${uniqueArcs.length} arc(s) with L=1 not shared with all others`,
                        uniqueArcs: uniqueArcs,
                        vertices: cas.vertices.map(v => v.id)
                    });
                }
            }
        });
        
        // Also identify pairs of CAS that don't share any arc with L=1
        for (let i = 0; i < casSet.length; i++) {
            for (let j = i + 1; j < casSet.length; j++) {
                const sharedBetweenPair = this.findSharedArcsBetweenTwo(
                    casSet[i], 
                    casSet[j]
                );
                
                if (sharedBetweenPair.length === 0) {
                    violations.push({
                        type: "no-shared-between-pair",
                        casIndices: [i, j],
                        message: `CAS ${i + 1} and CAS ${j + 1} share no arcs with L=1`
                    });
                }
            }
        }
        
        return violations;
    }
    
    /**
     * Finds arcs in the given list that don't appear in all other CAS.
     * @param {Array<string>} arcIds - Array of arc IDs to check.
     * @param {Array<Graph>} casSet - All CAS.
     * @param {number} excludeIndex - Index of CAS to exclude from comparison.
     * @returns {Array<string>} Array of arc IDs unique to this CAS.
     */
    static findUniqueArcsNotInOthers(arcIds, casSet, excludeIndex) {
        return arcIds.filter(arcId => {
            // Check if this arc appears in all other CAS
            for (let i = 0; i < casSet.length; i++) {
                if (i === excludeIndex) continue;
                
                const hasArc = casSet[i].edges.some(edge => {
                    return this.getArcId(edge) === arcId && edge.maxTraversals === 1;
                });
                
                if (!hasArc) {
                    return true; // This arc is NOT in this other CAS
                }
            }
            return false; // Arc appears in all other CAS
        });
    }
    
    /**
     * Finds arcs with L=1 shared between two specific CAS.
     * @param {Graph} cas1 - First CAS.
     * @param {Graph} cas2 - Second CAS.
     * @returns {Array<string>} Array of shared arc IDs.
     */
    static findSharedArcsBetweenTwo(cas1, cas2) {
        const cas1Arcs = new Set(
            cas1.edges
                .filter(e => e.maxTraversals === 1)
                .map(e => this.getArcId(e))
        );
        
        const sharedArcs = cas2.edges
            .filter(e => e.maxTraversals === 1)
            .filter(e => cas1Arcs.has(this.getArcId(e)))
            .map(e => this.getArcId(e));
        
        return sharedArcs;
    }
    
    /**
     * Creates a unique identifier for an arc.
     * @param {Edge} edge - The edge object.
     * @returns {string} Unique arc identifier.
     */
    static getArcId(edge) {
        return `${edge.from.id}->${edge.to.id}`;
    }
    
    /**
     * Creates a detailed report of generalized impedance analysis.
     * @param {Array<Graph>} casSet - Array of CAS.
     * @returns {Object} Detailed analysis report.
     */
    static generateDetailedReport(casSet) {
        const result = this.checkGeneralizedImpedance(casSet);
        
        const report = {
            totalCAS: casSet.length,
            passesGeneralizedImpedance: result.pass,
            sharedArcs: result.sharedArcs,
            violations: result.violations,
            summary: result.message,
            details: []
        };
        
        // Add details for each CAS
        casSet.forEach((cas, index) => {
            const arcsWithL1 = cas.edges.filter(e => e.maxTraversals === 1);
            report.details.push({
                casIndex: index,
                vertexCount: cas.vertices.length,
                edgeCount: cas.edges.length,
                arcsWithL1: arcsWithL1.length,
                arcsWithL1Ids: arcsWithL1.map(e => this.getArcId(e))
            });
        });
        
        return report;
    }
}