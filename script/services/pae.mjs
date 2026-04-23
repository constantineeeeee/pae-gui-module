/*
Service Module for Parallel Activity Extraction (PAE)
Based on Algorithm 2 from Doñoz (2024).

Key differences from aes.mjs (sequential AE):
  - Multiple processes run concurrently from the source
  - No backtracking — pending processes wait at join points
  - eRU is enforced across ALL processes combined, not per-process
  - Splits spawn new child processes
  - Competition: lowest process ID wins, losers are locked
  - Process interruption: exiting an RBS while a sibling is still inside
*/

import {
  getIncomingArcs,
  getOutgoingArcs,
  isEpsilon,
  isOutbridge,
  areTypeAlikeIncoming,
} from "../utils.mjs";
import {
  checkArc, // reused: arc-level unconstrained check + T update
  traverseArc, // reused: T finalization + activityProfile update
  getMaxT, // reused: timestep synchronization at joins
  getArcTraversals, // reused: counting traversals per process
  isArcPreviouslyChecked, // reused: join resolution guard
} from "./aes.mjs";

// =============================================================================
// Typedefs
// =============================================================================

/**
 * @typedef {number} ArcUID
 * @typedef {number} VertexUID
 *
 * @typedef {{
 *   arcs: object[],
 *   arcMap: object,
 *   vertexMap: object,
 *   arcsMatrix: object,
 *   rbsMatrix: object
 * }} Cache
 *
 * One process = one activity being built in parallel with the others.
 * Each process owns its own T and CTIndicator so arc checks don't bleed
 * across processes.
 *
 * @typedef {{
 *   id: number,
 *   currentVertex: VertexUID,
 *   status: "active" | "pending" | "locked" | "done",
 *   pendingArcUID: ArcUID | null,   // the arc this process is blocked on
 *   states: {
 *     T: object,
 *     CTIndicator: object,
 *     path: VertexUID[],
 *     activityProfile: object,
 *     tor: object
 *   }
 * }} Process
 *
 * @typedef {{
 *   parallelActivitySets: { processId: number, activityProfile: object }[][],
 *   isParallel: boolean
 * } | null} PAEResult
 */

// =============================================================================
// SECTION 1 — Process lifecycle
// These are called during initialization and whenever a process changes state.
// =============================================================================

/**
 * Creates a new process object at the given starting vertex.
 * Called once at init (process 1 at source), then again by
 * spawnProcessesFromSplit() for each branch of a split.
 *
 * @param {number} id
 * @param {VertexUID} startVertex
 * @returns {Process}
 */
export function createProcess(id, startVertex) {
  return {
    id,
    currentVertex: startVertex,
    nextArcUID: null,
    status: "active",
    pendingArcUID: null,
    states: {
      T: {},
      CTIndicator: {},
      path: [startVertex],
      activityProfile: {},
      tor: {},
    },
  };
}

/**
 * Marks a process as locked (deadlocked).
 * Called when:
 *   - It loses a competition at a shared arc (lines 20, 25 of the algorithm)
 *   - It is interrupted inside an RBS and the join is OR-type (line 46)
 *
 * @param {Process} process
 */
export function lockProcess(process) {
  process.status = "locked";
}

/**
 * Marks a process as pending — it is blocked waiting for another process
 * to arrive at a join point or resolve an RBS interruption.
 * Called when:
 *   - checkArc returns false (constrained) at a join vertex (line 30)
 *   - A sibling exits an RBS first, interrupting this process (line 41)
 *
 * @param {Process} process
 * @param {ArcUID} arcUID  the arc this process is blocked on
 */
export function markProcessPending(process, arcUID) {
  process.status = "pending";
  process.pendingArcUID = arcUID;
}

// =============================================================================
// SECTION 2 — Split handling
// Called at line 13 before iterating outgoing arcs.
// =============================================================================

/**
 * Inspects the outgoing arcs of a vertex and classifies the split type.
 *   AND-split : ≥2 outgoing arcs, ALL have C = ε
 *   OR-split  : ≥2 outgoing arcs, ALL have distinct Σ C-values
 *   MIX-split : a mix of ε and Σ arcs
 *   "none"    : 0 or 1 outgoing arc — no split
 *
 * Called before the arc loop at line 13 so we know whether to spawn
 * new processes or just advance the current one.
 *
 * @param {VertexUID} vertexUID
 * @param {Cache} cache
 * @returns {"AND" | "OR" | "MIX" | "none"}
 */
export function getSplitType(vertexUID, cache) {
  const { arcsMatrix, arcMap } = cache;
  const outgoing = [...getOutgoingArcs(vertexUID, arcsMatrix)];

  if (outgoing.length <= 1) return "none";

  const allEpsilon = outgoing.every((uid) => isEpsilon(arcMap[uid]));
  if (allEpsilon) return "AND";

  const allSigma = outgoing.every((uid) => !isEpsilon(arcMap[uid]));
  if (allSigma) return "OR";

  return "MIX";
}

/**
 * Spawns a new child process for each outgoing arc of a split vertex.
 * The parent process is kept for one branch; new processes are created
 * for the rest. Each child inherits a deep copy of the parent's states
 * so their T and CTIndicator histories don't interfere.
 *
 * Called at line 13 when getSplitType returns AND, OR, or MIX.
 *
 * @param {Process} parentProcess
 * @param {ArcUID[]} splitArcUIDs
 * @param {{ nextId: number }} idCounter  mutable counter shared across all splits
 * @returns {Process[]}  all spawned processes (does NOT include parent)
 */
export function spawnProcessesFromSplit(
  parentProcess,
  splitArcUIDs,
  idCounter,
) {
  const spawned = [];

  // Skip the first arc — the parent process handles that one itself.
  for (let i = 1; i < splitArcUIDs.length; i++) {
    const newProcess = createProcess(
      idCounter.nextId++,
      parentProcess.currentVertex,
    );

    // Deep copy parent's states so each branch starts from the same point
    // but evolves independently from here on.
    newProcess.states = structuredClone(parentProcess.states);

    spawned.push(newProcess);
  }

  return spawned;
}

// =============================================================================
// SECTION 3 — Join detection and resolution
// Called at lines 31–36 and 42–47 when checkArc returns false (constrained).
// =============================================================================

/**
 * Classifies the join type at a vertex by inspecting its incoming arcs.
 *   AND-join    : type-alike incoming arcs with DIFFERENT Σ C-values → sync all
 *   OR-join     : type-alike incoming arcs share the SAME C-value → first-come-first-served
 *   MIX-AND-join: mix of ε and Σ; Σ arc already has T ≠ 0 → merge and sync
 *   MIX-OR-join : mix of ε and Σ; Σ arc not yet checked → independent flow
 *   "none"      : only one incoming arc (no join)
 *
 * @param {VertexUID} vertexUID
 * @param {Cache} cache
 * @returns {"AND-join" | "OR-join" | "MIX-AND-join" | "MIX-OR-join" | "none"}
 */
export function getJoinType(vertexUID, cache) {
  const { arcsMatrix, arcMap } = cache;
  const incoming = [...getIncomingArcs(vertexUID, arcsMatrix)];

  if (incoming.length <= 1) return "none";

  const hasEpsilon = incoming.some((uid) => isEpsilon(arcMap[uid]));
  const hasSigma = incoming.some((uid) => !isEpsilon(arcMap[uid]));

  if (hasEpsilon && hasSigma) {
    // MIX join — sub-classify by whether the Σ arc has been seen yet.
    // TODO: inspect the combined T across all processes to determine
    // if the Σ arc was already checked (MIX-AND) or not (MIX-OR).
    // For now, return a placeholder.
    return "MIX-AND-join"; // refine during implementation
  }

  if (!hasEpsilon) {
    // All Σ: AND if C-values differ, OR if they're the same
    const cValues = incoming.map((uid) => arcMap[uid].C);
    const allSame = cValues.every((c) => c === cValues[0]);
    return allSame ? "OR-join" : "AND-join";
  }

  return "none";
}

/**
 * Checks whether all processes that should arrive at a join vertex have
 * arrived, and if so, advances the pending ones using the synchronized
 * max timestep. Uses getMaxT (from aes.mjs) to compute the sync point.
 *
 * Called at lines 31–36 (arc constrained at join) and 42–44 (RBS interruption
 * resolved at AND/MIX join).
 *
 * @param {Process[]} processes  all processes (active + pending)
 * @param {VertexUID} joinVertexUID
 * @param {Cache} cache
 * @returns {boolean}  true if the join was resolved and processes were advanced
 */
export function resolvePendingProcesses(processes, joinVertexUID, cache) {
  const { arcsMatrix, arcMap } = cache;
  const incomingArcs = getIncomingArcs(joinVertexUID, arcsMatrix);

  const pendingHere = processes.filter(
    (p) =>
      p.status === "pending" &&
      p.pendingArcUID !== null &&
      arcMap[p.pendingArcUID]?.toVertexUID === joinVertexUID,
  );

  if (pendingHere.length === 0) return false;

  // Check all incoming arcs have a process pending on them
  const allArrived = [...incomingArcs].every((arcUID) =>
    processes.some(
      (p) =>
        (p.status === "active" || p.status === "pending") &&
        p.pendingArcUID === arcUID,
    ),
  );

  if (!allArrived) return false;

  // Compute synchronized max timestep across all pending processes
  const combinedT = {};
  for (const proc of pendingHere) {
    for (const [arcUID, times] of Object.entries(proc.states.T)) {
      if (!combinedT[arcUID]) combinedT[arcUID] = [];
      combinedT[arcUID].push(...times);
    }
  }
  const maxT = getMaxT(incomingArcs, combinedT);

  // Sort by ID — lowest ID is the survivor
  pendingHere.sort((a, b) => a.id - b.id);
  const survivor = pendingHere[0];
  const absorbed = pendingHere.slice(1);

  // Merge all absorbed processes' states into the survivor
  for (const proc of absorbed) {
    // Merge T values
    for (const [arcUID, times] of Object.entries(proc.states.T)) {
      if (!survivor.states.T[arcUID]) survivor.states.T[arcUID] = [];
      survivor.states.T[arcUID].push(...times);
    }

    // Merge CTIndicator values
    for (const [arcUID, ctis] of Object.entries(proc.states.CTIndicator)) {
      if (!survivor.states.CTIndicator[arcUID])
        survivor.states.CTIndicator[arcUID] = [];
      survivor.states.CTIndicator[arcUID].push(...ctis);
    }

    // Merge activity profiles
    for (const [timestep, arcSet] of Object.entries(
      proc.states.activityProfile,
    )) {
      if (!survivor.states.activityProfile[timestep]) {
        survivor.states.activityProfile[timestep] = new Set();
      }
      for (const arcUID of arcSet) {
        survivor.states.activityProfile[timestep].add(arcUID);
      }
    }

    // Merge path
    for (const vertexUID of proc.states.path) {
      if (!survivor.states.path.includes(vertexUID)) {
        survivor.states.path.push(vertexUID);
      }
    }

    // Lock the absorbed process — it no longer runs independently
    proc.status = "locked";
    console.log(
      `  Process ${proc.id} absorbed into Process ${survivor.id} at vertex ${joinVertexUID}`,
    );
  }

  // Advance the survivor to the join vertex
  survivor.status = "active";
  survivor.currentVertex = joinVertexUID;
  survivor.pendingArcUID = null;

  // Record the join timestep in the survivor's activity profile
  if (!(maxT in survivor.states.activityProfile)) {
    survivor.states.activityProfile[maxT] = new Set();
  }

  console.log(
    `  Survivor Process ${survivor.id} now at vertex ${joinVertexUID} (t=${maxT})`,
  );
  return true;
}

// =============================================================================
// SECTION 4 — Competition handling
// Called at lines 16–25 when multiple processes are unconstrained on the same arc.
// =============================================================================

/**
 * Returns all active processes currently trying to traverse the same arc.
 * Used to detect competition at line 16.
 *
 * In PAE, competition happens when two processes reach the same arc and
 * combined traversals would exceed eRU (arc.L across all processes).
 *
 * @param {Process[]} processes
 * @param {ArcUID} arcUID
 * @param {Cache} cache
 * @returns {Process[]}
 */
export function getCompetingProcesses(processes, arcUID, cache) {
  const totalTraversals = getTotalArcTraversals(processes, arcUID);
  const { arcMap } = cache;
  const arc = arcMap[arcUID];

  // If total traversals are already at or above L, any new process trying
  // this arc is competing (resource exhausted).
  if (totalTraversals >= arc.L) {
    return processes.filter(
      (p) => p.status === "active" && p.currentVertex === arc.fromVertexUID,
    );
  }

  return [];
}

/**
 * Sums getArcTraversals across all processes for a given arc.
 * This is the "actual use" check against eRU at line 14.
 *
 * @param {Process[]} processes
 * @param {ArcUID} arcUID
 * @returns {number}
 */
export function getTotalArcTraversals(processes, arcUID) {
  let total = 0;
  for (const proc of processes) {
    total += getArcTraversals(arcUID, proc.states.CTIndicator);
  }
  return total;
}

// =============================================================================
// SECTION 5 — Process interruption
// Called right after traverseArc when the arc is an outbridge (exits an RBS).
// Corresponds to lines 38–47 of the algorithm.
// =============================================================================

/**
 * Detects whether `process` exiting an RBS via `arcUID` leaves a sibling
 * process still inside that RBS (process interruption).
 *
 * If interruption is detected:
 *   - The exiting process records the arc normally (already done by traverseArc)
 *   - The interrupted sibling is marked pending at its current position
 *   - The join type at the eventual merge vertex determines whether the sibling
 *     can be resolved (AND/MIX-AND → resolve later) or must be locked (OR)
 *
 * @param {Process[]} processes
 * @param {Process} exitingProcess   the process that just crossed an outbridge
 * @param {ArcUID} arcUID            the outbridge arc
 * @param {Cache} cache
 */
export function checkProcessInterruption(
  processes,
  exitingProcess,
  arcUID,
  cache,
) {
  const { rbsMatrix, arcMap } = cache;
  const arc = arcMap[arcUID];

  // Only relevant if this arc is actually an outbridge
  if (!isOutbridge(arcUID, arcMap, rbsMatrix)) return;

  const rbsCenterUID = rbsMatrix[arc.fromVertexUID];

  // Find sibling processes that are still inside the same RBS
  const interruptedSiblings = processes.filter(
    (p) =>
      p.id !== exitingProcess.id &&
      p.status === "active" &&
      rbsMatrix[p.currentVertex] === rbsCenterUID,
  );

  for (const sibling of interruptedSiblings) {
    // The sibling is now stuck inside an RBS whose exit was taken by another process.
    // Mark it pending at whatever arc it's currently trying to traverse.
    // TODO: determine the correct pendingArcUID for the sibling here.
    markProcessPending(sibling, null);

    // Now check the join type at the eventual merge point to decide fate.
    // AND/MIX-AND join → sibling can be resolved when both processes merge
    // OR join → sibling is locked (no resolution possible)
    const joinVertex = arc.toVertexUID; // the vertex after the outbridge
    const joinType = getJoinType(joinVertex, cache);

    if (joinType === "OR-join" || joinType === "MIX-OR-join") {
      lockProcess(sibling);
    }
    // Otherwise leave as pending — resolvePendingProcesses will handle it
    // when both processes eventually reach the AND/MIX-AND join.
  }
}

// =============================================================================
// SECTION 6 — Termination check
// Called at lines 6–8 when any process reaches the sink.
// =============================================================================

/**
 * Validates all four parallel activity conditions and groups results.
 * Called once all active processes have either reached the sink or been locked.
 *
 * The four conditions (Definition 3.1.5):
 *   1. Same source and sink vertices
 *   2. Do not interrupt each other
 *   3. Are not competing activities
 *   4. Complete at the same timestep
 *
 * Returns a PAEResult with parallelActivitySets[] if conditions are met,
 * or a result with isParallel = false if they're not.
 *
 * @param {Process[]} processes
 * @param {VertexUID} sink
 * @param {Cache} cache
 * @returns {PAEResult}
 */
export function getTerminationResult(processes, sink, cache) {
  const doneProcesses = processes.filter((p) => p.status === "done");

  if (doneProcesses.length === 0) return null;

  // Condition 4: all done processes must reach the sink at the same timestep.
  // The last timestep in the activity profile is the completion timestep.
  const completionTimesteps = doneProcesses.map((p) => {
    const steps = Object.keys(p.states.activityProfile).map(Number);
    return steps.length > 0 ? Math.max(...steps) : 0;
  });

  const allSameTime = completionTimesteps.every(
    (t) => t === completionTimesteps[0],
  );

  // Condition 2 & 3: no interruptions or competitions among done processes.
  // These are tracked as flags on each process during the main loop.
  // TODO: add `wasInterrupted` and `wasCompeting` boolean flags to the
  // Process typedef and set them during checkProcessInterruption and
  // getCompetingProcesses, then check them here.
  const noInterruptions = true; // placeholder
  const noCompetition = true; // placeholder

  const isParallel = allSameTime && noInterruptions && noCompetition;

  // Group done processes into a single parallel activity set.
  // If your algorithm can produce multiple sets (e.g. from separate splits
  // off the source), you'd group them here by ancestry.
  const parallelActivitySets = [
    doneProcesses.map((p) => ({
      processId: p.id,
      activityProfile: p.states.activityProfile,
    })),
  ];

  return { parallelActivitySets, isParallel };
}

// =============================================================================
// SECTION 7 — Main algorithm
// Entry point. Mirrors the structure of Algorithm 2 line by line.
// =============================================================================

/**
 * Runs the Parallel Activity Extraction algorithm.
 *
 * @param {VertexUID} source
 * @param {VertexUID} sink
 * @param {Cache} cache
 * @returns {PAEResult}
 */
export function parallelActivityExtraction(source, sink, cache) {
  const { arcMap, arcsMatrix } = cache;
  const processes = [createProcess(1, source)];
  const idCounter = { nextId: 2 };
  const results = [];

  let safetyLimit = 1000; // prevent infinite loop during testing

  while (processes.some((p) => p.status === "active")) {
    if (--safetyLimit <= 0) {
      console.warn("PAE: safety limit reached — possible infinite loop");
      break;
    }

    for (const proc of processes.filter((p) => p.status === "active")) {
      const outgoing = [...getOutgoingArcs(proc.currentVertex, arcsMatrix)];

      // No outgoing arcs and not at sink — dead end, lock it
      if (outgoing.length === 0) {
        lockProcess(proc);
        continue;
      }

      // At sink — done
      if (proc.currentVertex === sink) {
        proc.status = "done";
        results.push({
          processId: proc.id,
          activityProfile: proc.states.activityProfile,
        });
        continue;
      }

      // Only spawn from a split if this process hasn't been assigned an arc yet
      if (proc.nextArcUID === null) {
        if (outgoing.length > 1) {
          for (let i = 1; i < outgoing.length; i++) {
            // Only spawn if we haven't already spawned from this vertex
            const alreadySpawned = processes.some(
              (p) =>
                p.id !== proc.id &&
                p.currentVertex === proc.currentVertex &&
                p.nextArcUID === outgoing[i],
            );
            if (!alreadySpawned) {
              const child = createProcess(
                idCounter.nextId++,
                proc.currentVertex,
              );
              child.states = structuredClone(proc.states);
              child.nextArcUID = outgoing[i];
              processes.push(child);
            }
          }
          proc.nextArcUID = outgoing[0]; // assign first arc to parent too
        } else {
          proc.nextArcUID = outgoing[0];
        }
      }

      // This process takes the first arc (or its assigned arc)
      const arcUID = proc.nextArcUID ?? outgoing[0];
      proc.nextArcUID = null;

      const arc = arcMap[arcUID];
      if (!arc) {
        lockProcess(proc);
        continue;
      }

      console.log(
        `Process ${proc.id} at vertex ${proc.currentVertex} trying arc ${arcUID} (${arc.C}:${arc.L}) → ${arc.toVertexUID}`,
      );

      const isUnconstrained = checkArc({ arcUID }, proc.states, cache);
      console.log(`  → isUnconstrained: ${isUnconstrained}`);

      if (isUnconstrained) {
        traverseArc({ arcUID }, proc.states, cache);
        proc.currentVertex = arc.toVertexUID;
        console.log(`  → traversed, now at ${proc.currentVertex}`);

        // Check immediately if sink was reached
        if (proc.currentVertex === sink) {
          proc.status = "done";
          results.push({
            processId: proc.id,
            activityProfile: proc.states.activityProfile,
          });
          console.log(`  → Process ${proc.id} reached sink!`);
        }
      } else {
        const joinType = getJoinType(arc.toVertexUID, cache);

        if (joinType !== "none") {
          markProcessPending(proc, arcUID);
          console.log(`  → pending at ${joinType} (vertex ${arc.toVertexUID})`);
        } else {
          lockProcess(proc);
          console.log(`  → locked`);
        }
      }
    }
  }

  console.log(
    "PAE done — processes:",
    processes.length,
    "completed:",
    results.length,
  );
  console.log(
    "Results:",
    results.map((r) => ({
      processId: r.processId,
      steps: Object.entries(r.activityProfile).map(([t, arcs]) => ({
        timestep: Number(t),
        arcs: [...arcs],
      })),
    })),
  );

  if (results.length === 0) return null;

  function getCompletionTime(activityProfile) {
    const steps = Object.keys(activityProfile).map(Number);
    return steps.length > 0 ? Math.max(...steps) : 0;
  }

  const groups = new Map();

  for (const result of results) {
    const completionTime = getCompletionTime(result.activityProfile);
    if (!groups.has(completionTime)) {
      groups.set(completionTime, []);
    }
    groups.get(completionTime).push(result);
  }

  console.log("Groups by completion time:");
  for (const [time, group] of groups) {
    console.log(
      `  t=${time}: processes ${group.map((r) => r.processId).join(", ")}`,
    );
  }

  const parallelActivitySets = [...groups.values()].filter((g) => g.length > 1);
  const singleActivitySets = [...groups.values()].filter((g) => g.length === 1);

  console.log("Parallel activity sets:", parallelActivitySets);
  console.log("Single activity sets:", singleActivitySets);

  const isParallel = parallelActivitySets.length > 0;

  return { parallelActivitySets, isParallel };
}
