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
import { checkCompetingProcesses } from "./impedance-freeness.mjs";
import { Cycle } from "./soundness/utils/cycle.mjs";

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
 *   arcUID: ArcUID,
 *   winnerProcessId: number,
 *   loserProcessIds: number[],
 *   totalTraversals: number,
 *   arcL: number,
 *   reason: string
 * }} CompetitionEntry
 *
 * @typedef {{
 *   parallelActivitySets: { processId: number, activityProfile: object }[][],
 *   isParallel: boolean,
 *   competitionLog: CompetitionEntry[]
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
 * Returns the set of vertex UIDs reachable from `startUID` by following
 * outgoing arcs forward. Used to decide whether an active process can still
 * arrive on a given incoming arc of an AND-join — i.e. whether the join's
 * partner slot can still be filled. BFS over the adjacency matrix, ignores
 * L-attributes and constraints (we only ask about graph reachability, not
 * whether a specific traversal is currently legal).
 *
 * @param {VertexUID} startUID
 * @param {object} arcsMatrix
 * @returns {Set<VertexUID>}
 */
export function forwardReachableVertices(startUID, arcsMatrix) {
  const seen = new Set([startUID]);
  const queue = [startUID];
  while (queue.length) {
    const v = queue.shift();
    const outs = arcsMatrix[v] ?? {};
    for (const toVertexUID of Object.keys(outs)) {
      const tu = Number(toVertexUID);
      if (seen.has(tu)) continue;
      // Has at least one outgoing arc to this neighbour
      const arcsTo = outs[toVertexUID];
      if (!arcsTo || (Array.isArray(arcsTo) && arcsTo.length === 0) ||
          (arcsTo instanceof Set && arcsTo.size === 0)) continue;
      seen.add(tu);
      queue.push(tu);
    }
  }
  return seen;
}

/**
 * Returns true if some non-terminal process can still arrive on `targetArcUID`
 * (an incoming arc of a join vertex). A process can arrive if:
 *   - it is already pending on that arc, or
 *   - it is active and its currentVertex can forward-reach the source of
 *     the target arc (so it has at least one path to that incoming arc).
 *
 * Locked and done processes are ignored — they cannot fill the slot.
 *
 * @param {ArcUID} targetArcUID
 * @param {Process[]} processes
 * @param {Cache} cache
 * @returns {boolean}
 */
export function canStillArriveOnArc(targetArcUID, processes, cache) {
  const { arcMap, arcsMatrix } = cache;
  const targetArc = arcMap[targetArcUID];
  if (!targetArc) return false;
  const targetSource = targetArc.fromVertexUID;

  for (const p of processes) {
    if (p.status === "locked" || p.status === "done") continue;

    if (p.pendingArcUID === targetArcUID) return true;

    if (p.status === "active") {
      const reachable = forwardReachableVertices(p.currentVertex, arcsMatrix);
      if (reachable.has(targetSource)) return true;
    }
  }
  return false;
}

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

  // ── Ancestry-based grouping ───────────────────────────────────────────────
  // When multiple parallel activities each go through their own AND-split and
  // reconverge at the same AND-join vertex, we must only merge processes that
  // belong to the SAME activity (i.e. came from the same split ancestry).
  // Strategy: group pending processes by finding the maximal matching sets
  // where each set has exactly one process per incoming arc, prioritising
  // groups whose path histories share the most common prefix (same ancestry).
  //
  // Simple implementation: build groups of size == incomingArcs.length by
  // picking one process per incoming arc greedily from lowest ID.
  // Only resolve ONE group per call; subsequent calls handle remaining groups.
  const pendingByArc = new Map(); // arcUID → Process[]
  for (const arcUID of incomingArcs) {
    pendingByArc.set(arcUID, pendingHere.filter(p => p.pendingArcUID === arcUID));
  }

  // Check every incoming arc has at least one pending process
  const hasAllArcs = incomingArcs.every(uid => (pendingByArc.get(uid)?.length ?? 0) > 0);
  if (!hasAllArcs) return false;

  // Pick one process per incoming arc (lowest ID first within each arc's candidates)
  // to form a single merge group
  const mergeGroup = incomingArcs.map(uid => {
    const candidates = pendingByArc.get(uid);
    candidates.sort((a, b) => a.id - b.id);
    return candidates[0];
  });

  // Use mergeGroup as pendingHere for this resolution pass
  // (replace the original pendingHere variable scope below)
  const resolveGroup = mergeGroup;

  // Determine if this is a MIX-AND join (has both ε and Σ incoming arcs)
  const isMixJoin = incomingArcs.some((uid) => isEpsilon(arcMap[uid])) &&
                    incomingArcs.some((uid) => !isEpsilon(arcMap[uid]));

  // For MIX-AND: find the ε arc process — it will be cloned for the MIX-OR path
  const epsArcUID = isMixJoin
    ? incomingArcs.find((uid) => isEpsilon(arcMap[uid]))
    : null;
  const epsProcess = epsArcUID
    ? resolveGroup.find((p) => p.pendingArcUID === epsArcUID)
    : null;

  // Compute synchronized max timestep across the resolved group only
  const combinedT = {};
  for (const proc of resolveGroup) {
    for (const [arcUID, times] of Object.entries(proc.states.T)) {
      if (!combinedT[arcUID]) combinedT[arcUID] = [];
      combinedT[arcUID].push(...times);
    }
  }
  const maxT = getMaxT(incomingArcs, combinedT);

  // Sort by ID — lowest ID is the survivor
  resolveGroup.sort((a, b) => a.id - b.id);
  const survivor = resolveGroup[0];
  const absorbed = resolveGroup.slice(1);

  // Snapshot Σ process states BEFORE merge (needed for MIX-OR clone)
  const sigmaArcUIDsForSnapshot = incomingArcs.filter((uid) => !isEpsilon(arcMap[uid]));
  const sigmaProcessForClone = resolveGroup.find(p => sigmaArcUIDsForSnapshot.includes(p.pendingArcUID));
  const sigmaStateSnapshot = sigmaProcessForClone ? structuredClone(sigmaProcessForClone.states) : null;
  // Capture the Σ arc UID NOW, before the absorption loop nulls out pendingArcUID
  // on absorbed processes. Used later by the MIX-OR clone block.
  const sigmaArcUIDForClone = sigmaProcessForClone ? sigmaProcessForClone.pendingArcUID : null;

  // Capture pendingArcUIDs of all members of the resolve group BEFORE the
  // absorption loop clears them. We need these to record the join in the
  // survivor's activity profile after the merge.
  const absorbedPendingArcs = absorbed.map(p => p.pendingArcUID);

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
    proc.pendingArcUID = null;
    console.log(`  Process ${proc.id} absorbed into Process ${survivor.id} at vertex ${joinVertexUID}`);
  }

  // Advance survivor to the join vertex
  survivor.status = "active";
  survivor.currentVertex = joinVertexUID;

  if (!(maxT in survivor.states.activityProfile)) {
    survivor.states.activityProfile[maxT] = new Set();
  }

  // Record all joining arc UIDs in profile and finalize CTIndicator (1→2)
  const allJoiningArcs = [
    survivor.pendingArcUID,
    ...absorbedPendingArcs,
  ].filter(Boolean);

  for (const joiningArcUID of allJoiningArcs) {
    survivor.states.activityProfile[maxT].add(joiningArcUID);

    // Finalize CTIndicator: mark as traversed (2) not just checked (1)
    if (survivor.states.CTIndicator[joiningArcUID]) {
      const cti = survivor.states.CTIndicator[joiningArcUID];
      cti[cti.length - 1] = 2;
    }
    // Finalize T to maxT
    if (survivor.states.T[joiningArcUID]) {
      const t = survivor.states.T[joiningArcUID];
      t[t.length - 1] = maxT;
    }
  }

  survivor.pendingArcUID = null;

  console.log(`  Survivor Process ${survivor.id} now at vertex ${joinVertexUID} (t=${maxT})`);

  // MIX join: also spawn an independent clone for the MIX-OR path.
  //
  // Per the manuscript (Doñoz 2024) and the MIX-join semantics:
  //   - MIX-AND path (survivor): the ε arc waited and merged WITH the Σ arc.
  //     The survivor's profile already contains both joining arcs at t=maxT.
  //   - MIX-OR path (clone):  the Σ arc passes through INDEPENDENTLY without
  //     waiting for the ε arc. Clone uses only the Σ process's pre-merge
  //     state — its ancestry, its T/CTIndicator, its activity profile.
  //
  // The clone resumes from the join vertex as a fresh active process, ready
  // to continue the activity that took the Σ path alone.
  if (isMixJoin && idCounter && sigmaStateSnapshot && sigmaArcUIDForClone !== null) {
    // Record the Σ arc traversal in the clone at the join time-step.
    // Like the survivor, this finalizes the Σ arc as traversed (CTI 1→2)
    // and records its actual traversal time. The ε arc is NOT recorded —
    // that's the whole point of the MIX-OR path: only Σ fires here.
    if (!(maxT in sigmaStateSnapshot.activityProfile)) {
      sigmaStateSnapshot.activityProfile[maxT] = new Set();
    }
    sigmaStateSnapshot.activityProfile[maxT].add(sigmaArcUIDForClone);

    if (sigmaStateSnapshot.CTIndicator[sigmaArcUIDForClone]) {
      const cti = sigmaStateSnapshot.CTIndicator[sigmaArcUIDForClone];
      cti[cti.length - 1] = 2;
    }
    if (sigmaStateSnapshot.T[sigmaArcUIDForClone]) {
      const t = sigmaStateSnapshot.T[sigmaArcUIDForClone];
      t[t.length - 1] = maxT;
    }

    if (!sigmaStateSnapshot.path.includes(joinVertexUID)) {
      sigmaStateSnapshot.path.push(joinVertexUID);
    }

    const clone = createProcess(idCounter.nextId++, joinVertexUID);
    clone.states = sigmaStateSnapshot;
    processes.push(clone);
    console.log(
      `  Spawned MIX-OR Σ-only clone Process ${clone.id} at vertex ${joinVertexUID} ` +
      `(Σ arc ${sigmaArcUIDForClone} recorded at t=${maxT}, path: [${sigmaStateSnapshot.path.join(",")}])`
    );
  }

  return true;
}

// =============================================================================
// SECTION 4 — Competition handling
// =============================================================================

export function getTotalArcTraversals(processes, arcUID) {
  let total = 0;
  for (const proc of processes) {
    total += getArcTraversals(arcUID, proc.states.CTIndicator);
  }
  return total;
}

/**
 * Returns the set of active processes that are simultaneously trying to
 * traverse `arcUID` when doing so would exceed the arc's L-attribute.
 *
 * "Competing" means: the arc has already been consumed L times in aggregate
 * across all processes, OR multiple processes are simultaneously at the
 * arc's source vertex and the combined demand exceeds L.
 *
 * @param {Process[]} processes
 * @param {ArcUID} arcUID
 * @param {Cache} cache
 * @returns {Process[]}  empty when no competition exists
 */
export function getCompetingProcesses(processes, arcUID, cache) {
  const { arcMap } = cache;
  const arc = arcMap[arcUID];
  if (!arc) return [];

  // Candidates: active processes currently AT the arc's source vertex
  // AND specifically assigned to this arc (nextArcUID matches).
  // A process spawned from an OR-split at the same vertex but assigned
  // to a different arc is NOT a competitor for this arc.
  const candidates = processes.filter(
    (p) =>
      p.status === "active" &&
      p.currentVertex === arc.fromVertexUID &&
      (p.nextArcUID === arcUID || p.nextArcUID === null),
  );

  if (candidates.length <= 1) return [];

  // Total traversals already committed across ALL processes
  const committed = getTotalArcTraversals(processes, arcUID);

  // If all candidates could still traverse without exceeding L, no competition
  if (committed + candidates.length <= arc.L) return [];

  return candidates;
}

/**
 * Detects competition among active processes trying the same arc, resolves it
 * by locking all losers (lowest process ID wins), and records the event.
 *
 * Call this BEFORE checkArc / traverseArc for any arc that has multiple
 * simultaneous candidates.
 *
 * @param {Process[]} processes
 * @param {ArcUID} arcUID
 * @param {Cache} cache
 * @param {CompetitionEntry[]} competitionLog  mutated in-place
 * @returns {boolean}  true if competition was detected and resolved
 */
export function resolveCompetition(processes, arcUID, cache, competitionLog) {
  const competitors = getCompetingProcesses(processes, arcUID, cache);
  if (competitors.length === 0) return false;

  const { arcMap } = cache;
  const arc = arcMap[arcUID];
  const committed = getTotalArcTraversals(processes, arcUID);

  // Sort by process ID — lowest wins
  competitors.sort((a, b) => a.id - b.id);

  // How many more traversals are available?
  const remaining = Math.max(0, arc.L - committed);
  const winners   = competitors.slice(0, remaining > 0 ? remaining : 1);
  const losers    = competitors.slice(winners.length);

  for (const loser of losers) {
    lockProcess(loser);
    console.log(
      `  Competition on arc ${arcUID} (L=${arc.L}, committed=${committed}): ` +
      `Process ${loser.id} LOCKED (winner: Process ${winners[0]?.id})`,
    );
  }

  if (losers.length > 0) {
    competitionLog.push({
      arcUID,
      winnerProcessId:  winners[0]?.id ?? null,
      loserProcessIds:  losers.map((p) => p.id),
      totalTraversals:  committed,
      arcL:             arc.L,
      reason:
        `Arc (uid=${arcUID}) has L=${arc.L} but ${competitors.length} processes ` +
        `simultaneously attempted it (${committed} already committed). ` +
        `Process ${winners[0]?.id} wins; processes ${losers.map((p) => p.id).join(", ")} locked.`,
    });
  }

  return losers.length > 0;
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

/**
 * @param {Process[]} processes
 * @param {VertexUID} sink
 * @param {Cache} cache
 * @param {CompetitionEntry[]} competitionLog
 * @returns {PAEResult}
 */
export function getTerminationResult(processes, sink, cache, simpleModel, competitionLog = []) {
  const doneProcesses = processes.filter((p) => p.status === "done");
  if (doneProcesses.length === 0) return null;

  function getCompletionTime(activityProfile) {
    const steps = Object.keys(activityProfile).map(Number);
    return steps.length > 0 ? Math.max(...steps) : 0;
  }

  // Group done processes by completion timestep
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

  const parallelActivitySets = [];
  const impededResults = []; // post-hoc impeded processes (competition detected after traversal)

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Check for competing processes within this same-timestep group
    const { hasCompetition, competingActivityIds, competitionLog: ifCompetitionLog } = simpleModel
      ? checkCompetingProcesses(group, simpleModel)
      : { hasCompetition: false, competingActivityIds: [], competitionLog: [] };

    if (hasCompetition) {
      console.log(`  Competition detected among processes:`, competingActivityIds);

      // For each competing arc, determine winner (lowest process ID) and losers.
      // The winner keeps its full profile; losers get their profile truncated to
      // the timestep of the competing arc so the UI shows where they were impeded.
      for (const ifEntry of (ifCompetitionLog ?? [])) {
        const alreadyLogged = competitionLog.some(e => e.arcUID === ifEntry.arcUID);
        if (!alreadyLogged) {
          competitionLog.push({
            arcUID:           ifEntry.arcUID,
            winnerProcessId:  ifEntry.usedByProcessIds?.[0] ?? null,
            loserProcessIds:  ifEntry.usedByProcessIds?.slice(1) ?? [],
            usedByProcessIds: ifEntry.usedByProcessIds ?? [],
            totalTraversals:  ifEntry.usedByProcessIds?.length ?? 0,
            arcL:             ifEntry.arcL,
            reason:           ifEntry.reason,
          });
        }

        // Truncate loser profiles: keep only timesteps up to (and including)
        // the timestep where the competing arc appears, then stop.
        const loserIds = new Set(ifEntry.usedByProcessIds?.slice(1) ?? []);
        for (const entry of group) {
          if (!loserIds.has(entry.processId)) continue;

          // Find the earliest timestep that contains the competing arc
          const competingTimestep = Object.keys(entry.activityProfile)
            .map(Number)
            .sort((a, b) => a - b)
            .find(t => entry.activityProfile[t]?.has?.(ifEntry.arcUID));

          if (competingTimestep !== undefined) {
            // Keep only timesteps ≤ competingTimestep
            const truncated = {};
            for (const [ts, arcs] of Object.entries(entry.activityProfile)) {
              if (Number(ts) <= competingTimestep) {
                truncated[ts] = arcs;
              }
            }
            entry.activityProfile = truncated;
            console.log(
              `  Process ${entry.processId} profile truncated at t=${competingTimestep} ` +
              `(impeded by arc ${ifEntry.arcUID})`
            );
          }
        }
      }

      // Winner processes (lowest ID per competing arc) proceed normally.
      // Loser processes are moved out of the done group into impededResults.
      const allLoserIds = new Set(
        (ifCompetitionLog ?? []).flatMap(e => e.usedByProcessIds?.slice(1) ?? [])
      );
      const winnerGroup  = group.filter(a => !allLoserIds.has(a.processId));
      const loserEntries = group.filter(a =>  allLoserIds.has(a.processId));

      // Winners: if 2+ remain non-competing, they are parallel
      if (winnerGroup.length >= 2) parallelActivitySets.push(winnerGroup);

      // Losers: add to allProcessResults as impeded (partial profiles already truncated)
      for (const loser of loserEntries) {
        impededResults.push(loser);
      }
    } else {
      parallelActivitySets.push(group);
    }
  }

  // Competition only disqualifies parallelism if it affects the done processes
  // themselves. Intermediate lockouts from loop exploration are expected.
  const doneProcessIds = new Set(doneProcesses.map(p => p.id));
  const competitionAffectsDone = competitionLog.some(entry =>
    (entry.loserProcessIds ?? []).some(id => doneProcessIds.has(id))
  );
  const noCompetition = !competitionAffectsDone;
  const isParallel = parallelActivitySets.length > 0 && noCompetition;

  // Include winner done processes, post-hoc impeded processes (truncated profiles),
  // and traversal-time locked processes (eRU exhausted during traversal).
  const allProcessResults = [
    // Done processes that are NOT post-hoc losers (they keep their full profiles)
    ...doneProcesses
      .filter(p => !impededResults.some(ir => ir.processId === p.id))
      .map(p => ({ processId: p.id, activityProfile: p.states.activityProfile })),
    // Post-hoc impeded processes: competed for an arc but both completed;
    // their profiles are already truncated to the impeded timestep above.
    ...impededResults,
    // Traversal-time impeded processes — only those with a DISTINCT path from
    // all done processes (excludes pure-exploration lockouts from loop traversal).
    ...processes
      .filter(p => {
        if (p.status !== "locked") return false;
        if (!competitionLog.some(e => e.loserProcessIds?.includes(p.id))) return false;
        return !doneProcesses.some(done =>
          done.states.path.length === p.states.path.length &&
          done.states.path.every((v, i) => v === p.states.path[i])
        );
      })
      .map(p => ({ processId: p.id, activityProfile: p.states.activityProfile })),
  ];

  return {
    parallelActivitySets: parallelActivitySets.length > 0
      ? parallelActivitySets
      : [[...groups.values()].flat()],
    allProcessResults,
    isParallel,
    competitionLog,
  };
}


// =============================================================================
// SECTION 6.5 — Cycle / loop detection helpers
// =============================================================================

/**
 * Builds arcUID → eRU map from cycle detection.
 * Loop arcs must be traversed eRU times before the process exits the cycle.
 */
function buildCycleEruMap(cache) {
  const { arcs } = cache;

  // Build R in the format Cycle expects:
  // [{ arc: "fromUID, toUID", "r-id": arcUID, "l-attribute": L }]
  const R = arcs.map(arc => ({
    'arc':         `${arc.fromVertexUID}, ${arc.toVertexUID}`,
    'r-id':        arc.uid,
    'l-attribute': String(arc.L),
    'c':           arc.C,
  }));

  let cycleList = [];
  try {
    const cycleDetector = new Cycle(R);
    cycleList = cycleDetector.storeToCycleList();
  } catch (e) {
    console.warn("PAE: cycle detection failed —", e?.message ?? e);
    return new Map();
  }

  // Build arcUID → eRU map.
  // Each cycle entry has eRU = minL of that cycle assigned by storeToCycleList.
  // The "r-id" field in each cycle entry is the arcUID.
  const eruMap = new Map();
  for (const { cycle } of cycleList) {
    for (const entry of cycle) {
      const arcUID = Number(entry['r-id']);
      const eRU   = entry.eRU;
      if (!isNaN(arcUID) && eRU !== undefined) {
        const existing = eruMap.get(arcUID);
        eruMap.set(arcUID, existing !== undefined ? Math.min(existing, eRU) : eRU);
      }
    }
  }

  if (eruMap.size > 0) {
    console.log("PAE cycle eRU map:", [...eruMap.entries()]
      .map(([uid, eRU]) => `arc${uid}(eRU=${eRU})`).join(", "));
  } else {
    console.log("PAE: no cycles detected");
  }
  return eruMap;
}

/**
 * Sorts outgoing arcs so loop arcs (not yet traversed eRU times) come first.
 * This ensures maximal activities fully traverse all loops before exiting.
 */
function sortArcsLoopFirst(outgoingArcUIDs, CTIndicator, cycleEruMap) {
  const loopArcs    = [];
  const nonLoopArcs = [];

  for (const arcUID of outgoingArcUIDs) {
    const eRU = cycleEruMap.get(arcUID);
    if (eRU !== undefined) {
      const traversals = getArcTraversals(arcUID, CTIndicator);
      if (traversals < eRU) {
        loopArcs.push(arcUID);
      } else {
        nonLoopArcs.push(arcUID);
      }
    } else {
      nonLoopArcs.push(arcUID);
    }
  }

  return [...loopArcs, ...nonLoopArcs];
}

// =============================================================================
// SECTION 7 — Main algorithm
// =============================================================================

export function parallelActivityExtraction(source, sink, cache, simpleModel = null) {
  const { arcMap, arcsMatrix } = cache;
  const processes = [createProcess(1, source)];
  const idCounter = { nextId: 2 };
  const results = [];
  /** @type {CompetitionEntry[]} */
  const competitionLog = [];

  // Build cycle eRU map — loop arcs must be traversed eRU times first.
  const cycleEruMap = buildCycleEruMap(cache);

  let safetyLimit = 10000;

  while (processes.some((p) => p.status === "active")) {
    if (--safetyLimit <= 0) {
      console.warn("PAE: safety limit reached — possible infinite loop");
      break;
    }

    for (const proc of processes.filter((p) => p.status === "active")) {
      // Re-check — could have been locked/done mid-iteration
      if (proc.status !== "active") continue;

      // Sink check FIRST — before outgoing arcs (sink has no outgoing arcs)
      if (proc.currentVertex === sink) {
        proc.status = "done";
        results.push({
          processId: proc.id,
          activityProfile: proc.states.activityProfile,
        });
        continue;
      }

      const allOutgoing = [...getOutgoingArcs(proc.currentVertex, arcsMatrix)];

      // Filter out arcs this process has already exhausted per its own
      // L-attribute. After an outbridge traversal the RBS-internal arcs are
      // reset by aes.mjs::traverseArc, so they re-appear as available on the
      // next loop iteration. The outbridge arc itself is NOT reset, which is
      // what makes a one-shot exit (L=1) one-shot. Arcs that are exhausted
      // for this process but may still be eligible for OTHER processes
      // (separate L budget per parallel activity) are simply removed from
      // THIS process's choice set here — they are not a global block.
      const outgoing = allOutgoing.filter((uid) => {
        const a = arcMap[uid];
        return getArcTraversals(uid, proc.states.CTIndicator) < a.L;
      });

      if (outgoing.length === 0) {
        lockProcess(proc);
        continue;
      }

      // Determine which arc to assess
      if (proc.nextArcUID === null) {
        if (outgoing.length > 1) {
          for (let i = 1; i < outgoing.length; i++) {
            // A child is a duplicate only if it has the same path history as this
            // process — two processes that arrived at the same vertex via different
            // routes must each independently spawn their own split children.
            // A child is already spawned if another process with the same path
            // history is already assigned to this arc (nextArcUID match),
            // OR if a process with the same path already traversed this arc.
            // We do NOT block spawning just because a DIFFERENT lineage process
            // is assigned to this arc — each activity branch must independently
            // spawn its own children at every AND/OR split.
            const alreadySpawned = processes.some(
              (p) =>
                p.id !== proc.id &&
                p.nextArcUID === outgoing[i] &&
                p.states.path.length === proc.states.path.length &&
                p.states.path.every((v, idx) => v === proc.states.path[idx]),
            );
            if (!alreadySpawned) {
              const child = createProcess(idCounter.nextId++, proc.currentVertex);
              child.states = structuredClone(proc.states);
              child.nextArcUID = outgoing[i];
              processes.push(child);
              console.log(`  Process ${proc.id} spawned Process ${child.id} for arc ${outgoing[i]} at vertex ${proc.currentVertex}`);
            } else {
              console.log(`  Process ${proc.id} skipped spawn for arc ${outgoing[i]} (alreadySpawned)`);
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

      // ── eRU exhaustion check ──────────────────────────────────────────────
      // Check if this arc is already fully used across ALL processes,
      // even if only this one process is currently trying it.
      // This handles the case where a previous process already consumed L
      // traversals before this process arrived.
      // Count traversals by OTHER processes that represent genuine competition.
      // A process p genuinely competes for arc arcUID only if it traversed
      // that arc AFTER its path diverged from the current process (proc).
      // If p was spawned from proc's states (or from a common ancestor) and
      // the arc was traversed BEFORE the split, p's CTIndicator count is
      // inherited — not a real independent traversal.
      //
      // Detection: find the first index where proc.path and p.path differ.
      // If arc's fromVertex appears in proc.path ONLY before that split index,
      // then p's traversal of the arc is inherited, not independent.
      const arcFromVertex = arc.fromVertexUID;
      const arcToVertex   = arc.toVertexUID;
      const procPath = proc.states.path;

      const usedByOthers = processes
        .filter((p) => {
          if (p.id === proc.id) return false;
          if (getArcTraversals(arcUID, p.states.CTIndicator) === 0) return false;

          const pPath = p.states.path;

          // Find the split point: first index where paths diverge
          let splitIdx = 0;
          while (splitIdx < procPath.length && splitIdx < pPath.length &&
                 procPath[splitIdx] === pPath[splitIdx]) {
            splitIdx++;
          }
          // splitIdx is now the first index that differs (or end of shorter path)

          // Check if arcFromVertex appears in p's path AFTER the split point
          // (meaning p independently traversed through fromVertex after diverging)
          for (let i = splitIdx; i < pPath.length - 1; i++) {
            if (pPath[i] === arcFromVertex && pPath[i + 1] === arcToVertex) {
              return true; // genuinely independent traversal after split
            }
          }

          // Also count if p is currently at fromVertex right now (competing now)
          if (p.currentVertex === arcFromVertex &&
              (p.nextArcUID === arcUID || p.nextArcUID === null)) {
            return true;
          }

          return false;
        })
        .reduce((sum, p) => sum + getArcTraversals(arcUID, p.states.CTIndicator), 0);

      if (usedByOthers >= arc.L) {
        lockProcess(proc);
        console.log(`  Process ${proc.id} LOCKED — arc ${arcUID} exhausted by others (usedByOthers=${usedByOthers}, L=${arc.L})`);
        const priorUsers = processes.filter(
          (p) => p.id !== proc.id && getArcTraversals(arcUID, p.states.CTIndicator) > 0
        );
        competitionLog.push({
          arcUID,
          winnerProcessId:  priorUsers[0]?.id ?? null,
          loserProcessIds:  [proc.id],
          usedByProcessIds: [...priorUsers.map(p => p.id), proc.id],
          totalTraversals:  usedByOthers,
          arcL:             arc.L,
          reason:
            `Arc (uid=${arcUID}) L=${arc.L} already fully used by process(es) ` +
            `[${priorUsers.map(p => p.id).join(", ")}]. ` +
            `Process ${proc.id} is impeded and cannot traverse it.`,
        });
        continue;
      }

      // ── Simultaneous competition check ────────────────────────────────────
      // Multiple processes at the same vertex simultaneously — lowest ID wins.
      resolveCompetition(processes, arcUID, cache, competitionLog);

      // If this process was just locked by competition resolution, skip it
      if (proc.status !== "active") continue;
      // ─────────────────────────────────────────────────────────────────────

      const isUnconstrained = checkArc({ arcUID }, proc.states, cache);
      console.log(`  → isUnconstrained: ${isUnconstrained}`);

      if (isUnconstrained) {
        // Check if destination is a MIX join AND an ε-arc sibling is already
        // pending there. If so, this Σ-arc process must wait too so both can
        // resolve together (MIX-AND merge + MIX-OR clone).
        // We check the destination's incoming arcs directly rather than using
        // getJoinType(proc) — because getJoinType with the Σ process as askingProcess
        // will always return MIX-AND-join (its own T already has the Σ arc checked).
        const destIncoming = [...getIncomingArcs(arc.toVertexUID, cache.arcsMatrix)];
        const destIsMixJoin = destIncoming.length > 1 &&
          destIncoming.some(uid => isEpsilon(cache.arcMap[uid])) &&
          destIncoming.some(uid => !isEpsilon(cache.arcMap[uid]));

        const epsArcPendingAtDest = destIsMixJoin &&
          !isEpsilon(arc) &&   // this process is on a Σ arc
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

          // Per the RBS semantics in the algorithm (Petilos/Doñoz/Labanan):
          // when an outbridge of an RBS Gu is traversed, ONLY the arcs INSIDE
          // the RBS arc set EGu (arcs (a,b) with a,b ∈ VGu) are reset — not the
          // outbridge arc itself. aes.mjs::traverseArc already performs that
          // EGu reset. The outbridge's own L-attribute keeps counting, which
          // is what makes the outbridge act as a one-shot exit when L=1.
          // (We previously cleared the outbridge's own CTIndicator/T here,
          // which incorrectly made any L=1 outbridge re-traverseable forever
          // and produced infinite RBS loops.)

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
          // OR-join: no waiting, no merging — each process passes through its
          // own incoming arc independently. checkArc returned false only because
          // a sibling arc with same C was already traversed, but this process
          // is on a DIFFERENT arc with its own L-attribute. Allow it through.
          traverseArc({ arcUID }, proc.states, cache);
          proc.currentVertex = arc.toVertexUID;
          console.log(`  → OR-join: Process ${proc.id} passed through independently to ${proc.currentVertex}`);

          // Outbridge traversal resets only EGu arcs (handled in aes.mjs).
          // Do NOT reset the outbridge arc itself — its L-attribute applies.

          if (proc.currentVertex === sink) {
            proc.status = "done";
            results.push({ processId: proc.id, activityProfile: proc.states.activityProfile });
            console.log(`  → Process ${proc.id} reached sink!`);
          }

          checkProcessInterruption(processes, proc, arcUID, cache);

        } else {
          lockProcess(proc);
          console.log(`  → Process ${proc.id} locked (constrained, no join)`);
        }
      }
    }

    // Resolve pending AND and MIX joins.
    // Re-check status inside the loop because resolvePendingProcesses absorbs
    // partner processes and flips their status from "pending" to "locked"
    // mid-iteration. The snapshot taken by .filter() still includes those
    // absorbed processes, and without a re-check the stranded fallback would
    // run on a process that has already been merged into its survivor.
    for (const proc of processes.filter((p) => p.status === "pending")) {
      if (proc.status !== "pending") continue;
      if (!proc.pendingArcUID) continue;
      const pendingArc = cache.arcMap[proc.pendingArcUID];
      if (!pendingArc) continue;

      const joinType = getJoinType(pendingArc.toVertexUID, cache, processes, proc);
      if (joinType === "AND-join" || joinType === "MIX-AND-join" || joinType === "MIX-OR-join") {
        const resolved = resolvePendingProcesses(
          processes,
          pendingArc.toVertexUID,
          cache,
          idCounter,
        );
        if (resolved) {
          console.log(`Resolved join at vertex ${pendingArc.toVertexUID}`);
        } else {
          // Check if stranded — for every OTHER incoming arc, no live process
          // can still arrive on it. A process counts as "live" if it is pending
          // on that arc, or if it is active and its currentVertex can still
          // forward-reach the source of that arc through the graph.
          //
          // The previous version of this check only looked at processes
          // already pending on the partner arc, which fired the fallback the
          // moment the partner process was still upstream — breaking AND-joins.
          const incomingArcs = [...getIncomingArcs(pendingArc.toVertexUID, cache.arcsMatrix)];
          const isStranded = incomingArcs
            .filter(uid => uid !== proc.pendingArcUID)
            .every(uid => !canStillArriveOnArc(uid, processes, cache));

          if (isStranded) {
            traverseArc({ arcUID: proc.pendingArcUID }, proc.states, cache);
            proc.currentVertex = pendingArc.toVertexUID;
            proc.status = "active";
            proc.pendingArcUID = null;
            console.log(`  Process ${proc.id} unblocked (stranded — no merge partner), now at ${proc.currentVertex}`);

            if (proc.currentVertex === sink) {
              proc.status = "done";
              results.push({ processId: proc.id, activityProfile: proc.states.activityProfile });
              console.log(`  → Process ${proc.id} reached sink (stranded fallback)!`);
            }
          }
        }
      } else if (joinType === "none") {
        // joinType === "none" for a pending Σ process when all ε arc processes
        // at a MIX join are already consumed (locked/done). This process can
        // no longer merge — allow it through independently (MIX-OR fallback).
        const incomingArcs = [...getIncomingArcs(pendingArc.toVertexUID, cache.arcsMatrix)];
        const isMixVertex = incomingArcs.length > 1 &&
          incomingArcs.some(uid => isEpsilon(cache.arcMap[uid])) &&
          incomingArcs.some(uid => !isEpsilon(cache.arcMap[uid]));
        const epsArcExhausted = isMixVertex && incomingArcs
          .filter(uid => isEpsilon(cache.arcMap[uid]))
          .every(uid => !processes.some(
            p => (p.status === "pending" || p.status === "active") && p.pendingArcUID === uid
          ));

        if (epsArcExhausted) {
          // No ε partner available — pass through independently
          traverseArc({ arcUID: proc.pendingArcUID }, proc.states, cache);
          proc.currentVertex = pendingArc.toVertexUID;
          proc.status = "active";
          proc.pendingArcUID = null;
          console.log(
            `  Process ${proc.id} unblocked (MIX-OR fallback — ε arc exhausted), ` +
            `now at ${proc.currentVertex}`
          );

          if (proc.currentVertex === sink) {
            proc.status = "done";
            results.push({ processId: proc.id, activityProfile: proc.states.activityProfile });
            console.log(`  → Process ${proc.id} reached sink via MIX-OR fallback!`);
          }
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

  return getTerminationResult(processes, sink, cache, simpleModel, competitionLog);
}