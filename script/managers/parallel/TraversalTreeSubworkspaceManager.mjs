import { generateUniqueID } from "../../utils.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout Constants
const LEFT_PAD = 80;
const TOP_PAD = 60;
const X_GAP = 320;
const Y_GAP = 150;
const BOX_PAD_X = 10;
const BOX_PAD_Y = 8;
var t = 1;

export default class TraversalTreeViewerManager {
  context;
  id;

  #snapshot;
  #subworkspace;
  #svg;
  #root;
  #drawnNodes = new Set();

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
    console.log("Traversal Tree Result:", res);

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
    this.#drawnNodes = new Set();
    const make = (tag) => document.createElementNS(SVG_NS, tag);

    const n = res.allNodes[0];
    console.log("node id:", n.id);
    console.log("node v:", n.v);
    console.log("node S:", n.S);
    console.log("node time:", n.time);
    console.log(
      "children ids:",
      (n.children ?? []).map((c) => c.id),
    );
    console.log(
      "parent ids:",
      (n.parents ?? []).map((p) => p.id),
    );

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

    const firstNode = res.allNodes.find(
      (n) => !n.parents || n.parents.length === 0,
    );
    if (firstNode) {
      this.#renderDispatch(firstNode, res.joinTypes, LEFT_PAD, TOP_PAD);
    }

    // Resize SVG to fit content
    const bbox = this.#svg.getBBox();
    const padding = 100;

    const contentWidth = bbox.x + bbox.width + padding;
    const contentHeight = bbox.y + bbox.height + padding;

    const clientWidth = this.#root.clientWidth || 800;
    const clientHeight = this.#root.clientHeight || 600;

    this.#svg.style.width = `${Math.max(contentWidth, clientWidth)}px`;
    this.#svg.style.height = `${Math.max(contentHeight, clientHeight)}px`;
  }

  #renderDispatch(node, joinTypes, x, y) {
    const children = node.children ?? [];

    if (children.length === 0) return;

    if (children.length === 1) {
      const child = children[0];
      const isJoin = (child.parents ?? []).length > 1;

      if (isJoin) {
        const joinType = joinTypes.get(child.v) ?? "OR";

        if (joinType === "AND") {
          this.#renderNormalTraverse(node, [child], x, y, child.time);
          if (!this.#drawnNodes.has(child.id)) {
            this.#drawnNodes.add(child.id);
            this.#renderDispatch(child, joinTypes, x + X_GAP, y);
          }
        }
      } else {
        this.#renderNormalTraverse(node, [child], x, y, child.time);
        this.#renderDispatch(child, joinTypes, x + X_GAP, y);
      }
    } else {
      const topY = y;
      const bottomY = y + (children.length - 1) * Y_GAP;
      const midY = (topY + bottomY) / 2;

      this.#renderSplit(node, children, x, y, t);

      let childY = y;
      for (const child of children) {
        const grandchild = (child.children ?? [])[0];
        const isANDJoin =
          grandchild &&
          (grandchild.parents ?? []).length > 1 &&
          joinTypes.get(grandchild.v) === "AND";

        if (isANDJoin) {
          this.#renderANDJoin(child, grandchild, x + X_GAP, childY, midY);
        } else {
          this.#renderDispatch(child, joinTypes, x + X_GAP, childY);
        }

        childY += Y_GAP;
      }

      const joinNode = children
        .flatMap((c) => c.children ?? [])
        .find((c) => (c.parents ?? []).length > 1);

      if (joinNode && joinTypes.get(joinNode.v) === "AND") {
        if (!this.#drawnNodes.has(joinNode.id)) {
          this.#drawnNodes.add(joinNode.id);
          this.#drawNodeOnly(joinNode, x + X_GAP * 2, midY);
          this.#renderDispatch(joinNode, joinTypes, x + X_GAP * 2, midY);
        }
      }
    }
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

  // STRUCTURE TEMPLATES

  #renderNormalTraverse(node, children, x, y, currentTime) {
    const make = (tag) => document.createElementNS(SVG_NS, tag);
    const sToString = (S) => `S([${(S ?? []).join(",")}])`;

    // DRAW NODE
    const drawNode = (n, x, y, hideS = false) => {
      const g = make("g");
      g.setAttribute("transform", `translate(${x},${y})`);

      const title = make("text");
      title.setAttribute("font-size", "14");
      title.setAttribute("font-weight", "600");
      title.setAttribute("fill", "currentColor");
      title.textContent = n.v;
      g.appendChild(title);

      if (!hideS) {
        const sub = make("text");
        sub.setAttribute("y", "18");
        sub.setAttribute("font-size", "12");
        sub.setAttribute("opacity", "0.85");
        sub.setAttribute("fill", "currentColor");
        sub.textContent = sToString(n.S);
        g.appendChild(sub);
      }

      this.#svg.appendChild(g);
      return g.getBBox();
    };

    const parentBBox = drawNode(node, x, y);
    const child = children[0];

    const fromX = x + parentBBox.width + BOX_PAD_X;
    const fromY = y + parentBBox.height / 2;

    x += X_GAP;

    const childBBox = drawNode(child, x, y);

    const toX = x;
    const toY = y + childBBox.height / 2;

    // Draw edge (straight line for now)
    const path = make("path");
    const d = `M ${fromX} ${fromY} L ${toX} ${toY}`;
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-width", "2.2");
    this.#svg.appendChild(path);

    const text = make("text");
    const midX = (fromX + toX) / 2;
    const midY = (fromY + toY) / 2;

    text.setAttribute("x", String(midX));
    text.setAttribute("y", String(midY - 10));
    text.setAttribute("font-size", "12");
    text.setAttribute("font-weight", "700");
    text.setAttribute("fill", "#d11"); // red like the image
    text.setAttribute("text-anchor", "middle");

    text.textContent = `t=${currentTime}`;
    t += 1;
    this.#svg.appendChild(text);
  }
  #renderSplit(node, children, x, y, currentTime) {
    const make = (tag) => document.createElementNS(SVG_NS, tag);
    const sToString = (S) => `S([${(S ?? []).join(",")}])`;

    const drawNode = (n, nx, ny) => {
      const g = make("g");
      g.setAttribute("transform", `translate(${nx},${ny})`);

      const title = make("text");
      title.setAttribute("font-size", "14");
      title.setAttribute("font-weight", "600");
      title.setAttribute("fill", "currentColor");
      title.textContent = n.v;
      g.appendChild(title);

      const sub = make("text");
      sub.setAttribute("y", "18");
      sub.setAttribute("font-size", "12");
      sub.setAttribute("opacity", "0.85");
      sub.setAttribute("fill", "currentColor");
      sub.textContent = sToString(n.S);
      g.appendChild(sub);

      this.#svg.appendChild(g);
      return g.getBBox();
    };

    const totalHeight = (children.length - 1) * Y_GAP;

    const centeredY = y + totalHeight / 2;
    const parentBBox = drawNode(node, x, centeredY);

    const fromX = x + parentBBox.width + BOX_PAD_X;
    const fromY = centeredY + parentBBox.height / 2;

    const childX = x + X_GAP;
    let childY = y;

    for (const child of children) {
      const childBBox = drawNode(child, childX, childY);

      const toX = childX;
      const toY = childY + childBBox.height / 2;

      const path = make("path");
      const d = `M ${fromX} ${fromY} L ${toX} ${toY}`;
      path.setAttribute("d", d);
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "2.2");
      this.#svg.appendChild(path);

      const text = make("text");
      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2;
      text.setAttribute("x", String(midX));
      text.setAttribute("y", String(midY - 10));
      text.setAttribute("font-size", "12");
      text.setAttribute("font-weight", "700");
      text.setAttribute("fill", "#d11");
      text.setAttribute("text-anchor", "middle");
      text.textContent = `t=${currentTime}`;
      this.#svg.appendChild(text);

      t += 1;
      childY += Y_GAP;
    }
  }

  #renderANDJoin(node, children) {}
}
