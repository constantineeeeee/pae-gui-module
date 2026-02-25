import { generateUniqueID } from "../../utils.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout Constants
const LEFT_PAD = 80; 
const TOP_PAD = 60;
const X_GAP = 320; 
const Y_GAP = 90;  
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

    // if (!res || res === 0) {
    //   this.#drawMessage("No traversal tree generated.");
    //   return;
    // }

    // this.#renderResults(res);
    // this.#renderTree(res);
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

    const roots = res.allNodes.filter((n) => !n.parents || n.parents.length === 0);
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
    const drawBezierEdge = (x1, y1, x2, y2, timeLabel, opacity = "0.4") => {
      const path = make("path");
      const midX = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;

      path.setAttribute("d", d);
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("opacity", opacity);

      edgeGroup.appendChild(path);

      if (timeLabel !== undefined) {
        const text = make("text");
        const midY = (y1 + y2) / 2;

        text.setAttribute("x", String(midX));
        text.setAttribute("y", String(midY - 6));
        text.setAttribute("font-size", "11");
        text.setAttribute("font-weight", "600");
        text.setAttribute("fill", "currentColor");
        text.setAttribute("opacity", "0.85");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("paint-order", "stroke");
        text.setAttribute("stroke", "var(--color-surface, #ffffff)");
        text.setAttribute("stroke-width", "4");
        text.setAttribute("stroke-linecap", "round");
        text.setAttribute("stroke-linejoin", "round");

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
      const w = bb.width + BOX_PAD_X * 2;
      const h = bb.height + BOX_PAD_Y * 2;

      const bg = make("rect");
      bg.setAttribute("x", -BOX_PAD_X);
      bg.setAttribute("y", -BOX_PAD_Y);
      bg.setAttribute("width", w);
      bg.setAttribute("height", h);
      bg.setAttribute("fill", "var(--color-surface, #ffffff)");
      bg.setAttribute("rx", "6");
      bg.setAttribute("stroke", "transparent");
      bg.setAttribute("stroke-width", "0");

      g.insertBefore(bg, g.firstChild);

      return {
        w,
        h,
        xIn: x - BOX_PAD_X,
        xOut: x - BOX_PAD_X + w,
        yMid: y - BOX_PAD_Y + h / 2,
      };
    };

    // ---------- 6. Render Nodes & Capture Bounds ----------
    const finalPos = new Map();

    for (const n of res.allNodes) {
      const { x, y } = layoutPos.get(n.id);
      const dims = drawTextNode(x, y, n.v, n.S);
      finalPos.set(n.id, { id: n.id, v: n.v, x, y, ...dims });
    }

    // ---------- 7. Render Edges (Hiding Cross-Links) ----------
    for (const n of res.allNodes) {
      const to = finalPos.get(n.id);
      if (!to) continue;

      for (const p of n.parents ?? []) {
        const from = finalPos.get(p.id);
        if (!from) continue;

        // Turn the arc into a vertical line by skipping the Bezier!
        if (n.crossParents && n.crossParents.includes(p.id)) {
          continue; 
        }

        drawBezierEdge(from.xOut, from.yMid, to.xIn, to.yMid, n.time);
      }
    }

    // ---------- 8. Draw Vertical Bracket Lines ----------
    const nodesByColAndV = new Map();

    for (const n of res.allNodes) {
      const pos = finalPos.get(n.id);
      if (!pos) continue;

      const key = `${pos.x}_${n.v}`;
      if (!nodesByColAndV.has(key)) nodesByColAndV.set(key, []);
      nodesByColAndV.get(key).push(n);
    }

    for (const nodes of nodesByColAndV.values()) {
      if (nodes.length <= 1) continue;

      // Group nodes that share an intersecting parent
      // Since we kept the cross-link in `parents`, MIX joins perfectly cluster together!
      const clusters = [];
      for (const n of nodes) {
        let added = false;
        for (const cluster of clusters) {
          const sharesParent = cluster.some(cn => 
            n.parents.some(p => cn.parents.some(cp => cp.id === p.id))
          );
          if (sharesParent) {
            cluster.push(n);
            added = true;
            break;
          }
        }
        if (!added) clusters.push([n]);
      }

      for (const cluster of clusters) {
        if (cluster.length > 1) {
          cluster.sort((a, b) => finalPos.get(a.id).yMid - finalPos.get(b.id).yMid);

          const minY = finalPos.get(cluster[0].id).yMid;
          const maxY = finalPos.get(cluster[cluster.length - 1].id).yMid;
          const lineX = finalPos.get(cluster[0].id).xIn - 12;

          const vLine = make("line");
          vLine.setAttribute("x1", String(lineX));
          vLine.setAttribute("y1", String(minY));
          vLine.setAttribute("x2", String(lineX));
          vLine.setAttribute("y2", String(maxY));
          vLine.setAttribute("stroke", "currentColor");
          vLine.setAttribute("stroke-width", "2");
          vLine.setAttribute("stroke-dasharray", "4 4");
          vLine.setAttribute("opacity", "0.4");
          
          const capTop = make("line");
          capTop.setAttribute("x1", String(lineX)); capTop.setAttribute("y1", String(minY));
          capTop.setAttribute("x2", String(lineX + 6)); capTop.setAttribute("y2", String(minY));
          capTop.setAttribute("stroke", "currentColor"); capTop.setAttribute("stroke-width", "2"); capTop.setAttribute("opacity", "0.4");

          const capBottom = make("line");
          capBottom.setAttribute("x1", String(lineX)); capBottom.setAttribute("y1", String(maxY));
          capBottom.setAttribute("x2", String(lineX + 6)); capBottom.setAttribute("y2", String(maxY));
          capBottom.setAttribute("stroke", "currentColor"); capBottom.setAttribute("stroke-width", "2"); capBottom.setAttribute("opacity", "0.4");

          syncGroup.appendChild(vLine);
          syncGroup.appendChild(capTop);
          syncGroup.appendChild(capBottom);
        }
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