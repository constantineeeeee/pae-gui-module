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

  #drawEdge(edgeG, x1, y1, x2, y2, label) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1.8");
    line.setAttribute("opacity", "0.85");
    line.setAttribute("marker-end", "url(#tt-arrow)");
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

    // ── Render edges: ALL parent → child connections ──────────────────────────
    for (const n of res.allNodes) {
      const to = finalPos.get(n.id);
      if (!to) continue;

      for (const p of n.parents ?? []) {
        const from = finalPos.get(p.id);
        if (!from) continue;

        // Only label the edge with i= on non-placeholder targets
        // (placeholder nodes are intermediaries; the label goes on the
        //  final labeled node after the placeholder)
        const label = this.#isPlaceholder(n) ? null : n.time;

        this.#drawEdge(
          edgeGroup,
          from.xOut + 4,
          from.yMid,
          to.xIn - 2,
          to.yMid,
          label,
        );
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
      const list = document.createElement("div");
      list.style.cssText =
        "display:flex;flex-direction:column;gap:6px;font-size:12px;";

      for (const b of res.maximalPaths) {
        const row = document.createElement("div");
        row.style.cssText =
          "padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.1);";
        row.textContent = `${b.v}  —  ${fmtS(b.S)}`;
        list.appendChild(row);
      }

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