import { generateUniqueID } from "../../utils.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout Constants
const LEFT_PAD = 80;
const TOP_PAD = 80;
const X_GAP = 280; // horizontal spacing between depth levels
const Y_GAP = 120; // vertical spacing between sibling nodes

export default class TraversalTreeViewerManager {
  context;
  id;

  #snapshot;
  #subworkspace;
  #svg;
  #root;

  constructor(context, visualModelSnapshot) {
    this.context = context;
    this.id = generateUniqueID();
    this.#snapshot = visualModelSnapshot;

    this.#initialize();
  }

  async #initialize() {
    this.#subworkspace =
      await this.context.managers.workspace.addTraversalTreeSubworkspace(
        this.id,
      );
    const root = this.#subworkspace.tabAreaElement;
    this.#root = root;

    this.#svg = root.querySelector("svg[data-tt-svg]");

    root
      .querySelector('[data-tt-action="rerun"]')
      ?.addEventListener("click", () => this.#runAndRender());

    root
      .querySelector('[data-tt-action="close"]')
      ?.addEventListener("click", () => {
        this.context.managers.workspace.gotoMainModel();
      });

    root
      .querySelector('[data-tt-action="exportTT"]')
      ?.addEventListener("click", () => this.#exportImage());

    this.#runAndRender();
  }

  #exportImage() {
    if (!this.#svg || !this.#svg.firstChild) return;

    const svgData = new XMLSerializer().serializeToString(this.#svg);
    const processedSvgData = svgData.replace(/currentColor/g, "#000000");

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const width = parseInt(this.#svg.style.width, 10) || 800;
    const height = parseInt(this.#svg.style.height, 10) || 600;

    canvas.width = width;
    canvas.height = height;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    const img = new Image();
    const svgBlob = new Blob([processedSvgData], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      const imgURI = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.download = `Traversal-Tree-${this.id}.png`;
      a.href = imgURI;
      a.click();
    };

    img.src = url;
  }

  #runAndRender() {
    const snapshot =
      this.#snapshot ?? this.context.managers.visualModel.makeCopy();

    const res = this.context.managers.traversalTree.run(snapshot);

    if (!res || res === 0) {
      this.#clearSVG();
      this.#drawMessage("No traversal tree generated.");
      return;
    }

    this.#clearSVG();
    this.#renderResults(res);
    this.#renderTree(res);
  }

  #clearSVG() {
    if (this.#svg) this.#svg.innerHTML = "";
  }

  #drawMessage(text) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", "24");
    t.setAttribute("y", "40");
    t.setAttribute("font-size", "14");
    t.setAttribute("opacity", "0.9");
    t.textContent = text;
    this.#svg.appendChild(t);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Format S array as "S([0, a, (ε, m), ε])" */
  #sToString(S) {
    if (!S || S.length === 0) return "S([])";
    const parts = (S ?? []).map((entry) => {
      if (Array.isArray(entry)) return `(${entry.join(", ")})`;
      return String(entry);
    });
    return `S([${parts.join(", ")}])`;
  }

  /** True if the node is a join placeholder — rendered as "(v)" */
  #isPlaceholder(node) {
    return !!(node.placeholder || node.isPlaceholder || node.isJoinProxy);
  }

  // ─── Node drawing ────────────────────────────────────────────────────────────

  /**
   * Draw a labeled node:  vName (underlined, bold)
   *                        S([...])  (smaller, below)
   *
   * Returns bounding info: { x, y, w, h, xIn, xOut, yMid }
   */
  #drawLabeledNode(g, x, y, v, S) {
    const nodeG = document.createElementNS(SVG_NS, "g");
    nodeG.setAttribute("transform", `translate(${x},${y})`);

    // Vertex name — bold + underline
    const nameText = document.createElementNS(SVG_NS, "text");
    nameText.setAttribute("font-size", "13");
    nameText.setAttribute("font-weight", "bold");
    nameText.setAttribute("text-decoration", "underline");
    nameText.setAttribute("fill", "currentColor");
    nameText.setAttribute("x", "0");
    nameText.setAttribute("y", "0");
    nameText.textContent = v;
    nodeG.appendChild(nameText);

    // S([...]) subscript — smaller text below
    const sText = document.createElementNS(SVG_NS, "text");
    sText.setAttribute("font-size", "10");
    sText.setAttribute("fill", "currentColor");
    sText.setAttribute("opacity", "0.9");
    sText.setAttribute("x", "0");
    sText.setAttribute("y", "14");
    sText.textContent = this.#sToString(S);
    nodeG.appendChild(sText);

    g.appendChild(nodeG);

    // Measure via getBBox (after append)
    let bb;
    try {
      bb = nodeG.getBBox();
    } catch (_) {
      bb = { width: 80, height: 24 };
    }

    const w = Math.max(bb.width, 1);
    const h = Math.max(bb.height, 24);

    return {
      x,
      y,
      w,
      h,
      xIn: x,
      xOut: x + w,
      yMid: y + h / 2,
    };
  }

  /**
   * Draw a placeholder (join/proxy) node: "(v)"
   *
   * Returns bounding info: { x, y, w, h, xIn, xOut, yMid }
   */
  #drawPlaceholderNode(g, x, y, v) {
    const nodeG = document.createElementNS(SVG_NS, "g");
    nodeG.setAttribute("transform", `translate(${x},${y})`);

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("font-size", "13");
    text.setAttribute("fill", "currentColor");
    text.setAttribute("x", "0");
    text.setAttribute("y", "0");
    text.textContent = `(${v})`;
    nodeG.appendChild(text);

    g.appendChild(nodeG);

    let bb;
    try {
      bb = nodeG.getBBox();
    } catch (_) {
      bb = { width: 40, height: 16 };
    }

    const w = Math.max(bb.width, 1);
    const h = Math.max(bb.height, 16);

    return {
      x,
      y,
      w,
      h,
      xIn: x,
      xOut: x + w,
      yMid: y + h / 2,
    };
  }

  // ─── Edge drawing ────────────────────────────────────────────────────────────

  #drawEdge(edgeG, x1, y1, x2, y2, label, opts = {}) {
    const stroke = opts.stroke || "currentColor";
    const strokeWidth = opts.strokeWidth || "1.8";
    const opacity = opts.opacity || "0.85";
    const markerId = opts.markerId || "tt-arrow";

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", stroke);
    line.setAttribute("stroke-width", strokeWidth);
    line.setAttribute("opacity", opacity);
    line.setAttribute("marker-end", `url(#${markerId})`);
    edgeG.appendChild(line);

    if (label !== undefined && label !== null) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(mx));
      text.setAttribute("y", String(my - 6));
      text.setAttribute("font-size", "11");
      text.setAttribute("font-weight", "700");
      text.setAttribute("fill", "#d11");
      text.setAttribute("text-anchor", "middle");
      // Use "i=" prefix matching the paper's notation
      text.textContent = `i=${label}`;
      edgeG.appendChild(text);
    }
  }

  // ─── Main render ─────────────────────────────────────────────────────────────

  #renderTree(res) {
    const d3 = window.d3;
    if (!d3) {
      this.#drawMessage(
        'D3 not found. Add <script src="https://cdn.jsdelivr.net/npm/d3@7"></script> to main.html',
      );
      return;
    }

    const make = (tag) => document.createElementNS(SVG_NS, tag);

    // ── arrowhead marker ──────────────────────────────────────────────────────
    const defs = make("defs");
    const marker = make("marker");
    marker.setAttribute("id", "tt-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const tip = make("path");
    tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    tip.setAttribute("fill", "currentColor");
    marker.appendChild(tip);
    defs.appendChild(marker);

    // ── Path color palette and per-color arrowheads ───────────────────────────
    const PATH_COLORS = [
      "#3a81de", // blue
      "#4caf50", // green
      "#ff9800", // orange
      "#9c27b0", // purple
      "#e91e63", // pink
      "#00bcd4", // cyan
      "#795548", // brown
      "#607d8b", // blue-grey
    ];

    // Create one arrowhead marker per palette color so arrows match edges
    PATH_COLORS.forEach((color, idx) => {
      const m = make("marker");
      m.setAttribute("id", `tt-arrow-${idx}`);
      m.setAttribute("viewBox", "0 0 10 10");
      m.setAttribute("refX", "9");
      m.setAttribute("refY", "5");
      m.setAttribute("markerWidth", "6");
      m.setAttribute("markerHeight", "6");
      m.setAttribute("orient", "auto-start-reverse");
      const t = make("path");
      t.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
      t.setAttribute("fill", color);
      m.appendChild(t);
      defs.appendChild(m);
    });

    this.#svg.appendChild(defs);

    // ── Build spanning tree backbone (single parent per node) ─────────────────
    const childrenOf = new Map();
    res.allNodes.forEach((n) => childrenOf.set(n.id, []));

    // Process nodes from latest time to earliest so we assign parents greedily
    const sortedNodes = [...res.allNodes].sort(
      (a, b) => (b.time ?? 0) - (a.time ?? 0),
    );

    const parentOf = new Map();
    for (const n of sortedNodes) {
      for (const c of n.children ?? []) {
        if (!parentOf.has(c.id)) {
          parentOf.set(c.id, n.id);
          childrenOf.get(n.id)?.push(c);
        }
      }
    }

    const roots = res.allNodes.filter(
      (n) => !n.parents || n.parents.length === 0,
    );

    function toTree(node) {
      return {
        id: node.id,
        ref: node,
        children: (childrenOf.get(node.id) ?? []).map(toTree),
      };
    }

    const superRoot = {
      id: "__root__",
      ref: null,
      children: roots.map(toTree),
    };

    const rootH = d3.hierarchy(superRoot);

    // ── D3 tree layout ────────────────────────────────────────────────────────
    // nodeSize: [vertical spacing, horizontal spacing]
    // We map d.y -> x (horizontal), d.x -> y (vertical)
    const treeLayout = d3.tree().nodeSize([Y_GAP, X_GAP]);
    treeLayout(rootH);

    const nodes = rootH.descendants().filter((d) => d.data.ref);

    const minX = Math.min(...nodes.map((d) => d.x));
    const verticalShift = TOP_PAD - minX + 40;

    // Seed layout positions from D3
    const layoutPos = new Map();
    nodes.forEach((d) => {
      layoutPos.set(d.data.id, {
        x: LEFT_PAD + d.y,
        y: d.x + verticalShift,
      });
    });

    // Center AND-join nodes between their incoming parents
    const shiftSubtreeY = (nodeId, dy) => {
      const stack = [nodeId];
      while (stack.length) {
        const curId = stack.pop();
        const p = layoutPos.get(curId);
        if (p) layoutPos.set(curId, { x: p.x, y: p.y + dy });
        for (const k of childrenOf.get(curId) ?? []) stack.push(k.id);
      }
    };

    const joinTypeOf = (node) => {
      const direct = node.joinType ?? node.joinTypes ?? null;
      if (direct) return direct;
      return res.joinTypes?.get?.(node.v) ?? null;
    };

    for (const n of res.allNodes) {
      const jt = joinTypeOf(n);
      if (jt !== "AND") continue;
      if (!n.parents || n.parents.length < 2) continue;

      const myPos = layoutPos.get(n.id);
      if (!myPos) continue;

      const parentYs = n.parents
        .map((p) => layoutPos.get(p.id)?.y)
        .filter((y) => typeof y === "number");

      if (parentYs.length < 2) continue;

      const targetY = parentYs.reduce((a, b) => a + b, 0) / parentYs.length;
      const dy = targetY - myPos.y;
      if (Math.abs(dy) < 1) continue;
      shiftSubtreeY(n.id, dy);
    }

    // ── SVG layers ────────────────────────────────────────────────────────────
    const edgeGroup = make("g");
    const nodeGroup = make("g");
    this.#svg.appendChild(edgeGroup);
    this.#svg.appendChild(nodeGroup);

    // ── Render nodes ──────────────────────────────────────────────────────────
    // finalPos stores rendered bounds for each node id
    const finalPos = new Map();

    for (const n of res.allNodes) {
      const p = layoutPos.get(n.id);
      if (!p) continue;

      let dims;
      if (this.#isPlaceholder(n)) {
        dims = this.#drawPlaceholderNode(nodeGroup, p.x, p.y, n.v);
      } else {
        dims = this.#drawLabeledNode(nodeGroup, p.x, p.y, n.v, n.S);
      }

      finalPos.set(n.id, { id: n.id, v: n.v, ...dims });
    }

    // ── Draw synchronization bars between nodes sharing a joinGroupId ─────────
    // This covers two cases:
    //   1. Placeholder nodes (isPlaceholder=true) from OR/MIX-joins — these
    //      already had joinGroupId set during tree generation.
    //   2. Arrival nodes tagged isOrSubgroupMember=true — these are the actual
    //      pending-merge nodes at an AND-join where multiple incoming arcs share
    //      the same C-value (Structure 8). No extra placeholder is inserted;
    //      the sync bar is drawn directly between these arrival nodes.
    {
      const groupBuckets = new Map();
      for (const n of res.allNodes) {
        const gid = n.joinGroupId;
        if (!gid) continue;
        // Include placeholders AND tagged OR-subgroup members
        if (!this.#isPlaceholder(n) && !n.isOrSubgroupMember) continue;
        const pos = finalPos.get(n.id);
        if (!pos) continue;
        if (!groupBuckets.has(gid)) groupBuckets.set(gid, []);
        groupBuckets.get(gid).push(pos);
      }

      for (const [, positions] of groupBuckets) {
        if (positions.length < 2) continue;
        const xs = positions.map(p => p.x + (p.w ?? 0) / 2);
        const ys = positions.map(p => p.yMid);
        const avgX = xs.reduce((a, b) => a + b, 0) / xs.length;
        const yMin = Math.min(...ys);
        const yMax = Math.max(...ys);

        const bar = document.createElementNS(SVG_NS, "line");
        bar.setAttribute("x1", String(avgX));
        bar.setAttribute("y1", String(yMin));
        bar.setAttribute("x2", String(avgX));
        bar.setAttribute("y2", String(yMax));
        bar.setAttribute("stroke", "currentColor");
        bar.setAttribute("stroke-width", "1.6");
        bar.setAttribute("opacity", "0.6");
        edgeGroup.appendChild(bar);
      }
    }

    // ── Build maximal-path → edges map ─────────────────────────────────────
    // For each maximal path leaf, walk parents back to root collecting all
    // edges (parent→child pairs) along the path. An edge can belong to
    // multiple paths if those paths share a prefix or merge.
    const edgePaths = new Map();   // "parentId->childId" → Set<pathIndex>
    const nodePaths = new Map();   // nodeId → Set<pathIndex>

    const addNode = (id, pi) => {
      if (!nodePaths.has(id)) nodePaths.set(id, new Set());
      nodePaths.get(id).add(pi);
    };
    const addEdge = (key, pi) => {
      if (!edgePaths.has(key)) edgePaths.set(key, new Set());
      edgePaths.get(key).add(pi);
    };

    const maxPaths = res.maximalPaths ?? [];
    maxPaths.forEach((leaf, pathIndex) => {
      // Walk backwards from leaf via parents (visit each node once per path)
      const visited = new Set();
      const stack = [leaf];
      while (stack.length) {
        const n = stack.pop();
        if (!n || visited.has(n.id)) continue;
        visited.add(n.id);
        addNode(n.id, pathIndex);
        for (const p of n.parents ?? []) {
          addEdge(`${p.id}->${n.id}`, pathIndex);
          stack.push(p);
        }
      }
    });

    // ── Render edges with per-path coloring ────────────────────────────────
    for (const n of res.allNodes) {
      const to = finalPos.get(n.id);
      if (!to) continue;

      for (const p of n.parents ?? []) {
        const from = finalPos.get(p.id);
        if (!from) continue;

        const label = this.#isPlaceholder(n) ? null : n.time;

        const edgeKey = `${p.id}->${n.id}`;
        const pathIndices = [...(edgePaths.get(edgeKey) ?? [])].sort((a, b) => a - b);

        if (pathIndices.length === 0) {
          // Edge not on any maximal path — render in default style
          this.#drawEdge(
            edgeGroup,
            from.xOut + 4, from.yMid,
            to.xIn - 2, to.yMid,
            label,
          );
        } else if (pathIndices.length === 1) {
          // Single-path edge — use that path's color
          const ci = pathIndices[0] % PATH_COLORS.length;
          this.#drawEdge(
            edgeGroup,
            from.xOut + 4, from.yMid,
            to.xIn - 2, to.yMid,
            label,
            { stroke: PATH_COLORS[ci], strokeWidth: "2.4", opacity: "0.95",
              markerId: `tt-arrow-${ci}` },
          );
        } else {
          // Shared edge across multiple paths — draw stacked offset lines,
          // one per path color, so all colors are visible.
          const N = pathIndices.length;
          const SPREAD = 4; // px offset between stacked lines
          pathIndices.forEach((pi, idx) => {
            const ci = pi % PATH_COLORS.length;
            // Distribute lines symmetrically around the centerline
            const offset = (idx - (N - 1) / 2) * SPREAD;
            this.#drawEdge(
              edgeGroup,
              from.xOut + 4, from.yMid + offset,
              to.xIn - 2, to.yMid + offset,
              idx === 0 ? label : null, // only label once
              { stroke: PATH_COLORS[ci], strokeWidth: "2.0", opacity: "0.85",
                markerId: `tt-arrow-${ci}` },
            );
          });
        }
      }
    }

    // ── Resize SVG ────────────────────────────────────────────────────────────
    let maxRight = 0;
    let maxBottom = 0;

    for (const b of finalPos.values()) {
      if (b.xOut + 120 > maxRight) maxRight = b.xOut + 120;
      if (b.yMid + 80 > maxBottom) maxBottom = b.yMid + 80;
    }

    const clientWidth = this.#root.clientWidth || 800;
    const clientHeight = this.#root.clientHeight || 600;

    this.#svg.style.width = `${Math.max(maxRight, clientWidth)}px`;
    this.#svg.style.height = `${Math.max(maxBottom, clientHeight)}px`;
  }

  // ─── Sidebar / metadata panel ─────────────────────────────────────────────

  #renderResults(res) {
    const parallelHost = this.#root.querySelector("[data-tt-parallel]");
    if (!parallelHost) return;

    parallelHost.innerHTML = "";

    const fmtS = (S) => {
      if (!S || S.length === 0) return "S([])";
      const parts = (S ?? []).map((entry) =>
        Array.isArray(entry) ? `(${entry.join(", ")})` : String(entry),
      );
      return `S([${parts.join(", ")}])`;
    };

    if (res.maximalPaths && res.maximalPaths.length > 0) {
      const PATH_COLORS = [
        "#3a81de", "#4caf50", "#ff9800", "#9c27b0",
        "#e91e63", "#00bcd4", "#795548", "#607d8b",
      ];

      const list = document.createElement("div");
      list.style.cssText =
        "display:flex;flex-direction:column;gap:6px;font-size:12px;";

      res.maximalPaths.forEach((b, pathIndex) => {
        const color = PATH_COLORS[pathIndex % PATH_COLORS.length];

        const row = document.createElement("div");
        row.style.cssText =
          "padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.1);" +
          "display:flex;align-items:center;gap:8px;";

        // Color swatch matching the path's edges in the tree
        const swatch = document.createElement("span");
        swatch.style.cssText =
          `display:inline-block;width:12px;height:12px;border-radius:3px;` +
          `background:${color};flex-shrink:0;`;
        row.appendChild(swatch);

        const labelEl = document.createElement("span");
        labelEl.textContent = `Path ${pathIndex + 1}: ${b.v}  —  ${fmtS(b.S)}`;
        labelEl.style.cssText = "flex:1;";
        row.appendChild(labelEl);

        list.appendChild(row);
      });

      parallelHost.appendChild(list);
    } else {
      parallelHost.textContent = "No parallel branches calculated.";
    }

    const sourceMeta = this.#root.querySelector('[data-tt-meta="source"]');
    const sinkMeta = this.#root.querySelector('[data-tt-meta="sink"]');
    const nodesMeta = this.#root.querySelector('[data-tt-meta="nodes"]');
    const timesMeta = this.#root.querySelector('[data-tt-meta="times"]');

    if (sourceMeta && res.allNodes) {
      const roots = res.allNodes.filter(
        (n) => !n.parents || n.parents.length === 0,
      );
      sourceMeta.textContent =
        [...new Set(roots.map((r) => r.v))].join(", ") || "—";
    }

    if (sinkMeta && res.maximalPaths) {
      sinkMeta.textContent =
        [...new Set(res.maximalPaths.map((p) => p.v))].join(", ") || "—";
    }

    if (nodesMeta && res.allNodes) {
      nodesMeta.textContent = res.allNodes.length;
    }

    if (timesMeta && res.allNodes) {
      const maxTime = Math.max(...res.allNodes.map((n) => n.time || 0));
      timesMeta.textContent = `0 to ${maxTime}`;
    }
  }
}