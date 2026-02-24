import { generateUniqueID } from "../../utils.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout Constants
const LEFT_PAD = 60;
const TOP_PAD = 60;
const FIRST_GAP = 450;
const LATER_GAP = 260;
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

    // ---------- 0. Use Pre-Calculated Time from Generator ----------
    const nodeMap = new Map(res.allNodes.map((n) => [n.id, n]));

    // Calculate X coordinate based on the mathematical time instead of arc depth
    const timeToX = (n) => {
      const t = n.time; // Read direct property from the generator
      
      // 1. Root nodes
      if (t === 0) return LEFT_PAD;
      
      // 2. Immediate children (t = 1)
      if (t === 1) return LEFT_PAD + FIRST_GAP * 0.55;

      // 3. Normal nodes at t >= 2
      return LEFT_PAD + FIRST_GAP + (t - 2) * LATER_GAP;
    };

    // ---------- 1. Group nodes by Time ----------
    const byTime = new Map();
    for (const n of res.allNodes) {
      const t = n.time;
      if (!byTime.has(t)) byTime.set(t, []);
      byTime.get(t).push(n);
    }

    const times = [...byTime.keys()].sort((a, b) => a - b);

    // ---------- 2. Span-based Lane Assignment ----------
    const laneIntervals = new Map();
    const laneOf = new Map();

    const isFree = (lane, start, end) => {
      const intervals = laneIntervals.get(lane) ?? [];
      for (const [s, e] of intervals) {
        if (start < e && end > s) return false; // Strict overlap check
      }
      return true;
    };

    const occupy = (lane, start, end) => {
      if (!laneIntervals.has(lane)) laneIntervals.set(lane, []);
      laneIntervals.get(lane).push([start, end]);
    };

    times.forEach((t) => {
      const nodes = byTime.get(t) ?? [];

      // Sort nodes to prioritize maintaining the parent's lane
      nodes.sort((a, b) => {
        const laneA = a.parents?.[0] ? (laneOf.get(a.parents[0].id) ?? 0) : 0;
        const laneB = b.parents?.[0] ? (laneOf.get(b.parents[0].id) ?? 0) : 0;
        if (laneA !== laneB) return laneA - laneB;
        if (a.v !== b.v) return a.v.localeCompare(b.v);
        return sToString(a.S).localeCompare(sToString(b.S));
      });

      for (const n of nodes) {
        const parent = n.parents?.[0];
        const preferred = parent ? (laneOf.get(parent.id) ?? 0) : 0;
        const nTime = n.time;

        let maxChildTime = nTime;
        for (const c of n.children ?? []) {
          const cTime = c.time;
          if (cTime > maxChildTime) maxChildTime = cTime;
        }

        // Reserve span up to furthest child (or a slight bump if no children to reserve the cell)
        const start = nTime;
        const end = maxChildTime > nTime ? maxChildTime : nTime + 0.5;

        let assignedLane = -1;

        if (isFree(preferred, start, end)) {
          assignedLane = preferred;
        } else {
          for (let l = 0; l < 1000; l++) {
            if (isFree(l, start, end)) {
              assignedLane = l;
              break;
            }
          }
        }

        laneOf.set(n.id, assignedLane);
        occupy(assignedLane, start, end);
      }
    });

    // ---------- 3. SVG Group Layers ----------
    const edgeGroup = make("g");
    const nodeGroup = make("g");
    this.#svg.appendChild(edgeGroup);
    this.#svg.appendChild(nodeGroup);

    // ---------- 4. SVG Drawing Helpers ----------
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

    // ---------- 5. Render Nodes ----------
    const pos = new Map();

    for (const n of res.allNodes) {
      const lane = laneOf.get(n.id) ?? 0;
      const x = timeToX(n); // Now uses n.time
      const y = TOP_PAD + lane * Y_GAP;

      const dims = drawTextNode(x, y, n.v, n.S);
      pos.set(n.id, { x, y, ...dims });
    }

    // ---------- 6. Render Edges with Time Labels ----------
    for (const n of res.allNodes) {
      const to = pos.get(n.id);
      if (!to) continue;

      for (const p of n.parents ?? []) {
        const from = pos.get(p.id);
        if (!from) continue;

        // Pass n.time directly to the label instead of getDepth(n.id)
        drawBezierEdge(from.xOut, from.yMid, to.xIn, to.yMid, n.time);
      }
    }
  }

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
