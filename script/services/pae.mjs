/*
Service Module for Parallel Activity Extraction (PAE)
Based on the algorithm by Roy B. Doñoz (2024):
  "Parallel Activities in Robustness Diagrams with Loop and Time Controls"
  CMSC 199.2 - University of the Philippines Tacloban College

Implements Algorithm 2 (PAE) from Doñoz (2024).

─── SPLIT STRUCTURES (outgoing arcs from vertex x) ──────────────────────────
  AND-split : ≥2 outgoing arcs all have C = ε  →  all fire simultaneously;
              one new branch is induced per arc (all inherit past reachability)
  OR-split  : ≥2 outgoing arcs all have C ∈ Σ with DIFFERENT values
              →  exactly one fires per activity; one new branch per arc
  MIX-split : outgoing arcs are a mix of ε and Σ-constrained
              →  one new branch per arc (same rule as OR/AND: branch per arc)

  Rule (Doñoz 2024 §3.2, rule 1): for every OR/AND-split at vertex x, induce
  a separate activity profile S′ for each arc (x,y), with S′ adopting all past
  reachability configurations accumulated from source to x.

─── JOIN STRUCTURES (incoming arcs to vertex y) ──────────────────────────────
  AND-join    : type-alike incoming arcs all C ∈ Σ with DIFFERENT values
                →  ALL branches must arrive before y fires (synchronisation)
  OR-join     : type-alike incoming arcs share the SAME C value
                →  first-come-first-served; others are locked (non-deterministic)
  MIX-join/AND: one pair of type-alike arcs where one has C=ε, other C∈Σ,
                and T(C∈Σ arc) ≠ 0  →  merge; both contribute; T updates sync
  MIX-join/OR : same structure but C∈Σ arc is traversed without waiting for ε
                arc  →  process flow retained independently; T not synchronised

─── KEY PAE DIFFERENCES FROM SEQUENTIAL AE ──────────────────────────────────
  • Multiple processes run concurrently from source s
  • eRU(x,y) = arc.L  (max total traversals across ALL parallel processes)
  • Competing activities: processes contend for same arc with insufficient L
    → first-come-first-served (lower process id wins); losers LOCKED
  • Process interruption: process exits RBS while sibling still inside
    → sibling marked PENDING; resolved at AND/MIX-AND join, or LOCKED at OR
  • No backtracking — PENDING processes wait; unresolvable → LOCKED (deadlock)
  • Returns set of parallel maximal activities, or null on deadlock
*/

import {
    areTypeAlikeIncoming,
    getIncomingArcs,
    getOutgoingArcs,
    isEpsilon,
    isOutbridge,
} from "../utils.mjs";
import {
    checkArc,
    getArcTraversals,
    getMaxT,
    isArcPreviouslyChecked,
} from "./aes.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Type definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {number} ArcUID
 * @typedef {number} VertexUID
 * @typedef {{ uid: ArcUID, fromVertexUID: VertexUID, toVertexUID: VertexUID, C: string, L: number }} Arc
 * @typedef {{ uid: ArcUID, type: "boundary"|"entity"|"controller", isRBSCenter: boolean }} Vertex
 * @typedef {{ [vertexUID: number]: Vertex }} VertexMap
 * @typedef {{ [arcUID: number]: Arc }} ArcMap
 * @typedef {{ [fromUID: number]: { [toUID: number]: Set<ArcUID> } }} ArcsAdjacencyMatrix
 * @typedef {{ [vertexUID: number]: VertexUID }} RBSMatrix
 * @typedef {{ [arcUID: number]: number[] }} T
 * @typedef {{ [arcUID: number]: number[] }} CTIndicator
 *
 * @typedef {{
 *   arcs:       Arc[],
 *   arcMap:     ArcMap,
 *   vertexMap:  VertexMap,
 *   arcsMatrix: ArcsAdjacencyMatrix,
 *   rbsMatrix:  RBSMatrix,
 * }} Cache
 *
 * @typedef {"active"|"pending"|"locked"|"done"} ProcessStatus
 *
 * @typedef {{
 *   id:               number,
 *   status:           ProcessStatus,
 *   currentVertexUID: VertexUID,
 *   activityProfile:  { [timeStep: number]: Set<ArcUID> },
 *   T:                T,
 *   CTIndicator:      CTIndicator,
 *   pendingVertexUID: VertexUID | null,
 *   pendingArcUID:    ArcUID | null,
 * }} Process
 *
 * @typedef {{ [processId: number]: { [timeStep: number]: Set<ArcUID> } }} ParallelActivitySet
 *
 * @typedef {{
 *   parallelActivitySets: ParallelActivitySet[],
 *   isParallel:           boolean,
 * }} PAEResult
 */

// ─────────────────────────────────────────────────────────────────────────────
// Split / Join classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies the SPLIT structure at vertex x based on its outgoing arcs.
 *
 * AND-split : ≥2 outgoing arcs, ALL C = ε  (concurrent, no condition)
 * OR-split  : ≥2 outgoing arcs, ALL C ∈ Σ  (conditional, different values)
 * MIX-split : ≥2 outgoing arcs, mix of ε and Σ
 * "none"    : 0 or 1 outgoing arc — no split
 *
 * @param {VertexUID}           vertexUID
 * @param {ArcMap}              arcMap
 * @param {ArcsAdjacencyMatrix} arcsMatrix
 * @returns {"AND"|"OR"|"MIX"|"none"}
 */
function classifySplit(vertexUID, arcMap, arcsMatrix) {
    const outgoing = [...getOutgoingArcs(vertexUID, arcsMatrix)];
    if (outgoing.length < 2) return "none";

    let hasEpsilon    = false;
    let hasNonEpsilon = false;

    for (const arcUID of outgoing) {
        const arc = arcMap[arcUID];
        if (isEpsilon(arc)) hasEpsilon    = true;
        else                hasNonEpsilon = true;
    }

    if ( hasEpsilon && !hasNonEpsilon) return "AND";
    if (!hasEpsilon &&  hasNonEpsilon) return "OR";
    return "MIX";
}

/**
 * Classifies the JOIN structure at vertex y based on its incoming type-alike arcs.
 *
 * Per pseudocode lines 31–36:
 *   "AND or MIX merge point" = AND-join or MIX-AND-join (requires synchronisation)
 *   "MIX or OR merge point"  = additional step for MIX-AND joins (append second arc)
 *
 * Returns one of:
 *   "AND"     — all type-alike arcs C ∈ Σ with DIFFERENT values; synchronise all
 *   "MIX-AND" — mix of ε and Σ, and Σ arc already checked (T ≠ 0); merge meeting
 *   "MIX-OR"  — mix of ε and Σ, Σ arc not yet checked; independent flow
 *   "OR"      — type-alike arcs share the SAME C value; first-come-first-served
 *   "none"    — fewer than 2 type-alike incoming arcs; not a join
 *
 * @param {VertexUID}           vertexUID
 * @param {ArcMap}              arcMap
 * @param {ArcsAdjacencyMatrix} arcsMatrix
 * @param {RBSMatrix}           rbsMatrix
 * @param {T}                   combinedT   — merged T logs across all processes
 * @returns {"AND"|"MIX-AND"|"MIX-OR"|"OR"|"none"}
 */
function classifyJoin(vertexUID, arcMap, arcsMatrix, rbsMatrix, combinedT = {}) {
    const incoming = [...getIncomingArcs(vertexUID, arcsMatrix)];
    if (incoming.length < 2) return "none";

    // Group into type-alike families
    const families = [];
    for (const arcUID of incoming) {
        let placed = false;
        for (const fam of families) {
            if (areTypeAlikeIncoming(arcUID, fam[0], arcMap, rbsMatrix)) {
                fam.push(arcUID);
                placed = true;
                break;
            }
        }
        if (!placed) families.push([arcUID]);
    }

    const joinFamilies = families.filter(f => f.length >= 2);
    if (joinFamilies.length === 0) return "none";

    // Analyse the first join family
    const fam            = joinFamilies[0];
    const epsilonArcs    = fam.filter(uid =>  isEpsilon(arcMap[uid]));
    const nonEpsilonArcs = fam.filter(uid => !isEpsilon(arcMap[uid]));

    // OR-join: all arcs share identical C value (covers all-ε and all-same-Σ)
    const cValues = new Set(fam.map(uid => arcMap[uid].C.trim()));
    if (cValues.size === 1) return "OR";

    // AND-join: all arcs C ∈ Σ with different values
    if (epsilonArcs.length === 0) return "AND";

    // MIX-join: mix of ε and Σ arcs
    // Distinguish AND-flavour vs OR-flavour by whether the Σ arc was checked
    const sigmaChecked = nonEpsilonArcs.some(uid => {
        const t = combinedT[uid] || [];
        return t.some(v => v > 0);
    });
    return sigmaChecked ? "MIX-AND" : "MIX-OR";
}

// ─────────────────────────────────────────────────────────────────────────────
// Process lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/** @param {number} id  @param {VertexUID} startVertexUID  @returns {Process} */
function createProcess(id, startVertexUID) {
    return {
        id,
        status:           "active",
        currentVertexUID: startVertexUID,
        activityProfile:  {},
        T:                {},
        CTIndicator:      {},
        pendingVertexUID: null,
        pendingArcUID:    null,
    };
}

/**
 * Deep-clones a process with a new id.
 * Each split branch inherits the full past reachability of its parent
 * (Doñoz 2024 §3.2, rule 1).
 *
 * @param {Process} proc  @param {number} newId  @returns {Process}
 */
function cloneProcess(proc, newId) {
    const cloneProfile = {};
    for (const ts in proc.activityProfile)
        cloneProfile[ts] = new Set(proc.activityProfile[ts]);

    const cloneT = {};
    for (const uid in proc.T) cloneT[uid] = [...proc.T[uid]];

    const cloneCTI = {};
    for (const uid in proc.CTIndicator) cloneCTI[uid] = [...proc.CTIndicator[uid]];

    return {
        id:               newId,
        status:           proc.status,
        currentVertexUID: proc.currentVertexUID,
        activityProfile:  cloneProfile,
        T:                cloneT,
        CTIndicator:      cloneCTI,
        pendingVertexUID: proc.pendingVertexUID,
        pendingArcUID:    proc.pendingArcUID,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared T helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merges T logs from all processes for the given arc UIDs.
 * Used to compute the global maxT at join vertices.
 *
 * @param {ArcUID[]}  arcUIDs
 * @param {Process[]} processes
 * @returns {T}
 */
function buildCombinedT(arcUIDs, processes) {
    const combined = {};
    for (const uid of arcUIDs) {
        combined[uid] = [];
        for (const p of processes)
            if (p.T[uid]) combined[uid].push(...p.T[uid]);
    }
    return combined;
}

/**
 * Total traversals of arcUID across ALL processes.
 * Compared against arc.L (= eRU) before allowing further traversal.
 *
 * @param {ArcUID} arcUID  @param {Process[]} processes  @returns {number}
 */
function totalArcUse(arcUID, processes) {
    let n = 0;
    for (const p of processes) n += getArcTraversals(arcUID, p.CTIndicator);
    return n;
}

/**
 * Returns true when arc (x,y) participates in a cycle.
 * Used to give looping arcs exploration priority (Doñoz 2024, p.55).
 *
 * @param {ArcUID} arcUID  @param {ArcMap} arcMap  @param {ArcsAdjacencyMatrix} arcsMatrix
 * @returns {boolean}
 */
function isLoopingArc(arcUID, arcMap, arcsMatrix) {
    const arc = arcMap[arcUID];
    if (!arc) return false;
    const visited = new Set();
    const stack   = [arc.toVertexUID];
    while (stack.length) {
        const v = stack.pop();
        if (v === arc.fromVertexUID) return true;
        if (visited.has(v)) continue;
        visited.add(v);
        for (const uid of getOutgoingArcs(v, arcsMatrix)) {
            const a = arcMap[uid];
            if (a) stack.push(a.toVertexUID);
        }
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reachability append (process-scoped traversal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Appends arc (x,y) to a process's reachability and advances its cursor.
 * Mirrors traverseArc() from aes.mjs but scoped to one process's state.
 *
 * Steps:
 *  1. maxT = max timestep across incoming arcs of y in THIS process's T log
 *  2. Mark arc traversed (CTI = 2) at maxT
 *  3. Resolve type-alike checked siblings at y (sync their T to maxT)
 *  4. Record in activityProfile[maxT]
 *  5. If outbridge → reset internal RBS arc states in this process
 *  6. Advance cursor to y
 *
 * @param {ArcUID} arcUID  @param {Process} proc  @param {Cache} cache
 */
function appendReachability(arcUID, proc, cache) {
    const { arcMap, arcsMatrix, rbsMatrix, arcs } = cache;
    const arc = arcMap[arcUID];

    const incomingArcs = getIncomingArcs(arc.toVertexUID, arcsMatrix);
    const maxT         = getMaxT(incomingArcs, proc.T);

    if (!(arcUID in proc.T))           proc.T[arcUID]           = [];
    if (!(arcUID in proc.CTIndicator)) proc.CTIndicator[arcUID] = [];

    const cti = proc.CTIndicator[arcUID];
    if (cti.length > 0 && cti[cti.length - 1] === 1) {
        // Promote last "checked" to "traversed"
        proc.T[arcUID][proc.T[arcUID].length - 1] = maxT;
        cti[cti.length - 1] = 2;
    } else {
        proc.T[arcUID].push(maxT);
        cti.push(2);
    }

    // Sync type-alike checked siblings
    for (const inUID of incomingArcs) {
        if (inUID === arcUID) continue;
        if (!areTypeAlikeIncoming(arcUID, inUID, arcMap, rbsMatrix)) continue;
        if (!isArcPreviouslyChecked(inUID, proc.CTIndicator)) continue;
        const t = proc.T[inUID];
        t[t.length - 1] = maxT;
        proc.CTIndicator[inUID][proc.CTIndicator[inUID].length - 1] = 2;
    }

    // Activity profile
    if (!(maxT in proc.activityProfile)) proc.activityProfile[maxT] = new Set();
    proc.activityProfile[maxT].add(arcUID);

    // Outbridge: reset RBS-internal arc states
    if (isOutbridge(arcUID, arcMap, rbsMatrix)) {
        const centerUID = rbsMatrix[arc.fromVertexUID];
        for (const a of arcs) {
            if (rbsMatrix[a.fromVertexUID] === centerUID &&
                rbsMatrix[a.toVertexUID]   === centerUID) {
                proc.T[a.uid]           = [];
                proc.CTIndicator[a.uid] = [];
            }
        }
    }

    proc.currentVertexUID = arc.toVertexUID;
}

/**
 * Runs checkArc() from aes.mjs scoped to a single process's T/CTIndicator.
 * Returns true when arc is unconstrained for this process.
 *
 * @param {ArcUID} arcUID  @param {Process} proc  @param {Cache} cache
 * @returns {boolean}
 */
function checkArcForProcess(arcUID, proc, cache) {
    return checkArc({ arcUID }, {
        T:               proc.T,
        CTIndicator:     proc.CTIndicator,
        path:            [],
        activityProfile: proc.activityProfile,
        tor:             {},
    }, cache);
}

// ─────────────────────────────────────────────────────────────────────────────
// Split handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles a split at vertex x when process `proc` arrives there.
 *
 * Rule (Doñoz 2024 §3.2, rule 1):
 *   For every OR/AND/MIX-split at x, induce a SEPARATE branch for EACH arc (x,y).
 *   Each branch inherits all past reachability from source to x.
 *
 * `proc` takes `chosenArcUID`; one clone is created per sibling arc.
 *
 * @param {ArcUID[]}  outgoing       — all outgoing arcs from x
 * @param {ArcUID}    chosenArcUID   — arc that `proc` will take
 * @param {Process}   proc
 * @param {number[]}  nextIdRef      — [nextId] mutable counter
 * @param {Process[]} processes      — global list (mutated)
 * @param {Cache}     cache
 */
function handleSplit(outgoing, chosenArcUID, proc, nextIdRef, processes, cache) {
    for (const sibUID of outgoing) {
        if (sibUID === chosenArcUID) continue;
        const newProc = cloneProcess(proc, nextIdRef[0]++);
        processes.push(newProc);
        appendReachability(sibUID, newProc, cache);
    }
    appendReachability(chosenArcUID, proc, cache);
}

/**
 * Returns true when THIS process has already traversed one of the outgoing arcs
 * at this split vertex — meaning it is revisiting the vertex (loop).
 *
 * We must NOT block splitting just because a different sibling process has already
 * traversed some of these arcs.  Each distinct process that arrives at a split
 * vertex must spawn its own full set of branches.  Only suppress re-splitting when
 * `self` itself has already committed to one of the split arcs.
 *
 * @param {ArcUID[]}  outgoing
 * @param {Process}   self
 * @returns {boolean}
 */
function splitAlreadyHandled(outgoing, self) {
    return outgoing.some(uid => getArcTraversals(uid, self.CTIndicator) > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Join resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempts to resolve all PENDING processes blocked at a join vertex.
 *
 * Per pseudocode lines 30–37 (Doñoz 2024):
 *
 *   AND-join (line 31: "AND or MIX merge point"):
 *     Wait until ALL type-alike incoming arcs are traversed by some process.
 *     Get max time t from (xk, [yj]) and append (xk, yj) to S(t).
 *
 *   MIX-AND-join (lines 31 + 34: "AND or MIX merge point" AND "MIX or OR merge point"):
 *     Same synchronised wait as AND; additionally append (x, yk) to S(t)
 *     (the nested MIX/OR sub-step — both arcs are recorded).
 *
 *   MIX-OR-join (§3.2 rule 3: independent flow):
 *     Σ arc proceeds WITHOUT waiting for ε arc.
 *     Append (x, yk) to S(t) independently — T not synchronised.
 *
 *   OR-join:
 *     First-come-first-served (lowest process id wins).
 *     All others LOCKED.
 *
 * @param {Process[]} processes  @param {Cache} cache
 */
function resolvePendingProcesses(processes, cache) {
    const { arcMap, arcsMatrix, rbsMatrix } = cache;

    for (const proc of processes) {
        if (proc.status !== "pending") continue;
        if (!proc.pendingVertexUID || !proc.pendingArcUID) continue;

        const yj       = proc.pendingVertexUID;
        const inArcs   = [...getIncomingArcs(yj, arcsMatrix)];
        const combT    = buildCombinedT(inArcs, processes);
        const joinType = classifyJoin(yj, arcMap, arcsMatrix, rbsMatrix, combT);

        if (joinType === "OR") {
            // OR-join: first-come-first-served PER ARC.
            // Processes pending on DIFFERENT arcs at the same OR-join vertex
            // are independent — each resolves without locking the other.
            // Only processes competing for the SAME arc need first-come-first-served.
            const allOnSameArc = processes
                .filter(p =>
                    (p.status === "active" || p.status === "pending") &&
                    p.pendingVertexUID === yj &&
                    p.pendingArcUID    === proc.pendingArcUID
                )
                .sort((a, b) => a.id - b.id);

            if (allOnSameArc.length <= 1 || allOnSameArc[0] === proc) {
                // This process is the sole or first arrival on this arc — resolve it
                appendReachability(proc.pendingArcUID, proc, cache);
                proc.status           = "active";
                proc.pendingVertexUID = null;
                proc.pendingArcUID    = null;
            } else {
                // Another process with a lower id already claimed this same arc
                proc.status = "locked";
            }

        } else if (joinType === "MIX-OR") {
            // Pseudocode lines 34–35: independent flow — append (x, yk) independently
            // T is not synchronised; resolve immediately
            appendReachability(proc.pendingArcUID, proc, cache);
            proc.status           = "active";
            proc.pendingVertexUID = null;
            proc.pendingArcUID    = null;

        } else if (joinType === "AND" || joinType === "MIX-AND") {
            // Pseudocode lines 31–33: wait until all type-alike incoming arcs covered,
            // then get max time t from (xk, [yj]) and append (xk, yj).
            const allCovered = inArcs.every(inUID =>
                inUID === proc.pendingArcUID ||
                processes.some(p => getArcTraversals(inUID, p.CTIndicator) > 0)
            );
            if (!allCovered) continue; // still waiting

            // Lines 32–33: get max t from incoming arcs and append with synchronised T
            appendReachability(proc.pendingArcUID, proc, cache);
            proc.status           = "active";
            proc.pendingVertexUID = null;
            proc.pendingArcUID    = null;

            // Pseudocode lines 34–35 (nested): if join is also MIX-OR flavour,
            // additionally append the ε-arc side to S(t) at the same time step.
            // For MIX-AND this means we record the epsilon arc contribution too.
            if (joinType === "MIX-AND") {
                const epsilonArcs = inArcs.filter(uid => isEpsilon(arcMap[uid]));
                for (const epsUID of epsilonArcs) {
                    if (epsUID === proc.pendingArcUID) continue;
                    // Find the process that owns this epsilon arc (if any)
                    const epsilonOwner = processes.find(p =>
                        getArcTraversals(epsUID, p.CTIndicator) > 0
                    );
                    if (epsilonOwner) {
                        // Sync the epsilon arc's recorded time to the same maxT
                        const currentMaxT = getMaxT(new Set(inArcs), proc.T);
                        if (epsilonOwner.T[epsUID]) {
                            epsilonOwner.T[epsUID][epsilonOwner.T[epsUID].length - 1] = currentMaxT;
                        }
                        if (!(currentMaxT in epsilonOwner.activityProfile))
                            epsilonOwner.activityProfile[currentMaxT] = new Set();
                        epsilonOwner.activityProfile[currentMaxT].add(epsUID);
                    }
                }
            }
        }
        // joinType === "none" → leave pending; may resolve next iteration
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Process interruption
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects and marks process interruptions (Doñoz 2024, pseudocode lines 38–47).
 *
 * Pseudocode line 38: if x ∈ V_Gu, yj, xk ∉ V_Gu AND ∃ S(i) and S(i′) AND
 *   S(i) interrupts S(i′) wrt (x, yj) then:
 *
 *   Line 39: Append to S(i) the reachability {(x, yj)}  [done by caller]
 *   Line 41: Mark pending in S(i′) the reachability (x, [xk])
 *   Lines 42–44: if (yj, xk) is AND or MIX merge point →
 *     get max t from x to xk, append {(yj,xk),(x,xk)} to S(t)
 *   Lines 45–46: else → mark S(i′) locked
 *
 * Key fix: the pseudocode requires appending TWO arcs — (yj, xk) AND (x, xk) —
 * upon AND/MIX-AND resolution of the interrupted process (lines 43–44).
 * The previous implementation only appended the single pending arc.
 *
 * @param {Process}   exitingProc  @param {ArcUID} arcUID
 * @param {Process[]} processes    @param {Cache}  cache
 */
function handleProcessInterruption(exitingProc, arcUID, processes, cache) {
    const { arcMap, arcsMatrix, rbsMatrix } = cache;
    const arc = arcMap[arcUID];

    // Line 38: exiting arc must be an outbridge (x ∈ V_Gu, yj ∉ V_Gu)
    if (!isOutbridge(arcUID, arcMap, rbsMatrix)) return;
    const centerUID = rbsMatrix[arc.fromVertexUID];
    if (centerUID == null) return;

    // yj = arc.toVertexUID (outside RBS)
    const yj = arc.toVertexUID;

    for (const other of processes) {
        if (other === exitingProc) continue;
        if (other.status === "locked" || other.status === "done") continue;
        // i′ must still be inside the same RBS (xk ∈ V_Gu)
        if (rbsMatrix[other.currentVertexUID] !== centerUID) continue;

        // S(i) interrupts S(i′) — line 39 handled by caller (appendReachability
        // on the exiting arc is called before this function).

        // Line 41: mark pending in S(i′) at (x, [xk]) where xk = yj
        // (the pending vertex is the merge point outside the RBS)
        other.status           = "pending";
        other.pendingVertexUID = yj;

        // Determine the arc from S(i′)'s current position toward xk=yj.
        // We look for any outgoing arc from i′'s current vertex that leads
        // (directly or transitively) to yj — we use the exiting arc's target
        // as the pending resolution point.
        // The pendingArcUID is the arc S(i′) would need to traverse to exit.
        // If no direct arc exists, we store the interrupting arc uid as reference.
        const otherOutgoing = [...getOutgoingArcs(other.currentVertexUID, arcsMatrix)];
        const exitArcForOther = otherOutgoing.find(uid => arcMap[uid].toVertexUID === yj) ?? arcUID;
        other.pendingArcUID = exitArcForOther;

        // Lines 42–46: determine if (yj, xk) is AND/MIX merge point
        const inArcs   = [...getIncomingArcs(yj, arcsMatrix)];
        const combT    = buildCombinedT(inArcs, processes);
        const joinType = classifyJoin(yj, arcMap, arcsMatrix, rbsMatrix, combT);

        if (joinType === "AND" || joinType === "MIX-AND") {
            // Lines 43–44: get max time t from x to xk, append {(yj,xk),(x,xk)}
            // This is handled by resolvePendingProcesses when all branches arrive.
            // The MIX-AND resolution there will append both arcs (the pending arc
            // for other, and the epsilon/sigma sibling).
            // No immediate action needed — resolvePendingProcesses will fire.

        } else {
            // Lines 45–46: else → mark S(i′) locked
            other.status = "locked";
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Result packaging
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups done processes into parallel activity sets and verifies the
 * simultaneous completion condition (Doñoz 2024 §3.1.5, condition 4):
 *   parallel activities must complete at the SAME time step.
 *
 * Two processes belong to the same group when they share ≥1 arc (Def. 1.2.9).
 * Grouping uses transitive closure so that A-B and B-C puts A,B,C together.
 * isParallel = true iff every group has ≥2 processes AND all complete at the
 * same time step AND no locked processes exist.
 *
 * @param {Process[]} done  @param {Process[]} locked  @param {VertexUID} sinkUID
 * @returns {PAEResult}
 */
function buildResult(done, locked, sinkUID) {
    if (done.length === 0) return { parallelActivitySets: [], isParallel: false };

    const arcSets = done.map(proc => {
        const all = new Set();
        for (const ts in proc.activityProfile)
            for (const uid of proc.activityProfile[ts]) all.add(uid);
        return { proc, arcSet: all };
    });

    // ── Union-Find grouping (transitive closure on shared arcs) ───────────
    const parent = arcSets.map((_, i) => i);
    function find(x) { return parent[x] === x ? x : (parent[x] = find(parent[x])); }
    function union(x, y) { parent[find(x)] = find(y); }

    for (let i = 0; i < arcSets.length; i++)
        for (let j = i + 1; j < arcSets.length; j++)
            if ([...arcSets[i].arcSet].some(uid => arcSets[j].arcSet.has(uid)))
                union(i, j);

    const groupMap = new Map();
    for (let i = 0; i < arcSets.length; i++) {
        const root = find(i);
        if (!groupMap.has(root)) groupMap.set(root, []);
        groupMap.get(root).push(i);
    }

    const groups = [...groupMap.values()];

    // ── Simultaneous completion check per group ───────────────────────────
    const allGroupsSimultaneous = groups.every(idxs => {
        const times = idxs.map(idx => {
            const steps = Object.keys(arcSets[idx].proc.activityProfile).map(Number);
            return steps.length > 0 ? Math.max(...steps) : 0;
        });
        return new Set(times).size === 1;
    });

    return {
        parallelActivitySets: groups.map(idxs => {
            const set = {};
            for (const idx of idxs) {
                const { proc } = arcSets[idx];
                set[proc.id] = proc.activityProfile;
            }
            return set;
        }),
        // isParallel: every group has ≥2 processes, all complete simultaneously, no deadlocks
        isParallel: done.length > 1 && locked.length === 0 && allGroupsSimultaneous,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parallel Activity Extraction — Algorithm 2 (Doñoz 2024).
 *
 * Structural alignment with pseudocode:
 *
 *   Line 1–3 : initialise i=1, S1=(s), Ancestors=∅
 *   Line 4   : while TRUE loop
 *   Line 5   : X = vertices in S with outgoing branches pointing to Ancestors,
 *              x ∉ pending — implemented as: active processes not at sink whose
 *              current vertex has been added to Ancestors OR is the source.
 *   Line 6–8 : if x=f and no other ongoing processes → return parallelMaxActivities
 *   Line 10–12: if X=∅ → return 0 (null)
 *   Line 13  : for each (x,yj) ∈ E where x ∈ X
 *   Line 14  : if Check=TRUE and yj in Ancestors and totalUse ≤ eRU
 *   Line 15–28: unconstrained handling (competition + simple traversal)
 *   Line 29–47: constrained handling (join + interruption)
 *   Line 51  : Append x to Ancestors
 *   Line 52  : i++
 *
 * @param {VertexUID} sourceUID
 * @param {VertexUID} sinkUID
 * @param {Cache}     cache
 * @returns {PAEResult | null}  null = deadlock / no parallel activities found
 */
export function parallelActivityExtraction(sourceUID, sinkUID, cache) {
    const { arcMap, arcsMatrix, rbsMatrix } = cache;

    // Lines 1–3: initialise
    let i          = 1;                                   // process counter
    const processes = [createProcess(0, sourceUID)];      // S_1 = (s)
    const ancestors = new Set();                          // Ancestors = ∅
    const MAX_ITER  = 10_000;
    let   iterations = 0;

    while (iterations++ < MAX_ITER) {

        const active  = processes.filter(p => p.status === "active");
        const pending = processes.filter(p => p.status === "pending");
        const locked  = processes.filter(p => p.status === "locked");

        // ── Line 6–8: if x=f and no other ongoing processes → return ─────
        const atSink    = active.filter(p => p.currentVertexUID === sinkUID);
        const notAtSink = active.filter(p => p.currentVertexUID !== sinkUID);

        if (atSink.length > 0 && notAtSink.length === 0 && pending.length === 0) {
            for (const p of atSink) p.status = "done";
            const done = processes.filter(p => p.status === "done");
            // Line 7: return activities that reach [f] simultaneously with eRU satisfied
            return buildResult(done, locked, sinkUID);
        }

        // ── Line 5: X = active processes not at sink ──────────────────────
        // Per pseudocode: "vertices in S with outgoing branches pointing to
        // ancestral vertices, x ∉ pending". The Ancestors set is used to
        // detect loops (arcs pointing *back* to already-visited vertices),
        // NOT to gate whether a process may advance. Any active non-sink
        // process with available outgoing arcs is in the frontier.
        const frontier = active.filter(p =>
            p.currentVertexUID !== sinkUID &&
            getOutgoingArcs(p.currentVertexUID, arcsMatrix).size > 0
        );

        // ── Line 10–12: if X=∅ → return 0 ───────────────────────────────
        if (frontier.length === 0 && pending.length === 0) {
            const done = processes.filter(p => p.status === "done");
            return done.length > 0 ? buildResult(done, locked, sinkUID) : null;
        }

        let anyProgress = false;

        // ── Line 13: for each (x, yj) ∈ E where x ∈ X ───────────────────
        for (const proc of frontier) {
            const x         = proc.currentVertexUID;
            const outgoing  = [...getOutgoingArcs(x, arcsMatrix)];
            const splitType = classifySplit(x, arcMap, arcsMatrix);

            // Looping arcs first (Doñoz 2024, p.55)
            outgoing.sort((a, b) =>
                (isLoopingArc(a, arcMap, arcsMatrix) ? 0 : 1) -
                (isLoopingArc(b, arcMap, arcsMatrix) ? 0 : 1)
            );

            for (const arcUID of outgoing) {
                const arc = arcMap[arcUID];
                const yj  = arc.toVertexUID;

                // ── Line 14: eRU / L check ────────────────────────────────
                if (totalArcUse(arcUID, processes) >= arc.L) continue;

                // ── Line 14: Check routine ────────────────────────────────
                const isUnconstrained = checkArcForProcess(arcUID, proc, cache);

                if (isUnconstrained) {
                    // ── Lines 15–28: unconstrained ────────────────────────

                    // Lines 16–25: competition check
                    // Two processes compete when both are at x fighting for an arc
                    // whose remaining capacity (arc.L - current use) < 2.
                    const competitors = active.filter(p =>
                        p !== proc &&
                        p.currentVertexUID === x &&
                        totalArcUse(arcUID, processes) + 1 > arc.L
                    );

                    if (competitors.length > 0) {
                        // Lines 16–25: S(i) and S(i′) compete at (x, yj)
                        const contenders = [proc, ...competitors].sort((a, b) => a.id - b.id);
                        const winner     = contenders[0];
                        const losers     = contenders.slice(1);

                        if (winner === proc) {
                            // Lines 17–19: i < i′ → append to S(i)
                            appendReachability(arcUID, proc, cache);
                            anyProgress = true;
                        } else if (winner.id === proc.id) {
                            // Lines 21–24: i = i′ → non-deterministic choice
                            // Non-deterministically resolve: we append to the
                            // lower-id process as the canonical choice
                            appendReachability(arcUID, winner, cache);
                            anyProgress = true;
                        }
                        // Lines 20/25: mark losers locked
                        for (const loser of losers) {
                            if (loser !== proc) loser.status = "locked";
                            else proc.status = "locked";
                        }

                    } else if (splitType !== "none" && !splitAlreadyHandled(outgoing, proc)) {
                        // ── Split: one branch per outgoing arc (§3.2 rule 1) ─
                        // AND-split: all arcs fire → all branches created now
                        // OR-split / MIX-split: one branch per arc, proc takes arcUID
                        handleSplit(outgoing, arcUID, proc, [i], processes, cache);
                        i += outgoing.length - 1;  // advance counter for each new branch
                        anyProgress = true;
                        break; // proc has moved; skip remaining arcs

                    } else {
                        // Line 27: simple traversal — no split, no competition
                        appendReachability(arcUID, proc, cache);
                        anyProgress = true;
                    }

                } else {
                    // ── Lines 29–47: constrained ──────────────────────────

                    // Line 30: mark pending the reachability (x, [yj])
                    proc.status           = "pending";
                    proc.pendingVertexUID = yj;
                    proc.pendingArcUID    = arcUID;

                    const inArcs   = [...getIncomingArcs(yj, arcsMatrix)];
                    const combT    = buildCombinedT(inArcs, processes);
                    const joinType = classifyJoin(yj, arcMap, arcsMatrix, rbsMatrix, combT);

                    if (joinType === "AND" || joinType === "MIX-AND") {
                        // Lines 31–36: AND or MIX merge point
                        // Lines 32–33: get max t from (xk, [yj]) and append (xk, yj)
                        // Lines 34–35 (nested): if also MIX or OR → append (x, yk)
                        resolvePendingProcesses(processes, cache);
                        if (proc.status === "active") anyProgress = true;

                    } else if (joinType === "MIX-OR") {
                        // Lines 34–35: MIX or OR merge point — independent flow
                        // Append (x, yk) to S(t) without waiting
                        appendReachability(arcUID, proc, cache);
                        proc.status           = "active";
                        proc.pendingVertexUID = null;
                        proc.pendingArcUID    = null;
                        anyProgress = true;

                    } else if (joinType === "OR") {
                        // OR-join: delegate to resolvePendingProcesses which correctly
                        // handles per-arc first-come-first-served (processes on different
                        // arcs at the same OR-join vertex are independent).
                        resolvePendingProcesses(processes, cache);
                        if (proc.status === "active") anyProgress = true;

                    } else {
                        // "none" — no resolvable join structure → locked (deadlock)
                        proc.status = "locked";
                    }

                    // Lines 38–47: RBS exit interruption check
                    // Line 39: append (x, yj) to S(i) — already done by
                    // appendReachability in the caller if proc became active,
                    // or will be done at join resolution for the pending case.
                    handleProcessInterruption(proc, arcUID, processes, cache);
                }

                // Stop processing further arcs for this proc if it moved or locked
                if (proc.status !== "active") break;
            }

            // Line 51: Append x to Ancestors after processing all arcs from x
            ancestors.add(x);

            // Line 52: i++
            i++;

            if (proc.currentVertexUID === sinkUID && proc.status === "active")
                proc.status = "done";
        }

        // Unblock any pending processes after all frontier advances
        resolvePendingProcesses(processes, cache);

        // Global termination: no live processes remain
        const live = processes.filter(p => p.status === "active" || p.status === "pending");
        if (live.length === 0) {
            const finalDone   = processes.filter(p => p.status === "done");
            const finalLocked = processes.filter(p => p.status === "locked");
            return finalDone.length > 0 ? buildResult(finalDone, finalLocked, sinkUID) : null;
        }

        // No progress + all pending at truly unresolvable joins = deadlock
        // OR-joins are now resolved per-arc, so only "none" is unresolvable
        if (!anyProgress) {
            const stuck = processes.filter(p => p.status === "pending").every(p => {
                if (!p.pendingVertexUID) return true;
                const inArcs   = [...getIncomingArcs(p.pendingVertexUID, arcsMatrix)];
                const combT    = buildCombinedT(inArcs, processes);
                const jt       = classifyJoin(p.pendingVertexUID, arcMap, arcsMatrix, rbsMatrix, combT);
                return jt === "none";
            });
            if (stuck) return null;
        }
    }

    return null; // MAX_ITER safety guard
}