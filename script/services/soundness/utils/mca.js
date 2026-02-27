// mca.js
// ======================================================
// Matrix-based Modified Contraction Algorithm (MCA)
// ======================================================

export function runMCA(evsaResults) {
  const contractionPaths = generateContractionPaths(evsaResults);
  const results = [];

  for (const p of contractionPaths) {
    const Ri = evsaResults[p.rdltId - 1];
    const minCS = runMCAPhase2(Ri, p);

    results.push({
      rdltId: p.rdltId,
      level: p.level,
      atomicVertices: p.atomicVertices,
      minCS
    });
  }

  return results;
}


/* =====================================================
 * MCA PHASE 1 — CONTRACTION PATH GENERATION
 * ===================================================== */

export function generateContractionPaths(evsaResults) {
  const allPaths = [];

  evsaResults.forEach((rdlt, rdltIndex) => {
    const { RV_adj, RV_C } = buildMatrices(rdlt);

    const source = detectSource(RV_adj);
    const sink   = detectSink(RV_adj);

    if (!source || !sink) return;

    const atomMap = {};
    rdlt.vertices.forEach(v => {
      atomMap[v.vuid] = [v.vuid];
    });

    const results = tryContractAll(
      RV_adj,
      RV_C,
      source,
      sink,
      [source],
      [],
      source,
      atomMap
    );

    results.forEach(r => {
      const finalMerged = r.P[r.P.length - 1];
      const atomicVertices = finalMerged.split('∧');

      allPaths.push({
        rdltId: rdltIndex + 1,
        level: rdlt._evsa?.rbsIndex !== undefined ? 2 : 1,

        atomicVertices,

        contractionSequence: r.P,
        steps: r.steps
      });
    });
  });

  return allPaths;
}

/* =====================================================
 * ENUMERATION OF CONTRACTION PATHS
 * ===================================================== */

function tryContractAll(
  RV_adj,
  RV_C,
  x,
  sink,
  P,
  steps,
  pathHead,   // new
  atomMap     // vertex - atomic vertices
) {

  // console check
  logStep(
    `ENTER tryContractAll | x=${x} | pathHead=${pathHead} | P=[${P.join(' -> ')}]`
  );

  const results = [];

  // ---- termination ----
  if (hasAbsorbedSink(P, sink)) {
    results.push({ P, steps });
    return results;
  }

  // ---- candidate neighbors ----
  // const Y = neighbors(x, RV_adj)
  //   .filter(y => reachable(pathHead, y, RV_adj));

  // w console check
  const rawNeighbors = neighbors(x, RV_adj);

  logStep(
    `Neighbors of ${x}: [${rawNeighbors.join(', ')}]`
  );

  const Y = rawNeighbors.filter(y => {
    const ok = reachable(pathHead, y, RV_adj);
    logStep(
      `  Check reachable(pathHead=${pathHead}, y=${y}) => ${ok}`
    );
    return ok;
  });


  for (const y of Y) {

    // ---- clone state ----
    const adjCopy   = deepClone(RV_adj);
    const CCopy     = deepCloneLabels(RV_C);
    const PCopy     = [...P];
    const stepsCopy = [...steps];
    const atomMapCopy = structuredClone(atomMap);

    // ---- competing parents ----
    const U = incomingExcept(x, y, adjCopy);

    // ---- join feasibility (Algorithm 1) ----
    const LHS = new Set([
      ...(CCopy[x]?.[y] ?? []),
      'ε'
    ]);

    const RHS = unionAll(
      U.map(u => CCopy[u]?.[y] ?? new Set())
    );

    // console check
    logStep(
      `Join check for (${x} ⊗ ${y}): LHS={${[...LHS]}} RHS={${[...RHS]}}`
    );

    if (!isSuperset(LHS, RHS)) {
      // console check
      logStep(`Join rejected (${x} ⊗ ${y})`);
      continue;
    }

    // ---- reset competing incoming labels ----
    U.forEach(u => {
      CCopy[u][y] = new Set(['ε']);
    });

    // ---- perform contraction ----
    const { RV_adj: newAdj, RV_C: newC, z } =
      contract(x, y, adjCopy, CCopy);
    
    // console check
    logStep(`CONTRACT ${x} ⊗ ${y} → ${z}`);

    // ---- update atom map ----
    atomMapCopy[z] = [
      ...(atomMap[x] ?? [x]),
      ...(atomMap[y] ?? [y])
    ];

    // ---- update path head  ----
    let newPathHead = updatePathHead(
      pathHead,
      y,
      atomMapCopy,
      adjCopy
    );

    if (!newPathHead) continue;

    if (atomMapCopy[z].includes(newPathHead)) {
      newPathHead = z;
    }

    // console check
    logStep(
      `Updated pathHead → ${newPathHead} (after contracting into ${z})`
    );

    // ---- record ----
    PCopy.push(z);
    stepsCopy.push({ from: x, with: y, result: z });

    // Console check
    logStep(
      `RECURSE with x=${z}, pathHead=${newPathHead}`
    );

    // ---- recurse ----
    const subResults = tryContractAll(
      newAdj,
      newC,
      z,
      sink,
      PCopy,
      stepsCopy,
      newPathHead,
      atomMapCopy
    );

    results.push(...subResults);
  }

  return results;
}


/* CONTRACT */
function contract(x, y, RV_adj, RV_C) {

  const z = `${x}∧${y}`;

  const atomsX = x.split('∧');
  const atomsY = y.split('∧');
  const atomsZ = [...new Set([...atomsX, ...atomsY])];

  const oldV = Object.keys(RV_adj);
  const V = oldV.filter(v => v !== x && v !== y);
  V.push(z);

  const RV_adj2 = {};
  const RV_C2   = {};

  // initialize
  V.forEach(v => {
    RV_adj2[v] = {};
    RV_C2[v] = {};
    V.forEach(w => {
      RV_adj2[v][w] = 0;
      RV_C2[v][w] = new Set();
    });
  });

  // ---- copy unaffected edges ----
  for (const u of V) {
    for (const w of V) {
      if (u === z || w === z) continue;
      RV_adj2[u][w] = RV_adj[u]?.[w] ?? 0;
      RV_C2[u][w]   = new Set(RV_C[u]?.[w] ?? []);
    }
  }

  // ---- adjacency patch ----
  for (const w of V) {
    if (atomsZ.includes(w)) continue;

    let outSum = 0;
    let inSum  = 0;

    for (const u of atomsZ) {
      outSum += RV_adj[u]?.[w] ?? 0;
      inSum  += RV_adj[w]?.[u] ?? 0;
    }

    RV_adj2[z][w] = outSum;
    RV_adj2[w][z] = inSum;
  }

  // ---- label patch ----
  for (const w of V) {
    if (atomsZ.includes(w)) continue;

    const outLabels = new Set();
    const inLabels  = new Set();

    for (const u of atomsZ) {
      (RV_C[u]?.[w] ?? []).forEach(c => outLabels.add(c));
      (RV_C[w]?.[u] ?? []).forEach(c => inLabels.add(c));
    }

    RV_C2[z][w] = outLabels;
    RV_C2[w][z] = inLabels;
  }

  return { RV_adj: RV_adj2, RV_C: RV_C2, z };
}

/* =====================================================
 * MCA PHASE 2 — MINIMIZATION
 * ===================================================== */

/**
 * Induce R_min from R_i using atomic vertices
 */
export function induceRmin(Ri, atomicVertices) {
  const atomSet = new Set(atomicVertices);

  const vertices = Ri.vertices.filter(v =>
    atomSet.has(v.vuid)
  );

  const arcs = Ri.arcs.filter(a =>
    atomSet.has(a.from) && atomSet.has(a.to)
  );

  return {
    vertices,
    arcs,
    hasRBS: Ri.hasRBS,
    _evsa: Ri._evsa
  };
}

/**
 * Build adjacency matrix RV_adj from R_min
 */
export function buildAdjMatrix(Rmin) {
  const RV_adj = {};

  for (const v of Rmin.vertices) {
    RV_adj[v.vuid] = {};
    for (const w of Rmin.vertices) {
      RV_adj[v.vuid][w.vuid] = 0;
    }
  }

  for (const arc of Rmin.arcs) {
    RV_adj[arc.from][arc.to] += 1;
  }

  return RV_adj;
}

/**
 * Build constraint matrix RV_C from R_min
 */
export function buildCMatrix(Rmin) {
  const RV_C = {};

  for (const v of Rmin.vertices) {
    RV_C[v.vuid] = {};
    for (const w of Rmin.vertices) {
      RV_C[v.vuid][w.vuid] = new Set();
    }
  }

  for (const arc of Rmin.arcs) {
    const label = arc.c === 'E' ? 'ε' : arc.c;
    RV_C[arc.from][arc.to].add(label);
  }

  return RV_C;
}

/**
 * Initialize weight matrix W
 */
export function initWeightMatrix(Rmin) {
  const W = {};

  for (const v of Rmin.vertices) {
    W[v.vuid] = {};
    for (const w of Rmin.vertices) {
      W[v.vuid][w.vuid] = 0;
    }
  }

  return W;
}

/**
 * Phase 2 initialization
 */
export function initializePhase2Matrices(Ri, atomicVertices) {
  const Rmin = induceRmin(Ri, atomicVertices);
  const RV_adj = buildAdjMatrix(Rmin);
  const RV_C = buildCMatrix(Rmin);
  const W = initWeightMatrix(Rmin);

  return { Rmin, RV_adj, RV_C, W };
}

/**
 * Find merge points in R_min
 */
export function findMergePoints(RV_adj) {
  const mergePoints = new Set();

  for (const from in RV_adj) {
    for (const to in RV_adj[from]) {
      if (RV_adj[from][to] > 0) {
        mergePoints.add(to);
      }
    }
  }

  return Array.from(mergePoints);
}

/**
 * Compute a single DFS path from source to target in R_min
 */
export function dfsPath(RV_adj, source, target) {
  const visited = new Set();
  const path = [];

  function dfs(u) {
    visited.add(u);
    path.push(u);

    if (u === target) {
      return true; // path found
    }

    for (const v in RV_adj[u]) {
      if (RV_adj[u][v] > 0 && !visited.has(v)) {
        if (dfs(v)) {
          return true;
        }
      }
    }

    path.pop();
    return false;
  }

  const found = dfs(source);
  return found ? [...path] : null;
}

/**
 * backward traversal and constraint-sensitive weighting
 */
export function applyBackwardWeighting(
  RV_adj,
  RV_C,
  W,
  source,
  mergePoints
) {
  const visitedMP = new Set();

  for (const y of mergePoints) {
    const Q = dfsPath(RV_adj, source, y);
    if (!Q || Q.length < 2) continue;

    // Traverse backward along DFS path
    for (let j = Q.length - 1; j >= 1; j--) {
      const v = Q[j];
      const u = Q[j - 1];

      const distinct = new Set(RV_C[u][v]);
      W[u][v] += 1;

      // Examine competing incoming arcs
      const incoming = incomingVertices(v, RV_adj);
      for (const k of incoming) {
        if (k === u) continue;

        const labels = RV_C[k][v];
        let contributes = false;

        for (const c of labels) {
          if (!distinct.has(c)) {
            contributes = true;
            distinct.add(c);
          }
        }

        if (contributes) {
          W[k][v] += 1;
        }
      }

      visitedMP.add(v);

      // Early termination conditions
      if (u === source || visitedMP.has(u)) {
        break;
      }
    }
  }
}

/**
 * Pruning
 */
export function pruneByWeight(Rmin, W) {
  Rmin.arcs = Rmin.arcs.filter(a => W[a.from][a.to] > 0);
}

/**
 * Run MCA Phase 2 for a single contraction path
 */
export function runMCAPhase2(Ri, contractionPath) {
  const { atomicVertices } = contractionPath;

  const { Rmin, RV_adj, RV_C, W } =
    initializePhase2Matrices(Ri, atomicVertices);

  const mergePoints = findMergePoints(RV_adj);
  const source = findSource(Rmin); // see helper below

  applyBackwardWeighting(RV_adj, RV_C, W, source, mergePoints);
  pruneByWeight(Rmin, W);

  return {
    vertices: Rmin.vertices,
    arcs: Rmin.arcs,
    _sourceRi: Ri
  };
}


/* =====================================================
 * HELPERS
 * ===================================================== */

function buildMatrices(rdlt) {
  const RV_adj = {};
  const RV_C   = {};

  rdlt.vertices.forEach(v => {
    RV_adj[v.vuid] = {};
    RV_C[v.vuid] = {};
    rdlt.vertices.forEach(w => {
      RV_adj[v.vuid][w.vuid] = 0;
      RV_C[v.vuid][w.vuid] = new Set();
    });
  });

  rdlt.arcs.forEach(a => {
    RV_adj[a.from][a.to] += 1;
    const label = a.c === 'E' ? 'ε' : a.c;
    RV_C[a.from][a.to].add(label);
  });

  return { RV_adj, RV_C };
}

function neighbors(x, RV_adj) {
  return Object.keys(RV_adj[x]).filter(y => RV_adj[x][y] > 0);
}

function incomingExcept(x, y, RV_adj) {
  return Object.keys(RV_adj).filter(
    u => u !== x && u !== y && RV_adj[u][y] > 0
  );
}

function detectSource(RV_adj) {
  return Object.keys(RV_adj).find(v =>
    Object.values(RV_adj).every(row => row[v] === 0)
  );
}

function detectSink(RV_adj) {
  return Object.keys(RV_adj).find(v =>
    Object.values(RV_adj[v]).every(c => c === 0)
  );
}

function hasAbsorbedSink(P, sink) {
  return P[P.length - 1].split('∧').includes(sink);
}

function union(a, b) {
  return new Set([...a, ...b]);
}

function unionAll(sets) {
  const out = new Set();
  sets.forEach(s => s.forEach(v => out.add(v)));
  return out;
}

function isSuperset(A, B) {
  for (const b of B) if (!A.has(b)) return false;
  return true;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function deepCloneLabels(C) {
  const out = {};
  for (const u in C) {
    out[u] = {};
    for (const v in C[u]) {
      out[u][v] = new Set(C[u][v]);
    }
  }
  return out;
}

// function liesOnPathToSink(x, y, sink, RV_adj) {
//   // must be reachable from x
//   if (!reachable(x, y, RV_adj)) return false;

//   // and must reach sink
//   return reachable(y, sink, RV_adj);
// }

function reachable(start, target, RV_adj) {
  const visited = new Set();
  const stack = [start];

  while (stack.length) {
    const u = stack.pop();
    if (u === target) return true;

    for (const v in RV_adj[u]) {
      if (RV_adj[u][v] > 0 && !visited.has(v)) {
        visited.add(v);
        stack.push(v);
      }
    }
  }
  return false;
}

function updatePathHead(pathHead, y, atomMap, RV_adj) {
  if (!atomMap[y] || atomMap[y].length === 1) {
    return y;
  }

  // y is composite: pick the atomic vertex reachable from current pathHead
  for (const a of atomMap[y]) {
    if (reachable(pathHead, a, RV_adj)) {
      return a;
    }
  }

  return null;
}

// Debug helper
function logStep(info) {
  console.log(
    `%c[MCA-TRACE] ${info}`,
  );
}


// Phase 2 Helpers
function incomingVertices(v, RV_adj) {
  const incoming = [];
  for (const u in RV_adj) {
    if (RV_adj[u][v] > 0) {
      incoming.push(u);
    }
  }
  return incoming;
}

function findSource(Rmin) {
  const incomingCount = {};
  for (const v of Rmin.vertices) {
    incomingCount[v.vuid] = 0;
  }
  for (const a of Rmin.arcs) {
    incomingCount[a.to] += 1;
  }
  return Object.keys(incomingCount).find(v => incomingCount[v] === 0);
}

