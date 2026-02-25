import { generateUniqueID } from "../../utils.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout Constants
const LEFT_PAD = 80;
const TOP_PAD = 60;
const X_GAP = 320;
const Y_GAP = 150;
const BOX_PAD_X = 10;
const BOX_PAD_Y = 8;

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

    this.#runAndRender();
  }

  #clearSVG() {
    while (this.#svg.firstChild) {
      this.#svg.removeChild(this.#svg.firstChild);
    }
  }

  #runAndRender() {
    const snapshot =
      this.#snapshot ?? this.context.managers.visualModel.makeCopy();

    const res = this.context.managers.traversalTree.run(snapshot);

    this.#clearSVG();

    if (!res || res === 0) {
      this.#drawMessage("No traversal tree generated.");
      return;
    }

    this.#renderResults(res);
    this.#renderTree(res);
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

  #renderTree(res) {
    const make = (tag) => document.createElementNS(SVG_NS, tag);
    const sToString = (S) => `S([${(S ?? []).join(",")}])`;

    // ---- defs: arrowhead marker ----
    const defs = make("defs");
    const marker = make("marker");
    marker.setAttribute("id", "tt-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");

    const tip = make("path");
    tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    tip.setAttribute("fill", "currentColor");

    marker.appendChild(tip);
    defs.appendChild(marker);
    this.#svg.appendChild(defs);

    // ---------- 1. Build Spanning Tree ----------
    const childrenOf = new Map();
    res.allNodes.forEach((n) => childrenOf.set(n.id, []));

    const sortedNodes = [...res.allNodes].sort((a, b) => b.time - a.time);

    const parentOf = new Map();
    for (const n of sortedNodes) {
      for (const c of n.children ?? []) {
        if (!parentOf.has(c.id)) {
          parentOf.set(c.id, n.id);
          childrenOf.get(n.id).push(c);
        }
      }
    }

    // ---------- 2. Compute Subtree Widths ----------
    const leafCount = new Map();
    function calcLeaves(node) {
      const children = childrenOf.get(node.id);
      if (children.length === 0) {
        leafCount.set(node.id, 1);
        return 1;
      }
      let sum = 0;
      for (const c of children) sum += calcLeaves(c);
      leafCount.set(node.id, sum);
      return sum;
    }

    const roots = res.allNodes.filter(
      (n) => !n.parents || n.parents.length === 0,
    );
    roots.forEach((r) => calcLeaves(r));

    // ---------- 3. Assign Grid Positions ----------
    const layoutPos = new Map();

    function assignPos(node, yStart) {
      const x = LEFT_PAD + node.time * X_GAP;
      const myLeaves = leafCount.get(node.id);
      const myHeight = myLeaves * Y_GAP;
      const y = yStart + myHeight / 2 - Y_GAP / 2;

      layoutPos.set(node.id, { x, y });

      let currY = yStart;
      for (const c of childrenOf.get(node.id)) {
        assignPos(c, currY);
        currY += leafCount.get(c.id) * Y_GAP;
      }
    }

    let currentRootY = TOP_PAD;
    for (const r of roots) {
      assignPos(r, currentRootY);
      currentRootY += leafCount.get(r.id) * Y_GAP;
    }

    // ---------- 4. SVG Layers ----------
    const edgeGroup = make("g");
    const syncGroup = make("g");
    const nodeGroup = make("g");
    this.#svg.appendChild(edgeGroup);
    this.#svg.appendChild(syncGroup);
    this.#svg.appendChild(nodeGroup);

    // ---------- 5. SVG Drawing Helpers ----------
    const drawBezierEdge = (x1, y1, x2, y2, timeLabel, opacity = "0.9") => {
      const path = make("path");
      const midX = (x1 + x2) / 2;

      // smoother than your original: pull curves outward
      const c1x = x1 + (midX - x1) * 0.8;
      const c2x = x2 - (x2 - midX) * 0.8;

      const d = `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;

      path.setAttribute("d", d);
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "2.2");
      path.setAttribute("opacity", opacity);
      path.setAttribute("marker-end", "url(#tt-arrow)");

      edgeGroup.appendChild(path);

      if (timeLabel !== undefined) {
        const text = make("text");
        const midY = (y1 + y2) / 2;

        text.setAttribute("x", String(midX));
        text.setAttribute("y", String(midY - 10));
        text.setAttribute("font-size", "12");
        text.setAttribute("font-weight", "700");
        text.setAttribute("fill", "#d11"); // red like the image
        text.setAttribute("text-anchor", "middle");

        text.textContent = `t=${timeLabel}`;
        edgeGroup.appendChild(text);
      }
    };

    const drawTextNode = (x, y, v, S) => {
      const g = make("g");
      g.setAttribute("transform", `translate(${x},${y})`);

      const title = make("text");
      title.setAttribute("font-size", "14");
      title.setAttribute("font-weight", "600");
      title.setAttribute("fill", "currentColor");
      title.textContent = v;
      g.appendChild(title);

      const sub = make("text");
      sub.setAttribute("y", "18");
      sub.setAttribute("font-size", "12");
      sub.setAttribute("opacity", "0.85");
      sub.setAttribute("fill", "currentColor");
      sub.textContent = sToString(S);
      g.appendChild(sub);

      nodeGroup.appendChild(g);
      const bb = g.getBBox();
      return {
        w: bb.width,
        h: bb.height,
        xIn: x, // left edge of group anchor
        xOut: x + bb.width, // right edge
        yMid: y + bb.height / 2,
      };
    };

    // ---------- 6. Render Nodes & Capture Bounds ----------
    const finalPos = new Map();

    for (const n of res.allNodes) {
      const { x, y } = layoutPos.get(n.id);
      const dims = drawTextNode(x, y, n.v, n.S);
      finalPos.set(n.id, { id: n.id, v: n.v, x, y, ...dims });
    }
    // ---------- 7. Render Edges (Visually Converging Joins) ----------
    for (const n of res.allNodes) {
      const to = finalPos.get(n.id);
      if (!to) continue;

      for (const p of n.parents ?? []) {
        const from = finalPos.get(p.id);
        if (!from) continue;

        // We REMOVED the crossParents check here!
        // Now, every parent branch will draw a beautiful Bezier curve
        // that converges directly into this single merged node.
        drawBezierEdge(from.xOut, from.yMid, to.xIn, to.yMid, n.time);
      }
    }

    // ---------- 9. Dynamically Resize SVG ----------
    let maxX = 0;
    let maxY = 0;

    for (const bounds of finalPos.values()) {
      const rightEdge = bounds.xOut + 150;
      const bottomEdge = bounds.yMid + 150;

      if (rightEdge > maxX) maxX = rightEdge;
      if (bottomEdge > maxY) maxY = bottomEdge;
    }

    const clientWidth = this.#root.clientWidth || 800;
    const clientHeight = this.#root.clientHeight || 600;

    this.#svg.style.width = `${Math.max(maxX, clientWidth)}px`;
    this.#svg.style.height = `${Math.max(maxY, clientHeight)}px`;
  }

  // ... (Keep the rest of your class unmodified)
  #renderResults(res) {
    const parallelHost = this.#root.querySelector("[data-tt-parallel]");
    const nonParallelHost = this.#root.querySelector("[data-tt-nonparallel]");
    if (!parallelHost || !nonParallelHost) return;

    parallelHost.innerHTML = "";
    nonParallelHost.innerHTML = "";

    const fmtS = (S) => `S([${(S ?? []).join(",")}])`;

    const renderGroup = (host, title, branches) => {
      const wrap = document.createElement("div");
      wrap.className = "tt-group";

      const head = document.createElement("div");
      head.className = "tt-group-title";
      head.textContent = title;
      wrap.appendChild(head);

      const list = document.createElement("div");
      list.className = "tt-branch-list";

      for (const b of branches) {
        const row = document.createElement("div");
        row.className = "tt-branch-row";
        row.textContent = `${b.v}  —  ${fmtS(b.S)}`;
        list.appendChild(row);
      }

      wrap.appendChild(list);
      host.appendChild(wrap);
    };
  }
}