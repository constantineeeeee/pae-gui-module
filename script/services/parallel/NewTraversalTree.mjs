
import { parseRDLT } from "../convert/rdlt2pn/modules/parser.js";

const EPS = "ϵ";


function buildAdjacency(edges) {
  const out = new Map();
  const inc = new Map();
  edges.forEach((e, idx) => {
    const { from, to } = e;
    if (!out.has(from)) out.set(from, []);
    if (!inc.has(to)) inc.set(to, []);
    out.get(from).push({ ...e, __idx: idx });
    inc.get(to).push({ ...e, __idx: idx });
  });
  return { out, inc };
}