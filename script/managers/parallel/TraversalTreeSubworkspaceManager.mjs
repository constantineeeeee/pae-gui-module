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

    // ── DEBUG: log all node positions after D3 layout ─────────────────────────
    console.log("[TT DEBUG] Total allNodes:", res.allNodes.length, "D3 nodes:", nodes.length);
    for (const n of res.allNodes) {
      const pos = layoutPos.get(n.id);
      const label = n.isPlaceholder ? `(${n.v})` : `${n.v} S(${JSON.stringify(n.S)})`;
      console.log(`[TT NODE] id=${n.id} v=${n.v} placeholder=${!!n.isPlaceholder} ` +
        `parents=[${(n.parents??[]).map(p=>p.id).join(",")}] ` +
        `children=[${(n.children??[]).map(c=>c.id).join(",")}] ` +
        `pos=${pos ? Math.round(pos.x)+","+Math.round(pos.y) : "MISSING"} ` +
        `label="${label}"`);
    }

    // ── DEBUG: log allNodes from algorithm ───────────────────────────────────
    console.log("[TT DEBUG] allNodes from algorithm:");
    for (const n of res.allNodes) {
      console.log(`  [ALG NODE] id=${n.id} v=${n.v} S=${JSON.stringify(n.S)} ` +
        `triggerC=${n.triggerC} isPlaceholder=${!!n.isPlaceholder} ` +
        `joinGroupId=${n.joinGroupId ?? "none"} ` +
        `parents=[${(n.parents??[]).map(p=>p.id).join(",")}] ` +
        `children=[${(n.children??[]).map(c=>c.id).join(",")}]`);
    }

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
          // ── OR-join branch (default symmetrization) ────────────────────
          // Compute the midpoint y of all placeholders' parents
          const parentYs = [];
          for (const ph of placeholders) {
            for (const p of ph.parents ?? []) {
              const py = layoutPos.get(p.id)?.y;
              if (typeof py === "number") parentYs.push(py);
            }
          }
          if (parentYs.length < 2) continue;
          const midY = parentYs.reduce((a, b) => a + b, 0) / parentYs.length;

          // Symmetrically distribute placeholders around midY
          // (preserving their original ordering by current y)
          placeholders.sort((a, b) => {
            const ay = layoutPos.get(a.id)?.y ?? 0;
            const by = layoutPos.get(b.id)?.y ?? 0;
            return ay - by;
          });
          const phSpread = Math.max(80, Y_GAP * 0.6);
          const N_ph = placeholders.length;
          placeholders.forEach((ph, idx) => {
            const targetY = midY + (idx - (N_ph - 1) / 2) * phSpread;
            const cur = layoutPos.get(ph.id);
            if (!cur) return;
            const dy = targetY - cur.y;
            if (Math.abs(dy) >= 1) {
              // Move just the placeholder (children will be repositioned below)
              layoutPos.set(ph.id, { x: cur.x, y: targetY });
            }
          });

          // Symmetrically distribute output nodes around midY
          outputs.sort((a, b) => {
            const ay = layoutPos.get(a.id)?.y ?? 0;
            const by = layoutPos.get(b.id)?.y ?? 0;
            return ay - by;
          });
          const outSpread = Math.max(80, Y_GAP * 0.6);
          const N_out = outputs.length;
          outputs.forEach((out, idx) => {
            const targetY = midY + (idx - (N_out - 1) / 2) * outSpread;
            const cur = layoutPos.get(out.id);
            if (!cur) return;
            const dy = targetY - cur.y;
            if (Math.abs(dy) >= 1) {
              shiftSubtreeYPre(out.id, dy);
            }
          });
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

    // ── DEBUG: log final positions after all adjustments ────────────────────
    console.log("[TT DEBUG] Final layoutPos after adjustments:");
    for (const [id, pos] of layoutPos) {
      const n = res.allNodes.find(n => n.id === id);
      const label = n ? (n.isPlaceholder ? `(${n.v})` : `${n.v} S(${JSON.stringify(n.S)})`) : "?";
      console.log(`  [FINAL POS] id=${id} x=${Math.round(pos.x)} y=${Math.round(pos.y)} label="${label}"`);
    }

    // Check for overlapping positions
    const posGroups = new Map();
    for (const [id, pos] of layoutPos) {
      const key = `${Math.round(pos.x)},${Math.round(pos.y)}`;
      if (!posGroups.has(key)) posGroups.set(key, []);
      posGroups.get(key).push(id);
    }
    for (const [key, ids] of posGroups) {
      if (ids.length > 1) {
        const labels = ids.map(id => {
          const n = res.allNodes.find(n => n.id === id);
          return n ? `${n.id}:${n.v}` : id;
        });
        console.warn(`[TT OVERLAP] Position ${key} has ${ids.length} nodes: ${labels.join(", ")}`);
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