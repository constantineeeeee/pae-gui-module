// rdltUtilities.js
// ======================================================
// Generic RDLT graph utilities
// Used by MCA Phase 2 and MAS construction
// ======================================================


export function buildAdjacencyList(vertices, arcs) {
  const adj = {};

  vertices.forEach(v => {
    adj[v.vuid] = [];
  });

  arcs.forEach(a => {
    if (adj[a.from]) {
      adj[a.from].push(a.to);
    }
  });

  return adj;
}

export function computeInOutDegree(vertices, arcs) {
  const deg = {};

  vertices.forEach(v => {
    deg[v.vuid] = { in: 0, out: 0 };
  });

  arcs.forEach(a => {
    if (deg[a.from]) deg[a.from].out += 1;
    if (deg[a.to]) deg[a.to].in += 1;
  });

  return deg;
}

/**
 * Find all elementary cycles in a directed graph
 * Uses a simplified Johnson-style DFS enumeration
 *
 * Output:
 *   Array of cycles
 *   Each cycle is an array of arc objects: [{from, to}, ...]
 */
export function findCycles(vertices, arcs) {
  const adj = buildAdjacencyList(vertices, arcs);
  const cycles = [];
  const stack = [];
  const blocked = new Set();

  function dfs(start, v) {
    stack.push(v);
    blocked.add(v);

    for (const w of adj[v] || []) {
      if (w === start) {
        // Found a cycle
        const cycleVertices = [...stack, start];
        cycles.push(verticesToArcs(cycleVertices, arcs));
      } else if (!blocked.has(w)) {
        dfs(start, w);
      }
    }

    stack.pop();
    blocked.delete(v);
  }

  vertices.forEach(v => {
    dfs(v.vuid, v.vuid);
    blocked.clear();
    stack.length = 0;
  });

  return cycles;
}

/**
 * Convert a list of vertices into arc objects
 */
function verticesToArcs(vertexPath, arcs) {
  const arcList = [];

  for (let i = 0; i < vertexPath.length - 1; i++) {
    const from = vertexPath[i];
    const to = vertexPath[i + 1];

    const arc = arcs.find(a => a.from === from && a.to === to);
    if (arc) {
      arcList.push(arc);
    }
  }

  return arcList;
}

/**
 * Find all DFS paths from source to target
 */
export function dfsAllPaths(adj, source, target) {
  const results = [];
  const path = [];

  function dfs(u) {
    path.push(u);

    if (u === target) {
      results.push([...path]);
    } else {
      for (const v of adj[u] || []) {
        if (!path.includes(v)) {
          dfs(v);
        }
      }
    }

    path.pop();
  }

  dfs(source);
  return results;
}

/*
* Find source and sink vertices
*/
export function findSourceAndSinkFromGraph(rdlt) {
  const indeg = new Map();
  const outdeg = new Map();

  rdlt.vertices.forEach(v => {
    indeg.set(v.vuid, 0);
    outdeg.set(v.vuid, 0);
  });

  rdlt.arcs.forEach(a => {
    if (indeg.has(a.to)) indeg.set(a.to, indeg.get(a.to) + 1);
    if (outdeg.has(a.from)) outdeg.set(a.from, outdeg.get(a.from) + 1);
  });

  const sources = [];
  const sinks = [];

  indeg.forEach((d, v) => { if (d === 0) sources.push(v); });
  outdeg.forEach((d, v) => { if (d === 0) sinks.push(v); });

  return { sources, sinks };
}

