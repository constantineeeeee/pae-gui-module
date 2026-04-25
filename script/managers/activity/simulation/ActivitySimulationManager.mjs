import Activity from "../../../entities/activity/Activity.mjs";
import VisualArc from "../../../entities/model/visual/VisualArc.mjs";
import VisualComponent from "../../../entities/model/visual/VisualComponent.mjs";
import VisualRDLTModel from "../../../entities/model/visual/VisualRDLTModel.mjs";
import { generateUniqueID } from "../../../utils.mjs";
import { BaseModelDrawingManager } from "../../drawing/BaseModelDrawingManager.mjs";
import ModelContext from "../../model/ModelContext.mjs";
import { ASSubworkspaceManager } from "./ASSubworkspaceManager.mjs";
import { ASDetailsPanelManager } from "./panels/ASDetailsPanelManager.mjs";
import { ASProfilePanelManager } from "./panels/ASProfilePanelManager.mjs";
import { ASTORPanelManager } from "./panels/ASTORPanelManager.mjs";
import { buildElement } from "../../../utils.mjs";

export class ActivitySimulationManager {
    /** @type {ModelContext} */
    context;

    /** @type {string} */
    id;

    /** 
     * @type {Activity} 
    */
    #activity;

    /** @type {Activity[]} */
    #activities = [];

    /** @type {boolean} */
    #isParallel = false;

    /** @type {VisualRDLTModel} */
    #modelSnapshot;

    /** @type {BaseModelDrawingManager} */
    #drawingManager;

    /** @type {ASSubworkspaceManager} */
    #subworkspaceManager;

    /** 
     * @type {{
     *      details: ASDetailsPanelManager,
     *      profile: ASProfilePanelManager,
     *      tor: ASTORPanelManager
     * }} 
     * */
    #panels;

    /** @type {{ rowsByTimestep: { [t: number]: HTMLTableRowElement }, color: string }[]} */
    #parallelPanels = [];

    /** @type {number[]} — arc UIDs to permanently highlight red (competing arcs) */
    #competingArcUIDs = [];

    /** 
     * @type {{
     *  currentTimestep: number,
     *  maxTimestep: number
     * }} 
    * */
    #states = {
        currentTimestep: 1,
        maxTimestep: 0
    };



    /**
     * @param {ModelContext} context
     * @param {Activity} activity 
     * @param {VisualRDLTModel} visualModelSnapshot 
     */
    constructor(context, activity, visualModelSnapshot) {
        this.context = context;
        this.id = generateUniqueID();
        this.#modelSnapshot = visualModelSnapshot;

        // Support both a single Activity and an array of parallel Activities
        this.#isParallel = Array.isArray(activity);
        this.#activities = this.#isParallel ? activity : [activity];
        this.#activity = this.#activities[0]; // keep for panel compatibility

        // Max timestep is the highest across ALL profiles
        const allTimesteps = this.#activities.flatMap(a => Object.keys(a.profile).map(Number));
        this.#states.maxTimestep = allTimesteps.length > 0 ? Math.max(...allTimesteps) : 1;

        // Collect competing arc UIDs from any activity in the group
        this.#competingArcUIDs = this.#activities
            .flatMap(a => a.competingArcUIDs ?? [])
            .filter((uid, i, arr) => arr.indexOf(uid) === i); // deduplicate

        this.#initialize();
    }

    async #initialize() {
        const subworkspaceTabManager = await this.context.managers.workspace.addASSubworkspace(this.id);
        const rootElement = subworkspaceTabManager.tabAreaElement;
        this.#drawingManager = new BaseModelDrawingManager(rootElement.querySelector(".drawing > svg"), "aes");
        this.#subworkspaceManager = new ASSubworkspaceManager(this, rootElement);

        this.#panels = {
            details: new ASDetailsPanelManager(this, rootElement.querySelector(".panel[data-panel-id='details']")),
            profile: new ASProfilePanelManager(this, rootElement.querySelector(".panel[data-panel-id='profile']")),
            tor: new ASTORPanelManager(this, rootElement.querySelector(".panel[data-panel-id='tor']")),
        };

        this.#drawingManager.setupComponents(
            this.#modelSnapshot.getAllComponents(), 
            this.#modelSnapshot.getAllArcs());

        this.#panels.details.displayActivityDetails(this.#activity);

        // this.#panels.profile.displayProfileList(this.#activity.profile);
        // this.#panels.tor.displayTOR(this.#activity.tor);
        // if (this.#isParallel) {
        //     // Merge all profiles for display in the profile panel
        //     const mergedProfile = {};
        //     for (const activity of this.#activities) {
        //         for (const [t, arcs] of Object.entries(activity.profile)) {
        //             if (!mergedProfile[t]) mergedProfile[t] = new Set();
        //             for (const arcUID of arcs) mergedProfile[t].add(arcUID);
        //         }
        //     }
        //     this.#panels.profile.displayProfileList(mergedProfile);
        // } else {
        //     this.#panels.profile.displayProfileList(this.#activity.profile);
        //     this.#panels.tor.displayTOR(this.#activity.tor);
        // }

        if (this.#isParallel) {
            const profilePanelMain = rootElement.querySelector(".panel[data-panel-id='profile'] main");
            profilePanelMain.innerHTML = "";

            const colors = ["#3a81de", "#4caf50", "#ff9800", "#9c27b0"];

            this.#activities.forEach((activity, i) => {
                const color = colors[i % colors.length];

                // Colored label per process
                const label = document.createElement("div");
                label.style.cssText = `font-weight:500;font-size:13px;padding:8px 0 4px 8px;border-left:3px solid ${color};margin-bottom:4px;margin-top:${i > 0 ? "16px" : "0"}`;
                label.textContent = `Process ${i + 1}`;

                // Table
                const table = document.createElement("table");
                table.className = "anchor-right";
                table.innerHTML = `<thead><tr><th>Timestep</th><th>Traversed Arcs</th></tr></thead><tbody></tbody>`;

                const tbody = table.querySelector("tbody");
                const rowsByTimestep = {};

                const timesteps = Object.keys(activity.profile).map(Number).sort((a, b) => a - b);
                for (const t of timesteps) {
                    const tr = document.createElement("tr");
                    tr.style.cursor = "pointer";
                    tr.addEventListener("click", () => this.setCurrentTimestepForProcess(i, t));

                    const tdTime = document.createElement("td");
                    tdTime.textContent = t;

                    const tdArcs = document.createElement("td");
                    tdArcs.className = "as-profile-reachables";

                    // Track whether any arc in this timestep is a competing arc
                    let hasCompetingArc = false;

                    for (const arcUID of activity.profile[t]) {
                        const [from, to] = this.getArcIdentifierPair(arcUID);
                        const tag = document.createElement("div");
                        tag.className = "arc-tag";
                        tag.innerHTML = `<div>${from}</div><div>${to}</div>`;

                        // Highlight competing arc tags red
                        if (this.#competingArcUIDs.includes(arcUID)) {
                            tag.style.cssText = "background:#ffe5e5;color:#c0392b;border:1px solid #e74c3c;border-radius:4px;";
                            hasCompetingArc = true;
                        }

                        tdArcs.appendChild(tag);
                    }

                    // Mark the whole row red if it contains a competing arc
                    if (hasCompetingArc) {
                        tr.style.background = "#fff0f0";
                        // Add a small "⚠ impeded" badge
                        const badge = document.createElement("span");
                        badge.textContent = " ⚠";
                        badge.title = "Competing arc — activity impeded here";
                        badge.style.color = "#e74c3c";
                        badge.style.fontWeight = "bold";
                        tdTime.appendChild(badge);
                    }

                    tr.appendChild(tdTime);
                    tr.appendChild(tdArcs);
                    tbody.appendChild(tr);
                    rowsByTimestep[t] = tr;
                }

                profilePanelMain.appendChild(label);
                profilePanelMain.appendChild(table);

                this.#parallelPanels.push({ rowsByTimestep, color });
            });

        } else {
            this.#panels.profile.displayProfileList(this.#activity.profile);
            this.#panels.tor.displayTOR(this.#activity.tor);
        }

        this.setCurrentTimestep(1);
    }
    
    pause() {
        console.log("Pause");
    }

    next() {
        if(this.#states.currentTimestep < this.#states.maxTimestep) {
            this.setCurrentTimestep(this.#states.currentTimestep+1);
        }
    }

    prev() {
        if(this.#states.currentTimestep > 1) {
            this.setCurrentTimestep(this.#states.currentTimestep-1);
            return;
        }
    }

    // setCurrentTimestep(timestep) {
    //     this.#states.currentTimestep = timestep;
    //     this.#panels.profile.setActiveTimestep(timestep);

    //     // Update visualization
    //     this.#drawingManager.clearHighlights();
        
        
    //     // Highlight current arcs
    //     const traversedArcUIDs = this.#activity.profile[timestep] || new Set();
    //     for(const arcUID of traversedArcUIDs) {
    //         this.#drawingManager.highlightArc(arcUID);
    //     }
    // }

    setCurrentTimestep(timestep) {
        this.#states.currentTimestep = timestep;
        this.#panels.profile.setActiveTimestep(timestep);

        this.#drawingManager.clearHighlights();

        // Always re-apply red highlight for competing arcs (persists across timesteps)
        for (const arcUID of this.#competingArcUIDs) {
            this.#drawingManager.highlightArc(arcUID, "#e74c3c");
        }

        if (this.#isParallel) {
            const colors = ["#3a81de", "#4caf50", "#ff9800", "#9c27b0"];
            this.#activities.forEach((activity, i) => {
                const color = colors[i % colors.length];
                const arcs = activity.profile[timestep] ?? new Set();
                for (const arcUID of arcs) {
                    this.#drawingManager.highlightArc(arcUID, color);
                }

                // Highlight the active row in this process's table
                const panel = this.#parallelPanels[i];
                if (panel) {
                    Object.values(panel.rowsByTimestep).forEach(r => r.classList.remove("active"));
                    panel.rowsByTimestep[timestep]?.classList.add("active");
                }
            });
        } else {
            const traversedArcUIDs = this.#activity.profile[timestep] || new Set();
            for (const arcUID of traversedArcUIDs) {
                this.#drawingManager.highlightArc(arcUID);
            }
        }
    }

    /**
     * Highlights only the arcs for a specific process at the given timestep,
     * using that process's assigned color. Clears all highlights first so only
     * the clicked process's arcs are shown. Also marks the clicked row as active
     * and clears active state from all other rows across all process tables.
     *
     * @param {number} processIndex - 0-based index of the process whose row was clicked
     * @param {number} timestep
     */
    setCurrentTimestepForProcess(processIndex, timestep) {
        this.#states.currentTimestep = timestep;

        this.#drawingManager.clearHighlights();

        // Re-apply red for competing arcs before showing process-specific highlight
        for (const arcUID of this.#competingArcUIDs) {
            this.#drawingManager.highlightArc(arcUID, "#e74c3c");
        }

        const colors = ["#3a81de", "#4caf50", "#ff9800", "#9c27b0"];

        // Clear all active row highlights across every process table first
        this.#parallelPanels.forEach(panel => {
            Object.values(panel.rowsByTimestep).forEach(r => r.classList.remove("active"));
        });

        // Highlight only the clicked process's arcs
        const activity = this.#activities[processIndex];
        const color = colors[processIndex % colors.length];
        const arcs = activity?.profile[timestep] ?? new Set();
        for (const arcUID of arcs) {
            this.#drawingManager.highlightArc(arcUID, color);
        }

        // Mark the clicked row as active
        const panel = this.#parallelPanels[processIndex];
        if (panel) {
            panel.rowsByTimestep[timestep]?.classList.add("active");
        }
    }

    /** @returns {string} */
    getVertexIdentifier(vertexUID) {
        return this.#modelSnapshot.getComponent(vertexUID).identifier;
    }

    /** @returns {VisualComponent} */
    getVertex(vertexUID) {
        return this.#modelSnapshot.getComponent(vertexUID);
    }

    /** @returns {VisualArc} */
    getArc(arcUID) {
        return this.#modelSnapshot.getArc(arcUID);
    }

    /** @returns {[string, string]} */
    getArcIdentifierPair(arcUID) {
        const arc = this.#modelSnapshot.getArc(arcUID);
        if(!arc) return [ "", "" ];

        const vertexFrom = this.#modelSnapshot.getComponent(arc.fromVertexUID);
        const vertexTo = this.#modelSnapshot.getComponent(arc.toVertexUID);

        return [
            vertexFrom?.identifier || "",
            vertexTo?.identifier || "" ];
    }

}