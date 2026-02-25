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

    // Add this new listener for the export action
    root
      .querySelector('[data-tt-action="exportTT"]')
      ?.addEventListener("click", () => this.#exportImage());

    this.#runAndRender();
  }

  #exportImage() {
    if (!this.#svg || !this.#svg.firstChild) return;

    // 1. Serialize the SVG to a string
    const svgData = new XMLSerializer().serializeToString(this.#svg);

    // Replace 'currentColor' with a hardcoded black hex so it's visible in the exported PNG
    const processedSvgData = svgData.replace(/currentColor/g, "#000000");

    // 2. Prepare the Canvas
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    // Use the dynamically calculated width/height from the render logic
    const width = parseInt(this.#svg.style.width, 10) || 800;
    const height = parseInt(this.#svg.style.height, 10) || 600;

    canvas.width = width;
    canvas.height = height;

    // Fill a white background (otherwise the PNG will be transparent)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);

    // 3. Create an Image object from the SVG string
    const img = new Image();
    const svgBlob = new Blob([processedSvgData], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(svgBlob);

    // 4. Draw to Canvas and Trigger Download once loaded
    img.onload = () => {
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url); // Clean up memory

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

    // this.#clearSVG();

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

  #renderResults(res) {
    const parallelHost = this.#root.querySelector("[data-tt-parallel]");
    if (!parallelHost) return;

    // Clear previous results
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

    // 1. Render the strings into the UI panel
    if (res.maximalPaths && res.maximalPaths.length > 0) {
      renderGroup(parallelHost, res.maximalPaths);
    } else {
      parallelHost.textContent = "No parallel branches calculated.";
    }

    // 2. Populate Sidebar Details (Nodes, Times, Source, Sink)
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
