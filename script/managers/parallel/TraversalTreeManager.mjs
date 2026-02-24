// script/managers/parallel/TraversalTreeManager.mjs
import { generateTraversalTreeFromJSON } from "../../services/parallel/NewTraversalTree.mjs";

export default class TraversalTreeManager {
  constructor(context) {
    this.context = context;
  }

  run(visualModelSnapshot, opts = {}) {
    const simpleModel = visualModelSnapshot.toSimpleModel();

    const jsonInput = {
      vertices: simpleModel.components.map(v => ({
        id: v.identifier,
        type: v.type.charAt(0),
        label: "",
        M: v.isRBSCenter ? 1 : 0,
      })),
      edges: simpleModel.arcs.map(edge => ({
        from: simpleModel.components.find(v => v.uid === edge.fromVertexUID).identifier,
        to: simpleModel.components.find(v => v.uid === edge.toVertexUID).identifier,
        C: edge.C === "" ? "ϵ" : edge.C,
        L: edge.L,
      })),
    };

    console.log("Generated JSON for Traversal Tree:", jsonInput);

    return generateTraversalTreeFromJSON(jsonInput, opts);
  }
}