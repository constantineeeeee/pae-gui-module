// mas.js
import { cloneRDLT } from './rdltModel.js';
import { findCycles } from './rdltUtilities.js';


export function generateMaximalStructures(minimalStructures) {
  if (!Array.isArray(minimalStructures)) {
    console.warn('generateMaximalStructures: input is not an array');
    return [];
  }

//   console.log('Generating MAS from MinCS list:', minimalStructures);

  return minimalStructures.map(mincs => constructMAS(mincs));
}



function constructMAS(Rmin) {
  const RMAS = cloneRDLT(Rmin);
  const Vset = new Set(Rmin.vertices.map(v => v.vuid));

  // Re-add arcs from source Ri restricted to MinCS vertex set
  if (Rmin._sourceRi?.arcs) {
    Rmin._sourceRi.arcs.forEach(a => {
      if (Vset.has(a.from) && Vset.has(a.to)) {
        const exists = RMAS.arcs.some(
          e => e.from === a.from && e.to === a.to && e.c === a.c
        );
        if (!exists) RMAS.arcs.push({ ...a });
      }
    });
  }

  // Detect cycles
  const cycles = findCycles(RMAS.vertices, RMAS.arcs);
  const cycleEdges = new Set();

  cycles.forEach(cycle => {
    cycle.forEach(a => {
      cycleEdges.add(`${a.from}->${a.to}`);
    });
  });

  // Update l-values
  RMAS.arcs.forEach(a => {
    const key = `${a.from}->${a.to}`;
    const isCycle = cycleEdges.has(key);

    const participates = Rmin.arcs.some(
        e => e.from === a.from && e.to === a.to && e.c === a.c
    );


    if (!isCycle) {
        // (1 − cycle)
        a.l = 1;
    } else if (!participates) {
        // cycle ⊙ L ⊙ MAS_AP = 0
        a.l = 0;
    }
    // else: cycle arc that participates - keep original a.l
    });

  // Remove arcs with l=0
  RMAS.arcs = RMAS.arcs.filter(a => a.l > 0);

  return RMAS;
}
