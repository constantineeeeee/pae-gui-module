import {
  buildArcTagElement,
  buildElement,
  buildVertexTagElement,
} from "../../../utils.mjs";
import { VerificationsResultManager } from "../VerificationsResultManager.mjs";

export default class VERResultTabManager {
  /** @type {VerificationsResultManager} */
  #parentManager;

  /** @type {HTMLDivElement} */
  #rootElement;

  /**
   *
   * @type {{
   *   conclusion: {
   *       root: HTMLDivElement,
   *       title: HTMLDivElement,
   *       description: HTMLDivElement,
   *   },
   *   criteria: {
   *      section: HTMLDivElement,
   *      table: HTMLTableElement,
   *   },
   *   theoreticalNotes: {
   *      section: HTMLDivElement,
   *      content: HTMLDivElement,
   *   },
   *   violatingArcs: {
   *      section: HTMLDivElement,
   *      table: HTMLTableElement,
   *   },
   *   violatingVertices: {
   *      section: HTMLDivElement,
   *      table: HTMLTableElement,
   *   }
   * }}
   */
  #view = {
    conclusion: { root: null, title: null, description: null },
    criteria: { section: null, table: null },
    theoreticalNotes: { section: null, content: null },
    violatingArcs: { section: null, table: null },
    violatingVertices: { section: null, table: null },
  };

  constructor(parentManager, rootElement) {
    this.#parentManager = parentManager;
    this.#rootElement = rootElement;

    this.#initializeView();
  }

  #initializeView() {
    this.#view.conclusion.root =
      this.#rootElement.querySelector(".status-chip");
    this.#view.conclusion.title =
      this.#rootElement.querySelector(".status-title");
    this.#view.conclusion.description = this.#rootElement.querySelector(
      ".status-description"
    );

    this.#view.criteria.section = this.#rootElement.querySelector(
      `[data-ver-section="criteria"]`
    );
    this.#view.criteria.table = this.#rootElement.querySelector(
      `[data-ver-section="criteria"] table`
    );
    this.#view.theoreticalNotes.section = this.#rootElement.querySelector(
      `[data-ver-section="theoretical-notes"]`
    );
    this.#view.theoreticalNotes.content = this.#rootElement.querySelector(
      `[data-ver-section="theoretical-notes"] .theoretical-notes-content`
    );
    this.#view.violatingVertices.section = this.#rootElement.querySelector(
      `[data-ver-section="v-vertices"]`
    );
    this.#view.violatingVertices.table = this.#rootElement.querySelector(
      `[data-ver-section="v-vertices"] table`
    );
    this.#view.violatingArcs.section = this.#rootElement.querySelector(
      `[data-ver-section="v-arcs"]`
    );
    this.#view.violatingArcs.table = this.#rootElement.querySelector(
      `[data-ver-section="v-arcs"] table`
    );
  }

  /**
   *
   * @param {{
   *      name,
   *      evaluation: {
   *          conclusion: {
   *              pass,
   *              title,
   *              description
   *          },
   *          criteria: {
   *              pass, description
   *          }[],
   *          violating: {
   *              arcs: number[],
   *              vertices: number[]
   *          },
   *          violatingRemarks: {
   *              vertices: {[vertexUID: number]: string}
   *          },
   *      },
   *      model: {
   *          vertices: number[],
   *          arcs: number[]
   *      }
   * }} instance
   */
  displayInstanceResult(instance) {
    const {
      name,
      evaluation: { conclusion, criteria, violating, violatingRemarks },
    } = instance;

    // Setup conclusion chip
    if (conclusion.pass) {
      this.#view.conclusion.root.classList.add("passed");
    } else {
      this.#view.conclusion.root.classList.remove("passed");
    }

    this.#view.conclusion.title.innerHTML = conclusion.title;
    this.#view.conclusion.description.innerHTML = conclusion.description;

    // Setup criteria
    const criteriaSection = this.#view.criteria.section;
    const criteriaTableBody = this.#view.criteria.table.querySelector("tbody");
    criteriaTableBody.innerHTML = "";
    if (criteria && criteria.length > 0) {
      criteriaSection.classList.remove("hidden");
      for (const criterion of criteria) {
        const criteriaRow = buildElement("tr", { classname: "criteria-row" }, [
          buildElement("td", {}, [
            buildElement("i", {
              classname: "fas fa-" + (criterion.pass ? "check" : "close"),
            }),
          ]),
          buildElement("td", {}, [criterion.description]),
        ]);

        criteriaTableBody.appendChild(criteriaRow);
      }
    } else {
      criteriaSection.classList.add("hidden");
    }

    // Setup theoretical notes
    const theoreticalNotesSection = this.#view.theoreticalNotes.section;
    const theoreticalNotesContent = this.#view.theoreticalNotes.content;
    theoreticalNotesContent.innerHTML = "";
    
    // Check if this instance has theoretical notes (added by soundness-service for lazy soundness)
    const theoreticalNote = instance.evaluation?.theoreticalNote;
    if (theoreticalNote) {
      theoreticalNotesSection.classList.remove("hidden");
      
      const noteElement = buildElement("div", { classname: "theoretical-note" }, [
        buildElement("div", { classname: "note-theorem" }, [theoreticalNote.theorem]),
        buildElement("div", { classname: "note-statement" }, [theoreticalNote.statement]),
        buildElement("div", { classname: "note-explanation" }, [theoreticalNote.explanation])
      ]);
      
      theoreticalNotesContent.appendChild(noteElement);
    } else {
      theoreticalNotesSection.classList.add("hidden");
    }

    // Setup violating arcs
    const violatingArcsSection = this.#view.violatingArcs.section;
    const violatingArcsTableBody =
      this.#view.violatingArcs.table.querySelector("tbody");
    violatingArcsTableBody.innerHTML = "";

    // Dynamic header: "Shared Arc" instance shows "Shared Arc", all others show "Violating Arcs"
    const arcsHeader = violatingArcsSection.querySelector("header");
    if (arcsHeader) {
      arcsHeader.textContent = (name === "Shared Arc") ? "Shared Arc" : "Violating Arcs";
    }

    if (violating?.arcs && violating.arcs.length > 0) {
      violatingArcsSection.classList.remove("hidden");
      for (const arcUID of violating.arcs) {
        const identifierPair = this.#parentManager.getArcIdentifierPair(arcUID);
        const row = buildElement("tr", {}, [
          buildElement("td", {}, [buildArcTagElement(...identifierPair)]),
          buildElement("td", {}, [violatingRemarks?.arcs[arcUID] || ""]),
        ]);

        violatingArcsTableBody.appendChild(row);
      }
    } else {
      violatingArcsSection.classList.add("hidden");
    }

    // Setup violating vertices
    const violatingVerticesSection = this.#view.violatingVertices.section;
    const violatingVerticesTableBody =
      this.#view.violatingVertices.table.querySelector("tbody");
    violatingVerticesTableBody.innerHTML = "";

    if (violating?.vertices && violating.vertices.length > 0) {
      violatingVerticesSection.classList.remove("hidden");
      for (const vertexUID of violating.vertices) {
        const identifier = this.#parentManager.getVertexIdentifier(vertexUID);
        const row = buildElement("tr", {}, [
          buildElement("td", {}, [buildVertexTagElement(identifier)]),
          buildElement("td", {}, [violatingRemarks?.vertices[vertexUID] || ""]),
        ]);

        violatingVerticesTableBody.appendChild(row);
      }
    } else {
      violatingVerticesSection.classList.add("hidden");
    }
  }
}
