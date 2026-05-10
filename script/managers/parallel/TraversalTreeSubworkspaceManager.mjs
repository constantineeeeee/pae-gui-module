import { generateUniqueID } from "../../utils.mjs";
import ProcessColorRegistry from "../../services/parallel/ProcessColorRegistry.mjs";

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
  #groupColors = null;

  constructor(context, visualModelSnapshot, groupColors = null) {
    this.context = context;
    this.id = generateUniqueID();
    this.#snapshot = visualModelSnapshot;
    this.#groupColors = groupColors;

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

    // Get the tight bounding box of all drawn content
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    // Walk all child elements and union their bounding boxes
    const allEls = this.#svg.querySelectorAll("text, line, path, rect, circle, g");
    for (const el of allEls) {
      try {
        const bb = el.getBBox();
        if (bb.width === 0 && bb.height === 0) continue;
        minX = Math.min(minX, bb.x);
        minY = Math.min(minY, bb.y);
        maxX = Math.max(maxX, bb.x + bb.width);
        maxY = Math.max(maxY, bb.y + bb.height);
      } catch (_) {}
    }

    if (!isFinite(minX)) return; // nothing to export

    const PADDING = 32;
    minX -= PADDING;
    minY -= PADDING;
    maxX += PADDING;
    maxY += PADDING;

    const contentWidth  = maxX - minX;
    const contentHeight = maxY - minY;

    // Serialize SVG with a viewBox cropped to the content area
    const originalViewBox = this.#svg.getAttribute("viewBox");
    this.#svg.setAttribute("viewBox", `${minX} ${minY} ${contentWidth} ${contentHeight}`);

    const svgData = new XMLSerializer().serializeToString(this.#svg);
    const processedSvgData = svgData.replace(/currentColor/g, "#000000");

    // Restore original viewBox
    if (originalViewBox) {
      this.#svg.setAttribute("viewBox", originalViewBox);
    } else {
      this.#svg.removeAttribute("viewBox");
    }

    const SCALE = 2; // 2× for sharper output
    const canvas = document.createElement("canvas");
    canvas.width  = contentWidth  * SCALE;
    canvas.height = contentHeight * SCALE;

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(SCALE, SCALE);

    const img = new Image();
    const svgBlob = new Blob([processedSvgData], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      ctx.drawImage(img, 0, 0, contentWidth, contentHeight);
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
    // const PATH_COLORS = [
    //   "#3a81de", // blue
    //   "#4caf50", // green
    //   "#ff9800", // orange
    //   "#9c27b0", // purple
    //   "#e91e63", // pink
    //   "#00bcd4", // cyan
    //   "#795548", // brown
    //   "#607d8b", // blue-grey
    // ];
    const PATH_COLORS = ProcessColorRegistry.hasRegistrations
      ? ProcessColorRegistry.getAllColors()
      : ["#3a81de","#4caf50","#ff9800","#9c27b0","#e91e63","#00bcd4","#795548","#607d8b"];

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

    // Process nodes from highest col to lowest so parents are always
    // processed before children in the parentOf assignment below.
    const sortedNodes = [...res.allNodes].sort(
      (a, b) => (b.col ?? 0) - (a.col ?? 0),
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

    // Sort children: shorter branches (smaller max col) at the top so
    // leaf nodes cluster near the top of the tree, not the bottom.
    {
      const maxColOf = (treeNode) => {
        const col = treeNode.ref?.col ?? 0;
        if (!treeNode.children || treeNode.children.length === 0) return col;
        return Math.max(col, ...treeNode.children.map(maxColOf));
      };
      const sortTree = (treeNode) => {
        if (treeNode.children && treeNode.children.length > 1) {
          treeNode.children.sort((a, b) => maxColOf(a) - maxColOf(b));
        }
        for (const c of treeNode.children ?? []) sortTree(c);
      };
      sortTree(superRoot);
    }

    const rootH = d3.hierarchy(superRoot);

    // ── Layout: col-based X, D3-tree Y ───────────────────────────────────────
    // X position is determined by the node's `col` value — a visual column
    // index that always increments by 1 for every node so nothing overlaps.
    // `time` holds the correct PAE i-step (shared between placeholders and
    // their merge results) and is shown as the "i=N" label on edges; `col`
    // is purely for rendering separation.
    //
    // Map distinct col values → pixel X
    const allCols = [...new Set(res.allNodes.map(n => n.col ?? 0))].sort((a,b)=>a-b);
    const colToRank = new Map(allCols.map((c,i) => [c,i]));

    const treeLayout = d3.tree().nodeSize([Y_GAP, X_GAP]);
    treeLayout(rootH);

    const nodes = rootH.descendants().filter((d) => d.data.ref);

    const minX = Math.min(...nodes.map((d) => d.x));
    const verticalShift = TOP_PAD - minX + 40;

    // Build layoutPos: X from col rank, Y from D3's vertical placement
    const layoutPos = new Map();
    nodes.forEach((d) => {
      const nodeCol = d.data.ref?.col ?? 0;
      const rank = colToRank.get(nodeCol) ?? 0;
      layoutPos.set(d.data.id, {
        x: LEFT_PAD + rank * X_GAP,
        y: d.x + verticalShift,
      });
    });

    // ── Adjust MIX/OR placeholder groups ──────────────────────────────────
    // Two distinct cases driven by the join type of the placeholders' vertex:
    //
    //   • OR-join: all placeholders converge to a SINGLE merged output. We
    //     symmetrize placeholders + the lone output around the midpoint of
    //     their parents — this produces the "two lanes meeting at a sync
    //     bar" look that matches Structure 6 in the manuscript.
    //
    //   • MIX-join: placeholders feed into TWO outputs (MIX-AND merged with
    //     label "(ε,σ)" and MIX-OR independent with label "σ"). Per
    //     Structure 9 in the manuscript, the MIX-OR output must stay on the
    //     Σ-parent's branch (it represents the Σ-arc firing without waiting
    //     for ε), so we DO NOT pull placeholders to the midpoint. Instead,
    //     each placeholder stays aligned with its parent's Y, the MIX-AND
    //     merged output is placed on the ε-parent's lane (with the Σ-side
    //     placeholder reaching up via a diagonal arrow), and the MIX-OR
    //     output stays aligned with its single (Σ) parent.
    //
    // Done BEFORE the standard shiftSubtreeY centering so AND-merges still
    // pull their merged labeled output between parents afterwards.
    const shiftSubtreeYPre = (nodeId, dy) => {
      const stack = [nodeId];
      const seen = new Set();
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        const p = layoutPos.get(id);
        if (p) layoutPos.set(id, { x: p.x, y: p.y + dy });
        const node = res.allNodes.find(nn => nn.id === id);
        if (!node) continue;
        for (const c of node.children ?? []) stack.push(c.id);
      }
    };

    {
      const groupBuckets = new Map();
      for (const n of res.allNodes) {
        if (!n.isPlaceholder || !n.joinGroupId) continue;
        if (!groupBuckets.has(n.joinGroupId)) groupBuckets.set(n.joinGroupId, []);
        groupBuckets.get(n.joinGroupId).push(n);
      }

      for (const [, placeholders] of groupBuckets) {
        if (placeholders.length < 2) continue;

        // Determine the join type for this placeholder group. All placeholders
        // in a group share the same vertex v (the join vertex), so it suffices
        // to query the joinTypes map with the first placeholder's v.
        const joinV = placeholders[0].v;
        const joinType = res.joinTypes?.get?.(joinV) ?? null;

        // Collect distinct labeled output nodes hanging off these placeholders
        const outputNodes = new Set();
        for (const ph of placeholders) {
          for (const c of ph.children ?? []) outputNodes.add(c);
        }
        const outputs = [...outputNodes];

        if (joinType === "MIX") {
          // ── MIX-join branch ────────────────────────────────────────────
          // Keep each placeholder aligned with its parent's Y (no pull to
          // midpoint). Then position the labeled outputs:
          //   • The MIX-AND merged output (parents.length >= 2, label
          //     "(ε,σ)") aligns with the ε-parent's branch — matching the
          //     manuscript's Structure 9 illustration where the merged
          //     node sits on the ε-arc lane and the Σ-arc placeholder
          //     reaches up via a diagonal arrow.
          //   • The MIX-OR independent output (parents.length == 1, label
          //     "σ") stays aligned with its single placeholder parent's Y —
          //     this is the Σ-arc branch since MIX-OR represents the Σ-arc
          //     firing without waiting for ε.
          //
          // The ε-parent placeholder is identified by walking up to its
          // grandparent (the actual upstream tree node) and inspecting
          // triggerC — placeholders themselves carry triggerC=null.
          const isEpsPlaceholder = (ph) => {
            const upstream = ph.parents?.[0];
            return upstream?.triggerC === "ϵ";
          };

          for (const ph of placeholders) {
            const parent = ph.parents?.[0];
            if (!parent) continue;
            const parentPos = layoutPos.get(parent.id);
            const phPos = layoutPos.get(ph.id);
            if (!parentPos || !phPos) continue;
            // Snap placeholder to parent's Y (preserve x assigned by D3)
            if (Math.abs(parentPos.y - phPos.y) >= 1) {
              layoutPos.set(ph.id, { x: phPos.x, y: parentPos.y });
            }
          }

          // Identify the ε-parent placeholder for this MIX group (used to
          // align the MIX-AND merged output's branch).
          const epsPh = placeholders.find(isEpsPlaceholder) ?? placeholders[0];
          const epsPhY = layoutPos.get(epsPh.id)?.y;

          for (const out of outputs) {
            const outPos = layoutPos.get(out.id);
            if (!outPos) continue;
            const parents = out.parents ?? [];
            if (parents.length === 0) continue;

            let targetY;
            if (parents.length === 1) {
              // MIX-OR independent: align with its lone (Σ) parent
              const pp = layoutPos.get(parents[0].id);
              if (!pp) continue;
              targetY = pp.y;
            } else {
              // MIX-AND merged: align with the ε-parent's branch so the
              // merged node sits on the ε-lane and the Σ-placeholder feeds
              // it via a diagonal edge (matches Structure 9 illustration).
              if (typeof epsPhY !== "number") continue;
              targetY = epsPhY;
            }

            const dy = targetY - outPos.y;
            if (Math.abs(dy) >= 1) {
              shiftSubtreeYPre(out.id, dy);
            }
          }
        } else {
          // ── OR-join / AND-join branch ──────────────────────────────────
          // Each placeholder stays aligned with its own parent's Y so that
          // every branch is a straight horizontal line. The sync bar between
          // placeholders is allowed to be diagonal — that's fine. We do NOT
          // pull placeholders or outputs toward a shared midpoint, which is
          // what was creating the diamond / chevron shape.
          for (const ph of placeholders) {
            const parent = ph.parents?.[0];
            if (!parent) continue;
            const parentPos = layoutPos.get(parent.id);
            const phPos    = layoutPos.get(ph.id);
            if (!parentPos || !phPos) continue;
            if (Math.abs(parentPos.y - phPos.y) >= 1) {
              layoutPos.set(ph.id, { x: phPos.x, y: parentPos.y });
            }
          }
          // Snap each output node to its placeholder parent's Y as well
          for (const out of outputs) {
            const outPos = layoutPos.get(out.id);
            if (!outPos || (out.parents?.length ?? 0) !== 1) continue;
            const phPos = layoutPos.get(out.parents[0].id);
            if (!phPos) continue;
            const dy = phPos.y - outPos.y;
            if (Math.abs(dy) >= 1) shiftSubtreeYPre(out.id, dy);
          }
        }
      }
    }

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

    // ── Spread overlapping nodes (after AND-join centering) ─────────────────
    // Run AFTER centering so that node positions are already in their final
    // pre-render locations. Nodes at the same (x, y) get spread vertically.
    // We use shiftSubtreeY to drag each node's children along with it so
    // the whole sub-branch moves, not just the single node.
    {
      const MIN_SEP = Math.max(60, Y_GAP / 2);
      let changed = true;
      let iterations = 0;
      while (changed && iterations++ < 20) {
        changed = false;
        // Bucket by x column, find nodes that are too close vertically
        const byX = new Map();
        for (const [id, p] of layoutPos) {
          const col = Math.round(p.x);
          if (!byX.has(col)) byX.set(col, []);
          byX.get(col).push({ id, y: p.y });
        }
        for (const [, nodesInCol] of byX) {
          nodesInCol.sort((a, b) => a.y - b.y);
          for (let i = 1; i < nodesInCol.length; i++) {
            const prev = nodesInCol[i - 1];
            const curr = nodesInCol[i];
            const gap = curr.y - prev.y;
            if (gap < MIN_SEP) {
              const needed = MIN_SEP - gap;
              // Push current node and its subtree down by `needed`
              shiftSubtreeY(curr.id, needed);
              curr.y += needed; // update local snapshot for next comparison
              changed = true;
            }
          }
        }
      }
    }

    // ── Re-center tree vertically ──────────────────────────────────────────
    // The overlap resolution only pushes nodes downward, which causes a
    // cascading drift that leaves the top of the tree sparse and clusters
    // everything toward the bottom. Shift the whole layout so the topmost
    // node sits at TOP_PAD.
    {
      const allYs = [...layoutPos.values()].map(p => p.y);
      if (allYs.length > 0) {
        const minY = Math.min(...allYs);
        const shift = TOP_PAD - minY;
        if (Math.abs(shift) > 1) {
          for (const [id, p] of layoutPos) {
            layoutPos.set(id, { x: p.x, y: p.y + shift });
          }
        }
      }
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

    // ── Draw synchronization bars ─────────────────────────────────────────────
    // Rule: draw a sync bar ONLY when placeholder nodes exist for a group.
    // Placeholder nodes are created exclusively for OR-joins and MIX-joins
    // (via insertJoinPlaceholders). AND-join merged nodes have no placeholders,
    // so they never get a sync bar — automatically, with no special-case code.
    //
    // The bar does not need to be perfectly vertical — we draw straight
    // segments between consecutive placeholder centres (top to bottom),
    // which means the bar naturally follows wherever the layout placed those
    // placeholders.
    {
      // Collect ONLY placeholder nodes, grouped by their joinGroupId.
      const groupBuckets = new Map();
      for (const n of res.allNodes) {
        if (!this.#isPlaceholder(n)) continue;   // skip non-placeholders (incl. AND-join nodes)
        const gid = n.joinGroupId;
        if (!gid) continue;
        const pos = finalPos.get(n.id);
        if (!pos) continue;
        if (!groupBuckets.has(gid)) groupBuckets.set(gid, []);
        groupBuckets.get(gid).push(pos);
      }

      for (const [, positions] of groupBuckets) {
        if (positions.length < 2) continue;

        // Sort top to bottom by yMid so segments go in the right direction
        const sorted = [...positions].sort((a, b) => a.yMid - b.yMid);

        // Draw one segment between each consecutive pair of placeholders
        for (let k = 0; k < sorted.length - 1; k++) {
          const p1 = sorted[k];
          const p2 = sorted[k + 1];

          // Use the horizontal centre of each placeholder node
          const x1 = p1.x + (p1.w ?? 0) / 2;
          const x2 = p2.x + (p2.w ?? 0) / 2;

          const bar = document.createElementNS(SVG_NS, "line");
          bar.setAttribute("x1", String(x1));
          bar.setAttribute("y1", String(p1.yMid));
          bar.setAttribute("x2", String(x2));
          bar.setAttribute("y2", String(p2.yMid));
          bar.setAttribute("stroke", "currentColor");
          bar.setAttribute("stroke-width", "1.6");
          bar.setAttribute("opacity", "0.6");
          edgeGroup.appendChild(bar);
        }
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
      // const PATH_COLORS = [
      //   "#3a81de", "#4caf50", "#ff9800", "#9c27b0",
      //   "#e91e63", "#00bcd4", "#795548", "#607d8b",
      // ];
      const PATH_COLORS = ProcessColorRegistry.hasRegistrations
      ? ProcessColorRegistry.getAllColors()
      : ["#3a81de","#4caf50","#ff9800","#9c27b0","#e91e63","#00bcd4","#795548","#607d8b"];

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