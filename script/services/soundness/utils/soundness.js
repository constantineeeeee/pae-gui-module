import { Graph } from '../models/Graph.js';
import { SoundnessCriteria } from './soundness-criteria.js';
import { GraphOperations } from './graph-operations.js';
import { utils } from './rdlt-utils.mjs';
import { Cycle } from './cycle.mjs';
import { TestJoins } from './joins.mjs';
import { Matrix } from './matrix.mjs';
import { ActivityProfile } from '../models/ActivityProfile.js';
import { Activity } from '../models/Activity.js';
import { CASExtractor } from './cas-extractor.js';
import { GeneralizedImpedance } from './generalized-impedance.js';
// No need to import visualizer here - it's used in soundness-service

/**
* Utility class for verifying soundness properties.
*/
export class Soundness {
    /** 
    * Verifies the relaxed soundness property of an RDLT by checking for
    * weakened proper termination and liveness conditions.
    * @param {Graph} graph - The graph to check.
    * @param {Graph} evsa - The vertex-simplified RDLTs to check.
    * @returns {boolean} - True if the RDLT is relaxed sound, false otherwise.
    */
    static checkRelaxedSound(graph, evsa) {

        const livenessViolations = [], weakenedPTViolations = [], criteria = [];;
        let level = 1; // Initialize level for the EVSA
        for(const rdlt of evsa) {
            // Clear activity profiles array of the graph object
            rdlt.activityProfiles = [];

            console.log("input graph for the relaxed soundness check: ", rdlt);
            // Get the source and sink vertices for the current RDLT
            const { source, sink } = utils.getSourceAndSinkVertices(rdlt);
                
            if (!source || !sink) {
                console.warn("Source or sink vertex not found in the graph.");
                return false; // If either source or sink is missing, the graph is not easy sound
            }

            const activities = new Set();

            // Undergo activity extraction to get all cases
            for (let i = 0; i < 50; i++) {
                const activityProfile = rdlt.extractActivityProfile(source.id, sink.id);

                // Serialize the activities array for uniqueness
                const serializedActivities = JSON.stringify(
                    activityProfile.activities.map(slot => Array.from(slot).sort())
                );

                // Add the serialized activities to the set if unique
                if (!activities.has(serializedActivities)) {
                    activities.add(serializedActivities);
                    console.log("Added unique activity profile:", activityProfile);
                } else {
                    console.log("Duplicate activity profile detected. Skipping...");
                }
            }

            console.log("Unique activities:", activities);

            // For every unique activity, check for proper termination and liveness
            let activitiesArray = [];
            for (const serializedActivity of activities) {
                const reachabilityConfigurations = JSON.parse(serializedActivity);
                const activity = new Activity(source, sink, reachabilityConfigurations);

                activitiesArray.push(activity);
            }
            rdlt.activityProfile = new ActivityProfile(source, sink, activitiesArray);

            // Check for weakened proper termination condition
            const weakenedProperTermination = SoundnessCriteria.hasWeakenedProperTermination(rdlt.activityProfile);
            
            // Check for liveness
            const liveness = SoundnessCriteria.hasLiveness(rdlt.activityProfile, rdlt.vertices);
            
            if (!(weakenedProperTermination.pass && liveness.pass)) {
                // Add level information to liveness violations
                liveness.violations.forEach(violation => {
                    livenessViolations.push({
                        ...violation,
                        level: `L${level}` // Add the level information
                    });
                });

                // Add level information to weakened proper termination violations
                weakenedProperTermination.violations.forEach(violation => {
                    weakenedPTViolations.push({
                        ...violation,
                        level: `L${level}` // Add the level information
                    });
                });
            }

            criteria.push({
                pass: weakenedProperTermination.pass,
                description: weakenedProperTermination.pass ? 
                `Weakened Proper Termination (L${level}): Satisfied` :
                `Weakened Proper Termination (L${level}): Not Satisfied`
            });

            criteria.push({
                pass: liveness.pass,
                description: liveness.pass ? 
                `Liveness (L${level}): Satisfied` :
                `Liveness (L${level}): Not Satisfied`
            });

            level++;
        }

        if(weakenedPTViolations.length > 0 || livenessViolations.length > 0){
            return {
                pass: false, 
                message: "Relaxed Soundness Check was inconclusive",
                description: "The given RDLT did not satisfy relaxed soundness checks. Therefore more verification is needed.",
                violations: {
                    weakenedPTViolations,
                    livenessViolations
                },
                criteria: [
                    {   
                        pass: !(weakenedPTViolations.length > 0),
                        description: weakenedPTViolations.length > 0 
                        ? "Weakened Proper Termination (R): Not Satisfied" 
                        : "Weakened Proper Termination (R): Satisfied"
                    },
                    {   
                        pass: !(livenessViolations.length > 0),
                        description: livenessViolations.length > 0 
                        ? "Liveness (R): Not Satisfied" 
                        : "Liveness (R): Satisfied"
                    },
                    ...criteria
                ]
            };
        }
        else{
            return {
                pass: true, 
                message: "The model is Relaxed Sound",
                description: "The given RDLT satisfied relaxed soundness checks. Therefore it is relaxed sound.",
                criteria:[
                    {   
                        pass: true,
                        description: "Weakened Proper Termination (R): Satisfied"
                    },
                    {   
                        pass: true,
                        description: "Liveness (R): Satisfied"
                    },
                    ...criteria
                ]
            };
        }
    }
    
    /**
    * Verifies the classical soundness property of an RDLT by checking for
    * L-safeness based on the cycle structure and join conditions of the RDLT.
    *
    * @param {Graph} graph - The graph to check.
    * @param {Object[]} R1 - the Level-1 vertex-simplified RDLT.
    * @param {Object[]} R2 - the Level-2 vertex-simplified RDLT.
    * @returns {{
    *   pass: boolean,
    *   message: string,
    *   description: string,
    *   violations?: Object[]
    * }} An object indicating the result of the classical soundness check:
    * - `pass`: `true` if the RDLT is classical sound (L-safe), `false` if more verification is needed.
    * - `message`: a general message about the result.
    * - `description`: a more descriptive message about the result.
    * - `violations` (optional): if the RDLT fails L-safeness, this field contains an array of violation details
    *   as determined by `matrixInstance.getViolations()`.
    */
    static checkClassicalSound(graph, R1, R2) {
        // Pre-processing
        const cycleR1 = new Cycle(R1); // Cycle detection for R1
        
        //Evaluate the cycle; will populate Cycle_List
        cycleR1.evaluateCycle();
        
        const cycleListR1 = cycleR1.cycleList; // Get the cycle list for R1
        
        // Evaluate JOIN conditions and determine the appropriate matrix operations
        console.log("Testing joins in RBS...");
        const check = TestJoins.checkSimilarTargetVertexAndUpdate(R1, R2);
        
        if(check){
            console.log("All are OR-JOINs, using only R1 data.");
            
            // Convert to matrix representation of Asoy
            const matrixInstance = new Matrix(R1, cycleListR1);
            
            let l_safe_vector, matrix;
            // Perform matrix evaluation to determine L-safeness
            ({ l_safe_vector, matrix } = matrixInstance.evaluateLSafeness());
            
            console.log(`Matrix evaluation result: (R1 only): ${l_safe_vector === true ? 'RDLT is L-Safe' : 'RDLT is not L-Safe'}`);
            console.log(`Generated Matrix`);
            console.log("|  Arc  |   |x|   |y|  |l|  |c||eRU||cv| |op|  |cycle| |loop||out| |safe|");
            matrixInstance.printMatrix();
            console.log("-".repeat(60));
            
            // Print result for L-safeness
            
            if(l_safe_vector){
                console.log("Verification: RDLT is CLASSICAL SOUND");
                return {
                    pass: true, 
                    message: "The model is Classical Sound", 
                    description: "The model has satisfied L-safeness checks and therefore is classical sound.",
                    criteria: [
                        {   
                            pass: true,
                            description: "JOIN-Safeness (R): Satisfied"
                        },
                        {   
                            pass: true,
                            description: "LOOP-Safeness (R): Satisfied" 
                        },
                        {   
                            pass: true,
                            description: "Safeness (R): Satisfied" 
                        },
                        {   
                            pass: true,
                            description: "JOIN-Safeness (L1): Satisfied"
                        },
                        {   
                            pass: true,
                            description: "LOOP-Safeness (L1): Satisfied" 
                        },
                        {   
                            pass: true,
                            description: "Safeness (L1): Satisfied" 
                        }
                    ]
                };
            }
            else{
                console.log("Verification: Needs further verification");
                console.log("-".repeat(60));
                
                const violations = matrixInstance.getViolations();
                return {
                    pass: false, 
                    violations, 
                    message: "Classical Soundness check was inconclusive", 
                    description: "The model has not satisfied L-safeness checks and therefore needs further verification.",
                    criteria: [
                        {   
                            pass: matrixInstance.checkIfAllPositive("join"),
                            description: matrixInstance.checkIfAllPositive("join") 
                            ? "JOIN-Safeness (R): Satisfied" 
                            : "JOIN-Safeness (R): Not Satisfied"
                        },
                        {   
                            pass: matrixInstance.checkIfAllPositive("loop"),
                            description: matrixInstance.checkIfAllPositive("loop")
                            ? "LOOP-Safeness (R): Satisfied" 
                            : "LOOP-Safeness (R): Not Satisfied"
                        },
                        {   
                            pass: matrixInstance.checkIfAllPositive("safe"),
                            description: matrixInstance.checkIfAllPositive("safe")
                            ? "Safeness (R): Satisfied" 
                            : "Safeness (R): Not Satisfied"
                        },
                        {   
                            pass: matrixInstance.checkIfAllPositive("join"),
                            description: matrixInstance.checkIfAllPositive("join") 
                            ? "JOIN-Safeness (L1): Satisfied" 
                            : "JOIN-Safeness (L1): Not Satisfied"
                        },
                        {   
                            pass: matrixInstance.checkIfAllPositive("loop"),
                            description: matrixInstance.checkIfAllPositive("loop")
                            ? "LOOP-Safeness (L1): Satisfied" 
                            : "LOOP-Safeness (L1): Not Satisfied"
                        },
                        {   
                            pass: matrixInstance.checkIfAllPositive("safe"),
                            description: matrixInstance.checkIfAllPositive("safe")
                            ? "Safeness (L1): Satisfied" 
                            : "Safeness (L1): Not Satisfied"
                        }
                    ]
                };
            }
        }
        else{
            console.log("RDLT contains other JOINs. Evaluating both R1 and R2");
            
            const matrixInstance = new Matrix([...R1, ...R2], cycleListR1);
            
            // Perform matrix operations to determine L-safeness
            let l_safe_vector, matrix;
            ({ l_safe_vector, matrix } = matrixInstance.evaluateLSafeness());
                        
            console.log(`Matrix evaluation result: (R1 and R2): ${l_safe_vector === true ? 'RDLT is L-Safe' : 'RDLT is not L-Safe'}`);
            
            if(l_safe_vector){
                console.log("RDLT is CLASSICAL SOUND");
                return {
                    pass: true, 
                    message: "The model is Classical Sound", 
                    description: "The model has satisfied L-safeness checks and therefore is classical sound.",
                    criteria: [
                        {   
                            pass: true,
                            description: "JOIN-Safeness (R): Satisfied"
                        },
                        {   
                            pass: true,
                            description: "LOOP-Safeness (R): Satisfied" 
                        },
                        {   
                            pass: true,
                            description: "Safeness (R): Satisfied" 
                        },
                        {   
                            pass: true,
                            description: "JOIN-Safeness (L1 & L2): Satisfied"
                        },
                        {   
                            pass: true,
                            description: "LOOP-Safeness (L1 & L2): Satisfied" 
                        },
                        {   
                            pass: true,
                            description: "Safeness (L1 & L2): Satisfied" 
                        }
                    ]
                };
            }
            else{
                console.log("Verification: Needs further verification");
                console.log("-".repeat(60));
                
                const violations = matrixInstance.getViolations();
                return {
                    pass: false,
                    violations, 
                    message: "Classical Soundness check was inconclusive", 
                    description: "The model has not satisfied L-safeness checks and therefore needs further verification.",
                    criteria: [
                        {   
                            pass: matrixInstance.checkIfAllPositive("join"),
                            description: matrixInstance.checkIfAllPositive("join") 
                            ? "JOIN-Safeness (R): Satisfied" 
                            : "JOIN-Safeness (R): Not Satisfied"
                        },
                        {   
                            pass: matrixInstance.checkIfAllPositive("loop"),
                            description: matrixInstance.checkIfAllPositive("loop")
                            ? "LOOP-Safeness (R): Satisfied" 
                            : "LOOP-Safeness (R): Not Satisfied"
                        },
                        {   
                            pass: matrixInstance.checkIfAllPositive("safe"),
                            description: matrixInstance.checkIfAllPositive("safe")
                            ? "Safeness (R): Satisfied" 
                            : "Safeness (R): Not Satisfied"
                        },
                        {   
                            pass: matrixInstance.checkIfAllPositive("join"),
                            description: matrixInstance.checkIfAllPositive("join") 
                            ? "JOIN-Safeness (L1 & L2): Satisfied" 
                            : "JOIN-Safeness (L1 & L2): Not Satisfied"
                        },
                        {   
                            pass: matrixInstance.checkIfAllPositive("loop"),
                            description: matrixInstance.checkIfAllPositive("loop")
                            ? "LOOP-Safeness (L1 & L2): Satisfied" 
                            : "LOOP-Safeness (L1 & L2): Not Satisfied"
                        },
                        {   
                            pass: matrixInstance.checkIfAllPositive("safe"),
                            description: matrixInstance.checkIfAllPositive("safe")
                            ? "Safeness (L1 & L2): Satisfied" 
                            : "Safeness (L1 & L2): Not Satisfied"
                        }
                    ]
                };
            }
        }
    }
    
    /** 
    * Verifies the easy soundness property of an RDLT by checking for
    * the existence of a contraction path from the source to the sink.
    * @param {Graph} graph - The original RDLT.
    * @param {Graph[]} evsa - Collection of vertex-simplified RDLTs.
    * @returns {{
    *   pass: boolean,
    *   message: string,
    *   description: string,
    *   violations?: Object[]
    * }} An object indicating the result of the easy soundness check:
    * - `pass`: `true` if the RDLT is easy sound, `false` if more verification is needed.
    * - `message`: a general message about the result.
    * - `description`: a more descriptive message about the result.
    * - `violations` (optional): if the RDLT does not have a contraction path from
    * source to sink, this field contains an array of violation details
    */
    static checkEasySound(graph, evsa) {
        console.log("received evsa", evsa); // Debug: Check the received evsa

        let level = 1;
        const criteria = [], violations = []; // Store criteria details per level
        for (const rdlt of evsa) {
            // Get the source and sink vertices for the current RDLT
            const { source, sink } = utils.getSourceAndSinkVertices(rdlt);

            if (!source || !sink) {
                console.warn("Source or sink vertex not found in the graph.");
                return {
                    pass: false,
                    message: "Easy Soundness Check was inconclusive",
                    description: "Source or sink vertex is missing in the graph.",
                    violations: []
                };
            }

            // Get the contracted RDLT by applying the graph contraction strategy
            const contractedRDLT = GraphOperations.contractGraph(rdlt, source);
            let rdltClear = false; // Flag to indicate if a contraction path is found for the current RDLT
            const reachableVertices = new Set(); // Track reachable vertices
            const blockingVertices = []; // Track blocking vertices

            // Check if the contracted RDLT has a contraction path from the source to the sink
            for (const vertex of contractedRDLT.vertices) {
                const mergedVertexIds = vertex.id.split('_');

                // Add all reachable vertices to the set
                if (mergedVertexIds.includes(source.id)) {
                    mergedVertexIds.forEach(id => reachableVertices.add(id));
                }

                // Check if both the source and sink IDs are present in the merged vertex components
                if (mergedVertexIds.includes(source.id) && mergedVertexIds.includes(sink.id)) {
                    console.log(`There is a contraction path from ${source.id} to ${sink.id} in the contracted RDLT.`);
                    rdltClear = true;
                    break;
                }
            }

            // Identify blocking vertices (vertices not reachable from the source)
            for (const vertex of rdlt.vertices) {
                if (!reachableVertices.has(vertex.id) && vertex.id !== sink.id) {
                    blockingVertices.push(vertex);
                }
            }

            // If no contraction path is found, return the blocking vertices as violations
            if (!rdltClear) {
                violations.push(...blockingVertices.map(vertex => ({
                    id: vertex.id,
                    level: `L${level}` // Append level to the message
                })));

                criteria.push({
                    pass: false,
                    description: `Contraction Path From Source to Sink (L${level}): Not Satisfied`
                });
            }
            else{
                criteria.push({
                    pass: true,
                    description: `Contraction Path From Source to Sink (L${level}): Satisfied`
                });
            }

            level++; // Increment the level for the next EVSA
        }

        if(violations.length > 0){
            return {
                pass: false,
                message: "Easy Soundness Check was inconclusive",
                description: "There was no contraction path from the source to the sink. Therefore, further verification is needed to verify easy soundness.",
                violations,
                criteria: [
                    {
                        pass: false, 
                        description: "Contraction Path From Source to Sink (R): Satisfied" 
                    },
                    ...criteria
                ]
            }; // Return true if all RDLTs have a contraction path
        }
        else{
            return {
                pass: true,
                message: "The model is Easy Sound",
                description: "A contraction path from the source to the sink was found. Therefore, the given RDLT is easy sound.",
                violations: [],
                criteria: [
                    {   
                        pass: true, 
                        description: "Contraction Path From Source to Sink (R): Satisfied" 
                    },
                    ...criteria
                ]
            }; // Return true if all RDLTs have a contraction path
        }
    }
    
    /** 
    * Verifies the weak soundness property of an RDLT by checking for
    * the deadlock-tolerance of the RDLT.
    * @param {Graph} graph - The original RDLT.
    * @param {Graph[]} evsa - Collection of vertex-simplified RDLTs.
    * @param {Object} matrixInput - the RDLT & EVSA representation objects in readable format for matrix operations of Asoy 
    * @returns {{
    *   pass: boolean,
    *   message: string,
    *   description: string,
    *   violations?: Object[]
    * }} An object indicating the result of the weak soundness check:
    * - `pass`: `true` if the RDLT is weak sound, `false` if more verification is needed.
    * - `message`: a general message about the result.
    * - `description`: a more descriptive message about the result.
    * - `violations` (optional): if the RDLT failed weak soundness check, this field contains an array of violation details
    */
    static checkWeakSound(graph, evsa, matrixInput) {
        const violations = []; // Store violation details, messages, and types
        const criteria = []; // Store criteria details per level

        // Pre-processing for Asoy's matrix operations
        const cycleR1 = new Cycle(matrixInput.R1); // Cycle detection for R1
        cycleR1.evaluateCycle(); // Evaluate the cycle
        const cycleListR1 = cycleR1.cycleList; // Get the cycle list for R1

        // Evaluate JOIN conditions and determine the appropriate matrix operations
        console.log("Testing joins in RBS...");
        const check = TestJoins.checkSimilarTargetVertexAndUpdate(matrixInput.R1, matrixInput.R2);

        // Check for safe CA and loop-safe NCA
        let safeCA_loopSafeNCA = true, matrixViolations = [];
        if (check) {
            console.log("All are OR-JOINs, using only R1 data.");
            const matrixInstance = new Matrix(matrixInput.R1, cycleListR1);
            const { pass } = matrixInstance.evaluateSafeLoopSafe();
            if (!pass){
                safeCA_loopSafeNCA = false;
                matrixViolations = matrixInstance.getSafeLoopSafeViolations();
                criteria.push({
                    pass: false,
                    description: "Safe CA and Loop-Safe NCA (L1): Not Satisfied"
                });
            }
            else{
                criteria.push({
                    pass: true,
                    description: "Safe CA and Loop-Safe NCA (L1): Satisfied"
                });
            }
        } else {
            console.log("RDLT contains other JOINs. Evaluating both R1 and R2");
            const matrixInstance = new Matrix([...matrixInput.R1, ...matrixInput.R2], cycleListR1);
            const { pass } = matrixInstance.evaluateSafeLoopSafe();
            
            if (!pass){
                safeCA_loopSafeNCA = false;
                matrixViolations = matrixInstance.getSafeLoopSafeViolations();
                criteria.push({
                    pass: false,
                    description: "Safe CA and Loop-Safe NCA (L1 & L2): Not Satisfied"
                });
            }
            else{
                criteria.push({
                    pass: false,
                    description: "Safe CA and Loop-Safe NCA (L1 & L2): Satisfied"
                });
            }
        }

        if (matrixViolations.length > 0) {
            console.log("Formatting matrix violations...");
            matrixViolations.forEach(violation => {
                // Determine the level based on the r-id
                const level = violation['r-id'].startsWith("R1") ? "L1" : "L2";

                // Append the level to the message
                violations.push({
                    id: violation.arc, // Map the "arc" field to the "id"
                    message: `${violation.type} (${level})`, // Append the level to the type
                    type: "asoy-edge"
                });
            });
        }

        // Checking for deadlock resolving
        let alldeadlockResolving = true, weakenedJoinSafe = true;
        let deadlockPoints = [], reachedVertices = [], level = 1;
        for (const rdlt of evsa) {
            const { source, sink } = utils.getSourceAndSinkVertices(rdlt);
            if (!source || !sink) {
                console.warn("Source or sink vertex not found in the graph.");
                return false;
            }

            ({ deadlockPoints, reachedVertices } = GraphOperations.gatherDeadlockPoints(rdlt, source));
            const deadlockResolving = SoundnessCriteria.isDeadlockResolving(rdlt, deadlockPoints, reachedVertices, sink);
            if (!deadlockResolving.pass) {
                alldeadlockResolving = false;
                deadlockResolving.violations.forEach(violation => {
                    violations.push({
                        id: violation.id,
                        message: `Parent of deadlock point has no contraction path to the sink (L${level})`, // Append level to the message
                        type: "vertex"
                    });
                });

                criteria.push({
                    pass: false,
                    description: `Deadlock-Resolving (L${level}): Not Satisfied` // Append level to the description
                })
            }
            else{
                criteria.push({
                    pass: true,
                    description: `Deadlock-Resolving (L${level}): Satisfied` // Append level to the description
                })
            }

            // Checking for Weakened JOIN-Safe L values
            console.log("Checking weakened join l-safe for deadlock points: ", deadlockPoints);
            for (const deadlock of deadlockPoints) {
                const incomingArcs = rdlt.edges.filter(edge => edge.to.id === deadlock.id);
                let weakenedJoinSafeForThisDeadlock = true; // Track if weakened JOIN-safe L-values are satisfied for this deadlock

                if (incomingArcs.length !== 2) {
                    weakenedJoinSafeForThisDeadlock = false;
                    violations.push({
                        id: deadlock.id,
                        message: `Deadlock point does not have exactly two incoming arcs. (L${level})`, // Append level
                        type: "vertex"
                    });
                } else {
                    const joinVertex1 = incomingArcs[0].from;
                    const joinVertex2 = incomingArcs[1].from;

                    // Criterion 1: Shared split origin
                    const splitOrigin = GraphOperations.findUniqueSplitOrigin(rdlt, joinVertex1, joinVertex2, deadlock);
                    if (splitOrigin === null) {
                        weakenedJoinSafeForThisDeadlock = false;
                        violations.push({
                            id: deadlock.id,
                            message: `No shared split origin found for the deadlock point. (L${level})`, // Append level
                            type: "vertex"
                        });
                    } else {
                        const pathU = GraphOperations.findSimplePath(rdlt, splitOrigin, joinVertex1);
                        const pathV = GraphOperations.findSimplePath(rdlt, splitOrigin, joinVertex2);

                        if (!pathU) {
                            weakenedJoinSafeForThisDeadlock = false;
                            violations.push({
                                id: joinVertex1.id,
                                message: `No unique simple path found from split origin to join vertex. (L${level})`, // Append level
                                type: "vertex"
                            });
                        } else {
                            pathU.push(deadlock);
                        }

                        if (!pathV) {
                            weakenedJoinSafeForThisDeadlock = false;
                            violations.push({
                                id: joinVertex2.id,
                                message: `No unique simple path found from split origin to join vertex. (L${level})`, // Append level
                                type: "vertex"
                            });
                        } else {
                            pathV.push(deadlock);
                        }

                        // Criterion 2: No Unrelated Processes
                        if (pathU && pathV && (!GraphOperations.noInterruptions(rdlt, pathU) || !GraphOperations.noInterruptions(rdlt, pathV))) {
                            weakenedJoinSafeForThisDeadlock = false;
                            violations.push({
                                id: deadlock.id,
                                message: `Unrelated processes detected on one or both paths. (L${level})`, // Append level
                                type: "vertex"
                            });
                        }

                        // Criterion 3: No branching out
                        if (pathU && pathV && (!GraphOperations.noBranchingOut(rdlt, pathU) || !GraphOperations.noBranchingOut(rdlt, pathV))) {
                            weakenedJoinSafeForThisDeadlock = false;
                            violations.push({
                                id: deadlock.id,
                                message: `Branching out detected on one or both paths. (L${level})`, // Append level
                                type: "vertex"
                            });
                        }

                        // Criterion 5: Duplicate Values
                        if (incomingArcs[0].constraint !== "" && incomingArcs[1].constraint !== "") {
                            const checkDuplicateConditions = GraphOperations.checkDuplicateValues(incomingArcs[0], incomingArcs[1], rdlt);
                            if (!checkDuplicateConditions.pass) {
                                weakenedJoinSafeForThisDeadlock = false;
                                for (const violation of checkDuplicateConditions.violations) {
                                    violations.push({
                                        id: `${violation.from}, ${violation.to}`,
                                        message: `Duplicate constraint values not satisfied. (L${level})`, // Append level
                                        type: "edge"
                                    });
                                }
                            }
                        }

                        // Criterion 6: AND-Join L-Value Match
                        if (incomingArcs[0].constraint !== "" && incomingArcs[1].constraint !== "") {
                            if (incomingArcs[0].maxTraversals !== incomingArcs[1].maxTraversals) {
                                weakenedJoinSafeForThisDeadlock = false;
                                violations.push({
                                    id: `${incomingArcs[0].from.id}, ${incomingArcs[0].to.id}`,
                                    message: `L-values for AND-Join do not match. (L${level})`, // Append level
                                    type: "edge"
                                }, {
                                    id: `${incomingArcs[1].from.id}, ${incomingArcs[1].to.id}`,
                                    message: `L-values for AND-Join do not match. (L${level})`, // Append level
                                    type: "edge"
                                });
                            }
                        }
                    }
                }

                // Add to criteria if weakened JOIN-safe L-values are not satisfied for this deadlock
                if (!weakenedJoinSafeForThisDeadlock) {
                    weakenedJoinSafe = false;
                    criteria.push({
                        pass: false,
                        description: `Weakened JOIN-Safe L-Values (L${level}): Not Satisfied` // Append level to the description
                    });
                }
                else{
                    criteria.push({
                        pass: true,
                        description: `Weakened JOIN-Safe L-Values (L${level}): Satisfied` // Append level to the description
                    });
                }
            }
            level++;
        }

        let pass, message, description;
        if (alldeadlockResolving && safeCA_loopSafeNCA && weakenedJoinSafe) {
            pass = true;
            message = "The model is Weak Sound";
            description = "The given RDLT passed deadlock-tolerance checks. Therefore it is Weak Sound.";
        } else {
            pass = false;
            message = "Weak sound verification is inconclusive";
            description = "The given RDLT did not pass deadlock-tolerance checks. Therefore more verification is needed.";
        }
        console.log("Violations: ", violations);
        return {
            pass,
            message,
            description,
            criteria:[
                {   
                    pass: safeCA_loopSafeNCA,
                    description: safeCA_loopSafeNCA
                            ? "Safe CA and Loop-Safe NCA (R): Satisfied" 
                            : "Safe CA and Loop-Safe NCA (R): Not Satisfied"
                },
                {   
                    pass: alldeadlockResolving,
                    description: alldeadlockResolving
                            ? "Deadlock-Resolving (R): Satisfied" 
                            : "Deadlock-Resolving (R): Not Satisfied"
                },
                {   
                    pass: weakenedJoinSafe,
                    description: weakenedJoinSafe
                            ? "Weakened JOIN-Safe L-Values (R): Satisfied" 
                            : "Weakened JOIN-Safe L-Values (R): Not Satisfied"
                },
                ...criteria
            ],
            violations
        };
    }

    /**
     * Verifies the lazy soundness property of an RDLT by checking the two
     * formal conditions from Definition 1.24:
     *   1. Option to Complete  – at least one activity (CAS) reaches the sink.
     *   2. Proper Termination (Weakened) – exactly one activity can complete;
     *      verified operationally via Generalized Impedance when multiple CAS
     *      exist, or trivially when only one CAS exists.
     *
     * The criteria array returned ALWAYS contains all three visible entries
     * (Option to Complete, Proper Termination (Weakened), Generalized Impedance)
     * so the UI can show every condition and its status regardless of outcome.
     *
     * @param {Graph} graph - The original RDLT.
     * @param {Graph[]} evsa - Array containing [R1, R2, …] vertex-simplified RDLTs.
     * @returns {{
     *   pass: boolean,
     *   message: string,
     *   description: string,
     *   violations: Array,
     *   criteria: Array,
     *   sharedArcs?: Array,
     *   visualizationData: Object
     * }}
     */
    static checkLazySound(graph, evsa) {
        console.log("Starting lazy soundness verification...");

        const violations = [];

        // --------------- visualization data shell ---------------
        const visualizationData = {
            originalRDLT: graph,
            R1: null,
            R2: null,
            source: null,
            sink: null,
            masR1: [],
            masR2: [],
            casSet: [],
            impedanceResult: null,
            finalResult: null
        };

        // --------------- source / sink ---------------
        const { source, sink } = utils.getSourceAndSinkVertices(graph);
        visualizationData.source = source;
        visualizationData.sink = sink;

        if (!source || !sink) {
            // Cannot even begin – surface all three conditions as failed
            visualizationData.finalResult = {
                pass: false,
                message: "Lazy Soundness Check Failed",
                description: "Source or sink vertex not found."
            };

            return {
                pass: false,
                message: "Lazy Soundness Check Failed",
                description: "Source or sink vertex not found.",
                violations: [],
                criteria: [
                    { pass: false, description: "Option to Complete: Not Satisfied" },
                    { pass: false, description: "Proper Termination (Weakened): Not Satisfied" },
                    { pass: false, description: "Generalized Impedance: Not Satisfied" }
                ],
                visualizationData
            };
        }

        // --------------- build R1 / R2 ---------------
        const R1 = evsa[0];
        let R2 = null;
        if (evsa.length > 1) {
            R2 = new Graph();
            for (let i = 1; i < evsa.length; i++) {
                const r2i = evsa[i];
                if (r2i && r2i.vertices) {
                    r2i.vertices.forEach(v => {
                        if (!R2.vertices.some(existing => existing.id === v.id)) {
                            R2.addVertex(v);
                        }
                    });
                }
                if (r2i && r2i.edges) {
                    r2i.edges.forEach(e => {
                        if (!R2.edges.some(existing => existing.from.id === e.from.id && existing.to.id === e.to.id)) {
                            R2.addEdge(e);
                        }
                    });
                }
            }
        }
        visualizationData.R1 = R1;
        visualizationData.R2 = R2;

        // --------------- contraction path gate (Option to Complete) ---------------
        // Before extracting MAS/CAS, verify that a contraction path from source to
        // sink actually exists at every EVSA level.  The MAS extractor uses pure
        // DFS which ignores C-attribute constraints; a model whose OR-join is
        // blocked by unsatisfied C-conditions would produce phantom paths that are
        // not executable activities.  This gate uses the same contraction strategy
        // as Easy Soundness (GraphOperations.contractGraph) to prevent false
        // positives.
        let contractionPathExists = true;
        const contractionFailedLevels = [];
        const contractionBlockingVertices = [];

        for (let i = 0; i < evsa.length; i++) {
            const rdlt = evsa[i];
            const { source: levelSource, sink: levelSink } = utils.getSourceAndSinkVertices(rdlt);

            if (!levelSource || !levelSink) {
                contractionPathExists = false;
                contractionFailedLevels.push(`L${i + 1}`);
                continue;
            }

            const contractedRDLT = GraphOperations.contractGraph(rdlt, levelSource);
            let pathFound = false;
            const reachableVertices = new Set();

            for (const vertex of contractedRDLT.vertices) {
                const mergedVertexIds = vertex.id.split('_');
                if (mergedVertexIds.includes(levelSource.id)) {
                    mergedVertexIds.forEach(id => reachableVertices.add(id));
                }
                if (mergedVertexIds.includes(levelSource.id) && mergedVertexIds.includes(levelSink.id)) {
                    pathFound = true;
                    break;
                }
            }

            if (!pathFound) {
                contractionPathExists = false;
                contractionFailedLevels.push(`L${i + 1}`);

                // Collect blocking vertices for violation reporting
                for (const vertex of rdlt.vertices) {
                    if (!reachableVertices.has(vertex.id) && vertex.id !== levelSink.id) {
                        contractionBlockingVertices.push({
                            id: vertex.id,
                            level: `L${i + 1}`
                        });
                    }
                }
            }

            console.log(`Contraction path check L${i + 1}: ${pathFound ? 'PASS' : 'FAIL'}`);
        }

        if (!contractionPathExists) {
            // Short-circuit: no contraction path → Option to Complete fails.
            // Do NOT proceed with MAS/CAS extraction (DFS would find phantom paths).
            console.log(`Contraction path failed at level(s): ${contractionFailedLevels.join(', ')}`);

            const failDescription = `No contraction path from source to sink at level(s) ${contractionFailedLevels.join(', ')}. ` +
                `C-attribute constraints block reachability. No CAS generated therefore not lazy soundness.`;

            violations.push({
                type: "no-path",
                message: failDescription,
                vertices: contractionBlockingVertices.map(v => v.id)
            });

            visualizationData.finalResult = {
                pass: false,
                message: "Lazy Soundness Check Failed",
                description: failDescription
            };

            return {
                pass: false,
                message: "Lazy Soundness Check Failed",
                description: failDescription,
                violations,
                criteria: [
                    { pass: false, description: "Option to Complete: Not Satisfied" },
                    { pass: false, description: "Proper Termination (Weakened): Not Satisfied" },
                    { pass: false, description: "Generalized Impedance: Not Applicable" }
                ],
                visualizationData
            };
        }

        // --------------- extract CAS ---------------
        console.log("Extracting Complete Activity Structures...");
        const { casSet, masR1, masR2 } = CASExtractor.extractAllCASWithDetails(graph, R1, R2, source, sink);

        visualizationData.masR1 = masR1;
        visualizationData.masR2 = masR2;
        visualizationData.casSet = casSet;
        console.log(`Extracted ${casSet.length} CAS`);

        // --------------- evaluate each formal condition ---------------

        // --- Condition 1: Option to Complete ---
        // Satisfied iff at least one CAS was extracted (sink is reachable).
        const optionToComplete = casSet.length > 0;
        console.log(`Option to Complete: ${optionToComplete}`);

        // --- Condition 2 & 3: Proper Termination (Weakened) & Generalized Impedance ---
        // These two are evaluated together because Generalized Impedance is the
        // operational mechanism that guarantees Proper Termination when multiple
        // CAS exist.  We still run (or deliberately skip) the impedance check in
        // every branch so that the UI can show its status.
        let properTerminationWeakened = false;   // exactly one activity can complete
        let generalizedImpedance      = false;   // all CAS share an arc with L=1
        let impedanceResult           = null;

        if (casSet.length === 0) {
            // No CAS at all – both downstream conditions trivially fail.
            properTerminationWeakened = false;
            generalizedImpedance      = false;
            impedanceResult = {
                pass: false,
                sharedArcs: [],
                violations: [{ type: "no-path", message: "No CAS exist – generalized impedance cannot be evaluated." }],
                message: "Not applicable – no CAS extracted"
            };

            violations.push({
                type: "no-path",
                message: "Sink is unreachable from source",
                vertices: []
            });

        } else if (casSet.length === 1) {
            // Single CAS – proper termination is trivially satisfied because
            // there is no competing activity.  Generalized impedance is also
            // considered satisfied (vacuously true – no pair to impede).
            console.log("Single CAS found – proper termination trivially satisfied.");
            properTerminationWeakened = true;
            generalizedImpedance      = true;   // vacuously true
            impedanceResult = {
                pass: true,
                sharedArcs: [],
                violations: [],
                message: "Only one CAS exists – generalized impedance is vacuously satisfied"
            };

        } else {
            // Multiple CAS – run generalized impedance check.
            console.log(`Multiple CAS (${casSet.length}) found – checking generalized impedance`);
            impedanceResult = GeneralizedImpedance.checkGeneralizedImpedance(casSet);
            generalizedImpedance = impedanceResult.pass;

            // Proper termination (weakened) holds iff generalized impedance holds,
            // because the shared constrained arc (L=1) ensures only one activity
            // can complete (Lemma 1.1 in the paper).
            properTerminationWeakened = impedanceResult.pass;

            if (!impedanceResult.pass) {
                violations.push(...impedanceResult.violations);
            }
        }

        visualizationData.impedanceResult = impedanceResult;

        // --------------- assemble the overall result ---------------
        const overallPass = optionToComplete && properTerminationWeakened;

        // The criteria array always contains all three formal conditions so the
        // UI can show every one regardless of which path was taken.
        const criteria = [
            {
                pass: optionToComplete,
                description: optionToComplete
                    ? "Option to Complete: Satisfied"
                    : "Option to Complete: Not Satisfied"
            },
            {
                pass: properTerminationWeakened,
                description: properTerminationWeakened
                    ? "Proper Termination (Weakened): Satisfied"
                    : "Proper Termination (Weakened): Not Satisfied"
            },
            {
                pass: generalizedImpedance,
                description: generalizedImpedance
                    ? "Generalized Impedance: Satisfied"
                    : "Generalized Impedance: Not Satisfied"
            }
        ];

        // --------------- build human-readable description ---------------
        let description;
        if (overallPass) {
            if (casSet.length === 1) {
                description = "Exactly one Complete Activity Structure exists. Only one activity can complete.";
            } else {
                description = `All ${casSet.length} Complete Activity Structures share a common constrained resource (L=1). Only one activity can complete.`;
            }
        } else {
            // Enumerate which conditions failed for a clear diagnostic.
            const failedConditions = [];
            if (!optionToComplete)            failedConditions.push("Option to Complete");
            if (!properTerminationWeakened)   failedConditions.push("Proper Termination (Weakened)");
            if (!generalizedImpedance && casSet.length > 1) failedConditions.push("Generalized Impedance");

            if (casSet.length === 0) {
                description = "No Complete Activity Structure found. The sink is unreachable from the source.";
            } else {
                description = `Multiple Complete Activity Structures exist but they do not exhibit generalized impedance. Multiple activities may be able to complete. Failed: ${failedConditions.join(", ")}.`;
            }
        }

        visualizationData.finalResult = {
            pass: overallPass,
            message: overallPass ? "The model is Lazy Sound" : "Lazy Soundness Check Failed",
            description
        };

        return {
            pass: overallPass,
            message: overallPass ? "The model is Lazy Sound" : "Lazy Soundness Check Failed",
            description,
            violations,
            sharedArcs: impedanceResult?.sharedArcs,
            criteria,
            visualizationData
        };
    }
}