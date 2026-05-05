import { buildArcMap, buildVertexMap, isEpsilon } from "../utils.mjs";

/**
 * Classical Soundness (Liveness + Proper Termination)
 *
 * A separate, lightweight classical soundness check that is independent of the
 * Ejercito and Asoy implementations in `soundness/soundness-service.mjs`.
 *
 * Where the Ejercito / Asoy checks rely on the heavy CAS / MCA / R1-R2 graph
 * machinery (which is appropriate for relaxed and easy soundness), this module
 * works directly on the RDLT arc graph and verifies the two classical
 * workflow-net properties from van der Aalst (1998):
 *
 *   1. **Liveness** — every arc must lie on at least one realizable
 *      source-to-sink path. An arc that can never fire from any execution
 *      starting at the source is a "dead transition" and violates liveness.
 *
 *   2. **Proper termination** — from every state reachable from the source,
 *      the sink must remain reachable. Equivalently: every vertex reachable
 *      from the source must itself reach the sink, and no other vertex with
 *      zero outgoing arcs (other than the designated sink) is reachable from
 *      the source.
 *
 * We deliberately do NOT check:
 *   - structural well-handledness (delegated to well-handledness.mjs),
 *   - free-choiceness (delegated to free-choiceness.mjs),
 *   - mutual-exclusion / RBS-specific properties.
 *
 * This module returns a verification result in the same shape as the other
 * verification modules so it can be wired into the same UI dispatch pipeline.
 *
 * @param {{
 *      components: { uid, identifier, type, isRBSCenter }[],
 *      arcs: { uid, fromVertexUID, toVertexUID, C, L }[]
 * }} model
 * @param {VertexUID} source
 * @param {VertexUID} sink
 *
 * @returns {{
 *      title: string,
 *      instances: {
 *          name: string,
 *          evaluation: {
 *              conclusion: { pass: boolean, title: string, description: string },
 *              criteria: { pass: boolean, description: string }[],
 *              violating: { vertices: VertexUID[], arcs: ArcUID[] }
 *          }
 *      }[]
 * }}
 */
export function verifyClassicalSoundness(model, source, sink) {
  console.log("Clicked verification button for classical soundness");
  console.log({ model, source, sink });

  const vertices = model.components ?? model.vertices ?? [];
  const arcs = model.arcs ?? [];
  const arcMap = buildArcMap(arcs);
  const vertexMap = buildVertexMap(vertices);

  const sourceUID = Number(source);
  const sinkUID = Number(sink);

  // ── Build forward/backward adjacency lists once ────────────────────────────
  // Forward adjacency: vertex → list of {arcUID, toVertexUID}
  // Backward adjacency: vertex → list of {arcUID, fromVertexUID}
  const forwardAdj = new Map();
  const backwardAdj = new Map();
  for (const v of vertices) {
    forwardAdj.set(Number(v.uid), []);
    backwardAdj.set(Number(v.uid), []);
  }
  for (const arc of arcs) {
    const from = Number(arc.fromVertexUID);
    const to = Number(arc.toVertexUID);
    if (forwardAdj.has(from)) {
      forwardAdj.get(from).push({ arcUID: Number(arc.uid), toVertexUID: to });
    }
    if (backwardAdj.has(to)) {
      backwardAdj.get(to).push({ arcUID: Number(arc.uid), fromVertexUID: from });
    }
  }

  // ── Reachability sets ──────────────────────────────────────────────────────
  // R(source) = vertices reachable from source via forward edges.
  // CoR(sink) = vertices that can reach sink via forward edges (i.e. backward
  //              reachable from sink).
  const reachableFromSource = bfs(sourceUID, forwardAdj, "toVertexUID");
  const canReachSink = bfs(sinkUID, backwardAdj, "fromVertexUID");

  // ── Criterion 1: source reaches sink ───────────────────────────────────────
  // Even before per-arc checks, the workflow only has any chance of being
  // sound if the source can reach the sink in the underlying graph.
  const sourceReachesSink = reachableFromSource.has(sinkUID);

  // ── Criterion 2: no dead transitions (liveness) ────────────────────────────
  // An arc (u, v) is on some source→sink path iff:
  //   - u is reachable from source, AND
  //   - v can reach sink.
  // Any arc that fails this test is a dead transition.
  const deadArcs = [];
  for (const arc of arcs) {
    const from = Number(arc.fromVertexUID);
    const to = Number(arc.toVertexUID);
    if (!reachableFromSource.has(from) || !canReachSink.has(to)) {
      deadArcs.push(Number(arc.uid));
    }
  }

  // ── Criterion 3: proper termination ────────────────────────────────────────
  // Every vertex reachable from the source must itself reach the sink.
  // A reachable vertex that cannot reach the sink is a "trap" — execution can
  // arrive there with no way out and no way to terminate cleanly.
  const trapVertices = [];
  for (const v of reachableFromSource) {
    if (!canReachSink.has(v)) {
      trapVertices.push(v);
    }
  }

  // ── Criterion 4: sink is the unique terminal ──────────────────────────────
  // Other than the designated sink, no reachable vertex may have zero outgoing
  // arcs. A reachable vertex with no outgoing arcs is an additional terminal,
  // which violates proper completion.
  const extraTerminals = [];
  for (const v of reachableFromSource) {
    if (v === sinkUID) continue;
    const outs = forwardAdj.get(v) ?? [];
    if (outs.length === 0) {
      extraTerminals.push(v);
    }
  }

  // ── Criterion 5: sink itself is properly terminal ─────────────────────────
  // The designated sink should have zero outgoing arcs. If it has outgoing
  // arcs, execution can pass through it and continue, which means the
  // workflow doesn't actually terminate at the declared sink.
  const sinkOutgoing = (forwardAdj.get(sinkUID) ?? []).map(o => o.arcUID);
  const sinkIsTerminal = sinkOutgoing.length === 0;

  // ── L-attribute liveness check (RDLT-specific extension) ──────────────────
  // The classical liveness check above looks only at graph reachability. In
  // an RDLT, an arc with L < 1 can never fire and is dead by definition;
  // an arc with L > total reachable predecessors may also fail to be live in
  // some executions. We flag L<1 here and leave deeper L-balance reasoning
  // to well-handledness.
  const invalidLArcs = [];
  for (const arc of arcs) {
    const L = Number(arc.L ?? 0);
    if (!Number.isFinite(L) || L < 1) {
      invalidLArcs.push(Number(arc.uid));
    }
  }

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const livenessPass =
    deadArcs.length === 0 && invalidLArcs.length === 0;
  const properTerminationPass =
    trapVertices.length === 0 &&
    extraTerminals.length === 0 &&
    sinkIsTerminal &&
    sourceReachesSink;

  const overallPass = livenessPass && properTerminationPass;

  // ── Collect violating vertices and arcs (deduplicated) ────────────────────
  const violatingArcSet = new Set([...deadArcs, ...invalidLArcs]);
  const violatingVertexSet = new Set([...trapVertices, ...extraTerminals]);
  if (!sinkIsTerminal) {
    violatingVertexSet.add(sinkUID);
    for (const arcUID of sinkOutgoing) violatingArcSet.add(arcUID);
  }
  if (!sourceReachesSink) {
    violatingVertexSet.add(sourceUID);
    violatingVertexSet.add(sinkUID);
  }

  // ── Build human-readable criteria descriptions ────────────────────────────
  const criteria = [
    {
      pass: sourceReachesSink,
      description: sourceReachesSink
        ? `Source vertex reaches sink vertex`
        : `Source vertex cannot reach sink vertex`,
    },
    {
      pass: deadArcs.length === 0,
      description: deadArcs.length === 0
        ? `All arcs lie on some source-to-sink path (no dead transitions)`
        : `${deadArcs.length} dead arc(s) found that cannot fire in any execution`,
    },
    {
      pass: invalidLArcs.length === 0,
      description: invalidLArcs.length === 0
        ? `All arcs have valid L-attributes (L ≥ 1)`
        : `${invalidLArcs.length} arc(s) have invalid L-attribute (L < 1)`,
    },
    {
      pass: trapVertices.length === 0,
      description: trapVertices.length === 0
        ? `Every reachable vertex can reach the sink (proper termination)`
        : `${trapVertices.length} reachable vertex/vertices cannot reach the sink (trap states)`,
    },
    {
      pass: extraTerminals.length === 0,
      description: extraTerminals.length === 0
        ? `Sink is the unique terminal vertex among reachable vertices`
        : `${extraTerminals.length} reachable vertex/vertices have no outgoing arcs but are not the sink`,
    },
    {
      pass: sinkIsTerminal,
      description: sinkIsTerminal
        ? `Sink has no outgoing arcs (proper completion)`
        : `Sink has ${sinkOutgoing.length} outgoing arc(s) — execution can pass through it`,
    },
  ];

  return {
    title: "Classical Soundness",
    instances: [
      {
        name: "Main Model",
        evaluation: {
          conclusion: {
            pass: overallPass,
            title: overallPass
              ? "The model is classically sound"
              : "The model is NOT classically sound",
            description: overallPass
              ? "The model satisfies classical soundness — every arc fires in some execution (liveness) and every reachable state can terminate at the sink (proper termination)."
              : describeFailure({
                  livenessPass,
                  properTerminationPass,
                  deadArcs,
                  invalidLArcs,
                  trapVertices,
                  extraTerminals,
                  sinkIsTerminal,
                  sourceReachesSink,
                }),
          },
          criteria,
          violating: {
            arcs: [...violatingArcSet],
            vertices: [...violatingVertexSet],
          },
        },
      },
    ],
  };
}

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Breadth-first traversal of an adjacency map starting from a vertex.
 *
 * @param {VertexUID} start
 * @param {Map<VertexUID, {arcUID, [neighborKey]: VertexUID}[]>} adj
 *        Adjacency map: vertex → outgoing edges. Edge objects must contain
 *        the neighbor under `neighborKey`.
 * @param {string} neighborKey
 *        Property name of the neighbor in each edge object
 *        (`"toVertexUID"` for forward, `"fromVertexUID"` for backward).
 * @returns {Set<VertexUID>} the set of all vertices reachable from `start`.
 */
function bfs(start, adj, neighborKey) {
  const visited = new Set();
  if (start == null || !adj.has(start)) return visited;
  const queue = [start];
  visited.add(start);
  while (queue.length > 0) {
    const v = queue.shift();
    for (const edge of adj.get(v) ?? []) {
      const next = edge[neighborKey];
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return visited;
}

/**
 * Builds a clear failure summary describing which classical soundness criteria
 * were violated and why. Used as the `conclusion.description` when the model
 * fails verification.
 */
function describeFailure({
  livenessPass,
  properTerminationPass,
  deadArcs,
  invalidLArcs,
  trapVertices,
  extraTerminals,
  sinkIsTerminal,
  sourceReachesSink,
}) {
  const parts = [];

  if (!sourceReachesSink) {
    parts.push("the source cannot reach the sink in the underlying graph");
  }
  if (!livenessPass) {
    const liveProblems = [];
    if (deadArcs.length > 0) liveProblems.push(`${deadArcs.length} dead transition(s)`);
    if (invalidLArcs.length > 0) liveProblems.push(`${invalidLArcs.length} arc(s) with invalid L-attribute`);
    parts.push(`liveness fails (${liveProblems.join(", ")})`);
  }
  if (!properTerminationPass) {
    const termProblems = [];
    if (trapVertices.length > 0) termProblems.push(`${trapVertices.length} trap vertex/vertices`);
    if (extraTerminals.length > 0) termProblems.push(`${extraTerminals.length} extra terminal(s)`);
    if (!sinkIsTerminal) termProblems.push(`sink has outgoing arcs`);
    if (termProblems.length > 0) {
      parts.push(`proper termination fails (${termProblems.join(", ")})`);
    }
  }

  if (parts.length === 0) {
    return "The model violates classical soundness.";
  }
  return `Classical soundness violated: ${parts.join("; ")}.`;
}
