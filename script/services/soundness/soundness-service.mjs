// import { spawn } from 'child_process';
import { VertexType } from './models/VertexType.js';
import {isInbridge, isOutbridge, buildArcMap, buildRBSMatrix, buildVertexMap} from '../../utils.mjs';
import { Vertex } from './models/Vertex.js';
import { Edge } from './models/Edge.js';
import { ResetBoundSubsystem } from './models/ResetBoundSubsystem.js';
import { ProcessR1 } from './utils/create_r1.mjs';
import { InputRDLT } from './utils/input-rdlt.mjs';
import { Activity } from './models/Activity.js';
import { Graph } from './models/Graph.js';
import { Soundness } from './utils/soundness.js';
import { GraphOperations } from './utils/graph-operations.js';
import { processR2 } from './utils/create_r2.mjs';
import { utils } from './utils/rdlt-utils.mjs';

function getInBridges(model, arcMap, vertexMap) {
    
    console.log("arcMap:", arcMap);
    console.log("vertexMap:", vertexMap);
    
    const rbsMatrix = buildRBSMatrix(vertexMap, model.arcs);
    
    console.log("rbsMatrix:", rbsMatrix);
    
    const inBridgesUIDs = new Set();
    const inBridges = new Set(); // Set to collect "fromVertexIdentifier, toVertexIdentifier" strings
    
    for (const arc of model.arcs) {
        if (isInbridge(arc.uid, arcMap, rbsMatrix)) {
            inBridgesUIDs.add(arc.uid); // Collect UIDs of in-bridge arcs
        }
    }
    
    console.log("UIDs of in-bridge arcs:", inBridgesUIDs);
    
    // Map UIDs to their corresponding "fromVertexIdentifier, toVertexIdentifier" and add to inBridges
    for (const uid of inBridgesUIDs) {
        const arc = arcMap[uid]; // Retrieve the arc using the UID
        const fromVertex = vertexMap[arc.fromVertexUID]; // Retrieve the "from" vertex
        const toVertex = vertexMap[arc.toVertexUID]; // Retrieve the "to" vertex
        
        if (fromVertex && toVertex) {
            const entry = `${fromVertex.identifier}, ${toVertex.identifier}`;
            inBridges.add(entry); // Add the formatted string to the inBridges set
        }
    }
    
    return inBridges;
}

function getOutBridges(model, arcMap, vertexMap) {
    
    const rbsMatrix = buildRBSMatrix(vertexMap, model.arcs);
    const outBridgesUIDs = new Set();
    const outBridges = new Set(); // Set to collect "fromVertexIdentifier, toVertexIdentifier" strings
    
    for (const arc of model.arcs) {
        if (isOutbridge(arc.uid, arcMap, rbsMatrix)) {
            outBridgesUIDs.add(arc.uid); // Collect UIDs of out-bridge arcs
        }
    }
    
    console.log("UIDs of out-bridge arcs:", outBridgesUIDs);
    
    // Map UIDs to their corresponding "fromVertexIdentifier, toVertexIdentifier" and add to outBridges
    for (const uid of outBridgesUIDs) {
        const arc = arcMap[uid]; // Retrieve the arc using the UID
        const fromVertex = vertexMap[arc.fromVertexUID]; // Retrieve the "from" vertex
        const toVertex = vertexMap[arc.toVertexUID]; // Retrieve the "to" vertex
        
        if (fromVertex && toVertex) {
            const entry = `${fromVertex.identifier}, ${toVertex.identifier}`;
            outBridges.add(entry); // Add the formatted string to the outBridges set
        }
    }
    
    return outBridges;
}

export function mapGUIModelToSoundness(model, source, sink){
    const arcMap = buildArcMap(model.arcs);
    const vertexMap = buildVertexMap(model.components);

    const inVertices = getInBridges(model, arcMap, vertexMap);
    const outVertices = getOutBridges(model, arcMap, vertexMap);
    
    console.log("model:", model);
    console.log("inVertices:", inVertices);
    console.log('outVertices:', outVertices);
    
    const input_rdlt = new InputRDLT(model, inVertices, outVertices);
    const evsa = input_rdlt.evaluate();
    let R2;
    if(input_rdlt.centersList.length === 0){
        R2 = [];
    }
    else{
        R2 = processR2(evsa.Rs);
    }
    
    console.log("rdlt:", input_rdlt);
    console.log("evsa:", evsa);
    
    const R1 = ProcessR1(input_rdlt.model.arcs, evsa.R1.R1, input_rdlt.centersList, input_rdlt.in_list, input_rdlt.out_list, R2);
    
    console.log("R1:", R1);
    console.log("R2:", R2);
    
    const { rdltGraph, r2Graphs, r1Graph } = mapToGraphs(input_rdlt, R2, R1);
    console.log("rdltGraph:", rdltGraph);
    console.log("r2Graphs:", r2Graphs);
    console.log("r1Graph:", r1Graph);
    
    let combinedEvsa;
    if(r2Graphs.length > 0){
        combinedEvsa = [r1Graph, ...r2Graphs.map(item => item.graph)];
    }
    else{
        combinedEvsa = [r1Graph];
    }

    return {rdltGraph, combinedEvsa};
}

export function verifySoundness(model, source, sink, soundnessNotion) {
    console.log({ model, source, sink, soundnessNotion });
    
    const arcMap = buildArcMap(model.arcs);
    const vertexMap = buildVertexMap(model.components);

    const inVertices = getInBridges(model, arcMap, vertexMap);
    const outVertices = getOutBridges(model, arcMap, vertexMap);
    
    console.log("model:", model);
    console.log("inVertices:", inVertices);
    console.log('outVertices:', outVertices);
    
    const input_rdlt = new InputRDLT(model, inVertices, outVertices);
    const evsa = input_rdlt.evaluate();
    let R2;
    if(input_rdlt.centersList.length === 0){
        R2 = [];
    }
    else{
        R2 = processR2(evsa.Rs);
    }
    
    console.log("rdlt:", input_rdlt);
    console.log("evsa:", evsa);
    
    const R1 = ProcessR1(input_rdlt.model.arcs, evsa.R1.R1, input_rdlt.centersList, input_rdlt.in_list, input_rdlt.out_list, R2);
    
    console.log("R1:", R1);
    console.log("R2:", R2);
    
    const { rdltGraph, r2Graphs, r1Graph } = mapToGraphs(input_rdlt, R2, R1);
    console.log("rdltGraph:", rdltGraph);
    console.log("[DEBUG] rdltGraph edges L-values:", rdltGraph.edges.map(e => `${e.from.id}→${e.to.id} L=${e.maxTraversals}`));
    console.log("r2Graphs:", r2Graphs);
    console.log("r1Graph:", r1Graph);
    
    let combinedEvsa;
    if(r2Graphs.length > 0){
        combinedEvsa = [r1Graph, ...r2Graphs.map(item => item.graph)];
    }
    else{
        combinedEvsa = [r1Graph];
    }
    
    let soundnessPass, soundnessTitle, soundnessDescription, soundnessCriteria;
    let soundnessViolation = {arcs: [], vertices: []};
    let soundnessViolationRemarks = {arcs: {}, vertices: {}};
    let lazyResult = null;   // hoisted so the post-switch lazy instance builder can read it
    let theoreticalNote = null;  // hoisted so it's accessible in the return statement
    console.log('[soundness-service] theoreticalNote initialized:', theoreticalNote);
    switch (soundnessNotion) {
        case 'easy':
            console.time("Easy Soundness Verification");
            const easyResult = Soundness.checkEasySound(rdltGraph, combinedEvsa);
            console.timeEnd("Easy Soundness Verification"); // Logs the runtime

            // Format output
            soundnessPass = easyResult.pass;
            soundnessTitle = easyResult.message;
            soundnessDescription = easyResult.description;
            soundnessCriteria = easyResult.criteria;

            const mappedViolations = mapVerticesToUIDs(easyResult.violations, vertexMap);

            soundnessViolation.vertices = mappedViolations.map(violation => violation.uid);
            for (const violation of mappedViolations) {
                soundnessViolationRemarks.vertices[violation.uid] = `Vertex cannot be used for contraction (${violation.level})`;
            }

            break;

        case 'classical':
            console.time("Classical Soundness Verification");
            const classicalResult = Soundness.checkClassicalSound(input_rdlt, R1, R2);
            console.timeEnd("Classical Soundness Verification"); // Logs the runtime

            console.log("Classical Soundness Result:", classicalResult);

            // Format output
            soundnessPass = classicalResult.pass;
            soundnessTitle = classicalResult.message;
            soundnessDescription = classicalResult.description;
            soundnessCriteria = classicalResult.criteria;

            if (classicalResult.violations) {
                classicalResult.violations.forEach(violation => {
                    const transformedArcMap = utils.transformArcMap(arcMap);
                    const arcIdentifiers = violation.arc.replace(/[()]/g, '').split(', '); // Extract identifiers (e.g., ["x6", "x9"])
                    const fromUID = Object.keys(vertexMap).find(key => vertexMap[key].identifier === arcIdentifiers[0]);
                    const toUID = Object.keys(vertexMap).find(key => vertexMap[key].identifier === arcIdentifiers[1]);

                    if (!fromUID || !toUID) {
                        console.warn(`No UID found for arc: ${violation.arc}`);
                        return;
                    }

                    const arcKey = `${fromUID}, ${toUID}`; // Transform to UID-based key
                    console.log("arcKey:", arcKey);
                    console.log("transformed arc map: ", transformedArcMap);

                    const matchingArcs = transformedArcMap[arcKey];

                    if (matchingArcs) {
                        const matchedArc = matchingArcs.find(arc =>
                            (!violation['c-attribute'] || arc.C === violation['c-attribute']) &&
                            (!violation['l-attribute'] || arc.L === violation['l-attribute'])
                        );

                        if (matchedArc) {
                            console.log(`Mapped r-id: ${violation['r-id']} to UID: ${matchedArc.uid}`);
                            const violationMessage = violation.violation || ""; // Fallback to an empty string if undefined

                            const level = violation['r-id'].startsWith("R1") ? "L1" : "L2";

                            if (!soundnessViolation.arcs.includes(matchedArc.uid)) {
                                soundnessViolation.arcs.push(matchedArc.uid);
                            }

                            if (soundnessViolationRemarks.arcs[matchedArc.uid]) {
                                soundnessViolationRemarks.arcs[matchedArc.uid] += `; ${violation.type} (${level}): ${violationMessage}`;
                            } else {
                                soundnessViolationRemarks.arcs[matchedArc.uid] = `${violation.type} (${level}): ${violationMessage}`;
                            }
                        } else {
                            console.warn(`No exact match found for arc: ${violation.arc}`);
                        }
                    } else {
                        console.warn(`No match found for arc: ${violation.arc}`);
                    }
                });
            }

            break;

        case 'relaxed':
            console.time("Relaxed Soundness Verification");
            const relaxedResult = Soundness.checkRelaxedSound(rdltGraph, combinedEvsa);
            console.timeEnd("Relaxed Soundness Verification"); // Logs the runtime

            console.log("Violations: ", relaxedResult.violations);

            // Format output
            soundnessPass = relaxedResult.pass;
            soundnessTitle = relaxedResult.message;
            soundnessDescription = relaxedResult.description;
            soundnessCriteria = relaxedResult.criteria;

            if (relaxedResult.violations) {
                const mappedWeakenedPTViolations = mapVerticesToUIDs(relaxedResult.violations.weakenedPTViolations, vertexMap);
                const mappedLivenessViolations = mapVerticesToUIDs(relaxedResult.violations.livenessViolations, vertexMap);

                soundnessViolation.vertices = mappedWeakenedPTViolations.map(violation => violation.uid);
                soundnessViolation.vertices = mappedLivenessViolations.map(violation => violation.uid);

                for (const violation of mappedWeakenedPTViolations) {
                    soundnessViolationRemarks.vertices[violation.uid] = `Fails Proper Termination (${violation.level})`;
                }
                for (const violation of mappedLivenessViolations) {
                    soundnessViolationRemarks.vertices[violation.uid] = `Vertex is not used in any activity (${violation.level})`;
                }
            }

            break;

        case 'weak':
            console.time("Weak Soundness Verification");
            const matrixInput = {
                input_rdlt,
                R1,
                R2
            }; // Group the objects in Asoy's format so we can reuse her matrix operations
            const weakResult = Soundness.checkWeakSound(rdltGraph, combinedEvsa, matrixInput);
            console.timeEnd("Weak Soundness Verification"); // Logs the runtime

            // Format output
            soundnessPass = weakResult.pass;
            soundnessTitle = weakResult.message;
            soundnessDescription = weakResult.description;
            soundnessCriteria = weakResult.criteria;

            if (weakResult.violations) {
                const vertexMap = buildVertexMap(model.components);

                weakResult.violations.forEach(violation => {
                    if (violation.type === "asoy-edge") {
                        const transformedArcMap = utils.transformArcMap(arcMap);
                        const arcIdentifiers = violation.id.replace(/[()]/g, '').split(', '); // Extract identifiers (e.g., ["x6", "x9"])
                        const fromUID = Object.keys(vertexMap).find(key => vertexMap[key].identifier === arcIdentifiers[0]);
                        const toUID = Object.keys(vertexMap).find(key => vertexMap[key].identifier === arcIdentifiers[1]);

                        if (!fromUID || !toUID) {
                            console.warn(`No UID found for arc: ${violation.arc}`);
                            return;
                        }

                        const arcKey = `${fromUID}, ${toUID}`; // Transform to UID-based key
                        console.log("arcKey:", arcKey);
                        console.log("transformed arc map: ", transformedArcMap);

                        const matchingArcs = transformedArcMap[arcKey];

                        if (matchingArcs) {
                            const matchedArc = matchingArcs.find(arc =>
                                (!violation['c-attribute'] || arc.C === violation['c-attribute']) &&
                                (!violation['l-attribute'] || arc.L === violation['l-attribute'])
                            );

                            if (matchedArc) {
                                console.log(`Mapped r-id: ${violation['r-id']} to UID: ${matchedArc.uid}`);
                                const violationMessage = violation.violation || ""; // Fallback to an empty string if undefined

                                if (!soundnessViolation.arcs.includes(matchedArc.uid)) {
                                    soundnessViolation.arcs.push(matchedArc.uid);
                                }

                                if (soundnessViolationRemarks.arcs[matchedArc.uid]) {
                                    soundnessViolationRemarks.arcs[matchedArc.uid] += `; ${violation.message}`;
                                } else {
                                    soundnessViolationRemarks.arcs[matchedArc.uid] = `${violation.message}`;
                                }
                            } else {
                                console.warn(`No exact match found for arc: ${violation.arc}`);
                            }
                        } else {
                            console.warn(`No match found for arc: ${violation.arc}`);
                        }   
                    }
                    else if (violation.type === "vertex") {
                        const mappedVertex = mapVerticesToUIDs([violation], vertexMap);
                        const uid = mappedVertex.map(vertex => vertex.uid).filter(uid => uid !== null); // Filter out null UIDs if necessary
                        
                        if (!soundnessViolation.vertices.includes(...uid)) {
                            soundnessViolation.vertices.push(...uid);
                        }

                        if (soundnessViolationRemarks.vertices[uid]) {
                            soundnessViolationRemarks.vertices[uid] += `; ${violation.message}`;
                        } else {
                            soundnessViolationRemarks.vertices[uid] = `${violation.message}`;
                        }
                    }
                    else if(violation.type === "edge"){
                        const transformedArcMap = utils.transformArcMap(arcMap);
                        const arcIdentifiers = violation.id.replace(/[()]/g, '').split(', '); // Extract identifiers (e.g., ["x6", "x9"])\
                        const fromUID = Object.keys(vertexMap).find(key => vertexMap[key].identifier === arcIdentifiers[0]);
                        const toUID = Object.keys(vertexMap).find(key => vertexMap[key].identifier === arcIdentifiers[1]);

                        if (!fromUID || !toUID) {
                            console.warn(`No UID found for arc: ${violation.id}`);
                            return;
                        }

                        const arcKey = `${fromUID}, ${toUID}`; // Transform to UID-based key
                        console.log("arcKey:", arcKey);
                        console.log("transformed arc map: ", transformedArcMap);

                        const matchingArcs = transformedArcMap[arcKey];

                        if (matchingArcs) {
                            const matchedArc = matchingArcs.find(arc =>
                                (!violation['c-attribute'] || arc.C === violation['c-attribute']) &&
                                (!violation['l-attribute'] || arc.L === violation['l-attribute'])
                            );

                            if (matchedArc) {
                                console.log(`Mapped r-id: ${violation['r-id']} to UID: ${matchedArc.uid}`);
                                const violationMessage = violation.violation || ""; // Fallback to an empty string if undefined

                                if (!soundnessViolation.arcs.includes(matchedArc.uid)) {
                                    soundnessViolation.arcs.push(matchedArc.uid);
                                }

                                if (soundnessViolationRemarks.arcs[matchedArc.uid]) {
                                    soundnessViolationRemarks.arcs[matchedArc.uid] += `; ${violation.message}`;
                                } else {
                                    soundnessViolationRemarks.arcs[matchedArc.uid] = `${violation.message}`;
                                }
                            } else {
                                console.warn(`No exact match found for arc: ${violation.arc}`);
                            }
                        } else {
                            console.warn(`No match found for arc: ${violation.arc}`);
                        }
                    }

                });
            }
            break;
        case 'lazy':
            console.time("Lazy Soundness Verification");

            console.log("=== SOUNDNESS SERVICE DEBUG ===");
            console.log("rdltGraph:", rdltGraph);
            console.log("combinedEvsa:", combinedEvsa);
            console.log("combinedEvsa length:", combinedEvsa?.length);
            console.log("combinedEvsa[0] (R1):", combinedEvsa[0]);
            console.log("combinedEvsa[1] (R2):", combinedEvsa[1]);
            console.log("==============================");

            
            lazyResult = Soundness.checkLazySound(rdltGraph, combinedEvsa);
            console.timeEnd("Lazy Soundness Verification");

            console.log("Lazy Soundness Result:", lazyResult);

            // Detect theoretical notes based on the lazy soundness result
            // theoreticalNote is already declared at function scope
            const vizData = lazyResult.visualizationData || {};
            const casCount = vizData.casSet ? vizData.casSet.length : 0;

            if (soundnessNotion === 'lazy' && lazyResult.pass) {
                if (casCount === 1) {
                    // Corollary 3.2.7: Single CAS → automatically lazy sound
                    theoreticalNote = {
                        theorem: "Corollary 3.2.7",
                        statement: "An RDLT R is lazy sound if and only if there is exactly one maximal activity derivable from R.",
                        explanation: "Since only one CAS exists, there is exactly one maximal activity. Therefore, there is no alternative path for an activity to traverse, satisfying the weakened proper termination requirement."
                    };
                }
                // Note: Theorem 3.2.6 (classical without parallel → lazy) would require
                // classical soundness verification data, which isn't available here.
                // That check would go in the classical soundness case.
            } else if (soundnessNotion === 'lazy' && !lazyResult.pass && casCount > 1) {
                // When lazy fails with multiple CAS, it could be Theorem 3.2.8 scenario
                // (classical with parallel activities → not lazy), but we'd need to
                // confirm classical soundness first. For now, we don't add a note
                // since we can't be certain without that data.
            }

            // Format output
            soundnessPass = lazyResult.pass;
            soundnessTitle = lazyResult.message;
            soundnessDescription = lazyResult.description;
            soundnessCriteria = lazyResult.criteria;

            if (lazyResult.violations && lazyResult.violations.length > 0) {
                lazyResult.violations.forEach(violation => {
                    if (violation.type === "vertex" || violation.type === "no-path" || violation.casIndex !== undefined) {
                        // Handle vertex violations (includes CAS-level violations that list affected vertices)
                        const violationVertices = violation.vertices || [];
                        violationVertices.forEach(vertexId => {
                            const uid = Object.keys(vertexMap).find(key => vertexMap[key].identifier === vertexId);
                            if (uid && !soundnessViolation.vertices.includes(uid)) {
                                soundnessViolation.vertices.push(uid);
                            }
                            if (uid) {
                                soundnessViolationRemarks.vertices[uid] = violation.message || "Lazy soundness violation";
                            }
                        });
                    }
                    // Handle arc-level violations from generalized impedance failure
                    if (violation.type === "unique-constrained-arcs" && violation.uniqueArcs) {
                        violation.uniqueArcs.forEach(arcId => {
                            // arcId is "fromId->toId"
                            const parts = arcId.split("->");
                            if (parts.length === 2) {
                                const fromUID = Object.keys(vertexMap).find(key => vertexMap[key].identifier === parts[0].trim());
                                const toUID = Object.keys(vertexMap).find(key => vertexMap[key].identifier === parts[1].trim());
                                if (fromUID && toUID) {
                                    const transformedArcMap = utils.transformArcMap(arcMap);
                                    const arcKey = `${fromUID}, ${toUID}`;
                                    const matchingArcs = transformedArcMap[arcKey];
                                    if (matchingArcs) {
                                        matchingArcs.forEach(matchedArc => {
                                            if (!soundnessViolation.arcs.includes(matchedArc.uid)) {
                                                soundnessViolation.arcs.push(matchedArc.uid);
                                            }
                                            soundnessViolationRemarks.arcs[matchedArc.uid] = violation.message || "Arc not shared across all CAS";
                                        });
                                    }
                                }
                            }
                        });
                    }
                    // Handle no-shared-between-pair violations (highlight all arcs with L=1 in the pair)
                    if (violation.type === "no-shared-between-pair" && lazyResult.sharedArcs === undefined) {
                        // Mark it as a general violation on vertices involved in both CAS
                        const msg = violation.message || "CAS pair does not share a constrained resource";
                        // No specific arc to highlight; the CAS-level vertex violations above cover this
                        console.log("Lazy soundness pair violation:", msg);
                    }
                });
            }
            break;
    }
    
    // --------------- helper: Graph → { vertices: UID[], arcs: UID[] } ---------------
    // Each MAS / CAS Graph has .vertices[].id and .edges[].from.id / .to.id
    // where .id is the *identifier* string (e.g. "x1").  vertexMap is keyed by
    // GUI UID and each entry has .identifier.  transformArcMap is keyed by
    // "fromUID, toUID" and maps to arrays of arc objects with .uid.
    function graphToUIDs(graph) {
        if (!graph || !graph.vertices) return { vertices: [], arcs: [] };

        const transformedArcMap = utils.transformArcMap(arcMap);
        const vertexUIDs = [];
        const arcUIDs   = [];

        // --- vertices ---
        for (const v of graph.vertices) {
            const uid = Object.keys(vertexMap).find(
                key => vertexMap[key].identifier === v.id
            );
            if (uid && !vertexUIDs.includes(Number(uid))) {
                vertexUIDs.push(Number(uid));
            }
        }

        // --- arcs (edges) ---
        for (const e of graph.edges) {
            const fromUID = Object.keys(vertexMap).find(
                key => vertexMap[key].identifier === e.from.id
            );
            const toUID = Object.keys(vertexMap).find(
                key => vertexMap[key].identifier === e.to.id
            );
            if (fromUID && toUID) {
                const arcKey     = `${fromUID}, ${toUID}`;
                const candidates = transformedArcMap[arcKey];
                if (candidates) {
                    // If the edge carries a constraint, prefer the matching one;
                    // otherwise take all arcs between this pair (handles ε / parallel arcs).
                    for (const candidate of candidates) {
                        if (!arcUIDs.includes(candidate.uid)) {
                            arcUIDs.push(candidate.uid);
                        }
                    }
                }
            }
        }

        return { vertices: vertexUIDs, arcs: arcUIDs };
    }

    // --------------- build extra instances for lazy soundness ---------------
    let lazyInstances = [];   // appended after "Main Model"

    if (soundnessNotion === 'lazy' && lazyResult) {
        const vizData = lazyResult.visualizationData || {};

        // --- MAS instances (one per MAS in R1, then R2) ---
        // MAS displays ACTUAL L-values from edges (preserves cycle arcs where L>1)
        if (vizData.masR1) {
            console.log("[DEBUG] masR1 edges L-values:");
            vizData.masR1.forEach((mas, idx) => {
                console.log(`  MAS R1-${idx+1}:`, mas.edges.map(e => `${e.from.id}→${e.to.id} L=${e.maxTraversals}`));
                
                const uids = graphToUIDs(mas);
                
                // Build arcOverrides using ACTUAL L-values from MAS edges
                const arcOverrides = {};
                mas.edges.forEach(edge => {
                    const fromUID = Object.keys(vertexMap).find(
                        key => vertexMap[key].identifier === edge.from.id
                    );
                    const toUID = Object.keys(vertexMap).find(
                        key => vertexMap[key].identifier === edge.to.id
                    );
                    if (fromUID && toUID) {
                        const arcKey = `${fromUID}, ${toUID}`;
                        const transformedArcMap = utils.transformArcMap(arcMap);
                        const candidates = transformedArcMap[arcKey];
                        if (candidates && candidates.length > 0) {
                            const arcUID = candidates[0].uid;
                            const originalArc = arcMap[arcUID];
                            if (originalArc) {
                                arcOverrides[arcUID] = {
                                    C: originalArc.C || "ϵ",
                                    L: edge.maxTraversals  // Use actual MAS L-value (preserves cycle arcs)
                                };
                            }
                        }
                    }
                });
                
                lazyInstances.push({
                    name: `MAS R1 – ${idx + 1}`,
                    evaluation: {
                        conclusion: {
                            pass: true,
                            title: `MAS R1 – ${idx + 1}`,
                            description: `Maximal Activity Structure ${idx + 1} extracted from R1.`
                        },
                        criteria: [],
                        violating:        { arcs: [], vertices: [] },
                        violatingRemarks: { arcs: {},  vertices: {} }
                    },
                    model: uids,
                    options: { 
                        suppressRBS: true, 
                        forceControllerType: true, 
                        useModelStyling: true,
                        arcOverrides: arcOverrides
                    }
                });
            });
        }
        if (vizData.masR2 && vizData.masR2.length > 0) {
            vizData.masR2.forEach((mas, idx) => {
                const uids = graphToUIDs(mas);
                
                // Build arcOverrides using ACTUAL L-values from MAS edges
                const arcOverrides = {};
                mas.edges.forEach(edge => {
                    const fromUID = Object.keys(vertexMap).find(
                        key => vertexMap[key].identifier === edge.from.id
                    );
                    const toUID = Object.keys(vertexMap).find(
                        key => vertexMap[key].identifier === edge.to.id
                    );
                    if (fromUID && toUID) {
                        const arcKey = `${fromUID}, ${toUID}`;
                        const transformedArcMap = utils.transformArcMap(arcMap);
                        const candidates = transformedArcMap[arcKey];
                        if (candidates && candidates.length > 0) {
                            const arcUID = candidates[0].uid;
                            const originalArc = arcMap[arcUID];
                            if (originalArc) {
                                arcOverrides[arcUID] = {
                                    C: originalArc.C || "ϵ",
                                    L: edge.maxTraversals  // Use actual MAS L-value
                                };
                            }
                        }
                    }
                });
                
                lazyInstances.push({
                    name: `MAS R2 – ${idx + 1}`,
                    evaluation: {
                        conclusion: {
                            pass: true,
                            title: `MAS R2 – ${idx + 1}`,
                            description: `Maximal Activity Structure ${idx + 1} extracted from R2.`
                        },
                        criteria: [],
                        violating:        { arcs: [], vertices: [] },
                        violatingRemarks: { arcs: {},  vertices: {} }
                    },
                    model: uids,
                    options: { 
                        suppressRBS: true, 
                        forceControllerType: true, 
                        useModelStyling: true,
                        arcOverrides: arcOverrides
                    }
                });
            });
        }

        // --- CAS instances ---
        if (vizData.casSet) {
            console.log("[DEBUG] CAS edges L-values:");

            // Pre-compute whether any arc is shared across ALL CAS (with L!=1)
            // so the CAS description can reference it.
            const allCAS = vizData.casSet;
            let sharedNonL1Exists = false;
            if (!lazyResult.pass && allCAS.length > 0) {
                const candidates = (allCAS[0].edges || []).filter(e => e.maxTraversals !== 1);
                sharedNonL1Exists = candidates.some(edge => {
                    const fromId = edge.from?.id ?? edge.from;
                    const toId   = edge.to?.id   ?? edge.to;
                    const c      = edge.constraint ?? 'ϵ';
                    return allCAS.every(cas =>
                        (cas.edges || []).some(e =>
                            (e.from?.id ?? e.from) === fromId &&
                            (e.to?.id   ?? e.to)   === toId   &&
                            (e.constraint ?? 'ϵ')  === c
                        )
                    );
                });
            }

            vizData.casSet.forEach((cas, idx) => {
                console.log(`  CAS ${idx+1}:`, cas.edges.map(e => `${e.from.id}→${e.to.id} L=${e.maxTraversals}`));

                const uids = graphToUIDs(cas);
                
                // Build arcOverrides for CAS: use the actual L-values from CAS edges (which include eRU)
                const arcOverrides = {};
                cas.edges.forEach(edge => {
                    const fromUID = Object.keys(vertexMap).find(
                        key => vertexMap[key].identifier === edge.from.id
                    );
                    const toUID = Object.keys(vertexMap).find(
                        key => vertexMap[key].identifier === edge.to.id
                    );
                    if (fromUID && toUID) {
                        const arcKey = `${fromUID}, ${toUID}`;
                        const transformedArcMap = utils.transformArcMap(arcMap);
                        const candidates = transformedArcMap[arcKey];
                        if (candidates && candidates.length > 0) {
                            const arcUID = candidates[0].uid;
                            const originalArc = arcMap[arcUID];
                            if (originalArc) {
                                arcOverrides[arcUID] = {
                                    C: originalArc.C || "ϵ",
                                    L: edge.maxTraversals
                                };
                            }
                        }
                    }
                });

                // Description for not-lazy-sound case points to the Shared Arc tab
                let casDescription;
                if (lazyResult.pass) {
                    casDescription = `CAS ${idx + 1} participates in a lazy-sound model.`;
                } else if (sharedNonL1Exists) {
                    casDescription = `CAS ${idx + 1} – see the "Shared Arc" tab for the arc shared across all CAS (L ≠ 1).`;
                } else {
                    casDescription = `CAS ${idx + 1} – there is no arc shared across all CAS. See the "Shared Arc" tab.`;
                }

                lazyInstances.push({
                    name: `CAS ${idx + 1}`,
                    evaluation: {
                        conclusion: {
                            pass: lazyResult.pass,
                            title: lazyResult.pass ? "Lazy Sound" : "Not Lazy Sound",
                            description: casDescription
                        },
                        criteria: [],
                        violating:        { arcs: [], vertices: [] },
                        violatingRemarks: { arcs: {},  vertices: {} }
                    },
                    model: uids,
                    options: { 
                        suppressRBS: true, 
                        forceControllerType: true, 
                        useModelStyling: true,
                        arcOverrides: arcOverrides
                    }
                });
            });
        }

        // --- Full-RDLT arc-highlight instance (shared OR violating, mutually exclusive) ---
        // When lazy sound: highlight the shared L=1 arcs that satisfy generalized impedance.
        // When not lazy sound: highlight the L=1 arcs that are NOT shared (the violators).
        // Both show the complete input RDLT so the arcs are seen in full context.
        if (lazyResult.pass && lazyResult.sharedArcs && lazyResult.sharedArcs.length > 0) {
            // ---- SATISFIED path ----
            // Algorithm 3 is existential: it only needs ONE witness arc (x, y)
            // with L=1 that is common to every CAS to confirm generalized
            // impedance.  Figure 7 of the manuscript highlights exactly that
            // single witness.  We resolve only the first entry in sharedArcs
            // (the witness) and stop — not every L=1 arc that happens to appear
            // in all CAS.
            const sharedArcUIDs  = [];
            const sharedRemarks  = {};
            const transformedArcMap = utils.transformArcMap(arcMap);

            const witness = lazyResult.sharedArcs[0]; // the single witness arc
            const fromUID = Object.keys(vertexMap).find(
                key => vertexMap[key].identifier === witness.from
            );
            const toUID = Object.keys(vertexMap).find(
                key => vertexMap[key].identifier === witness.to
            );
            if (fromUID && toUID) {
                const arcKey     = `${fromUID}, ${toUID}`;
                const candidates = transformedArcMap[arcKey];
                if (candidates) {
                    for (const c of candidates) {
                        sharedArcUIDs.push(c.uid);
                        sharedRemarks[c.uid] = `Shared constrained arc (${witness.from} → ${witness.to}), L=1 – generalized impedance satisfied`;
                    }
                }
            }

            lazyInstances.push({
                name: "Shared Arc",
                evaluation: {
                    conclusion: {
                        pass: true,
                        title: "Shared Constrained Arc (Witness)",
                        description: `All ${vizData.casSet ? vizData.casSet.length : 0} CAS share the arc (${witness.from} → ${witness.to}) with L=1. This is the witness that confirms generalized impedance.`
                    },
                    criteria: [],
                    violating:        { arcs: sharedArcUIDs, vertices: [] },
                    violatingRemarks: { arcs: sharedRemarks,  vertices: {} }
                }
                // no model / options — full RDLT with RBS intact, witness arc highlighted
            });

        } else if (!lazyResult.pass && vizData.impedanceResult && !vizData.impedanceResult.pass) {
            // ---- VIOLATED path ----
            // Instead of showing arcs with L=1 that are NOT shared (the old logic),
            // find arcs that ARE shared across ALL CAS but have L != 1.
            // These are arcs that could potentially become the generalized impedance
            // witness if their L-value were set to 1.
            // If no such arc exists, report that there is no shared arc.

            const casSet = vizData.casSet || [];
            const transformedArcMap = utils.transformArcMap(arcMap);
            const sharedNonL1UIDs  = [];
            const sharedNonL1Remarks = {};

            if (casSet.length > 0) {
                // Collect candidate arcs from first CAS that have L != 1
                const candidates = (casSet[0].edges || []).filter(edge =>
                    edge.maxTraversals !== 1
                );

                // Keep only those present in every other CAS (same from, to, constraint)
                const sharedNonL1Edges = candidates.filter(edge => {
                    const fromId = edge.from?.id ?? edge.from;
                    const toId   = edge.to?.id   ?? edge.to;
                    const c      = edge.constraint ?? 'ϵ';
                    return casSet.every(cas =>
                        (cas.edges || []).some(e =>
                            (e.from?.id ?? e.from) === fromId &&
                            (e.to?.id   ?? e.to)   === toId   &&
                            (e.constraint ?? 'ϵ')  === c
                        )
                    );
                });

                // Map to UI arc UIDs
                for (const edge of sharedNonL1Edges) {
                    const fromId = edge.from?.id ?? edge.from;
                    const toId   = edge.to?.id   ?? edge.to;
                    const fromUID = Object.keys(vertexMap).find(
                        key => vertexMap[key].identifier === fromId
                    );
                    const toUID = Object.keys(vertexMap).find(
                        key => vertexMap[key].identifier === toId
                    );
                    if (fromUID && toUID) {
                        const arcKey     = `${fromUID}, ${toUID}`;
                        const candidates = transformedArcMap[arcKey];
                        if (candidates) {
                            for (const c of candidates) {
                                if (!sharedNonL1UIDs.includes(c.uid)) {
                                    sharedNonL1UIDs.push(c.uid);
                                    sharedNonL1Remarks[c.uid] =
                                        `Shared across all ${casSet.length} CAS but L=${edge.maxTraversals ?? '?'} (not 1) — generalized impedance not satisfied`;
                                }
                            }
                        }
                    }
                }
            }

            const noSharedArc = sharedNonL1UIDs.length === 0;

            lazyInstances.push({
                name: "Shared Arc",
                evaluation: {
                    conclusion: {
                        pass: false,
                        title: noSharedArc
                            ? "No Shared Arc"
                            : "Shared Arc (L ≠ 1)",
                        description: noSharedArc
                            ? `There is no arc shared across all ${casSet.length} CAS. Generalized impedance cannot be satisfied.`
                            : `These arcs are shared across all ${casSet.length} CAS but have L ≠ 1. For generalized impedance, a shared arc must have L = 1.`
                    },
                    criteria: [],
                    violating:        { arcs: sharedNonL1UIDs, vertices: [] },
                    violatingRemarks: { arcs: sharedNonL1Remarks, vertices: {} }
                }
            });
        }
    }

    return {
        title: "Soundness Verification",
        instances: [
            {
                name: "Main Model",
                evaluation: {
                    conclusion: {
                        pass: soundnessPass,
                        title: soundnessTitle,
                        description: soundnessDescription
                    },
                    criteria: soundnessCriteria,
                    violating: {
                        arcs: soundnessViolation.arcs,
                        vertices: soundnessViolation.vertices
                    },
                    violatingRemarks: {
                        arcs: soundnessViolationRemarks.arcs,
                        vertices: soundnessViolationRemarks.vertices
                    },
                    ...(theoreticalNote && { theoreticalNote })  // Add theoretical note if present
                },
            },
            ...lazyInstances
        ]
        
    };
}

/**
* Maps RDLT, R2, and R1 data to their respective Graph models.
* @param {Object} rdlt - The RDLT model data.
* @param {Object[]} R2 - The R2 data (array of reset-bound subsystems).
* @param {Object[]} R1 - The R1 data (array of arcs).
* @returns {Object} An object containing the mapped Graph models for RDLT, R2, and R1.
*/
function mapToGraphs(rdlt, R2, R1) {
    const rdltGraph = new Graph();
    let r2Graphs; // Array to hold multiple R2 graphs
    const r1Graph = new Graph();

    // Map RDLT to Graph
    if (rdlt && rdlt.model && rdlt.model.components && rdlt.model.arcs) {
        console.log("Mapping RDLT to Graph...");

        // Add vertices with UIDs
        rdlt.model.components.forEach(component => {
            const vertex = new Vertex(
                component.uid, // Use the UID from the original model
                VertexType.ENTITY_OBJECT,
                {}, // Additional attributes can be added here
                component.identifier || '' // Use the identifier
            );
            rdltGraph.addVertex(vertex);
        });

        // Add edges with UIDs
        rdlt.model.arcs.forEach(arc => {
            const fromVertex = rdltGraph.vertices.find(v => v.id === arc.fromVertexUID);
            const toVertex = rdltGraph.vertices.find(v => v.id === arc.toVertexUID);
            const edge = new Edge(
                arc.uid, // Use the UID from the original model
                fromVertex,
                toVertex,
                arc.C,
                arc.L,
                [] // Additional attributes can be added here
            );
            rdltGraph.addEdge(edge);
        });

        // Map Reset-Bound Subsystems (RBS)
        if (rdlt.centersList && rdlt.centersList.length > 0) {
            console.log("Mapping Reset-Bound Subsystems...");
            rdlt.centersList.forEach(centerId => {
                const centerVertex = rdltGraph.vertices.find(v => v.id === centerId.uid);
                if (!centerVertex) {
                    console.error(`Center vertex with ID ${centerId.uid} not found in the graph.`);
                    return;
                }

                // Get members of the RBS (vertices connected to the center)
                const members = rdltGraph.edges
                    .filter(edge => edge.from.id === centerId.uid)
                    .map(edge => (edge.from.id === centerId.uid ? edge.to : edge.from));

                // Get in-bridges (arcs in in_list connected to members)
                const inBridges = rdlt.in_list
                    .map(entry => {
                        const [fromId, toId] = entry.split(', ');
                        const fromVertex = rdltGraph.vertices.find(v => v.name === fromId);
                        const toVertex = rdltGraph.vertices.find(v => v.name === toId);

                        // Find the edge in the graph
                        return rdltGraph.edges.find(edge => edge.from === fromVertex && edge.to === toVertex);
                    })
                    .filter(edge => edge && (members.includes(edge.to) || centerVertex === edge.to));

                // Get out-bridges (arcs in out_list connected to members)
                const outBridges = rdlt.out_list
                    .map(entry => {
                        const [fromId, toId] = entry.split(', ');
                        const fromVertex = rdltGraph.vertices.find(v => v.name === fromId);
                        const toVertex = rdltGraph.vertices.find(v => v.name === toId);
                        return rdltGraph.edges.find(edge => edge.from === fromVertex && edge.to === toVertex);
                    })
                    .filter(edge => edge && members.includes(edge.from));

                // Create and add the ResetBoundSubsystem
                const resetBoundSubsystem = new ResetBoundSubsystem(centerVertex, members, inBridges, outBridges);
                rdltGraph.addResetBoundSubsystem(resetBoundSubsystem);
            });
        }
    }

    // Map R2 to Graphs
    if (R2 && R2.length > 0) {
        console.log("Mapping R2 to Graphs...");

        // Group R2 entries by r_number
        const r2Groups = R2.reduce((groups, arc) => {
            const rNumber = arc['r-id'].split('-')[0]; // Extract r_number from r-id
            if (!groups[rNumber]) {
                groups[rNumber] = [];
            }
            groups[rNumber].push(arc);
            return groups;
        }, {});

        // Create a Graph for each group
        r2Graphs = Object.entries(r2Groups).map(([rNumber, arcs]) => {
            const graph = new Graph();
            console.log(`Creating Graph for R2 group: ${rNumber}`);

            arcs.forEach(arc => {
                const [fromId, toId] = arc.arc.split(', ');
                const fromVertex = graph.vertices.find(v => v.id === fromId) || new Vertex(fromId, VertexType.ENTITY_OBJECT, {}, fromId);
                const toVertex = graph.vertices.find(v => v.id === toId) || new Vertex(toId, VertexType.ENTITY_OBJECT, {}, toId);

                // Add vertices if not already present
                if (!graph.vertices.find(v => v.id === fromId)) graph.addVertex(fromVertex);
                if (!graph.vertices.find(v => v.id === toId)) graph.addVertex(toVertex);

                const edge = new Edge(
                    arc['r-id'], // Use the UID from the processed R2
                    fromVertex,
                    toVertex,
                    arc['c-attribute'],
                    parseInt(arc['l-attribute'], 10),
                    []
                );
                graph.addEdge(edge);
            });

            return { rNumber, graph };
        });

        console.log("Mapped R2 Graphs:", r2Graphs);
    } else {
        r2Graphs = [];
    }

    // Map R1 to Graph
    if (R1 && R1.length > 0) {
        console.log("Mapping R1 to Graph...");
        R1.forEach((arc, index) => {
            const [fromId, toId] = arc.arc.split(', ');
            const fromVertex = r1Graph.vertices.find(v => v.id === fromId) || new Vertex(fromId, VertexType.ENTITY_OBJECT, {}, fromId);
            const toVertex = r1Graph.vertices.find(v => v.id === toId) || new Vertex(toId, VertexType.ENTITY_OBJECT, {}, toId);

            if (!r1Graph.vertices.find(v => v.id === fromId)) r1Graph.addVertex(fromVertex);
            if (!r1Graph.vertices.find(v => v.id === toId)) r1Graph.addVertex(toVertex);

            const edge = new Edge(
                arc['r-id'],
                fromVertex,
                toVertex,
                arc['c-attribute'],
                parseInt(arc['l-attribute'], 10),
                []
            );
            
            // Transfer eRU if present (for abstract arcs)
            if (arc.eRU !== undefined && arc.eRU !== null) {
                edge.eRU = parseInt(arc.eRU, 10);
            }
            
            r1Graph.addEdge(edge);
        });
    }

    return { rdltGraph, r2Graphs, r1Graph };
}

export function getDeadlockPoints(model, input_source, input_sink){
    const {rdlt, combinedEvsa} = mapGUIModelToSoundness(model, input_source, input_sink);
    const arcMap = buildArcMap(model.arcs);
    const vertexMap = buildVertexMap(model.components);

    let deadlockPoints = [];
    for(const evsa of combinedEvsa){
        // Get the source and sink vertices for the current RDLT
        const { source, sink } = utils.getSourceAndSinkVertices(evsa);
        
        if (!source || !sink) {
            console.warn("Source or sink vertex not found in the graph.");
            return false; // If either source or sink is missing, the graph is not easy sound
        }

        deadlockPoints.push(...GraphOperations.gatherDeadlockPoints(evsa, source).deadlockPoints);
    }

    // Map deadlock points to objects with an `id` attribute
    const deadlockPointIDs = deadlockPoints.map(deadlockPoint => ({
        id: deadlockPoint.id
    }));

    const mappedVertices = mapVerticesToUIDs(deadlockPointIDs, vertexMap);
    const uids = mappedVertices.map(vertex => vertex.uid).filter(uid => uid !== null); // Filter out null UIDs if necessary

    return uids;
}

function mapVerticesToUIDs(vertices, vertexMap) {
    return vertices.map(vertex => {
        if (!vertex.id) {
            console.warn(`Vertex is missing an 'id' property:`, vertex);
            return { ...vertex, uid: null }; // Return the vertex with a null UID
        }

        // Normalize the ID if necessary (e.g., trim whitespace, convert case)
        const normalizedId = vertex.id.trim();
        const uid = Object.keys(vertexMap).find(key => vertexMap[key].identifier === normalizedId);

        if (uid) {
            return { ...vertex, uid: Number(uid) }; // Add the UID to the vertex object
        } else {
            console.warn(`No UID found for identifier: ${vertex.id}`);
            return { ...vertex, uid: null }; // Add a null UID if not found
        }
    });
}