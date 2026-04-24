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
  checkArc,
  traverseArc,
  getMaxT,
  getArcTraversals,
  isArcPreviouslyChecked,
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
 * @typedef {{
 *   id: number,
 *   currentVertex: VertexUID,
 *   status: "active" | "pending" | "locked" | "done",
 *   pendingArcUID: ArcUID | null,
 *   nextArcUID: ArcUID | null,
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
// =============================================================================

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

export function lockProcess(process) {
  process.status = "locked";
}

export function markProcessPending(process, arcUID) {
  process.status = "pending";
  process.pendingArcUID = arcUID;
}

// =============================================================================
// SECTION 2 — Split handling
// =============================================================================

export function getSplitType(vertexUID, cache) {
  const { arcsMatrix, arcMap } = cache;
  const outgoing = [...getOutgoingArcs(vertexUID, arcsMatrix)];

  if (outgoing.length <= 1) return "none";

  const cValues = outgoing.map((uid) => arcMap[uid].C);
  const allSameC = cValues.every((c) => c === cValues[0]);
  if (allSameC) return "AND";

  const allSigma = outgoing.every((uid) => !isEpsilon(arcMap[uid]));
  if (allSigma) return "OR";

  return "MIX";
}

export function spawnProcessesFromSplit(parentProcess, splitArcUIDs, idCounter) {
  const spawned = [];
  for (let i = 1; i < splitArcUIDs.length; i++) {
    const newProcess = createProcess(idCounter.nextId++, parentProcess.currentVertex);
    newProcess.states = structuredClone(parentProcess.states);
    newProcess.nextArcUID = splitArcUIDs[i];
    spawned.push(newProcess);
  }
  return spawned;
}

// =============================================================================
// SECTION 3 — Join detection and resolution
// =============================================================================

/**
 * Classifies the join type at a vertex.
 *
 * For MIX joins (mix of ε and Σ incoming arcs):
 *   - MIX-AND-join: the asking process's OWN T already has the Σ arc checked.
 *     This means the Σ arc was traversed by THIS process's ancestry, so it must
 *     wait to merge (it's the ε process arriving after the Σ process already ran).
 *   - MIX-OR-join: the asking process's OWN T has NOT seen the Σ arc yet.
 *     This means the Σ arc process hasn't reached here yet — the ε process
 *     arrived first and should pass through independently.
 */
export function getJoinType(vertexUID, cache, processes = [], askingProcess = null) {
  const { arcsMatrix, arcMap } = cache;
  const incoming = [...getIncomingArcs(vertexUID, arcsMatrix)];

  if (incoming.length <= 1) return "none";

  const hasEpsilon = incoming.some((uid) => isEpsilon(arcMap[uid]));
  const hasSigma   = incoming.some((uid) => !isEpsilon(arcMap[uid]));

  if (hasEpsilon && hasSigma) {
    const sigmaArcs = incoming.filter((uid) => !isEpsilon(arcMap[uid]));

    // Check whether THIS process's own T has seen the Σ arc
    const sigmaChecked = askingProcess
      ? sigmaArcs.some((arcUID) =>
          askingProcess.states.T[arcUID] && askingProcess.states.T[arcUID].length > 0
        )
      : sigmaArcs.some((arcUID) =>
          processes.some((p) => p.states.T[arcUID] && p.states.T[arcUID].length > 0)
        );

    return sigmaChecked ? "MIX-AND-join" : "MIX-OR-join";
  }

  const cValues = incoming.map((uid) => arcMap[uid].C);
  const allSameC = cValues.every((c) => c === cValues[0]);
  return allSameC ? "OR-join" : "AND-join";
}

/**
 * Resolves pending processes at an AND or MIX-AND join.
 *
 * After merging, for MIX-AND joins it also spawns an independent clone
 * representing the MIX-OR path — the ε arc process that passes through
 * independently without merging with the Σ arc process.
 *
 * @param {Process[]} processes
 * @param {VertexUID} joinVertexUID
 * @param {Cache} cache
 * @param {{ nextId: number }} idCounter  needed to create the MIX-OR clone
 * @returns {boolean}
 */
export function resolvePendingProcesses(processes, joinVertexUID, cache, idCounter) {
  const { arcsMatrix, arcMap } = cache;
  const incomingArcs = [...getIncomingArcs(joinVertexUID, arcsMatrix)];

  const pendingHere = processes.filter(
    (p) =>
      p.status === "pending" &&
      p.pendingArcUID !== null &&
      arcMap[p.pendingArcUID]?.toVertexUID === joinVertexUID,
  );

  if (pendingHere.length === 0) return false;

  // All incoming arcs must have a process pending on them
  const allArrived = incomingArcs.every((arcUID) =>
    processes.some(
      (p) =>
        (p.status === "active" || p.status === "pending") &&
        p.pendingArcUID === arcUID,
    ),
  );

  if (!allArrived) return false;

  // Determine if this is a MIX-AND join (has both ε and Σ incoming arcs)
  const isMixJoin = incomingArcs.some((uid) => isEpsilon(arcMap[uid])) &&
                    incomingArcs.some((uid) => !isEpsilon(arcMap[uid]));

  // For MIX-AND: find the ε arc process — it will be cloned for the MIX-OR path
  const epsArcUID = isMixJoin
    ? incomingArcs.find((uid) => isEpsilon(arcMap[uid]))
    : null;
  const epsProcess = epsArcUID
    ? pendingHere.find((p) => p.pendingArcUID === epsArcUID)
    : null;

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

  // Merge absorbed processes into the survivor
  for (const proc of absorbed) {
    for (const [arcUID, times] of Object.entries(proc.states.T)) {
      if (!survivor.states.T[arcUID]) survivor.states.T[arcUID] = [];
      survivor.states.T[arcUID].push(...times);
    }

    for (const [arcUID, ctis] of Object.entries(proc.states.CTIndicator)) {
      if (!survivor.states.CTIndicator[arcUID])
        survivor.states.CTIndicator[arcUID] = [];
      survivor.states.CTIndicator[arcUID].push(...ctis);
    }

    for (const [timestep, arcSet] of Object.entries(proc.states.activityProfile)) {
      if (!survivor.states.activityProfile[timestep]) {
        survivor.states.activityProfile[timestep] = new Set();
      }
      for (const arcUID of arcSet) {
        survivor.states.activityProfile[timestep].add(arcUID);
      }
    }

    for (const vertexUID of proc.states.path) {
      if (!survivor.states.path.includes(vertexUID)) {
        survivor.states.path.push(vertexUID);
      }
    }

    proc.status = "locked";
    console.log(`  Process ${proc.id} absorbed into Process ${survivor.id} at vertex ${joinVertexUID}`);
  }

  // Advance survivor to the join vertex
  survivor.status = "active";
  survivor.currentVertex = joinVertexUID;

  if (!(maxT in survivor.states.activityProfile)) {
    survivor.states.activityProfile[maxT] = new Set();
  }

  if (survivor.pendingArcUID !== null) {
    survivor.states.activityProfile[maxT].add(survivor.pendingArcUID);
  }
  for (const proc of absorbed) {
    if (proc.pendingArcUID !== null) {
      survivor.states.activityProfile[maxT].add(proc.pendingArcUID);
    }
  }

  survivor.pendingArcUID = null;

  console.log(`  Survivor Process ${survivor.id} now at vertex ${joinVertexUID} (t=${maxT})`);

  // MIX-AND join: also spawn an independent clone for the MIX-OR path.
  // This clone represents the ε arc process passing through x4 independently
  // (without merging with the Σ arc process), producing Activities 3 & 4.
  if (isMixJoin && epsProcess && idCounter) {
    // Clone starts from the ε process's own states BEFORE the merge
    // We use the epsProcess's states snapshotted before absorption
    // (if epsProcess was the survivor, clone from survivor's pre-merge state;
    //  if it was absorbed, its states are already merged into survivor —
    //  so we clone from survivor but strip the Σ arc contributions)
    //
    // Simplest correct approach: create a clone from the ε process's
    // pre-merge state. Since epsProcess may be the survivor or absorbed,
    // we deep-clone survivor's states and remove the Σ arc's contributions.
    const sigmaArcUIDs = incomingArcs.filter((uid) => !isEpsilon(arcMap[uid]));

    const cloneStates = structuredClone(survivor.states);

    // Remove Σ arc contributions from the clone's profile and T
    // so the clone only represents the ε-only path
    for (const sigmaArcUID of sigmaArcUIDs) {
      // Remove sigma arc from activity profile at maxT
      if (cloneStates.activityProfile[maxT]) {
        cloneStates.activityProfile[maxT].delete(sigmaArcUID);
      }
      // Remove sigma arc T entries that belong to Σ process (not ε process)
      // We keep only the T entries from the ε arc side
      delete cloneStates.T[sigmaArcUID];
      delete cloneStates.CTIndicator[sigmaArcUID];
    }

    // Also remove the ε arc's entry from survivor's profile at maxT
    // since survivor represents the MERGED path (includes both arcs)
    // The clone already has the ε arc; make sure survivor also keeps it (it does via add above)

    const clone = createProcess(idCounter.nextId++, joinVertexUID);
    clone.states = cloneStates;

    processes.push(clone);
    console.log(`  Spawned MIX-OR independent clone Process ${clone.id} at vertex ${joinVertexUID}`);
  }

  return true;
}

// =============================================================================
// SECTION 4 — Competition handling
// =============================================================================

export function getCompetingProcesses(processes, arcUID, cache) {
  const totalTraversals = getTotalArcTraversals(processes, arcUID);
  const { arcMap } = cache;
  const arc = arcMap[arcUID];

  if (totalTraversals >= arc.L) {
    return processes.filter(
      (p) => p.status === "active" && p.currentVertex === arc.fromVertexUID,
    );
  }

  return [];
}

export function getTotalArcTraversals(processes, arcUID) {
  let total = 0;
  for (const proc of processes) {
    total += getArcTraversals(arcUID, proc.states.CTIndicator);
  }
  return total;
}

// =============================================================================
// SECTION 5 — Process interruption
// =============================================================================

export function checkProcessInterruption(processes, exitingProcess, arcUID, cache) {
  const { rbsMatrix, arcMap } = cache;
  const arc = arcMap[arcUID];

  if (!isOutbridge(arcUID, arcMap, rbsMatrix)) return;

  const rbsCenterUID = rbsMatrix[arc.fromVertexUID];

  const interruptedSiblings = processes.filter(
    (p) =>
      p.id !== exitingProcess.id &&
      p.status === "active" &&
      rbsMatrix[p.currentVertex] === rbsCenterUID,
  );

  for (const sibling of interruptedSiblings) {
    markProcessPending(sibling, null);

    const joinVertex = arc.toVertexUID;
    const joinType = getJoinType(joinVertex, cache, processes, sibling);

    if (joinType === "OR-join" || joinType === "MIX-OR-join") {
      lockProcess(sibling);
    }
  }
}

// =============================================================================
// SECTION 6 — Termination check
// =============================================================================

export function getTerminationResult(processes, sink, cache) {
  const doneProcesses = processes.filter((p) => p.status === "done");

  if (doneProcesses.length === 0) return null;

  const noInterruptions = true; // placeholder
  const noCompetition = true;   // placeholder

  function getCompletionTime(activityProfile) {
    const steps = Object.keys(activityProfile).map(Number);
    return steps.length > 0 ? Math.max(...steps) : 0;
  }

  const groups = new Map();
  for (const proc of doneProcesses) {
    const t = getCompletionTime(proc.states.activityProfile);
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push({ processId: proc.id, activityProfile: proc.states.activityProfile });
  }

  console.log("Groups by completion time:");
  for (const [time, group] of groups) {
    console.log(`  t=${time}: processes ${group.map((r) => r.processId).join(", ")}`);
  }

  const parallelActivitySets = [...groups.values()].filter((g) => g.length > 1);
  const isParallel = parallelActivitySets.length > 0 && noInterruptions && noCompetition;

  return {
    parallelActivitySets: parallelActivitySets.length > 0
      ? parallelActivitySets
      : [...groups.values()],
    isParallel,
  };
}

// =============================================================================
// SECTION 7 — Main algorithm
// =============================================================================

export function parallelActivityExtraction(source, sink, cache) {
  const { arcMap, arcsMatrix } = cache;
  const processes = [createProcess(1, source)];
  const idCounter = { nextId: 2 };
  const results = [];

  let safetyLimit = 10000;

  while (processes.some((p) => p.status === "active")) {
    if (--safetyLimit <= 0) {
      console.warn("PAE: safety limit reached — possible infinite loop");
      break;
    }

    for (const proc of processes.filter((p) => p.status === "active")) {
      // Re-check — could have been locked/done mid-iteration
      if (proc.status !== "active") continue;

      const outgoing = [...getOutgoingArcs(proc.currentVertex, arcsMatrix)];

      if (outgoing.length === 0) {
        lockProcess(proc);
        continue;
      }

      if (proc.currentVertex === sink) {
        proc.status = "done";
        results.push({
          processId: proc.id,
          activityProfile: proc.states.activityProfile,
        });
        continue;
      }

      // Determine which arc to assess
      if (proc.nextArcUID === null) {
        if (outgoing.length > 1) {
          for (let i = 1; i < outgoing.length; i++) {
            // A child is a duplicate only if it has the same path history as this
            // process — two processes that arrived at the same vertex via different
            // routes must each independently spawn their own split children.
            const alreadySpawned = processes.some(
              (p) =>
                p.id !== proc.id &&
                p.currentVertex === proc.currentVertex &&
                p.nextArcUID === outgoing[i] &&
                p.states.path.length === proc.states.path.length &&
                p.states.path.every((v, idx) => v === proc.states.path[idx]),
            );
            if (!alreadySpawned) {
              const child = createProcess(idCounter.nextId++, proc.currentVertex);
              child.states = structuredClone(proc.states);
              child.nextArcUID = outgoing[i];
              processes.push(child);
            }
          }
          proc.nextArcUID = outgoing[0];
        } else {
          proc.nextArcUID = outgoing[0];
        }
      }

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
        // traverseArc({ arcUID }, proc.states, cache);
        // proc.currentVertex = arc.toVertexUID;
        // console.log(`  → traversed, now at ${proc.currentVertex}`);

        // if (proc.currentVertex === sink) {
        //   proc.status = "done";
        //   results.push({
        //     processId: proc.id,
        //     activityProfile: proc.states.activityProfile,
        //   });
        //   console.log(`  → Process ${proc.id} reached sink!`);
        // }

        // checkProcessInterruption(processes, proc, arcUID, cache);

        const destJoinType = getJoinType(arc.toVertexUID, cache, processes, proc);
        const epsArcPendingAtDest = destJoinType === "MIX-OR-join" &&
          processes.some(
            (p) =>
              p.status === "pending" &&
              p.pendingArcUID !== null &&
              cache.arcMap[p.pendingArcUID]?.toVertexUID === arc.toVertexUID &&
              isEpsilon(cache.arcMap[p.pendingArcUID])
          );

        if (epsArcPendingAtDest) {
          // Σ arc process must also wait so both can resolve at MIX join
          markProcessPending(proc, arcUID);
          console.log(`  → Process ${proc.id} pending (Σ arc, waiting for MIX join resolution at ${arc.toVertexUID})`);
        } else {
          traverseArc({ arcUID }, proc.states, cache);
          proc.currentVertex = arc.toVertexUID;
          console.log(`  → traversed, now at ${proc.currentVertex}`);

          if (proc.currentVertex === sink) {
            proc.status = "done";
            results.push({ processId: proc.id, activityProfile: proc.states.activityProfile });
            console.log(`  → Process ${proc.id} reached sink!`);
          }

          checkProcessInterruption(processes, proc, arcUID, cache);
        }
      } else {
        const joinType = getJoinType(arc.toVertexUID, cache, processes, proc);
        console.log(`  → constrained, join type: ${joinType}`);

        if (joinType === "AND-join") {
          markProcessPending(proc, arcUID);
          console.log(`  → Process ${proc.id} pending (AND-join at ${arc.toVertexUID})`);

        } else if (joinType === "MIX-AND-join") {
          // Σ arc process arriving after ε already passed — must wait to merge
          markProcessPending(proc, arcUID);
          console.log(`  → Process ${proc.id} pending (MIX-AND-join at ${arc.toVertexUID})`);

        } else if (joinType === "MIX-OR-join") {
          // ε arc process arriving while Σ has NOT been checked yet.
          // Mark pending — it will wait. When the Σ arc process also arrives
          // and both are pending, resolvePendingProcesses will:
          //   1. Merge them → MIX-AND survivor (Activities 1 & 2)
          //   2. Spawn a clone for the MIX-OR independent path (Activities 3 & 4)
          markProcessPending(proc, arcUID);
          console.log(`  → Process ${proc.id} pending (MIX-OR, waiting for Σ arc at ${arc.toVertexUID})`);

        } else if (joinType === "OR-join") {
          lockProcess(proc);
          console.log(`  → Process ${proc.id} locked (OR-join, first-come-first-served)`);

        } else {
          lockProcess(proc);
          console.log(`  → Process ${proc.id} locked (constrained, no join)`);
        }
      }
    }

    // Resolve pending AND and MIX joins
    for (const proc of processes.filter((p) => p.status === "pending")) {
      if (!proc.pendingArcUID) continue;
      const pendingArc = cache.arcMap[proc.pendingArcUID];
      if (!pendingArc) continue;

      const joinType = getJoinType(pendingArc.toVertexUID, cache, processes, proc);
      if (joinType === "AND-join" || joinType === "MIX-AND-join" || joinType === "MIX-OR-join") {
        // For MIX-OR: check if BOTH the ε and Σ arc processes are now pending
        // (i.e. the Σ process also arrived and is constrained). If so, this
        // becomes a MIX-AND merge with an additional MIX-OR clone.
        const resolved = resolvePendingProcesses(
          processes,
          pendingArc.toVertexUID,
          cache,
          idCounter,
        );
        if (resolved) console.log(`Resolved join at vertex ${pendingArc.toVertexUID}`);
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

  return getTerminationResult(processes, sink, cache);
}