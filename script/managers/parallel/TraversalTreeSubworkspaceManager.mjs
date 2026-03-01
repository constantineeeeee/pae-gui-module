import { generateUniqueID } from "../../utils.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout Constants
const LEFT_PAD = 80;
const TOP_PAD = 60;

// D3 layout spacing (similar to your old X_GAP/Y_GAP)
const X_GAP = 320; // horizontal spacing
const Y_GAP = 150; // vertical spacing

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

  // ✅ FIXED: correct manager + method name
  #runAndRender() {
    const snapshot =
      this.#snapshot ?? this.context.managers.visualModel.makeCopy();

    // Your project uses traversalTree.run(snapshot)
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

  #renderTree(res) {
    const d3 = window.d3;
    if (!d3) {
      this.#drawMessage(
        'D3 not found. Add: <script src="https://cdn.jsdelivr.net/npm/d3@7"></script> in main.html',
      );
      return;
    }

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

    // ============================================================
    // 1) Build spanning-tree backbone (single parent per node)
    // ============================================================
    const childrenOf = new Map();
    res.allNodes.forEach((n) => childrenOf.set(n.id, []));

    const sortedNodes = [...res.allNodes].sort(
      (a, b) => (b.time ?? 0) - (a.time ?? 0),
    );

    const parentOf = new Map();
    for (const n of sortedNodes) {
      for (const c of n.children ?? []) {
        if (!parentOf.has(c.id)) {
          parentOf.set(c.id, n.id);
          childrenOf.get(n.id).push(c);
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

    // if multiple roots, add a super root
    const superRoot = {
      id: "__root__",
      ref: null,
      children: roots.map(toTree),
    };

    const rootH = d3.hierarchy(superRoot);

    // ============================================================
    // 2) D3 layout
    // nodeSize: [vertical, horizontal]
    // We'll map d.y -> x (horizontal), d.x -> y (vertical)
    // ============================================================
    const treeLayout = d3.tree().nodeSize([Y_GAP, X_GAP]);
    treeLayout(rootH);

    const nodes = rootH.descendants().filter((d) => d.data.ref);

    // find vertical bounds
    const minX = Math.min(...nodes.map((d) => d.x));
    const maxX = Math.max(...nodes.map((d) => d.x));

    // shift everything downward so nothing is clipped
    const verticalShift = TOP_PAD - minX + 40; // 40 = breathing space

    const layoutPos = new Map();

    // 1) FIRST: seed layoutPos from D3 positions
    nodes.forEach((d) => {
      layoutPos.set(d.data.id, {
        x: LEFT_PAD + d.y,
        y: d.x + verticalShift,
      });
    });

    // --- Join type helper ---
    const joinTypeOf = (node) => {
      // Prefer per-node join type if present
      const direct = node.joinType ?? node.joinTypes ?? null;
      if (direct) return direct;

      // Or res.joinTypes may be a Map keyed by vertex name (node.v)
      // Your console shows: Map(2) { 'x2' => 'OR', 'y7' => 'AND' }
      return res.joinTypes?.get?.(node.v) ?? null;
    };

    // --- shift a node + its backbone subtree (childrenOf) by dy in the layoutPos map ---
    const shiftSubtreeY = (nodeId, dy) => {
      const stack = [nodeId];
      while (stack.length) {
        const curId = stack.pop();
        const p = layoutPos.get(curId);
        if (p) layoutPos.set(curId, { x: p.x, y: p.y + dy });

        const kids = childrenOf.get(curId) ?? [];
        for (const k of kids) stack.push(k.id);
      }
    };

    // 2) THEN: center AND-joins between their incoming parents
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

      // Move AND node AND its subtree so outgoing path remains aligned
      shiftSubtreeY(n.id, dy);
    }

    // ============================================================
    // 3) SVG Layers
    // ============================================================
    const edgeGroup = make("g");
    const syncGroup = make("g");
    const nodeGroup = make("g");
    this.#svg.appendChild(edgeGroup);
    this.#svg.appendChild(syncGroup);
    this.#svg.appendChild(nodeGroup);

    // ============================================================
    // 4) Helpers
    // ============================================================
    const drawStraightEdge = (x1, y1, x2, y2, timeLabel, opacity = "0.9") => {
      const line = make("line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));

      line.setAttribute("stroke", "currentColor");
      line.setAttribute("stroke-width", "2.2");
      line.setAttribute("opacity", opacity);
      line.setAttribute("fill", "none");
      line.setAttribute("marker-end", "url(#tt-arrow)");

      edgeGroup.appendChild(line);

      // time label near the middle (slightly above the line)
      if (timeLabel !== undefined) {
        const text = make("text");
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;

        text.setAttribute("x", String(mx));
        text.setAttribute("y", String(my - 10));
        text.setAttribute("font-size", "12");
        text.setAttribute("font-weight", "700");
        text.setAttribute("fill", "#d11");
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
      title.textContent = v; // x4
      g.appendChild(title);

      const sub = make("text");
      sub.setAttribute("y", "18");
      sub.setAttribute("font-size", "12");
      sub.setAttribute("opacity", "0.85");
      sub.setAttribute("fill", "currentColor");
      sub.textContent = sToString(S); // S([0,...])
      g.appendChild(sub);

      nodeGroup.appendChild(g);
      const bb = g.getBBox();
      return {
        w: bb.width,
        h: bb.height,
        xIn: x,
        xOut: x + bb.width,
        yMid: y + bb.height / 2,
      };
    };

    // ============================================================
    // 5) Render nodes & capture bounds
    // ============================================================
    const finalPos = new Map();

    for (const n of res.allNodes) {
      const p = layoutPos.get(n.id);
      if (!p) continue;
      const dims = drawTextNode(p.x, p.y, n.v, n.S);
      finalPos.set(n.id, { id: n.id, v: n.v, x: p.x, y: p.y, ...dims });
    }

    // ============================================================
    // 6) Render edges: draw ALL parents -> child
    // This makes AND-joins merge (multiple incoming curves converge).
    // ============================================================
    for (const n of res.allNodes) {
      const to = finalPos.get(n.id);
      if (!to) continue;

      for (const p of n.parents ?? []) {
        const from = finalPos.get(p.id);
        if (!from) continue;

        // draw a curve from parent right-edge -> child left-edge
        // drawBezierEdge(from.xOut, from.yMid, to.xIn, to.yMid, n.time);
        drawStraightEdge(from.xOut, from.yMid, to.xIn, to.yMid, n.time);
      }
    }

    // ============================================================
    // 7) Resize SVG
    // ============================================================
    let screenMaxX = 0;
    let maxY = 0;

    for (const bounds of finalPos.values()) {
      const rightEdge = bounds.xOut + 150;
      const bottomEdge = bounds.yMid + 150;

      if (rightEdge > screenMaxX) screenMaxX = rightEdge;
      if (bottomEdge > maxY) maxY = bottomEdge;
    }

    const clientWidth = this.#root.clientWidth || 800;
    const clientHeight = this.#root.clientHeight || 600;

    this.#svg.style.width = `${Math.max(screenMaxX, clientWidth)}px`;
    this.#svg.style.height = `${Math.max(maxY, clientHeight)}px`;
  }

  #renderResults(res) {
    const parallelHost = this.#root.querySelector("[data-tt-parallel]");
    if (!parallelHost) return;

    parallelHost.innerHTML = "";

    const fmtS = (S) => `S([${(S ?? []).join(",")}])`;

    const renderGroup = (host, branches) => {
      const list = document.createElement("div");
      list.className = "tt-branch-list";
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "8px";

      for (const b of branches) {
        const row = document.createElement("div");
        row.className = "tt-branch-row";
        row.style.fontSize = "13px";
        row.style.paddingBottom = "4px";
        row.style.borderBottom = "1px solid rgba(255,255,255,0.1)";
        row.textContent = `${b.v}  —  ${fmtS(b.S)}`;
        list.appendChild(row);
      }

      host.appendChild(list);
    };

    if (res.maximalPaths && res.maximalPaths.length > 0) {
      renderGroup(parallelHost, res.maximalPaths);
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
