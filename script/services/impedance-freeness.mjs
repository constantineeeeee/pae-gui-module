// import { mapGUIModelToSoundness } from "./soundness/soundness-service.mjs";
// import { VertexType } from "./models/VertexType.js";
import {
  isInbridge,
  isOutbridge,
  buildArcMap,
  buildRBSMatrix,
  buildVertexMap,
} from "../utils.mjs";
import { Vertex } from "./soundness/models/Vertex.js";
import { VertexType } from "./soundness/models/VertexType.js";
import { Edge } from "./soundness/models/Edge.js";
import { ResetBoundSubsystem } from "./soundness/models/ResetBoundSubsystem.js";
import { InputRDLT } from "./soundness/utils/input-rdlt.mjs";
// import { Activity } from "./models/Activity.js";
import { Graph } from "./soundness/models/Graph.js";
// import { Soundness } from "./utils/soundness.js";
// import { GraphOperations } from "./utils/graph-operations.js";
import { ProcessR1 } from "./soundness/utils/create_r1.mjs";
import { processR2 } from "./soundness/utils/create_r2.mjs";
// import { utils } from "./utils/rdlt-utils.mjs";
import { CASExtractor } from "./soundness/utils/cas-extractor.js";

export function verifyImpedanceFreeness(simpleModel, source, sink) {
    console.log(source, sink);
  const arcMap = buildArcMap(simpleModel.arcs);
  const vertexMap = buildVertexMap(simpleModel.components);

  const inVertices = getInBridges(simpleModel, arcMap, vertexMap);
  const outVertices = getOutBridges(simpleModel, arcMap, vertexMap);

  //   console.log("simpleModel:", simpleModel);
  //   console.log("inVertices:", inVertices);
  //   console.log("outVertices:", outVertices);

  const inputRDLT = new InputRDLT(simpleModel, inVertices, outVertices);
  const evsa = inputRDLT.evaluate();

  let R2;

  if (inputRDLT.centersList.length === 0) {
    R2 = [];
  } else {
    R2 = processR2(evsa.Rs);
  }

  const R1 = ProcessR1(
    inputRDLT.model.arcs,
    evsa.R1.R1,
    inputRDLT.centersList,
    inputRDLT.in_list,
    inputRDLT.out_list,
    R2,
  );

  // console.log("R1:", R1);
  // console.log("R2:", R2);
  // console.log("EVSA:", evsa);

  const { rdltGraph, r2Graphs, r1Graph } = mapToGraphs(inputRDLT, R1, R2);
  const sourceVertex = rdltGraph.vertices.find(
    (v) => v.id === source || v.id === String(source),
  );
  const sinkVertex = rdltGraph.vertices.find(
    (v) => v.id === sink || v.id === String(sink),
  );

  let R2Graph = null;
  if (r2Graphs.length > 0) {
    R2Graph = new Graph();
    for (const { graph } of r2Graphs) {
      graph.vertices.forEach((v) => {
        if (!R2Graph.vertices.some((e) => e.id === v.id)) R2Graph.addVertex(v);
      });
      graph.edges.forEach((e) => {
        if (
          !R2Graph.edges.some(
            (ex) => ex.from.id === e.from.id && ex.to.id === e.to.id,
          )
        )
          R2Graph.addEdge(e);
      });
    }
  }

  //   console.log("rdltGraph:", rdltGraph);
  //   console.log("r2Graphs:", r2Graphs);
  //   console.log("r1Graph:", r1Graph);

  let combinedEvsa;
  if (r2Graphs.length > 0) {
    combinedEvsa = [r1Graph, ...r2Graphs.map((item) => item.graph)];
  } else {
    combinedEvsa = [r1Graph];
  }

  //   console.log("Combined EVSA Graphs:", combinedEvsa);

  const casSet = CASExtractor.extractAllCASWithDetails(
    rdltGraph,
    R2Graph,
    r1Graph,
    source,
    sink,
  );
  console.log("Extracted CAS:", casSet);

  let pass = true;

  return {
    title: "Impedance-Freeness",
    instances: [
      {
        name: "Main Model",
        evaluation: {
          conclusion: {
            pass,
            title: pass ? "Impedance-Free" : "Not Impedance-Free",
            description: ``,
          },
          //   criteria,
          violating: { arcs: [], vertices: [] },
        },
      },
    ],
  };
}

function getInBridges(model, arcMap, vertexMap) {
  //   console.log("arcMap:", arcMap);
  //   console.log("vertexMap:", vertexMap);

  const rbsMatrix = buildRBSMatrix(vertexMap, model.arcs);

  //   console.log("rbsMatrix:", rbsMatrix);

  const inBridgesUIDs = new Set();
  const inBridges = new Set(); // Set to collect "fromVertexIdentifier, toVertexIdentifier" strings

  for (const arc of model.arcs) {
    if (isInbridge(arc.uid, arcMap, rbsMatrix)) {
      inBridgesUIDs.add(arc.uid); // Collect UIDs of in-bridge arcs
    }
  }

  //   console.log("UIDs of in-bridge arcs:", inBridgesUIDs);

  // Map UIDs to their corresponding "fromVertexIdentifier, toVertexIdentifier" and add to inBridges
  for (const uid of inBridgesUIDs) {
    const arc = arcMap[uid]; // Retrieve the arc using the UID
    const fromVertex = vertexMap[arc.fromVertexUID]; // Retrieve the "from" vertex
    const toVertex = vertexMap[arc.toVertexUID]; // Retrieve the "to" vertex

    if (fromVertex && toVertex) {
      const entry = `${fromVertex.identifier}, ${toVertex.identifier}`;
      inBridges.add(entry); // Add the formatted string to the inBridges set
    }
  }

  return inBridges;
}

function getOutBridges(model, arcMap, vertexMap) {
  const rbsMatrix = buildRBSMatrix(vertexMap, model.arcs);
  const outBridgesUIDs = new Set();
  const outBridges = new Set(); // Set to collect "fromVertexIdentifier, toVertexIdentifier" strings

  for (const arc of model.arcs) {
    if (isOutbridge(arc.uid, arcMap, rbsMatrix)) {
      outBridgesUIDs.add(arc.uid); // Collect UIDs of out-bridge arcs
    }
  }

  //   console.log("UIDs of out-bridge arcs:", outBridgesUIDs);

  // Map UIDs to their corresponding "fromVertexIdentifier, toVertexIdentifier" and add to outBridges
  for (const uid of outBridgesUIDs) {
    const arc = arcMap[uid]; // Retrieve the arc using the UID
    const fromVertex = vertexMap[arc.fromVertexUID]; // Retrieve the "from" vertex
    const toVertex = vertexMap[arc.toVertexUID]; // Retrieve the "to" vertex

    if (fromVertex && toVertex) {
      const entry = `${fromVertex.identifier}, ${toVertex.identifier}`;
      outBridges.add(entry); // Add the formatted string to the outBridges set
    }
  }

  return outBridges;
}

function mapToGraphs(rdlt, R2, R1) {
  const rdltGraph = new Graph();
  let r2Graphs; // Array to hold multiple R2 graphs
  const r1Graph = new Graph();

  // Map RDLT to Graph
  if (rdlt && rdlt.model && rdlt.model.components && rdlt.model.arcs) {
    console.log("Mapping RDLT to Graph...");

    // Add vertices with UIDs
    rdlt.model.components.forEach((component) => {
      const vertex = new Vertex(
        component.uid, // Use the UID from the original model
        VertexType.ENTITY_OBJECT,
        {}, // Additional attributes can be added here
        component.identifier || "", // Use the identifier
      );
      rdltGraph.addVertex(vertex);
    });

    // Add edges with UIDs
    rdlt.model.arcs.forEach((arc) => {
      const fromVertex = rdltGraph.vertices.find(
        (v) => v.id === arc.fromVertexUID,
      );
      const toVertex = rdltGraph.vertices.find((v) => v.id === arc.toVertexUID);
      const edge = new Edge(
        arc.uid, // Use the UID from the original model
        fromVertex,
        toVertex,
        arc.C,
        arc.L,
        [], // Additional attributes can be added here
      );
      rdltGraph.addEdge(edge);
    });

    // Map Reset-Bound Subsystems (RBS)
    if (rdlt.centersList && rdlt.centersList.length > 0) {
      console.log("Mapping Reset-Bound Subsystems...");
      rdlt.centersList.forEach((centerId) => {
        const centerVertex = rdltGraph.vertices.find(
          (v) => v.id === centerId.uid,
        );
        if (!centerVertex) {
          console.error(
            `Center vertex with ID ${centerId.uid} not found in the graph.`,
          );
          return;
        }

        // Get members of the RBS (vertices connected to the center)
        const members = rdltGraph.edges
          .filter((edge) => edge.from.id === centerId.uid)
          .map((edge) => (edge.from.id === centerId.uid ? edge.to : edge.from));

        // Get in-bridges (arcs in in_list connected to members)
        const inBridges = rdlt.in_list
          .map((entry) => {
            const [fromId, toId] = entry.split(", ");
            const fromVertex = rdltGraph.vertices.find(
              (v) => v.name === fromId,
            );
            const toVertex = rdltGraph.vertices.find((v) => v.name === toId);

            // Find the edge in the graph
            return rdltGraph.edges.find(
              (edge) => edge.from === fromVertex && edge.to === toVertex,
            );
          })
          .filter(
            (edge) =>
              edge && (members.includes(edge.to) || centerVertex === edge.to),
          );

        // Get out-bridges (arcs in out_list connected to members)
        const outBridges = rdlt.out_list
          .map((entry) => {
            const [fromId, toId] = entry.split(", ");
            const fromVertex = rdltGraph.vertices.find(
              (v) => v.name === fromId,
            );
            const toVertex = rdltGraph.vertices.find((v) => v.name === toId);
            return rdltGraph.edges.find(
              (edge) => edge.from === fromVertex && edge.to === toVertex,
            );
          })
          .filter((edge) => edge && members.includes(edge.from));

        // Create and add the ResetBoundSubsystem
        const resetBoundSubsystem = new ResetBoundSubsystem(
          centerVertex,
          members,
          inBridges,
          outBridges,
        );
        rdltGraph.addResetBoundSubsystem(resetBoundSubsystem);
      });
    }
  }

  // Map R2 to Graphs
  if (R2 && R2.length > 0) {
    console.log("Mapping R2 to Graphs...");

    // Group R2 entries by r_number
    const r2Groups = R2.reduce((groups, arc) => {
      const rNumber = arc["r-id"].split("-")[0]; // Extract r_number from r-id
      if (!groups[rNumber]) {
        groups[rNumber] = [];
      }
      groups[rNumber].push(arc);
      return groups;
    }, {});

    // Create a Graph for each group
    r2Graphs = Object.entries(r2Groups).map(([rNumber, arcs]) => {
      const graph = new Graph();
      console.log(`Creating Graph for R2 group: ${rNumber}`);

      arcs.forEach((arc) => {
        const [fromId, toId] = arc.arc.split(", ");
        const fromVertex =
          graph.vertices.find((v) => v.id === fromId) ||
          new Vertex(fromId, VertexType.ENTITY_OBJECT, {}, fromId);
        const toVertex =
          graph.vertices.find((v) => v.id === toId) ||
          new Vertex(toId, VertexType.ENTITY_OBJECT, {}, toId);

        // Add vertices if not already present
        if (!graph.vertices.find((v) => v.id === fromId))
          graph.addVertex(fromVertex);
        if (!graph.vertices.find((v) => v.id === toId))
          graph.addVertex(toVertex);

        const edge = new Edge(
          arc["r-id"], // Use the UID from the processed R2
          fromVertex,
          toVertex,
          arc["c-attribute"],
          parseInt(arc["l-attribute"], 10),
          [],
        );
        graph.addEdge(edge);
      });

      return { rNumber, graph };
    });

    console.log("Mapped R2 Graphs:", r2Graphs);
  } else {
    r2Graphs = [];
  }

  // Map R1 to Graph
  if (R1 && R1.length > 0) {
    console.log("Mapping R1 to Graph...");
    R1.forEach((arc, index) => {
      const [fromId, toId] = arc.arc.split(", ");
      const fromVertex =
        r1Graph.vertices.find((v) => v.id === fromId) ||
        new Vertex(fromId, VertexType.ENTITY_OBJECT, {}, fromId);
      const toVertex =
        r1Graph.vertices.find((v) => v.id === toId) ||
        new Vertex(toId, VertexType.ENTITY_OBJECT, {}, toId);

      if (!r1Graph.vertices.find((v) => v.id === fromId))
        r1Graph.addVertex(fromVertex);
      if (!r1Graph.vertices.find((v) => v.id === toId))
        r1Graph.addVertex(toVertex);

      const edge = new Edge(
        arc["r-id"],
        fromVertex,
        toVertex,
        arc["c-attribute"],
        parseInt(arc["l-attribute"], 10),
        [],
      );
      r1Graph.addEdge(edge);
    });
  }

  return { rdltGraph, r2Graphs, r1Graph };
}
