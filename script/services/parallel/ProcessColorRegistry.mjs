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

const ProcessColorRegistry = {

  /**
   * Call once per PAE run, right after #flattenResult() in PAESimulationManager.
   * Non-impeded processes are registered first so path indices match
   * the order res.maximalPaths is built in the traversal tree.
   *
   * @param {{ processId: number, isImpeded?: boolean }[]} entries
   */
  registerFromEntries(entries) {
    this.clear();

    const nonImpeded = entries.filter(e => !e.isImpeded);
    const impeded    = entries.filter(e =>  e.isImpeded);

    let idx = 0;

    for (const entry of nonImpeded) {
      if (_byProcessId.has(entry.processId)) continue;
      const color = PALETTE[idx % PALETTE.length];
      _byProcessId.set(entry.processId, color);
      _byPathIndex.set(_orderedColors.length, color);
      _orderedColors.push(color);
      idx++;
    }

    for (const entry of impeded) {
      if (_byProcessId.has(entry.processId)) continue;
      const color = _dim(PALETTE[idx % PALETTE.length]);
      _byProcessId.set(entry.processId, color);
      _byPathIndex.set(_orderedColors.length, color);
      _orderedColors.push(color);
      idx++;
    }
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