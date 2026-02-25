import { mapGUIModelToSoundness } from "./soundness/soundness-service.mjs";
import { Graph } from "./soundness/models/Graph.js";
import { Vertex } from "./soundness/models/Vertex.js";
import { Edge } from "./soundness/models/Edge.js";
import { MASExtractor } from "./soundness/utils/mas-extractor.js";

function findMatchingVertex(graph, v) {
  if (!graph || !v) return null;
  const norm = (x) => (x ?? "").toString().trim();

  // 1) Strict id match.
  const byId = (graph.vertices || []).find((gv) => gv.id === v.id);
  if (byId) return byId;

  // 2) Cross-match by {name,id,identifier} since simplified graphs often
  // use identifier strings while the GUI model uses numeric UIDs.
  const candidates = [v.name, v.id, String(v.id), String(v.name)];
  return (
    (graph.vertices || []).find((gv) =>
      candidates.some(
        (c) =>
          norm(gv.name) === norm(c) ||
          norm(gv.id) === norm(c) ||
          norm(gv.attributes?.identifier) === norm(c)
      )
    ) || null
  );
}

function mergeGraphs(graphs) {
  const merged = new Graph();
  const vById = new Map();

  const getOrAddVertex = (v) => {
    if (!v) return null;
    const key = v.id;
    if (vById.has(key)) return vById.get(key);
    const copy = new Vertex(
      v.id,
      v.type ?? v.name,
      v.attributes ?? {},
      v.name ?? String(v.id)
    );
    vById.set(key, copy);
    merged.addVertex(copy);
    return copy;
  };

  for (const g of graphs || []) {
    if (!g) continue;
    for (const v of g.vertices || []) getOrAddVertex(v);
    for (const e of g.edges || []) {
      const from = getOrAddVertex(e.from);
      const to = getOrAddVertex(e.to);
      const edgeCopy = new Edge(
        e.id,
        from,
        to,
        e.constraint,
        e.maxTraversals,
        e.attributes ?? []
      );
      if (e.eRU !== undefined) edgeCopy.eRU = e.eRU;
      merged.addEdge(edgeCopy);
    }
  }

  return merged;
}

function edgeKey(e) {
  const normC = (c) => {
    const x = (c ?? "").toString().trim();
    if (x === "" || x === "ϵ" || x === "ε" || x.toLowerCase() === "epsilon") return "ε";
    return x;
  };
  const c = normC(e.constraint);
  // Simplified graphs (R1/R2 derived) often use identifier strings (e.g., "x1") as
  // vertex.id, while the original GUI model uses numeric UIDs. To reliably
  // match MAS edges back to original edges, prefer vertex.name (identifier)
  // when available.
  const fromKey = (e.from?.name ?? e.from?.id ?? "").toString();
  const toKey = (e.to?.name ?? e.to?.id ?? "").toString();
  return `${fromKey}→${toKey}::${c}`;
}

function findOriginalEdgeByKey(graph, key) {
  const [ft, cPart] = key.split("::");
  const [fromId, toId] = ft.split("→");
  const constraint = (cPart ?? "").trim();

  const norm = (x) => (x ?? "").toString().trim();
  const normC = (c) => {
    const x = norm(c);
    if (x === "" || x === "ϵ" || x === "ε" || x.toLowerCase() === "epsilon") return "ε";
    return x;
  };
  const sameConstraint = (a, b) => normC(a) === normC(b);

  return (
    (graph.edges || []).find((e) => {
      const c = normC(e.constraint);
      const fromMatches =
        norm(e.from?.name) === norm(fromId) || norm(e.from?.id) === norm(fromId);
      const toMatches =
        norm(e.to?.name) === norm(toId) || norm(e.to?.id) === norm(toId);
      return (
        fromMatches && toMatches && sameConstraint(c, constraint)
      );
    }) || null
  );
}

function edgeLabelFromOriginal(graph, edgeKeyStr) {
  const e = findOriginalEdgeByKey(graph, edgeKeyStr);
  if (!e) return null;
  const from = e.from?.name ?? e.from?.id;
  const to = e.to?.name ?? e.to?.id;
  const x = (e.constraint ?? "").toString().trim();
  const c = x === "" || x === "ϵ" || x === "ε" || x.toLowerCase() === "epsilon" ? "ε" : x;
  return `${from}→${to} (${c}) [uid:${e.id}]`;
}

function edgeLabelByUID(graph, uid) {
  const e = (graph.edges || []).find((x) => Number(x.id) === Number(uid));
  if (!e) return `uid:${uid}`;
  const from = e.from?.name ?? e.from?.id;
  const to = e.to?.name ?? e.to?.id;
  const x = (e.constraint ?? "").toString().trim();
  const c = x === "" || x === "ϵ" || x === "ε" || x.toLowerCase() === "epsilon" ? "ε" : x;
  return `${from}→${to} (${c}) [uid:${e.id}]`;
}

/**
 * Expand an activity extracted from EVSA level 1 (R1) with EVSA level 2+ (RBS)
 * details using resetBoundSubsystem metadata. This restores internal member arcs
 * so the activity renders as a connected subgraph when an RBS exists.
 */
function expandWithRBSDetails(rdltGraph, activityArcUIDs) {
  const uidSet = new Set((activityArcUIDs || []).map((x) => Number(x)));

  const edgeById = new Map();
  for (const e of rdltGraph.edges || []) edgeById.set(Number(e.id), e);

  const touchedVertices = new Set();
  for (const uid of uidSet) {
    const e = edgeById.get(Number(uid));
    if (!e) continue;
    touchedVertices.add(Number(e.from?.id));
    touchedVertices.add(Number(e.to?.id));
  }

  for (const rbs of rdltGraph.resetBoundSubsystems || []) {
    if (!rbs) continue;
    const centerId = Number(rbs.center?.id);
    const memberIds = new Set((rbs.members || []).map((v) => Number(v.id)));
    memberIds.add(centerId);

    const inUids = new Set((rbs.inBridges || []).map((e) => Number(e.id)));
    const outUids = new Set((rbs.outBridges || []).map((e) => Number(e.id)));

    // Touch if the activity touches any member/center vertex OR uses a bridge arc.
    let touches = touchedVertices.has(centerId);
    if (!touches) {
      for (const vid of touchedVertices) {
        if (memberIds.has(vid)) {
          touches = true;
          break;
        }
      }
    }
    if (!touches) {
      for (const uid of uidSet) {
        if (inUids.has(uid) || outUids.has(uid)) {
          touches = true;
          break;
        }
      }
    }
    if (!touches) continue;

    // Pull in all internal edges (both endpoints within memberIds).
    for (const e of rdltGraph.edges || []) {
      const fromId = Number(e.from?.id);
      const toId = Number(e.to?.id);
      if (memberIds.has(fromId) && memberIds.has(toId)) uidSet.add(Number(e.id));
    }
  }

  const vertexUIDs = new Set();
  for (const uid of uidSet) {
    const e = edgeById.get(Number(uid));
    if (!e) continue;
    vertexUIDs.add(Number(e.from?.id));
    vertexUIDs.add(Number(e.to?.id));
  }

  return { arcs: [...uidSet], vertices: [...vertexUIDs] };
}

/**
 * @param {*} model - simple model snapshot (same input as other verifications)
 * @param {number|string} sourceUID
 * @param {number|string} sinkUID
 */
export function verifyImpedanceFree(model, sourceUID, sinkUID) {
  const { rdltGraph, combinedEvsa } = mapGUIModelToSoundness(
    model,
    Number(sourceUID),
    Number(sinkUID)
  );

  const R1 = combinedEvsa?.[0] ?? null;
  const R2Merged =
    combinedEvsa && combinedEvsa.length > 1
      ? mergeGraphs(combinedEvsa.slice(1))
      : null;

  const source =
    rdltGraph.vertices.find((v) => v.id === Number(sourceUID)) ?? null;
  const sink = rdltGraph.vertices.find((v) => v.id === Number(sinkUID)) ?? null;

  if (!source || !sink || !R1) {
    return {
      title: "Impedance-Free Verification",
      instances: [
        {
          name: "Main Model",
          evaluation: {
            conclusion: {
              pass: false,
              title: "Unable to evaluate",
              description:
                "Could not resolve source/sink or simplified graph for MAS extraction.",
            },
            criteria: [],
            violating: { vertices: [], arcs: [] },
          },
        },
      ],
    };
  }

  // 1) Extract MAS (Maximal Activity Structures) from the vertex-simplified RDLT.
  // We treat each MAS as the structural representative of a maximal activity.
  const r1Source = findMatchingVertex(R1, source);
  const r1Sink = findMatchingVertex(R1, sink);

  if (!r1Source || !r1Sink) {
    return {
      title: "Impedance-Free Verification",
      instances: [
        {
          name: "Main Model",
          evaluation: {
            conclusion: {
              pass: false,
              title: "Unable to evaluate",
              description:
                "Could not resolve the source/sink vertices in the vertex-simplified graph used for MAS extraction.",
            },
            criteria: [
              {
                pass: false,
                description: "MAS extraction requires the source and sink vertices to be present in the simplified graph.",
              },
            ],
            violating: { vertices: [], arcs: [] },
          },
        },
      ],
    };
  }

  const masSet = MASExtractor.extractAllMAS(R1, r1Source, r1Sink);
  const masCount = masSet?.length ?? 0;

  // Expand each MAS envelope into its concrete maximal activities (behaviors)
  // so impedance-freeness is verified over maximal activities, not just envelopes.
  /** @type {{ masIndex:number, actIndex:number, graph:Graph }[]} */
  const maximalActivities = [];

  for (let i = 0; i < masCount; i++) {
    const mas = masSet[i];
    if (!mas) continue;

    const ms = findMatchingVertex(mas, r1Source);
    const mf = findMatchingVertex(mas, r1Sink);

    // If we can't resolve s/f inside this MAS (should be rare), fall back to treating
    // the MAS itself as a single activity.
    if (!ms || !mf) {
      maximalActivities.push({ masIndex: i, actIndex: 0, graph: mas });
      continue;
    }

    const acts = MASExtractor.extractMaximalActivitiesFromMAS(mas, ms, mf);
    if (!acts || acts.length === 0) {
      maximalActivities.push({ masIndex: i, actIndex: 0, graph: mas });
      continue;
    }

    for (let k = 0; k < acts.length; k++) {
      maximalActivities.push({ masIndex: i, actIndex: k, graph: acts[k] });
    }
  }

  const actCount = maximalActivities.length;

  // Debug: print the generated maximal activities (edge-wise) so it's easy
  // to compare with traversal paths.
  try {
    console.groupCollapsed(
      `[impedance-free] Generated maximal activities from MAS: ${actCount} (MAS envelopes: ${masCount})`
    );
    for (let i = 0; i < actCount; i++) {
      const meta = maximalActivities[i];
      const g = meta?.graph;
      const keys = (g?.edges || []).map(edgeKey);
      console.groupCollapsed(
        `MaxAct ${i + 1} (from MAS ${meta?.masIndex + 1 ?? "?"}) — edges=${keys.length}`
      );
      keys.sort();
      for (const k of keys) {
        const lbl = edgeLabelFromOriginal(rdltGraph, k);
        console.log(lbl ?? `unmatched: ${k}`);
      }
      console.groupEnd();
    }
    console.groupEnd();
  } catch (_) {
    // ignore logging errors
  }

  // Trivial pass if 0 or 1 maximal activity
  if (actCount <= 1) {
    return {
      title: "Impedance-Free Verification",
      instances: [
        {
          name: "Main Model",
          evaluation: {
            conclusion: {
              pass: true,
              title: "Impedance-free",
              description:
                actCount === 0
                  ? "No maximal activities were extracted, so impedance-freeness is vacuously satisfied by this checker."
                  : "Only one maximal activity exists, so there is no pair of maximal activities that could impede each other.",
            },
            criteria: [
              { pass: true, description: `MAS envelopes extracted: ${masCount}` },
              { pass: true, description: `Maximal activities extracted from MAS: ${actCount}` },
              {
                pass: true,
                description: "Pairwise impedance checks: skipped (needs ≥ 2 maximal activities).",
              },
            ],
            violating: { vertices: [], arcs: [] },
          },
        },
      ],
    };
  }

  // 2) Build edge-key sets per maximal activity
  const actEdgeKeys = maximalActivities.map(({ graph }) => {
    const s = new Set();
    for (const e of graph?.edges || []) s.add(edgeKey(e));
    return s;
  });

  // Precompute: map each maximal activity to original arc UIDs when possible (for UI display)
  const actOriginalArcUIDs = actEdgeKeys.map((keys) => {
    const uids = [];
    for (const k of keys) {
      const oe = findOriginalEdgeByKey(rdltGraph, k);
      if (oe) uids.push(Number(oe.id));
    }
    return [...new Set(uids)];
  });

  // Expand each activity with EVSA level-2+ (RBS internal) details so the
  // rendered activity is connected when an RBS exists.
  const actExpanded = actOriginalArcUIDs.map((uids) =>
    expandWithRBSDetails(rdltGraph, uids)
  );

  // Console: show CONNECTED generated maximal activities (after EVSA L2 expansion)
  try {
    console.groupCollapsed(
      `[impedance-free] Connected maximal activities: ${actCount} (MAS envelopes: ${masCount})`
    );
    for (let i = 0; i < actCount; i++) {
      const meta = maximalActivities[i];
      const uids = actExpanded[i]?.arcs ?? actOriginalArcUIDs[i] ?? [];
      console.groupCollapsed(
        `MaxAct ${i + 1} (from MAS ${meta?.masIndex + 1 ?? "?"}) — arcs=${uids.length}`
      );
      const labels = uids.map((uid) => edgeLabelByUID(rdltGraph, uid)).sort();
      for (const lbl of labels) console.log(lbl);
      console.groupEnd();
    }
    console.groupEnd();
  } catch (_) {
    // ignore logging errors
  }

  // 3) Pairwise checks
  let allPairsPass = true;
  const violatingArcUIDs = new Set();
  const violatingVertexUIDs = new Set();
  const violatingRemarks = { arcs: {}, vertices: {} };

  /** @type {{i:number,j:number, sharedKeys:string[], sharedArcUIDs:number[]}} */
  const sharedPairs = [];

  for (let i = 0; i < actCount; i++) {
    for (let j = i + 1; j < actCount; j++) {
      const shared = [];
      for (const k of actEdgeKeys[i]) if (actEdgeKeys[j].has(k)) shared.push(k);
      if (shared.length === 0) continue;

      // Record shared resources for visibility (even if they end up passing)
      const sharedArcUIDs = [];
      for (const k of shared) {
        const oe = findOriginalEdgeByKey(rdltGraph, k);
        if (oe) sharedArcUIDs.push(Number(oe.id));
      }
      sharedPairs.push({ i, j, sharedKeys: shared, sharedArcUIDs: [...new Set(sharedArcUIDs)] });

      for (const k of shared) {
        const origEdge = findOriginalEdgeByKey(rdltGraph, k);
        if (!origEdge) continue;

        const inCycle = MASExtractor.isPartOfCycle(rdltGraph, origEdge);
        const L = Number(origEdge.maxTraversals ?? 1);

        // Rule A: shared looping arc => impeding
        if (inCycle) {
          allPairsPass = false;
          violatingArcUIDs.add(Number(origEdge.id));
          violatingVertexUIDs.add(Number(origEdge.from.id));
          violatingVertexUIDs.add(Number(origEdge.to.id));
          violatingRemarks.arcs[String(origEdge.id)] =
            `Shared by maximal activities ${i + 1} and ${j + 1} and is part of a cycle (looping resource) — treated as impeding.`;
          continue;
        }

        // Rule B: shared non-loop arc must have enough budget for both activities
        if (L < 2) {
          allPairsPass = false;
          violatingArcUIDs.add(Number(origEdge.id));
          violatingVertexUIDs.add(Number(origEdge.from.id));
          violatingVertexUIDs.add(Number(origEdge.to.id));
          violatingRemarks.arcs[String(origEdge.id)] =
            `Shared by maximal activities ${i + 1} and ${j + 1} but L=${L} (<2). Two maximal activities would require traversing it twice.`;
        }
      }
    }
  }

  const pass = allPairsPass;
  const conclusionTitle = pass ? "Impedance-free" : "Not impedance-free";
  const conclusionDesc = pass
    ? `All ${actCount} maximal activities passed the pairwise shared-resource checks (no impeding pairs detected).`
    : "At least one MAS pair shares a looping arc or shares a non-loop arc whose L-budget is insufficient (L<2).";

  // Build result instances:
  //  - Summary instance
  //  - One instance per MAS to show what was extracted
  //  - One instance per shared-pair to show shared arcs (highlighted in green)
  const instances = [];

  instances.push({
    name: "Main Model",
    evaluation: {
      conclusion: { pass, title: conclusionTitle, description: conclusionDesc },
      criteria: [
        { pass: true, description: `MAS envelopes extracted: ${masCount}` },
        { pass: true, description: `Maximal activities extracted from MAS: ${actCount}` },
        {
          pass,
          description:
            "Rule: shared looping arcs are rejected; shared non-loop arcs require L ≥ 2 (pairwise budget).",
        },
        {
          pass: true,
          description: `MAS pairs that share at least one arc: ${sharedPairs.length}`,
        },
      ],
      violating: {
        arcs: [...violatingArcUIDs],
        vertices: [...violatingVertexUIDs],
      },
      violatingRemarks,
    },
  });

  // Maximal activity detail instances
  for (let i = 0; i < actCount; i++) {
    const keys = [...actEdgeKeys[i]];
    const labels = keys
      .map((k) => edgeLabelFromOriginal(rdltGraph, k) ?? `unmatched: ${k}`)
      .slice(0, 60); // keep UI sane

    const meta = maximalActivities[i];
    const parent = meta ? ` (from MAS ${meta.masIndex + 1})` : "";

    // Filter the drawing to only vertices/arcs used by this maximal activity,
    // expanded with EVSA L2+ (RBS internal) details for connectivity.
    const expanded = actExpanded[i] ?? {
      arcs: actOriginalArcUIDs[i] ?? [],
      vertices: [],
    };

    instances.push({
      name: `Maximal Activity ${i + 1}${parent}`,
      evaluation: {
        conclusion: {
          pass: true,
          title: `Extracted Maximal Activity ${i + 1}${parent}`,
          description:
            labels.length > 0
              ? `Arcs in this maximal activity (${keys.length}): ${labels.join("; ")}`
              : `Arcs in this maximal activity: (no arcs could be mapped back to the original model)`,
        },
        criteria: [],
        violating: {
          // IMPORTANT: these are NOT violations. We leave violating.* empty so
          // the drawing doesn't misleadingly highlight the activity as "violating".
          arcs: [],
          vertices: [],
        },
        violatingRemarks: { arcs: {}, vertices: {} },
      },
      model: {
        arcs: expanded.arcs,
        vertices: expanded.vertices,
      },
    });
  }

  // Shared pair instances (green highlight because name === "Shared Arc")
  for (const p of sharedPairs) {
    const labels = p.sharedKeys
      .map((k) => edgeLabelFromOriginal(rdltGraph, k) ?? `unmatched: ${k}`)
      .slice(0, 60);
    const remarks = {};
    for (const uid of p.sharedArcUIDs) {
      remarks[String(uid)] = `Shared by maximal activities ${p.i + 1} and ${p.j + 1}`;
    }
    instances.push({
      name: "Shared Arc",
      evaluation: {
        conclusion: {
          pass: true,
          title: `Shared resources: activity ${p.i + 1} vs activity ${p.j + 1}`,
          description: `Shared arcs (${p.sharedKeys.length}): ${labels.join("; ")}`,
        },
        criteria: [],
        violating: { arcs: p.sharedArcUIDs, vertices: [] },
        violatingRemarks: { arcs: remarks, vertices: {} },
      },
      model: { arcs: p.sharedArcUIDs },
    });
  }

  return { title: "Impedance-Free Verification", instances };
}
