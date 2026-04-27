/*
Service Module for Parallel Activity Extraction (PAE)
Based on Algorithm 2 from Doñoz (2024).

Key differences from aes.mjs (sequential AE):
  - Multiple processes run concurrently from the source
  - No backtracking — pending processes wait at join points
  - eRU is enforced across ALL processes combined, not per-process
  - Splits spawn new child processes
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


export function createProcess(id, startVertex) {
  return {
    id,
    currentVertex: startVertex,
    nextArcUID: null,
    status: "active",
    pendingArcUID: null,
    /**
     * Process Interruption marker. If non-null, this process was inside an
     * RBS at the moment another process exited that RBS via an outbridge.
     *
     * Value is the RBS center UID of the interrupting RBS. The process is
     * marked status='pending' until either:
     *   - a future AND/MIX-join with the interrupting process's path resolves
     *     it (B is then unblocked and merged via resolvePendingProcesses), or
     *   - no such join exists in B's forward reachability → B is locked.
     *
     * Cleared once B exits the RBS itself (current vertex is no longer in
     * VGu of the interrupting RBS center).
     */
    interruptedByRBS: null,
    /**
     * The id of the specific process whose outbridge traversal triggered the
     * PI marker. Tracked so the resume logic can verify the interrupting
     * lineage (or one of its descendants/absorbers) is still alive and can
     * reach a shared AND/MIX-join. If the interrupting process locks or
     * terminates without ever sharing a join with us, we lock.
     */
    interruptedByProcessId: null,
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
  // Build pendingByArc map needed for variant construction below
  const pendingByArc = new Map(); // arcUID → Process[]
  for (const arcUID of incomingArcs) {
    pendingByArc.set(arcUID, pendingHere.filter(p => p.pendingArcUID === arcUID));
  }

  // Check every incoming arc has at least one pending process
  const hasAllArcs = incomingArcs.every(uid => (pendingByArc.get(uid)?.length ?? 0) > 0);
  if (!hasAllArcs) return false;

  // ── OR-subgroup-aware merge variants ──────────────────────────────────────
  // When an AND-join has multiple incoming arcs sharing the same C-value,
  // those arcs form an OR-subgroup (Structure 8 from manuscript §3.3). The
  // join produces multiple merge variants — one per Cartesian-product choice
  // of "one arc per C-group". Each variant becomes its own surviving activity.
  //
  // Example: at x4 with incoming = [(x2→x4, 'a'), (x3→x4, 'a'), (x5→x4, 'b')],
  //   C-groups: { 'a': [x2-arc, x3-arc], 'b': [x5-arc] }
  //   Variants: { 'a':x2-arc + 'b':x5-arc },  { 'a':x3-arc + 'b':x5-arc }
  //   → two merged activities, sharing the same x5-arc traversal but
  //     differing in which 'a'-arc was used.
  //
  // For C-groups with only one arc, that arc participates in EVERY variant.
  // Its pending process must be CLONED for each variant beyond the first so
  // the same state can be merged into multiple parallel survivors.

  // Group incoming arcs by C-value
  const arcsByC = new Map();
  for (const uid of incomingArcs) {
    const c = arcMap[uid].C ?? '';
    if (!arcsByC.has(c)) arcsByC.set(c, []);
    arcsByC.get(c).push(uid);
  }

  // ── Process-level variant generation ──────────────────────────────────────
  // Build variants based on PROCESSES pending at each C-group, not just arcs.
  // For each C-group, list all pending processes (across all arcs in that
  // group). Then take the Cartesian product across C-groups, generating one
  // mergeGroup per combination of (one process per C-group).
  //
  // The number of variants equals the product of process counts per C-group.
  // Example: C='h' has 4 pending processes, C='c' has 2 pending processes →
  // 4 × 2 = 8 variants? No — we want max(4, 2) = 4 variants, pairing each
  // 'h' process with its OWN 'c' process (cloning 'c' processes as needed).

  // Build C → processes map
  const processesPerC = new Map(); // C-value → Process[]
  for (const [c, arcUIDs] of arcsByC.entries()) {
    const allProcs = [];
    for (const uid of arcUIDs) {
      const procs = pendingByArc.get(uid) ?? [];
      allProcs.push(...procs);
    }
    allProcs.sort((a, b) => a.id - b.id);
    processesPerC.set(c, allProcs);
  }

  // The number of variants = max process count across all C-groups.
  // Each variant takes ONE process per C-group; if a C-group runs out of
  // unique processes, we clone its lowest-ID process.
  let maxProcs = 0;
  for (const [, procs] of processesPerC) maxProcs = Math.max(maxProcs, procs.length);

  if (maxProcs === 0) return false;

  const variantGroups = [];
  const consumedPerC = new Map();
  for (const c of processesPerC.keys()) consumedPerC.set(c, 0);

  for (let vIdx = 0; vIdx < maxProcs; vIdx++) {
    const mergeGroup = [];
    const clonedProcs = new Map();
    let valid = true;

    for (const [c, procs] of processesPerC.entries()) {
      const consumedCount = consumedPerC.get(c);
      if (consumedCount < procs.length) {
        mergeGroup.push(procs[consumedCount]);
        consumedPerC.set(c, consumedCount + 1);
      } else {
        // Need to clone an existing process for this C-group.
        // Pick the lowest-ID process (which carries the earliest, most-shared
        // state) and clone it onto the appropriate arc.
        const original = procs[0];
        if (!original) { valid = false; break; }
        if (!idCounter) { valid = false; break; }

        const cloneState = structuredClone(original.states);
        const clone = {
          id: idCounter.nextId++,
          currentVertex: original.currentVertex,
          nextArcUID: original.nextArcUID,
          status: 'pending',
          pendingArcUID: original.pendingArcUID,
          interruptedByRBS: original.interruptedByRBS ?? null,
          interruptedByProcessId: original.interruptedByProcessId ?? null,
          states: cloneState,
        };
        processes.push(clone);
        mergeGroup.push(clone);
        clonedProcs.set(original.pendingArcUID, clone);
        console.log(
          `  Cloned Process ${original.id} → Process ${clone.id} ` +
          `(C-group '${c}' needed for parallel merge variant ${vIdx + 1})`
        );
      }
    }

    if (valid && mergeGroup.length === processesPerC.size) {
      variantGroups.push({ mergeGroup, clonedProcs });
    }
  }

  if (variantGroups.length === 0) return false;

  // Now process each variant — perform the merge for each variant group.
  // The first variant's survivor is the lowest-ID original process; subsequent
  // variants get their own survivors (any of their group members).
  let resolvedAny = false;
  for (let vIdx = 0; vIdx < variantGroups.length; vIdx++) {
    const { mergeGroup: resolveGroup } = variantGroups[vIdx];
    const ok = mergeOneVariant(
      resolveGroup,
      incomingArcs,
      joinVertexUID,
      processes,
      cache,
      idCounter,
    );
    if (ok) resolvedAny = true;
  }

  return resolvedAny;
}

/**
 * Performs a single merge: combine the resolveGroup of pending processes into
 * a survivor at the join vertex. Used by resolvePendingProcesses for each
 * Cartesian-product variant of an AND-join with OR-subgroups.
 */
function mergeOneVariant(resolveGroup, incomingArcs, joinVertexUID, processes, cache, idCounter) {
  const { arcMap } = cache;

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

/**
 * Builds the set of vertices VGu of an RBS Gu given its center UID. Per the
 * matrix-representation definition (Malinao 2017): VGu = {u} ∪ {v ∈ V :
 * (u, v) ∈ E ∧ C((u, v)) = ε}. Only direct ε-children of the center.
 *
 * The cache.rbsMatrix maps every member vertex UID → its RBS center UID.
 * This helper enumerates members of one specific RBS by reverse-lookup.
 *
 * @param {VertexUID} centerUID
 * @param {Cache} cache
 * @returns {Set<VertexUID>}
 */
export function getRBSMembers(centerUID, cache) {
  const members = new Set();
  for (const [vertexStr, ownerCenter] of Object.entries(cache.rbsMatrix)) {
    if (Number(ownerCenter) === Number(centerUID)) {
      members.add(Number(vertexStr));
    }
  }
  return members;
}

/**
 * Returns true if vertex `u` is currently inside RBS centered at `centerUID`.
 *
 * @param {VertexUID} u
 * @param {VertexUID} centerUID
 * @param {Cache} cache
 * @returns {boolean}
 */
export function isVertexInRBS(u, centerUID, cache) {
  return Number(cache.rbsMatrix[u]) === Number(centerUID);
}

/**
 * Searches for a vertex along B's forward-reachable path that:
 *   - is itself a join vertex (has more than one incoming arc), and
 *   - is also forward-reachable from A's current vertex (so the two paths
 *     can actually meet there), and
 *   - has join type AND-join, MIX-AND-join, or MIX-OR-join (any join type
 *     that can resolve the PI per the manuscript: "resolved when they
 *     eventually merge in an AND or MIX-join that traverses the C(x,y)=ε
 *     condition first").
 *
 * Returns the first such vertex UID found, or null if no resolution is
 * possible (in which case the interrupted process should be locked —
 * the deadlock case from line 100 of Algorithm 2).
 *
 * @param {VertexUID} bVertex - B's current position (inside RBS)
 * @param {VertexUID} aVertex - A's current position (just exited RBS)
 * @param {Process[]} processes
 * @param {Cache} cache
 * @returns {VertexUID | null}
 */
export function findInterruptionResolutionVertex(bVertex, aVertex, processes, cache) {
  const { arcsMatrix, vertexMap } = cache;
  const bReachable = forwardReachableVertices(bVertex, arcsMatrix);
  const aReachable = forwardReachableVertices(aVertex, arcsMatrix);

  for (const candidate of bReachable) {
    if (!aReachable.has(candidate)) continue;
    if (candidate === bVertex || candidate === aVertex) continue;

    const incoming = [...getIncomingArcs(candidate, arcsMatrix)];
    if (incoming.length < 2) continue; // not a join vertex

    const joinType = getJoinType(candidate, cache, processes, null);
    // Per the manuscript, PI resolves only at AND/MIX-joins. OR-joins do not
    // resolve PI — they would lock the interrupted process.
    if (joinType === "AND-join" ||
        joinType === "MIX-AND-join" ||
        joinType === "MIX-OR-join") {
      return candidate;
    }
  }
  return null;
}

/**
 * Process Interruption check (Algorithm 2 lines 38-47 and 91-100, Doñoz 2024).
 *
 * Triggered immediately after activity A traverses an outbridge `(x, y)` where
 * `x ∈ VGu` and `y ∉ VGu` for some RBS Gu. Looks for any other ACTIVE process
 * B currently at a vertex inside Gu — those are interrupted by A's exit.
 *
 * Per the manuscript:
 *   "If one outgoing process exits the RBS first, the other activity/ies will
 *    be marked pending inside the RBS, and is resolved when they eventually
 *    merge in an AND or MIX-join (that traverses the C(x, y) = ε condition
 *    first) in reaching the merging vertex."
 *
 * For each interrupted sibling:
 *   1. Search forward-reachable vertices from B's current position for a
 *      candidate AND/MIX join that A can also reach.
 *   2. If found: mark B as PI-pending. B's `interruptedByRBS` records the
 *      RBS center, and B's status becomes 'pending'. The main loop's pending
 *      resolver will later let B resume forward traversal toward that join,
 *      which will be resolved by `resolvePendingProcesses`.
 *   3. If no resolvable join exists: lock B — this is the deadlock case in
 *      line 100 of Algorithm 2.
 *
 * Multi-RBS support: this check is scoped to a single RBS center per call.
 * If a model has multiple RBS, each one's outbridge traversal triggers an
 * independent PI check. A single process can be interrupted by multiple RBS
 * if it's somehow inside a nested structure, but typically only one applies.
 *
 * @param {Process[]} processes
 * @param {Process} exitingProcess - the activity A that just traversed outbridge
 * @param {ArcUID} arcUID - the outbridge arc just traversed
 * @param {Cache} cache
 */
export function checkProcessInterruption(processes, exitingProcess, arcUID, cache) {
  const { rbsMatrix, arcMap } = cache;
  const arc = arcMap[arcUID];

  if (!isOutbridge(arcUID, arcMap, rbsMatrix)) return;

  const rbsCenterUID = rbsMatrix[arc.fromVertexUID];

  // Find every other process currently INSIDE this RBS (active or already
  // interrupted by another exit). We don't interrupt processes that are
  // outside the RBS — and we don't re-interrupt locked or done processes.
  const interruptedSiblings = processes.filter(
    (p) =>
      p.id !== exitingProcess.id &&
      (p.status === "active" || p.status === "pending") &&
      p.status !== "done" && p.status !== "locked" &&
      isVertexInRBS(p.currentVertex, rbsCenterUID, cache),
  );

  if (interruptedSiblings.length === 0) {
    // Manuscript Case (a): only one activity uses the RBS → skip PI check.
    return;
  }

  console.log(
    `  PI: Process ${exitingProcess.id} exited RBS (center ${rbsCenterUID}) via arc ${arcUID}. ` +
    `Found ${interruptedSiblings.length} sibling(s) still inside.`
  );

  for (const sibling of interruptedSiblings) {
    // Don't re-mark a sibling that's already PI-pending for this RBS.
    if (sibling.interruptedByRBS === rbsCenterUID) continue;

    // Look for a resolvable AND/MIX-join in B's forward reachability that A
    // can also reach. If none, lock B (deadlock per line 100 of Alg. 2).
    const resolutionVertex = findInterruptionResolutionVertex(
      sibling.currentVertex,
      exitingProcess.currentVertex,
      processes,
      cache,
    );

    if (resolutionVertex === null) {
      console.log(
        `  PI: Process ${sibling.id} at vertex ${sibling.currentVertex} has no ` +
        `AND/MIX-join resolution path with Process ${exitingProcess.id} → LOCKED (deadlock).`
      );
      lockProcess(sibling);
      continue;
    }

    // Mark sibling as interrupted. Status = pending (NOT locked). Sibling
    // keeps its currentVertex, but its forward traversal is gated until the
    // pending resolver determines the join is fillable. We DON'T set
    // pendingArcUID — sibling has no specific arc it's blocked on, just a
    // PI marker. The unblock happens via `tryResumeInterruptedProcess`
    // called from the main loop.
    sibling.status = "pending";
    sibling.interruptedByRBS = rbsCenterUID;
    sibling.interruptedByProcessId = exitingProcess.id;
    sibling.pendingArcUID = null;
    console.log(
      `  PI: Process ${sibling.id} at vertex ${sibling.currentVertex} marked ` +
      `pending (interruptedByRBS=${rbsCenterUID}, by Process ${exitingProcess.id}, ` +
      `will resolve at vertex ${resolutionVertex}).`
    );
  }
}

/**
 * Called once per main-loop iteration. Allows interrupted processes to resume
 * forward traversal: a PI-pending process is reactivated to 'active' if its
 * resolution path with the interrupting process is still viable. The actual
 * merge/lock then happens through the existing pending-resolution loop and
 * join logic.
 *
 * Specifically, B (the interrupted process) can resume if:
 *   - the interrupting process A (or any active descendant/survivor of A's
 *     lineage at a downstream position) can still reach a vertex that B can
 *     also reach, and that vertex is an AND/MIX-join.
 *
 * If A is locked or done, but A's path was absorbed into a survivor S during
 * a prior merge, then S inherits A's lineage — we treat any non-locked /
 * non-done process whose `currentVertex` is forward-reachable from A's last
 * known position OR whose path includes A's last vertex as a possible
 * resolution partner. (Pragmatic approximation; fully tracing absorption
 * lineage would require additional bookkeeping.)
 *
 * If no such resolution path exists, B is locked (manuscript line 100).
 *
 * @param {Process[]} processes
 * @param {Cache} cache
 */
export function tryResumeInterruptedProcesses(processes, cache) {
  for (const proc of processes) {
    if (proc.status !== "pending") continue;
    if (proc.interruptedByRBS === null) continue;
    if (proc.pendingArcUID !== null) continue; // arc-pending takes precedence

    // Find the lineage of the interrupting process. It is "alive" for our
    // purposes if either:
    //   - the original interrupting process is still active/pending and can
    //     reach a shared AND/MIX-join with us; OR
    //   - some other active/pending process whose path passes through the
    //     interrupting process's path is reachable to a shared AND/MIX-join.
    // The simplest viable test: enumerate all live processes and check
    // whether ANY of them shares a downstream AND/MIX-join with us. This
    // matches the manuscript intent: PI is resolved when the interrupted
    // activity merges with the interrupting activity at an AND/MIX-join.
    // If the interrupting process was absorbed into a survivor, the survivor
    // is a live process and will satisfy the test.
    const livePartners = processes.filter(
      (p) => p.id !== proc.id &&
             p.status !== "locked" &&
             p.status !== "done"
    );

    let resolutionVertex = null;
    let resolutionPartnerId = null;
    const myReach = forwardReachableVertices(proc.currentVertex, cache.arcsMatrix);

    for (const partner of livePartners) {
      const partnerReach = forwardReachableVertices(partner.currentVertex, cache.arcsMatrix);
      for (const v of myReach) {
        if (!partnerReach.has(v)) continue;
        if (v === proc.currentVertex || v === partner.currentVertex) continue;
        const incoming = [...getIncomingArcs(v, cache.arcsMatrix)];
        if (incoming.length < 2) continue;
        const jt = getJoinType(v, cache, processes, null);
        if (jt === "AND-join" || jt === "MIX-AND-join" || jt === "MIX-OR-join") {
          resolutionVertex = v;
          resolutionPartnerId = partner.id;
          break;
        }
      }
      if (resolutionVertex !== null) break;
    }

    if (resolutionVertex !== null) {
      proc.status = "active";
      console.log(
        `  PI: Process ${proc.id} resuming from PI-pending ` +
        `(viable resolution at vertex ${resolutionVertex} with Process ${resolutionPartnerId}).`
      );
    } else {
      console.log(
        `  PI: Process ${proc.id} has no viable resolution partner → LOCKED (deadlock).`
      );
      lockProcess(proc);
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
              // Children inherit any active PI marker from their parent — they
              // are spawning at the same vertex and the parent was interrupted,
              // so the child is also interrupted.
              child.interruptedByRBS = proc.interruptedByRBS;
              child.interruptedByProcessId = proc.interruptedByProcessId;
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
        // Check if destination is a MIX join. If so, the Σ-arc process must
        // wait at the join so both the MIX-AND merge AND the MIX-OR clone
        // can be produced. Per the manuscript:
        //   - MIX-AND path: ε waits for Σ; both merge as one activity.
        //   - MIX-OR path:  Σ goes through independently as its own activity.
        // Both must be produced. The Σ process going through unconstrained
        // before the ε partner arrives would skip the MIX-AND merge entirely.
        //
        // We mark the Σ process pending if any ε arc to the same join vertex
        // is still reachable by some live process — i.e. the merge partner
        // can still arrive. The `canStillArriveOnArc` helper handles the
        // "in-flight" case (active processes upstream of the partner arc).
        const destIncoming = [...getIncomingArcs(arc.toVertexUID, cache.arcsMatrix)];
        const destIsMixJoin = destIncoming.length > 1 &&
          destIncoming.some(uid => isEpsilon(cache.arcMap[uid])) &&
          destIncoming.some(uid => !isEpsilon(cache.arcMap[uid]));

        let mustWaitForMixPartner = false;
        if (destIsMixJoin && !isEpsilon(arc)) {
          // Find ε incoming arcs (other than the one this process is taking)
          const epsIncomingArcs = destIncoming.filter(uid =>
            uid !== arcUID && isEpsilon(cache.arcMap[uid])
          );
          // If any ε partner could still arrive at the join, this Σ process
          // must wait so the MIX-AND merge can still happen.
          mustWaitForMixPartner = epsIncomingArcs.some(uid =>
            canStillArriveOnArc(uid, processes, cache)
          );
        }

        if (mustWaitForMixPartner) {
          // Σ arc process must wait so both MIX-AND and MIX-OR can be produced
          markProcessPending(proc, arcUID);
          console.log(`  → Process ${proc.id} pending (Σ arc, waiting for MIX join resolution at ${arc.toVertexUID})`);
        } else {
          traverseArc({ arcUID }, proc.states, cache);
          proc.currentVertex = arc.toVertexUID;
          console.log(`  → traversed, now at ${proc.currentVertex}`);

          // PI bookkeeping: if this process was previously marked as
          // interrupted by an RBS exit and has now itself moved to a vertex
          // OUTSIDE that RBS, the interruption no longer applies — clear it.
          if (proc.interruptedByRBS !== null &&
              !isVertexInRBS(proc.currentVertex, proc.interruptedByRBS, cache)) {
            console.log(
              `  PI: Process ${proc.id} exited RBS (center ${proc.interruptedByRBS}) — clearing PI marker.`
            );
            proc.interruptedByRBS = null;
            proc.interruptedByProcessId = null;
          }

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

          // PI marker cleanup — see comment in unconstrained branch above.
          if (proc.interruptedByRBS !== null &&
              !isVertexInRBS(proc.currentVertex, proc.interruptedByRBS, cache)) {
            console.log(
              `  PI: Process ${proc.id} exited RBS (center ${proc.interruptedByRBS}) — clearing PI marker.`
            );
            proc.interruptedByRBS = null;
            proc.interruptedByProcessId = null;
          }

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

    // After arc-based pending resolution, give PI-pending processes a chance
    // to resume. A process marked interrupted-by-RBS has no specific arc it
    // is waiting on; it just needs an AND/MIX-join down the line where it
    // can merge with the interrupting process. If such a join is still
    // reachable, reactivate; otherwise lock.
    tryResumeInterruptedProcesses(processes, cache);
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