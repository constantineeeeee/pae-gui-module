import Activity from "../../entities/activity/Activity.mjs";
import { buildElement, Form } from "../../utils.mjs";
import { ActivitiesManager } from "../activity/ActivitiesManager.mjs";
import ModelContext from "../model/ModelContext.mjs";
import { PAESimulationManager } from "../activity/extraction/PAESimulationManager.mjs";
import TraversalTreeViewerManager from "../parallel/TraversalTreeSubworkspaceManager.mjs";

export default class ExecutePanelManager {
    /** @type { ModelContext } */
    context;

    /** @type {HTMLDivElement} */
    #rootElement;

    /**
     * @type {{
     *  activities: {
     *      root: HTMLDivElement,
     *      table: HTMLTableElement,
     *      importButton: HTMLButtonElement
     *      addActivityButton: HTMLButtonElement
     *  },
     *  activityExtraction: {
     *      root: HTMLDivElement,
     *      generateButton: HTMLButtonElement,
     *      simulateButton: HTMLButtonElement,
     *      isParallelCheckbox: HTMLInputElement,
     *  },
     *  vertexSimplification: {
     *      root: HTMLDivElement,
     *      generateLevel1Button: HTMLButtonElement,
     *      generateLevel2Button: HTMLButtonElement,
     *  },
     *  convert: {
     *      root: HTMLDivElement,
     *      convertToPNButton: HTMLButtonElement
     *  }
     * }}
     */
    #views = {
        activities: {},
        activityExtraction: {},
        vertexSimplification: {},
        convert: {}
    };

    /**
     * @type {{
     *  activityExtraction: Form,
     *  vertexSimplification: Form
     * }}
     */
    #forms = {
        activityExtraction: null,
        vertexSimplification: null
    };

    /**
     * @param {ModelContext} context 
     */
    constructor(context, rootElement) {
        this.context = context;
        this.#rootElement = rootElement;

        this.#initializeView();
        this.#initializeForms();
    }

    #initializeView() {
        this.#initializeActivitiesSection();
        this.#initializeAESection();
        this.#initializeVSSection();
        this.#initializeConvertSection();
    }

    #initializeActivitiesSection() {
        const activitiesSectionRoot = this.#rootElement.querySelector("[data-section-id='activities']");
        const activitiesSectionViews = this.#views.activities;

        activitiesSectionViews.root = activitiesSectionRoot;
        activitiesSectionViews.table = activitiesSectionRoot.querySelector("table");
        activitiesSectionViews.addActivityButton = activitiesSectionRoot.querySelector("button[data-subaction='add-activity']");
        activitiesSectionViews.importButton = activitiesSectionRoot.querySelector("button[data-subaction='import']");

        activitiesSectionViews.addActivityButton.addEventListener("click", () => this.context.managers.workspace.createdInputtedActivity());
        activitiesSectionViews.importButton.addEventListener("click", () => this.context.managers.activities.importActivity());
    }

    #initializeAESection() {
        const aeSectionRoot = this.#rootElement.querySelector("[data-section-id='ae']");
        const aeSectionViews = this.#views.activityExtraction;

        aeSectionViews.root = aeSectionRoot;
        aeSectionViews.generateButton = aeSectionRoot.querySelector("button[data-subaction='generate']");
        aeSectionViews.simulateButton = aeSectionRoot.querySelector("button[data-subaction='simulate']");
        aeSectionViews.isParallelCheckbox = aeSectionRoot.querySelector("[name='isParallel']");


        aeSectionViews.isParallelCheckbox.addEventListener("change", () => {
            // Simulate button stays enabled — when isParallel is checked,
            // it runs PAE then opens parallel activity simulation directly.
        });

        aeSectionViews.generateButton.addEventListener("click", async () => {
            const { name, source, sink, mode, isTargeted, isMaximal, isParallel } = this.#forms.activityExtraction.getValues();
            if(!source || !sink) return;

            const visualModel = this.context.managers.visualModel.makeCopy();

            if(isParallel) {
                // PAE path — no targeted arcs, no maximal, no simulate
                const paeManager = new PAESimulationManager(
                    this.context,
                    { name: name?.trim() || "<Untitled PAE>", source: Number(source), sink: Number(sink) },
                    visualModel
                );

                await paeManager.ready;

                const conclusion = paeManager.getConclusion();

                // ── Highlight competing arcs red on the main model canvas ──────
                const competingArcs = paeManager.getCompetingArcUIDs();
                const drawingView   = this.context.managers.drawing;
                if (competingArcs.size > 0 && drawingView) {
                    for (const arcUID of competingArcs) {
                        drawingView.highlightArc(arcUID, "red");
                    }
                }

                if (paeManager.isDeadlock || !paeManager.isParallel) {
                    const entries        = paeManager.getProcessEntries();
                    const competitionLog = paeManager.competitionLog;
                    const interruptionLog = paeManager.interruptionLog;
                    // Collect competing arc UIDs — same for all processes in the group
                    const competingArcUIDs    = [...paeManager.getCompetingArcUIDs()];
                    const interruptingArcUIDs = [...paeManager.getInterruptingArcUIDs()];

                    // Highlight interruption arcs in orange (different from competition red)
                    for (const arcUID of interruptingArcUIDs) {
                        drawingView.highlightArc(arcUID, "orange");
                    }

                    const arcDescriptions = competitionLog.map((e) => {
                        const [from, to] = paeManager.getArcIdentifierPair(e.arcUID);
                        return `(${from || "?"}→${to || "?"}) L=${e.arcL}, used by ${
                            (e.usedByProcessIds ?? [e.winnerProcessId, ...e.loserProcessIds]).length
                        } activities`;
                    });

                    const interruptionDescriptions = interruptionLog.map((e) => {
                        return `RBS '${e.rbsCenter}': activities [${e.activityIds.join(", ")}] ` +
                               `overlap at t=[${(e.overlapTimesteps ?? []).join(", ")}]`;
                    });

                    if (entries.length === 0) {
                        // No processes completed — one placeholder failed activity
                        this.context.managers.activities.addActivity(new Activity({
                            name:             name?.trim() || "<Untitled PAE>",
                            source:           Number(source),
                            sink:             Number(sink),
                            origin:           "pae",
                            conclusion,
                            profile:          {},
                            tor:              {},
                            competingArcUIDs,
                            interruptingArcUIDs,
                        }));
                    } else {
                        // One failed Activity per process so user can simulate each
                        const parallelGroupId = crypto.randomUUID();
                        entries.forEach((entry, idx) => {
                            const label = entries.length === 1
                                ? (name?.trim() || "<Untitled PAE>")
                                : `${name?.trim() || "<Untitled PAE>"} — Process ${idx + 1}`;

                            const processConclusion = {
                                pass:        false,
                                title:       conclusion.title,
                                description: interruptionLog.length > 0
                                    // ? `Interrupting activities:\n${interruptionDescriptions.map(d => "• " + d).join("\n")}`
                                    ? ``
                                    : (competitionLog.length > 0
                                        ? `Competing arcs:\n${arcDescriptions.map(d => "• " + d).join("\n")}`
                                        : conclusion.description),
                            };

                            this.context.managers.activities.addActivity(new Activity({
                                name:             label,
                                source:           Number(source),
                                sink:             Number(sink),
                                origin:           "pae",
                                parallelGroupId,
                                conclusion:       processConclusion,
                                profile:          entry.activityProfile,
                                tor:              {},
                                competingArcUIDs,    // highlighted red in simulation view
                                interruptingArcUIDs, // highlighted orange in simulation view
                            }));
                        });
                    }

                    this.context.managers.workspace.gotoMainModel();
                    this.context.managers.workspace.showPanel("execute");
                    return;
                }

                for(let g = 0; g < paeManager.groupCount; g++) {
                    const groupLabel = paeManager.groupCount > 1
                        ? `${name?.trim() || "PAE"} (Group ${g + 1})`
                        : name?.trim() || "<Untitled PAE>";
                    paeManager.saveParallelActivities(groupLabel, g);
                }

            } else {
                // Normal AE path — unchanged from before
                let targetedArcs = new Set();
                if(isTargeted) {
                    targetedArcs = await this.context.managers.workspace.startTargetedArcSelection(visualModel);
                }

                this.context.managers.activities.generateActivity({ 
                    name: name?.trim() || "<Untitled Activity>", 
                    source: Number(source), 
                    sink: Number(sink),
                    targetedArcs,
                    isMaximal
                }, visualModel);
            }
        });

        aeSectionViews.simulateButton.addEventListener("click", async () => {
            const { name, source, sink, mode, isTargeted, isParallel } = this.#forms.activityExtraction.getValues();
            if(!source || !sink) return;
            if(!isParallel && !mode) return; // sequential mode requires mode

            const visualModel = this.context.managers.visualModel.makeCopy();

            // ── PARALLEL SIMULATION PATH ─────────────────────────────────
            // Run PAE, then open parallel activity simulation directly (no
            // intermediate save-to-activities-list step).
            if (isParallel) {
                const paeManager = new PAESimulationManager(
                    this.context,
                    { name, source: Number(source), sink: Number(sink) },
                    visualModel
                );
                await paeManager.ready;

                const conclusion = paeManager.getConclusion();
                const competingArcUIDs    = [...paeManager.getCompetingArcUIDs()];
                const interruptingArcUIDs = [...paeManager.getInterruptingArcUIDs()];

                const entries = paeManager.isParallel
                    ? paeManager.getProcessEntriesForGroup(0)
                    : paeManager.getProcessEntries();

                if (entries.length === 0) {
                    // No processes completed — show feedback and return
                    this.context.managers.workspace.gotoMainModel();
                    this.context.managers.workspace.showPanel("execute");
                    alert(`PAE could not produce any activities.\n\n${conclusion.title}: ${conclusion.description}`);
                    return;
                }

                // Build Activity objects in-memory (not added to the saved list)
                const parallelGroupId = crypto.randomUUID();
                const activities = entries.map((entry, idx) => new Activity({
                    name: entries.length === 1
                        ? (name?.trim() || "<Untitled PAE>")
                        : `${name?.trim() || "<Untitled PAE>"} — Process ${idx + 1}`,
                    source:  Number(source),
                    sink:    Number(sink),
                    origin:  "pae",
                    parallelGroupId,
                    conclusion,
                    profile: entry.activityProfile,
                    tor:     {},
                    competingArcUIDs,
                    interruptingArcUIDs,
                }));

                // Open parallel simulation directly
                if (activities.length > 1) {
                    this.context.managers.workspace.startParallelActivitySimulation(activities);
                } else {
                    this.context.managers.workspace.startActivitySimulation(activities[0]);
                }
                return;
            }

            // ── SEQUENTIAL AES PATH (unchanged) ──────────────────────────
            let targetedArcs = new Set();
            if(isTargeted) {
                targetedArcs = await this.context.managers.workspace.startTargetedArcSelection(visualModel);
            }
            
            const aesManager = this.context.managers.workspace.startAESimulation({
                name, source: Number(source), sink: Number(sink), mode,
                targetedArcs
            }, visualModel);
        });
    }

    #initializeVSSection() {
        const vsSectionRoot = this.#rootElement.querySelector("[data-section-id='vs']");
        const vsSectionViews = this.#views.vertexSimplification;

        vsSectionViews.root = vsSectionRoot;
        vsSectionViews.generateLevel1Button = vsSectionRoot.querySelector("button[data-subaction='vs-generate-1']");
        vsSectionViews.generateLevel2Button = vsSectionRoot.querySelector("button[data-subaction='vs-generate-2']");

        vsSectionViews.generateLevel1Button.addEventListener("click", async () => {
            await this.context.managers.workspace.startVertexSimplification(1);
        });

        vsSectionViews.generateLevel2Button.addEventListener("click", async () => {
            const { rbs } = this.#forms.vertexSimplification.getValues();
            if(!rbs) return;

            await this.context.managers.workspace.startVertexSimplification(2, Number(rbs));
        });
    }

    #initializeConvertSection() {
        const convertSectionRoot = this.#rootElement.querySelector("[data-section-id='convert']");
        const convertSectionViews = this.#views.convert;

        convertSectionViews.root = convertSectionRoot;
        convertSectionViews.convertToPNButton = convertSectionRoot.querySelector("button[data-subaction='convert-to-pn']");

        convertSectionViews.convertToPNButton.addEventListener("click", () => {
            this.context.managers.workspace.startConvertToPetriNet();
        });
    }

    #initializeForms() {
        // Activity Extraction
        this.#forms.activityExtraction = new Form(this.#views.activityExtraction.root)
            .setFieldNames([ 'name', 'source', 'sink', 'mode', 'isTargeted', 'isMaximal', 'isParallel' ]);
        this.#forms.activityExtraction.getFieldElement('mode').addEventListener("change", (event) => 
            this.#views.activityExtraction.root.setAttribute("data-value-mode", event.target.value));
        this.#forms.activityExtraction.getFieldElement('isMaximal').addEventListener("change", (event) => 
            this.#views.activityExtraction.root.setAttribute("data-value-ismaximal", event.target.checked));
        this.#forms.activityExtraction.getFieldElement('isParallel').addEventListener("change", (event) => {
            this.#views.activityExtraction.root.setAttribute("data-value-isparallel", event.target.checked);
            // Simulate button stays enabled — runs PAE then opens parallel simulation.
        });
 
        this.#forms.vertexSimplification = new Form(this.#views.vertexSimplification.root)
            .setFieldNames([ 'rbs' ]);
    }

    /** @param {Activity[]} activities */
    // refreshActivitiesList(activities) {
    //     const activitiesManager = this.context.managers.activities;
        
    //     const tableBody = this.#views.activities.table.querySelector("tbody");
    //     tableBody.innerHTML = "";

    //     for(const activity of activities) {
    //         const viewButton = buildElement("button", { classname: "icon" }, [ buildElement("i", { classname: "fas fa-eye" }) ]);
    //         const simulateButton = buildElement("button", { classname: "icon" }, [ buildElement("i", { classname: "fas fa-play" }) ]);
    //         const downloadButton = buildElement("button", { classname: "icon" }, [ buildElement("i", { classname: "fas fa-arrow-down" }) ]);
    //         const deleteButton = buildElement("button", { classname: "icon" }, [ buildElement("i", { classname: "fas fa-close" }) ]);
            
    //         simulateButton.addEventListener("click", () => activitiesManager.simulateActivity(activity.id));
    //         downloadButton.addEventListener("click", () => this.context.managers.export.exportActivityToTextFile(activity));
    //         deleteButton.addEventListener("click", () => activitiesManager.deleteActivity(activity.id));

    //         const passed = activity.conclusion?.pass || false;

    //         const actRow = buildElement("tr", { "data-passed": passed }, [
    //             buildElement("td", {}, [
    //                 buildElement("div", { classname: "activity-name" }, [ activity.name ]),
    //                 buildElement("div", { classname: "activity-origin" }, [
    //                     buildElement("span", { classname: "data-passed-message" }, [ passed ? "Passed" : "Failed" ]),
    //                     " • ",
    //                     { aes: "Simulated", direct: "Direct Input", ae: "Generated", import: "From File", pae: "Parallel Extracted" }[activity.origin] || ""
    //                 ]),
    //             ]),
    //             buildElement("td", {}, [ simulateButton, downloadButton, deleteButton ])
    //         ]);

    //         tableBody.appendChild(actRow);
    //     }
    // }

    refreshActivitiesList(activities) {
        const activitiesManager = this.context.managers.activities;
        const tableBody = this.#views.activities.table.querySelector("tbody");
        tableBody.innerHTML = "";

        // Group activities by parallelGroupId — ungrouped ones get their own group
        const groups = new Map();
        for (const activity of activities) {
            const key = activity.parallelGroupId || activity.id;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(activity);
        }

        for (const [key, group] of groups) {
            const isParallelGroup = group.length > 1;

            // const simulateButton = buildElement("button", { classname: "icon" }, [buildElement("i", { classname: "fas fa-play" })]);
            // const downloadButton = buildElement("button", { classname: "icon" }, [buildElement("i", { classname: "fas fa-arrow-down" })]);
            // const deleteButton = buildElement("button", { classname: "icon" }, [buildElement("i", { classname: "fas fa-close" })]);
            const simulateButton = buildElement("button", { classname: "icon" }, [buildElement("i", { classname: "fas fa-play" })]);
            const downloadButton = buildElement("button", { classname: "icon" }, [buildElement("i", { classname: "fas fa-arrow-down" })]);
            const deleteButton   = buildElement("button", { classname: "icon" }, [buildElement("i", { classname: "fas fa-close" })]);
            const ttButton       = buildElement("button", { classname: "icon" }, [buildElement("i", { classname: "fas fa-diagram-project" })]);

            const passed = group[0].conclusion?.pass || false;
            const origin = { aes: "Simulated", direct: "Direct Input", ae: "Generated", import: "From File", pae: "Parallel Extracted" }[group[0].origin] || "";

            // Label: if parallel group, show shared name without "— Process N"
            const label = isParallelGroup
                ? group[0].name.replace(/\s*—\s*Process\s*\d+$/, "")
                : group[0].name;

            // Sub-labels: show each process name indented
            const subLabels = isParallelGroup
                ? group.map(a => buildElement("div", { classname: "activity-process-label" }, [a.name]))
                : [];

            simulateButton.addEventListener("click", () => {
                if (isParallelGroup) {
                    activitiesManager.simulateParallelGroup(group.map(a => a.id));
                } else {
                    activitiesManager.simulateActivity(group[0].id);
                }
            });

            downloadButton.addEventListener("click", () => {
                for (const activity of group) {
                    this.context.managers.export.exportActivityToTextFile(activity);
                }
            });

            deleteButton.addEventListener("click", () => {
                for (const activity of group) {
                    activitiesManager.deleteActivity(activity.id);
                }
            });

            const PALETTE = [
                "#3a81de","#4caf50","#ff9800","#9c27b0",
                "#e91e63","#00bcd4","#795548","#607d8b",
            ];
            const groupColors = group.map((_, i) => PALETTE[i % PALETTE.length]);

            ttButton.addEventListener("click", () => {
                const snapshot = this.context.managers.visualModel.makeCopy();
                new TraversalTreeViewerManager(this.context, snapshot, groupColors);
            });
            ttButton.style.display = isParallelGroup ? "" : "none";

            const actRow = buildElement("tr", { "data-passed": passed }, [
                buildElement("td", {}, [
                    buildElement("div", { classname: "activity-name" }, [label]),
                    buildElement("div", { classname: "activity-origin" }, [
                        buildElement("span", { classname: "data-passed-message" }, [passed ? "Passed" : "Failed"]),
                        " • ",
                        origin,
                        isParallelGroup ? ` (${group.length} processes)` : ""
                    ]),
                    ...subLabels
                ]),
                // buildElement("td", {}, [simulateButton, downloadButton, deleteButton])
                buildElement("td", {}, [simulateButton, downloadButton, deleteButton])
            ]);

            tableBody.appendChild(actRow);
        }
    }

    refreshModelValues() {

        // Refresh AE configs
        const potentialSourceVertices = this.context.managers.visualModel.getPotentialSourceVertices();
        const potentialSinkVertices = this.context.managers.visualModel.getPotentialSinkVertices();

        this.#forms.activityExtraction.getFieldElement("source").innerHTML = 
            potentialSourceVertices.map(vertex => `<option value="${vertex.uid}">${vertex.identifier}</option>`).join("");

        this.#forms.activityExtraction.getFieldElement("sink").innerHTML = 
            potentialSinkVertices.map(vertex => `<option value="${vertex.uid}">${vertex.identifier}</option>`).join("");


        // Refresh RBS centers list
        const rbsCenters = this.context.managers.visualModel.getAllComponents().filter(c => c.isRBSCenter);
        this.#forms.vertexSimplification.getFieldElement("rbs").innerHTML =
            rbsCenters.map(vertex => `<option value="${vertex.uid}">${vertex.identifier}</option>`).join("");
    }
}