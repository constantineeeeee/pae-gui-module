const PALETTE = [
  "#3a81de", // blue
  "#4caf50", // green
  "#ff9800", // orange
  "#9c27b0", // purple
  "#e91e63", // pink
  "#00bcd4", // cyan
  "#795548", // brown
  "#607d8b", // blue-grey
];

/** @type {Map<number, string>}  processId → color */
const _byProcessId = new Map();
/** @type {Map<number, string>}  pathIndex → color */
const _byPathIndex = new Map();
/** @type {string[]} ordered list, one per registered process */
const _orderedColors = [];
/** @type {Set<string>[]} per-pathIndex arc-key set for content matching */
const _arcKeysByPathIdx = [];

const ProcessColorRegistry = {

  /**
   * Call once per PAE run, right after #flattenResult() in PAESimulationManager.
   * Non-impeded processes are registered first so path indices match
   * the order res.maximalPaths is built in the traversal tree.
   *
   * Each entry MAY include an `arcKeys` Set (strings of the form
   * "fromIdentifier->toIdentifier") describing the arcs the process
   * traversed; this enables content-based matching from the traversal
   * tree (which has no direct knowledge of PAE process IDs) via
   * `getColorByArcKeys()`.
   *
   * @param {{ processId: number, isImpeded?: boolean, arcKeys?: Set<string> }[]} entries
   */
  registerFromEntries(entries) {
    this.clear();

    // Group entries by groupIndex (each parallelActivitySet is a group;
    // impeded processes form their own trailing group). Colors are then
    // assigned with a SINGLE global counter that does NOT reset between
    // groups — so processes across multiple parallel sets always have
    // distinct colors (e.g. Set 0 → blue/green; Set 1 → orange/purple).
    // The activity-profile UI (ActivitySimulationManager) reads colors
    // back via getByProcessId() to stay in sync.
    const byGroup = new Map();
    for (const e of entries) {
      const g = e.groupIndex ?? 0;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(e);
    }

    const groupKeys = [...byGroup.keys()].sort((a, b) => a - b);

    let globalIdx = 0;

    for (const g of groupKeys) {
      const groupEntries = byGroup.get(g);
      // Within each group: non-impeded first (their pathIndex must align
      // with the order res.maximalPaths is built), then impeded.
      const sorted = [
        ...groupEntries.filter(e => !e.isImpeded),
        ...groupEntries.filter(e =>  e.isImpeded),
      ];
      for (const entry of sorted) {
        if (_byProcessId.has(entry.processId)) continue;
        const base  = PALETTE[globalIdx % PALETTE.length];
        const color = entry.isImpeded ? _dim(base) : base;
        _byProcessId.set(entry.processId, color);
        _byPathIndex.set(_orderedColors.length, color);
        _arcKeysByPathIdx.push(entry.arcKeys instanceof Set ? entry.arcKeys : new Set());
        _orderedColors.push(color);
        globalIdx++;
      }
    }
  },

  /** True iff at least one process has been registered for this PAE run. */
  get hasRegistrations() {
    return _orderedColors.length > 0;
  },

  /**
   * Find the registered color whose arc-key set exactly matches the given
   * set. Used by the traversal-tree renderer to color each NTT branch by
   * the matching PAE process so the two views stay color-consistent.
   *
   * Returns null if no exact match is found (caller should fall back to
   * the default palette index).
   *
   * @param {Set<string>} arcKeys
   * @returns {string | null}
   */
  getColorByArcKeys(arcKeys) {
    if (!(arcKeys instanceof Set) || arcKeys.size === 0) return null;
    for (let i = 0; i < _arcKeysByPathIdx.length; i++) {
      const stored = _arcKeysByPathIdx[i];
      if (stored.size !== arcKeys.size) continue;
      let match = true;
      for (const k of arcKeys) {
        if (!stored.has(k)) { match = false; break; }
      }
      if (match) return _orderedColors[i];
    }
    return null;
  },

  /** @param {number} processId @returns {string} */
  getByProcessId(processId) {
    return _byProcessId.get(processId) ?? PALETTE[0];
  },

  /**
   * pathIndex = position in res.maximalPaths, which matches insertion order
   * of non-impeded processes from registerFromEntries().
   * @param {number} pathIndex @returns {string}
   */
  getByPathIndex(pathIndex) {
    return _byPathIndex.get(pathIndex) ?? PALETTE[pathIndex % PALETTE.length];
  },

  /** @returns {string[]} all colors in insertion order */
  getAllColors() { return [..._orderedColors]; },

  clear() {
    _byProcessId.clear();
    _byPathIndex.clear();
    _orderedColors.length = 0;
    _arcKeysByPathIdx.length = 0;
  },
};

export default ProcessColorRegistry;

function _dim(hex, alpha = 0.5) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}