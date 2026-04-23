import {
  areTypeAlikeIncoming,
  getIncomingArcs,
  getOutgoingArcs,
  isEpsilon,
  isOutbridge,
  isVertexAnObject,
} from "../utils.mjs";

import {
  checkArc,
  getMaxT,
  getArcTraversals,
  getArcChecksOrTraversals,
  isArcPreviouslyChecked,
  traverseArc,
} from "./aes.mjs";

export function createProcess(id, startVertex) {
  return {
    id,
    currentVertex: startVertex,
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

export function markProcessAsPending(process, arcUID) {
  process.status = "pending";
  process.pendingArcUID = arcUID;
}

export function getSplitType(vertexUID, cache) {
  const { arcsMatrix, arcMap } = cache;
  const outgoingArcs = [...getOutgoingArcs(vertexUID, arcsMatrix)];

  if (outgoingArcs.length === 0) return "none";

  const cValues = outgoingArcs.map((uid) => arcMap[uid].C);
  const allSameC = cValues.every((c) => c === cValues[0]);

  const allSigma = outgoingArcs.every((uid) => !isEpsilon(arcMap[uid]));
  if (allSigma) return "OR";

  return "MIX";
}

export function spawnProcessFromSplit(parentProcess, splitArcUIDs, idCounter) {
  const spawned = [];

  for (let i = 1; i < splitArcUIDs.length; i++) {
    const newProcess = createProcess(
      idCounter.nextId++,
      parentProcess.currentVertex,
    );

    newProcess.states = structuredClone(parentProcess.states);
    spawned.push(newProcess);
  }
  return spawned;
}

export function getJoinType(vertexUID, cache) {
  const { arcsMatrix, arcMap } = cache;
  const incomingArcs = [...getIncomingArcs(vertexUID, arcsMatrix)];

  if (incomingArcs.length <= 1) return "none";

  const hasEpsilon = incomingArcs.some((uid) => isEpsilon(arcMap[uid]));
  const hasSigma = incomingArcs.some((uid) => !isEpsilon(arcMap[uid]));

  if (hasEpsilon && hasSigma) {
    const sigmaArcs = incomingArcs.filter((uid) => !isEpsilon(arcMap[uid]));
    const sigmaAlreadyChecked = sigmaArcs.every((arcUID) =>
      processes.some(
        (p) => p.states.T[arcUID] && p.states.T[arcUID].length > 0,
      ),
    );
    return sigmaAlreadyChecked ? "MIX-AND-join" : "MIX-OR-join";
  }

  const cValues = incomingArcs.map((uid) => arcMap[uid].C);
  const allSameC = cValues.every((c) => c === cValues[0]);
  return allSameC ? "OR-join" : "AND-join";
}

export function resolvePendingProcesses(processes, joinVertexUID, cache) {
  const { arcsMatrix } = cache;
  const incomingArcs = getIncomingArcs(joinVertexUID, arcsMatrix);

  // Collect processes that are pending at this join vertex
  const pendingHere = processes.filter(
    (p) =>
      p.status === "pending" &&
      p.pendingArcUID !== null &&
      cache.arcMap[p.pendingArcUID]?.toVertexUID === joinVertexUID,
  );

  if (pendingHere.length === 0) return false;

  // A join is resolved when all expected incoming branches have arrived.
  // "Expected" = processes whose current arc points to this join vertex.
  // TODO: refine this condition — it depends on join type (AND vs OR vs MIX).
  const allArrived = [...incomingArcs].every((arcUID) => {
    return processes.some(
      (p) =>
        (p.status === "active" || p.status === "pending") &&
        p.pendingArcUID === arcUID,
    );
  });

  if (!allArrived) return false;

  // Compute the synchronized timestep = max T across all arriving arcs
  // combined across all processes' T maps.
  const combinedT = {};
  for (const proc of processes) {
    for (const [arcUID, times] of Object.entries(proc.states.T)) {
      if (!combinedT[arcUID]) combinedT[arcUID] = [];
      combinedT[arcUID].push(...times);
    }
  }
  const maxT = getMaxT(incomingArcs, combinedT);

  // Advance all pending processes: set them active, move to join vertex
  for (const proc of pendingHere) {
    proc.status = "active";
    proc.currentVertex = joinVertexUID;
    proc.pendingArcUID = null;

    // Record the synchronized arc in the process's activity profile
    // at the max timestep so all processes share the same timestamp.
    if (!(maxT in proc.states.activityProfile)) {
      proc.states.activityProfile[maxT] = new Set();
    }
    // TODO: add the resolved arc UIDs to the activity profile here
  }

  return true;
}

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

export function getTerminationResult(processes, sink, cache) {
  const doneProcesses = processes.filter((p) => p.status === "done");

  if (doneProcesses.length === 0) return null;

  // GET THE COMPLETION TIMESTEP FOR EACH DONE PROCESS (Condition 4 of PAE)
  const completionTimesteps = doneProcesses.map((p) => {
    const steps = Object.keys(p.states.activityProfile).map(Number);
    return steps.length > 0 ? Math.max(...steps) : 0;
  });

  // Get processes that completed at the same timestep
  const allSameTime = completionTimesteps.every(
    (t) => t === completionTimesteps[0],
  );

  const noInterruptions = true;
  const noCompetitions = true;

  const isParallel = allSameTime && noInterruptions && noCompetitions;

  const parallelActivitySets = [
    doneProcesses.map((p) => ({
      processId: p.id,
      activityProfile: p.states.activityProfile,
    })),
  ];

  return { parallelActivitySets, isParallel };
}

// ALGORITHM START
export function parallelActivityExtraction(source, sink, cache) {
  const ancestors = new Set();
  const idCounter = { nextId: 2 };

  const processes = [createProcess(1, source)];

  while (true) {
    const activeProcesses = processes.filter((p) => p.status === "active");

    const atSink = activeProcesses.some((p) => p.currentVertex === sink);

    const stillRunning = activeProcesses.filter(
      (p) => p.currentVertex !== sink,
    );

    if (atSink.length > 0 && stillRunning.length === 0) {
      for (const proc of atSink) proc.status = "done";
      return getTerminationResult(processes, sink, cache);
    }

    if (activeProcesses.length === 0) return null;

    for (const process of activeProcesses) {
      if (process.currentVertex === sink) continue;

      const currentVertex = process.currentVertex;
      const outgoingArcs = [
        ...getOutgoingArcs(currentVertex, cache.arcsMatrix),
      ];

      const splitType = getSplitType(currentVertex, cache);
      let arcsToAsses = outgoingArcs;

      if (splitType !== "none") {
        const newProcesses = spawnProcessFromSplit(
          process,
          outgoingArcs,
          idCounter,
        );
        processes.push(...newProcesses);

        // TODO: assign each spawned process its starting arc explicitly

        arcsToAsses = [outgoingArcs[0]];

        for (const arcUID of arcsToAsses) {
          const arc = cache.arcMap[arcUID];

          const totalUse = getTotalArcTraversals(processes, arcUID);

          if (totalUse >= arc.L) continue;

          if (arc.toVertexUID !== sink && !ancestors.has(arc.toVertexUID))
            continue;

          const isUnconstrained = checkArc({ arcUID }, process.states, cache);

          if (isUnconstrained) {
            const competingProcesses = getCompetingProcesses(
              processes,
              arcUID,
              cache,
            );

            if (competingProcesses.length > 1) {
              competingProcesses.sort((a, b) => a.id - b.id);
              const winner = competingProcesses[0];

              for (const loser of competingProcesses.slice(1)) {
                lockProcess(loser);
              }

              if (winner.id !== process.id) continue;
            }

            traverseArc({ arcUID }, process.states, cache);
            process.currentVertex = arc.toVertexUID;
            ancestors.add(arc.toVertexUID);

            checkProcessInterruption(processes, process, arcUID, cache);
          } else {
            markProcessAsPending(process, arcUID);

            const joinType = getJoinType(arc.toVertexUID, cache);

            if (joinType === "AND-join" || joinType === "MIX-AND-join") {
              resolvePendingProcesses(processes, arc.toVertexUID, cache);
            }
          }
        }
      }
    }
    ancestors.add(currentVertex);
  }

  for (const process of processes.filter((p) => p.status === "pending")) {
    if (!process.pendingArcUID) continue;

    const pendingArc = cache.arcMap[process.pendingArcUID];
    if (!pendingArc) continue;

    resolvePendingProcesses(processes, pendingArc.toVertexUID, cache);
  }
}
