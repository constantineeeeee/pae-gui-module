/*
Service Module for Parallel Activity Extraction (PAE)
Based on the algorithm by Roy B. Doñoz (2024):
  "Parallel Activities in Robustness Diagrams with Loop and Time Controls"
  CMSC 199.2 - University of the Philippines Tacloban College

This module implements Algorithm 2 (PAE) from Doñoz (2024), which extracts
sets of parallel maximal activities from a given RDLT R with one source vertex s
and one sink vertex f.

Key differences from sequential AE (Malinao 2017 / aes.mjs):
  - Multiple activity processes (branches) run concurrently from the source
  - Shared arcs are governed by an extended reusability value (eRU), derived
    from the arc's L-value relative to how many parallel activities use it
  - Competing activities (processes contending for the same arc whose L-value
    cannot accommodate all of them) are resolved by first-come-first-served or
    non-deterministic choice; the losing process is marked LOCKED
  - Process interruptions (one activity exits an RBS while another is still
    inside it) are detected and resolved: the interrupted process is marked
    PENDING until it merges at an AND- or MIX-join; it is marked LOCKED if
    resolution is impossible (OR-join / MIX-join that uses C(x,y)∈Σ first)
  - There is no backtracking; a PENDING process simply waits for resolution
  - The algorithm returns the set of all parallel maximal activity profiles,
    or null if any deadlock / unresolvable competition is encountered

Terminology (from Doñoz 2024):
  - S(i)            : reachability set (activity profile branch) for process i
  - Ancestors       : set of vertices already visited (used to detect loops)
  - PENDING vertex  : ([v]) — a vertex whose reachability is blocked and waits
                      for another process to resolve it via a join
  - LOCKED process  : a process that has lost a competition or is stuck in an
                      unresolvable pending state; marks a deadlock
  - eRU(x,y)        : extended reusability of arc (x,y) — effectively arc.L
                      (the maximum number of times the arc may be traversed
                      across all parallel activities combined)
  - Competing arcs  : two processes that both need to traverse the same arc
                      whose remaining capacity cannot serve both
  - Process interrupt: activity i exits an RBS G_u while activity i' is still
                       inside G_u, causing i' to be pending until they merge
*/

import {
    areTypeAlikeIncoming,
    getIncomingArcs,
    getOutgoingArcs,
    isEpsilon,
    isOutbridge,
    isInbridge,
    isVertexAnObject,
} from "../utils.mjs";
import {
    checkArc,
    getArcTraversals,
    getMaxT,
    isArcPreviouslyChecked,
} from "./aes.mjs";

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {number} ArcUID
 * @typedef {number} VertexUID
 *
 * @typedef {{ uid: ArcUID, fromVertexUID: VertexUID, toVertexUID: VertexUID, C: string, L: number }} Arc
 * @typedef {{ uid: ArcUID, type: "boundary" | "entity" | "controller", isRBSCenter: boolean }} Vertex
 *
 * @typedef {{ [vertexUID: number]: Vertex }}                                         VertexMap
 * @typedef {{ [arcUID: number]: Arc }}                                               ArcMap
 * @typedef {{ [fromUID: number]: { [toUID: number]: Set<ArcUID> } }}                 ArcsAdjacencyMatrix
 * @typedef {{ [vertexUID: number]: VertexUID }}                                      RBSMatrix
 *
 * @typedef {{ [arcUID: number]: number[] }} T          — timestep log per arc
 * @typedef {{ [arcUID: number]: number[] }} CTIndicator — 1=checked, 2=traversed
 *
 * @typedef {{
 *   arcs:        Arc[],
 *   arcMap:      ArcMap,
 *   vertexMap:   VertexMap,
 *   arcsMatrix:  ArcsAdjacencyMatrix,
 *   rbsMatrix:   RBSMatrix,
 * }} Cache
 *
 * Process status constants
 * @typedef {"active" | "pending" | "locked" | "done"} ProcessStatus
 *
 * A single parallel process (branch / S(i) in Doñoz 2024)
 * @typedef {{
 *   id:              number,
 *   status:          ProcessStatus,
 *   currentVertexUID: VertexUID,
 *   activityProfile: { [timeStep: number]: Set<ArcUID> },
 *   T:               T,
 *   CTIndicator:     CTIndicator,
 *   pendingVertexUID: VertexUID | null,   — vertex blocked on (the [v] notation)
 *   pendingArcUID:    ArcUID   | null,    — arc that caused the pending state
 * }} Process
 *
 * Output activity set (one parallel group)
 * @typedef {{ [processId: number]: { [timeStep: number]: Set<ArcUID> } }} ParallelActivitySet
 *
 * Full PAE result
 * @typedef {{
 *   parallelActivitySets: ParallelActivitySet[],   — each element = one parallel group
 *   isParallel:           boolean,                 — true iff ≥1 group returned
 * }} PAEResult
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when arc (x,y) is a "looping arc" in the RDLT sense —
 * i.e. its target vertex can reach its source vertex (it participates in
 * a cycle). We use this to give looping arcs priority in PAE (Doñoz 2024,
 * p. 55: "choice of arc to check gives priority to looping arcs").
 *
 * @param {ArcUID}             arcUID
 * @param {ArcMap}             arcMap
 * @param {ArcsAdjacencyMatrix} arcsMatrix
 * @returns {boolean}
 */
function isLoopingArc(arcUID, arcMap, arcsMatrix) {
    const arc = arcMap[arcUID];
    if (!arc) return false;
    // DFS from toVertex to see whether we can reach fromVertex
    const visited = new Set();
    const stack = [arc.toVertexUID];
    while (stack.length > 0) {
        const v = stack.pop();
        if (v === arc.fromVertexUID) return true;
        if (visited.has(v)) continue;
        visited.add(v);
        const outgoing = getOutgoingArcs(v, arcsMatrix);
        for (const uid of outgoing) {
            const a = arcMap[uid];
            if (a) stack.push(a.toVertexUID);
        }
    }
    return false;
}

/**
 * Determines whether vertex yj is an AND-join or a MIX-join.
 * An AND-join has all type-alike incoming arcs with C = ε.
 * A MIX-join has a mix of ε and non-ε type-alike incoming arcs.
 *
 * Returns "AND" | "MIX" | "OR" | "none".
 *
 * @param {VertexUID}          vertexUID
 * @param {ArcMap}             arcMap
 * @param {ArcsAdjacencyMatrix} arcsMatrix
 * @param {RBSMatrix}          rbsMatrix
 * @returns {"AND" | "MIX" | "OR" | "none"}
 */
function classifyJoin(vertexUID, arcMap, arcsMatrix, rbsMatrix) {
    const incomingArcs = [...getIncomingArcs(vertexUID, arcsMatrix)];
    if (incomingArcs.length <= 1) return "none";

    // Group into type-alike families
    const grouped = [];
    for (const arcUID of incomingArcs) {
        let placed = false;
        for (const group of grouped) {
            if (areTypeAlikeIncoming(arcUID, group[0], arcMap, rbsMatrix)) {
                group.push(arcUID);
                placed = true;
                break;
            }
        }
        if (!placed) grouped.push([arcUID]);
    }

    // Only joins (≥2 type-alike incoming arcs) are interesting
    const joinGroups = grouped.filter(g => g.length >= 2);
    if (joinGroups.length === 0) return "none";

    let hasEpsilon = false;
    let hasNonEpsilon = false;
    for (const group of joinGroups) {
        for (const arcUID of group) {
            const arc = arcMap[arcUID];
            if (isEpsilon(arc)) hasEpsilon = true;
            else hasNonEpsilon = true;
        }
    }

    if (hasEpsilon && !hasNonEpsilon) return "AND";
    if (hasEpsilon && hasNonEpsilon) return "MIX";
    return "OR";
}

/**
 * Returns how many times arc (x,y) has been traversed *across all processes*.
 *
 * @param {ArcUID}    arcUID
 * @param {Process[]} processes
 * @returns {number}
 */
function totalArcUseAcrossProcesses(arcUID, processes) {
    let count = 0;
    for (const proc of processes) {
        count += getArcTraversals(arcUID, proc.CTIndicator);
    }
    return count;
}

/**
 * Deep-clones the mutable parts of a Process so that splits produce
 * independent branches.
 *
 * @param {Process} proc
 * @param {number}  newId
 * @returns {Process}
 */
function cloneProcess(proc, newId) {
    const cloneProfile = {};
    for (const ts in proc.activityProfile) {
        cloneProfile[ts] = new Set(proc.activityProfile[ts]);
    }
    const cloneT = {};
    for (const arcUID in proc.T) {
        cloneT[arcUID] = [...proc.T[arcUID]];
    }
    const cloneCTI = {};
    for (const arcUID in proc.CTIndicator) {
        cloneCTI[arcUID] = [...proc.CTIndicator[arcUID]];
    }
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

/**
 * Creates a fresh process rooted at a given vertex.
 *
 * @param {number}    id
 * @param {VertexUID} startVertexUID
 * @returns {Process}
 */
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
 * Appends arc (x,y) traversal to a process's activity profile and updates
 * its T / CTIndicator, mirroring what traverseArc() does in aes.mjs but
 * scoped to the individual process state.
 *
 * Steps (per Doñoz 2024 / Malinao 2017):
 *  1. Compute maxT from incoming arcs of yj in this process's T log
 *  2. Mark the arc as traversed (CTI = 2) at maxT
 *  3. Record in activityProfile at that maxT
 *  4. If arc is an outbridge, reset internal RBS arc states in this process
 *
 * @param {ArcUID}  arcUID
 * @param {Process} proc
 * @param {Cache}   cache
 */
function appendReachability(arcUID, proc, cache) {
    const { arcMap, arcsMatrix, rbsMatrix, arcs, vertexMap } = cache;
    const arc = arcMap[arcUID];

    const incomingArcs = getIncomingArcs(arc.toVertexUID, arcsMatrix);
    const maxT = getMaxT(incomingArcs, proc.T);

    // Mark traversed
    if (!(arcUID in proc.T))          proc.T[arcUID] = [];
    if (!(arcUID in proc.CTIndicator)) proc.CTIndicator[arcUID] = [];
    // Update last checked entry to traversed, or push new traversal
    const cti = proc.CTIndicator[arcUID];
    if (cti.length > 0 && cti[cti.length - 1] === 1) {
        proc.T[arcUID][proc.T[arcUID].length - 1] = maxT;
        cti[cti.length - 1] = 2;
    } else {
        proc.T[arcUID].push(maxT);
        cti.push(2);
    }

    // Also resolve type-alike checked incoming arcs at this vertex
    for (const inUID of incomingArcs) {
        if (inUID === arcUID) continue;
        if (!areTypeAlikeIncoming(arcUID, inUID, arcMap, rbsMatrix)) continue;
        if (!isArcPreviouslyChecked(inUID, proc.CTIndicator)) continue;
        const t = proc.T[inUID];
        t[t.length - 1] = maxT;
        proc.CTIndicator[inUID][proc.CTIndicator[inUID].length - 1] = 2;
    }

    // Update activity profile
    if (!(maxT in proc.activityProfile)) proc.activityProfile[maxT] = new Set();
    proc.activityProfile[maxT].add(arcUID);

    // Outbridge reset: clear internal RBS arc states inside the exited RBS
    if (isOutbridge(arcUID, arcMap, rbsMatrix)) {
        const centerUID = rbsMatrix[arc.fromVertexUID];
        for (const a of arcs) {
            if (
                rbsMatrix[a.fromVertexUID] === centerUID &&
                rbsMatrix[a.toVertexUID]   === centerUID
            ) {
                proc.T[a.uid] = [];
                proc.CTIndicator[a.uid] = [];
            }
        }
    }

    // Advance process cursor
    proc.currentVertexUID = arc.toVertexUID;
}

/**
 * Runs the Check routine (from aes.mjs) in the context of a single process,
 * using that process's own T / CTIndicator state.
 *
 * Returns true when arc (x,y) is unconstrained for this process.
 *
 * @param {ArcUID}  arcUID
 * @param {Process} proc
 * @param {Cache}   cache
 * @returns {boolean}
 */
function checkArcForProcess(arcUID, proc, cache) {
    // Build a minimal "states" object that checkArc() from aes.mjs expects
    const states = {
        T:               proc.T,
        CTIndicator:     proc.CTIndicator,
        path:            [],   // not used by checkArc
        activityProfile: proc.activityProfile,
        tor:             {},   // PAE does not track TOR per-process
    };
    return checkArc({ arcUID }, states, cache);
}

// ---------------------------------------------------------------------------
// Core PAE algorithm — public export
// ---------------------------------------------------------------------------

/**
 * Parallel Activity Extraction (PAE) — Algorithm 2 from Doñoz (2024).
 *
 * Given an RDLT R (via cache) with a single source vertex s and a single
 * sink vertex f, returns all sets of parallel maximal activities.
 *
 * Each returned ParallelActivitySet groups the activity profiles of those
 * processes that completed simultaneously and without competition /
 * process interruption.  Returns null when the first deadlock is reached.
 *
 * High-level flow:
 *  1.  Initialise a single process at s.
 *  2.  Main loop: while there are active/pending processes —
 *        a. Identify the frontier X: active processes whose current vertex
 *           has at least one explorable outgoing arc.
 *        b. Termination check: if any process has reached f and no other
 *           processes are still running → collect & return results.
 *        c. Empty frontier → deadlock → return null.
 *        d. For each process in X, try each outgoing arc (looping arcs first):
 *             i.  Check whether total arc use would exceed eRU (= L).
 *                 If not, run the Check routine.
 *             ii. If unconstrained → resolve competition if needed, then
 *                 append reachability; split process if arc leads to a fork.
 *             iii.If constrained → mark process PENDING; attempt join
 *                 resolution (AND/MIX: resolve at maxT; OR/MIX-Σ: LOCKED).
 *             iv. Process interruption check: if one process exits an RBS
 *                 while another is inside → mark inner process PENDING;
 *                 resolve at AND/MIX join or LOCK at OR join.
 *        e. Resolve pending processes that can now be unblocked.
 *        f. Increment global step counter i.
 *  3.  Collect all activity profiles from done processes and return them.
 *
 * @param {VertexUID} sourceUID  — uid of the source vertex s
 * @param {VertexUID} sinkUID    — uid of the sink vertex f
 * @param {Cache}     cache
 * @returns {PAEResult | null}
 */
export function parallelActivityExtraction(sourceUID, sinkUID, cache) {
    const { arcMap, arcsMatrix, rbsMatrix } = cache;

    // ── 1. Initialise ──────────────────────────────────────────────────────
    let nextProcessId = 0;
    const processes = [createProcess(nextProcessId++, sourceUID)];

    // Ancestors: vertices already committed to the traversal tree (Doñoz 2024, line 3)
    const ancestors = new Set();

    // Global step counter i (Doñoz 2024, line 1)
    let i = 1;

    // Safety guard against infinite loops
    const MAX_ITERATIONS = 10_000;
    let iterations = 0;

    // ── 2. Main loop ────────────────────────────────────────────────────────
    while (iterations++ < MAX_ITERATIONS) {

        // ── 2a. Build frontier X ─────────────────────────────────────────
        // X = active processes that have outgoing arcs to explore and whose
        // current vertex has not exceeded its outgoing arc traversal limits
        // (Doñoz 2024, line 5: "set of vertices in S with outgoing branches
        // pointing to ancestral vertices, x ∈ X, x ≠ pending")
        const activeProcesses = processes.filter(p => p.status === "active");

        // ── 2b. Termination: all active processes reached sink ────────────
        // (Doñoz 2024, lines 6-9)
        const doneProcesses = processes.filter(p => p.status === "done");
        const lockedProcesses = processes.filter(p => p.status === "locked");
        const pendingProcesses = processes.filter(p => p.status === "pending");

        // If every process is either done or locked (no active / pending left)
        if (activeProcesses.length === 0 && pendingProcesses.length === 0) {
            if (doneProcesses.length === 0) return null; // pure deadlock
            return _buildResult(doneProcesses, lockedProcesses);
        }

        // If some active processes have reached the sink
        const atSink = activeProcesses.filter(p => p.currentVertexUID === sinkUID);
        if (
            atSink.length > 0 &&
            atSink.length === activeProcesses.length &&
            pendingProcesses.length === 0
        ) {
            // All remaining processes are at f — done
            for (const p of atSink) p.status = "done";
            return _buildResult(processes.filter(p => p.status === "done"), lockedProcesses);
        }

        // ── 2c. Empty frontier → deadlock ────────────────────────────────
        // Processes that have reachable outgoing arcs
        const frontier = activeProcesses.filter(p => {
            if (p.currentVertexUID === sinkUID) return false;
            const outgoing = getOutgoingArcs(p.currentVertexUID, arcsMatrix);
            return outgoing.size > 0;
        });

        if (frontier.length === 0 && pendingProcesses.length === 0) {
            // No process can advance — deadlock
            return null;
        }

        // ── 2d. Advance each process in the frontier ──────────────────────
        // (Doñoz 2024, lines 13-53)
        let anyProgress = false;

        for (const proc of frontier) {
            const x = proc.currentVertexUID;
            const outgoingArcs = [...getOutgoingArcs(x, arcsMatrix)];

            // Priority: looping arcs first (Doñoz 2024, p.55)
            outgoingArcs.sort((a, b) => {
                const aLoop = isLoopingArc(a, arcMap, arcsMatrix) ? 0 : 1;
                const bLoop = isLoopingArc(b, arcMap, arcsMatrix) ? 0 : 1;
                return aLoop - bLoop;
            });

            for (const arcUID of outgoingArcs) {
                const arc = arcMap[arcUID];
                const yj = arc.toVertexUID;

                // ── eRU check: would total use of this arc exceed L? ─────
                // (Doñoz 2024, line 14: "actual use of (x,yj) is at most eRU(x,yj)")
                const currentTotalUse = totalArcUseAcrossProcesses(arcUID, processes);
                if (currentTotalUse >= arc.L) continue; // arc exhausted

                // ── Run Check routine ─────────────────────────────────────
                const isUnconstrained = checkArcForProcess(arcUID, proc, cache);

                // ── Detect competing processes ────────────────────────────
                // Competing = another active process is at the same vertex x
                // and also wants this arc, but L cannot accommodate both
                // (Doñoz 2024, lines 16-26)
                const competitors = activeProcesses.filter(p =>
                    p !== proc &&
                    p.currentVertexUID === x &&
                    totalArcUseAcrossProcesses(arcUID, processes) + 1 > arc.L
                );

                if (isUnconstrained) {
                    // ── Unconstrained path ────────────────────────────────

                    if (competitors.length > 0) {
                        // Competition: first-come-first-served (lower id wins)
                        // (Doñoz 2024, lines 17-25)
                        const allContenders = [proc, ...competitors].sort((a, b) => a.id - b.id);
                        const winner = allContenders[0];

                        if (winner === proc) {
                            appendReachability(arcUID, proc, cache);
                            anyProgress = true;
                        }
                        // Lock all losers
                        for (const loser of allContenders.slice(1)) {
                            loser.status = "locked";
                        }
                    } else {
                        // No competition — check for a fork (split)
                        // A fork occurs when yj has additional outgoing paths
                        // and the current process hasn't split yet.
                        // Forks in PAE produce new parallel branches.
                        const siblingOutgoing = outgoingArcs.filter(uid => uid !== arcUID);
                        const shouldFork =
                            siblingOutgoing.length > 0 &&
                            !_hasExistingForkForVertex(processes, x, arcUID);

                        if (shouldFork) {
                            // Create one new process per sibling arc (split)
                            // (Doñoz 2024, p.55: "splits denote the generation
                            //  of separate activities")
                            for (const sibArcUID of siblingOutgoing) {
                                const sibArc = arcMap[sibArcUID];
                                const newProc = cloneProcess(proc, nextProcessId++);
                                processes.push(newProc);
                                // The new process takes the sibling arc
                                appendReachability(sibArcUID, newProc, cache);
                            }
                        }

                        appendReachability(arcUID, proc, cache);
                        anyProgress = true;
                    }
                } else {
                    // ── Constrained path: mark PENDING ───────────────────
                    // (Doñoz 2024, line 30: "Mark pending the reachability (x,[yj])")
                    proc.status = "pending";
                    proc.pendingVertexUID = yj;
                    proc.pendingArcUID = arcUID;

                    // Attempt immediate join resolution
                    // (Doñoz 2024, lines 31-37)
                    const joinType = classifyJoin(yj, arcMap, arcsMatrix, rbsMatrix);

                    if (joinType === "AND" || joinType === "MIX") {
                        // Resolve pending at maxT across all incoming arcs
                        const incomingToYj = getIncomingArcs(yj, arcsMatrix);
                        const maxT = getMaxT(incomingToYj, proc.T);
                        appendReachability(arcUID, proc, cache);
                        proc.status = "active";
                        proc.pendingVertexUID = null;
                        proc.pendingArcUID = null;
                        anyProgress = true;

                        // For MIX-join, also allow the ε branch (Doñoz 2024, line 35)
                        if (joinType === "MIX") {
                            const epsilonIncoming = [...incomingToYj].find(uid =>
                                isEpsilon(arcMap[uid]) && uid !== arcUID
                            );
                            if (epsilonIncoming) {
                                appendReachability(epsilonIncoming, proc, cache);
                            }
                        }
                    } else {
                        // OR / unresolvable join → LOCKED (Doñoz 2024, p.55:
                        // "first-come-first-served … other merging and pending
                        //  vertex is considered locked and will result to a deadlock")
                        proc.status = "locked";
                    }

                    // ── Process interruption check ────────────────────────
                    // (Doñoz 2024, lines 38-48)
                    // If x is in some RBS G_u and yj is outside G_u, while
                    // another process is still inside G_u → interruption
                    _handleProcessInterruption(proc, arcUID, processes, cache);
                }
            }

            // Mark done if at sink
            if (proc.currentVertexUID === sinkUID && proc.status === "active") {
                proc.status = "done";
            }

            // Record x in ancestors (Doñoz 2024, line 51)
            ancestors.add(x);
        }

        // ── 2e. Try to unblock pending processes ──────────────────────────
        _resolvePendingProcesses(processes, sinkUID, cache);

        // ── 2f. Detect global deadlock ────────────────────────────────────
        const stillLive = processes.filter(
            p => p.status === "active" || p.status === "pending"
        );
        if (stillLive.length === 0) {
            const done = processes.filter(p => p.status === "done");
            return done.length > 0
                ? _buildResult(done, processes.filter(p => p.status === "locked"))
                : null;
        }

        if (!anyProgress) {
            // No process made progress this round — detect whether pending
            // processes can *ever* be resolved, or if we are in a deadlock
            const unresolvable = processes.filter(p => p.status === "pending").every(p => {
                if (!p.pendingVertexUID) return true;
                const jt = classifyJoin(p.pendingVertexUID, arcMap, arcsMatrix, rbsMatrix);
                return jt === "OR" || jt === "none";
            });
            if (unresolvable) return null;
        }

        // ── 2g. Advance step counter ──────────────────────────────────────
        i++;
    }

    // Fell out of the loop (MAX_ITERATIONS exceeded) — treat as failure
    return null;
}

// ---------------------------------------------------------------------------
// Internal resolution helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether an existing process fork for vertex x already handles arcUID
 * (prevents duplicate splits on re-visits).
 *
 * @param {Process[]} processes
 * @param {VertexUID} vertexUID
 * @param {ArcUID}    arcUID
 * @returns {boolean}
 */
function _hasExistingForkForVertex(processes, vertexUID, arcUID) {
    // A fork already exists if another process has already traversed this arc
    return processes.some(p => getArcTraversals(arcUID, p.CTIndicator) > 0);
}

/**
 * Handles process interruption detection and resolution.
 *
 * If process proc is exiting an RBS G_u via arc (x,y) (i.e. arc is an
 * outbridge of G_u) and another process i' is still inside G_u, then i' is
 * marked PENDING. It will be resolved when both processes eventually merge at
 * an AND- or MIX-join; otherwise it is LOCKED.
 *
 * (Doñoz 2024, lines 38-48 and lines 91-100)
 *
 * @param {Process}   exitingProc — the process exiting the RBS
 * @param {ArcUID}    arcUID      — the outbridge arc
 * @param {Process[]} processes
 * @param {Cache}     cache
 */
function _handleProcessInterruption(exitingProc, arcUID, processes, cache) {
    const { arcMap, arcsMatrix, rbsMatrix } = cache;
    const arc = arcMap[arcUID];

    if (!isOutbridge(arcUID, arcMap, rbsMatrix)) return;

    const centerUID = rbsMatrix[arc.fromVertexUID];
    if (centerUID === undefined || centerUID === null) return;

    // Identify processes still inside G_u
    for (const otherProc of processes) {
        if (otherProc === exitingProc) continue;
        if (otherProc.status === "locked" || otherProc.status === "done") continue;

        const otherCenter = rbsMatrix[otherProc.currentVertexUID];
        if (otherCenter !== centerUID) continue;

        // otherProc is still inside G_u — interruption detected
        // Mark it pending; try to resolve at the next join
        otherProc.status = "pending";
        otherProc.pendingVertexUID = arc.toVertexUID; // the merge vertex

        const joinType = classifyJoin(arc.toVertexUID, arcMap, arcsMatrix, rbsMatrix);
        if (joinType === "AND" || joinType === "MIX") {
            // Will be resolved later in _resolvePendingProcesses
        } else {
            // Unresolvable — lock
            otherProc.status = "locked";
        }
    }
}

/**
 * Attempts to unblock pending processes by checking whether the join vertex
 * they are waiting at now has all its required incoming arcs resolved
 * (i.e. all type-alike incoming arcs have been traversed by some process).
 *
 * (Doñoz 2024, p.55: "pending processes simply wait for other processes that
 *  may resolve the former's pending case")
 *
 * @param {Process[]} processes
 * @param {VertexUID} sinkUID
 * @param {Cache}     cache
 */
function _resolvePendingProcesses(processes, sinkUID, cache) {
    const { arcMap, arcsMatrix, rbsMatrix } = cache;

    for (const proc of processes) {
        if (proc.status !== "pending") continue;
        if (!proc.pendingVertexUID || !proc.pendingArcUID) continue;

        const yj = proc.pendingVertexUID;
        const joinType = classifyJoin(yj, arcMap, arcsMatrix, rbsMatrix);

        if (joinType === "OR") {
            // Non-deterministic OR-join: first-come-first-served
            // The first process to arrive wins; others are locked
            const competitors = processes.filter(p =>
                p !== proc &&
                (p.status === "active" || p.status === "pending") &&
                p.pendingVertexUID === yj
            );
            if (competitors.length === 0) {
                // This process wins by default
                if (proc.pendingArcUID !== null) {
                    appendReachability(proc.pendingArcUID, proc, cache);
                }
                proc.status = "active";
                proc.pendingVertexUID = null;
                proc.pendingArcUID    = null;
            } else {
                // Lock all but the earliest (lowest id)
                const allAtJoin = [proc, ...competitors].sort((a, b) => a.id - b.id);
                const winner = allAtJoin[0];
                if (proc === winner) {
                    if (proc.pendingArcUID !== null) {
                        appendReachability(proc.pendingArcUID, proc, cache);
                    }
                    proc.status = "active";
                    proc.pendingVertexUID = null;
                    proc.pendingArcUID    = null;
                } else {
                    proc.status = "locked";
                }
            }
            continue;
        }

        if (joinType === "AND" || joinType === "MIX") {
            // Check whether all type-alike incoming arcs of yj have been
            // traversed by at least one process
            const incomingArcs = [...getIncomingArcs(yj, arcsMatrix)];
            const allResolved = incomingArcs.every(inUID => {
                if (inUID === proc.pendingArcUID) return true; // this process covers it
                return processes.some(p => getArcTraversals(inUID, p.CTIndicator) > 0);
            });

            if (allResolved) {
                // Compute maxT across all processes for incoming arcs of yj
                const combinedT = {};
                for (const inUID of incomingArcs) {
                    combinedT[inUID] = [];
                    for (const p of processes) {
                        if (p.T[inUID]) combinedT[inUID].push(...p.T[inUID]);
                    }
                }
                const maxT = getMaxT(new Set(incomingArcs), combinedT);

                if (proc.pendingArcUID !== null) {
                    appendReachability(proc.pendingArcUID, proc, cache);
                }
                proc.status = "active";
                proc.pendingVertexUID = null;
                proc.pendingArcUID    = null;
            }
            // else: still waiting — leave as pending
        }
    }
}

/**
 * Packages the completed processes into a PAEResult.
 *
 * Groups done processes into parallel sets: processes that share the same
 * set of arc UIDs (same arcs, possibly at different timesteps) are considered
 * the same activity group (activity group ≡ they share a non-empty arc
 * intersection, per Def. 1.2.9 in Doñoz 2024).
 *
 * @param {Process[]} doneProcesses
 * @param {Process[]} lockedProcesses
 * @returns {PAEResult}
 */
function _buildResult(doneProcesses, lockedProcesses) {
    if (doneProcesses.length === 0) {
        return { parallelActivitySets: [], isParallel: false };
    }

    // Collect all arcs per done process
    const arcSets = doneProcesses.map(proc => {
        const allArcs = new Set();
        for (const ts in proc.activityProfile) {
            for (const arcUID of proc.activityProfile[ts]) allArcs.add(arcUID);
        }
        return { proc, arcSet: allArcs };
    });

    // Group into parallel sets: any two processes with overlapping arc sets
    // belong to the same activity group
    const groups = [];
    const assigned = new Set();

    for (let i = 0; i < arcSets.length; i++) {
        if (assigned.has(i)) continue;
        const group = [i];
        assigned.add(i);
        for (let j = i + 1; j < arcSets.length; j++) {
            if (assigned.has(j)) continue;
            // Check intersection
            const hasOverlap = [...arcSets[i].arcSet].some(uid => arcSets[j].arcSet.has(uid));
            if (hasOverlap) {
                group.push(j);
                assigned.add(j);
            }
        }
        groups.push(group);
    }

    const parallelActivitySets = groups.map(groupIndices => {
        const actSet = {};
        for (const idx of groupIndices) {
            const { proc } = arcSets[idx];
            actSet[proc.id] = proc.activityProfile;
        }
        return actSet;
    });

    return {
        parallelActivitySets,
        isParallel: doneProcesses.length > 1 && lockedProcesses.length === 0,
    };
}