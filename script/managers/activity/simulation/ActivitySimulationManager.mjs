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

// ── Shared activity color palette ─────────────────────────────────────────
// MUST match ACTIVITY_COLORS in TraversalTreeSubworkspaceManager.mjs exactly
// so that arc highlights in the main model correspond 1:1 to the path colors
// rendered in the traversal tree view.
const ACTIVITY_COLORS = [
    "#3a81de", // blue   — Activity 1
    "#4caf50", // green  — Activity 2
    "#ff9800", // orange — Activity 3
    "#9c27b0", // purple — Activity 4
    "#e91e63", // pink
    "#00bcd4", // cyan
    "#795548", // brown
    "#607d8b", // blue-grey
];

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
    #interruptingArcUIDs = [];

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

        // Collect interrupting arc UIDs (reset-safeness violations)
        this.#interruptingArcUIDs = this.#activities
            .flatMap(a => a.interruptingArcUIDs ?? [])
            .filter((uid, i, arr) => arr.indexOf(uid) === i);

        this.#initialize();
    }

    async #initialize() {
        const subworkspaceTabManager = await this.context.managers.workspace.addASSubworkspace(this.id);
        const rootElement = subworkspaceTabManager.tabAreaElement;
        this.#drawingManager = new BaseModelDrawingManager(rootElement.querySelector(".drawing > svg"), "aes");
        this.#subworkspaceManager = new ASSubworkspaceManager(this, rootElement);

        // Show "View Traversal Tree" only when there are multiple parallel activities
        this.#subworkspaceManager.setTraversalTreeButtonVisible(
            this.#isParallel && this.#activities.length > 1
        );

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

            const colors = ACTIVITY_COLORS;

            this.#activities.forEach((activity, i) => {
                const color = colors[i % colors.length];

                // Process label row: colored title + "Highlight All" toggle button
                const labelRow = document.createElement("div");
                labelRow.style.cssText = `display:flex;align-items:center;justify-content:space-between;padding:6px 4px 4px 8px;border-left:3px solid ${color};margin-bottom:4px;margin-top:${i > 0 ? "16px" : "0"};`;

                const label = document.createElement("span");
                label.style.cssText = `font-weight:500;font-size:13px;`;
                label.textContent = `Process ${i + 1}`;

                const highlightBtn = document.createElement("button");
                highlightBtn.textContent = "Highlight All";
                highlightBtn.title = `Highlight all arcs used by Process ${i + 1}`;
                highlightBtn.style.cssText = `font-size:11px;padding:3px 8px;min-height:24px;border-color:${color};color:${color};`;
                highlightBtn.dataset.processHighlightBtn = String(i);
                highlightBtn.addEventListener("click", () => this.highlightAllArcsForProcess(i));

                labelRow.appendChild(label);
                labelRow.appendChild(highlightBtn);

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
                    let hasInterruptingArc = false;

                    for (const arcUID of activity.profile[t]) {
                        const [from, to] = this.getArcIdentifierPair(arcUID);
                        const tag = document.createElement("div");
                        tag.className = "arc-tag";
                        tag.innerHTML = `<div>${from}</div><div>${to}</div>`;

                        // Highlight competing arc tags red
                        if (this.#competingArcUIDs.includes(arcUID)) {
                            tag.style.cssText = "background:#ffe5e5;color:#c0392b;border:1px solid #e74c3c;border-radius:4px;";
                            hasCompetingArc = true;
                        } else if (this.#interruptingArcUIDs.includes(arcUID)) {
                            tag.style.cssText = "background:#fdf1d9;color:#9c5a00;border:1px solid #f39c12;border-radius:4px;";
                            hasInterruptingArc = true;
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

                    // Mark the whole row orange if it contains an interrupting arc
                    if (hasInterruptingArc && !hasCompetingArc) {
                        tr.style.background = "#fdf3e2";
                        const badge = document.createElement("span");
                        badge.textContent = " ⚡";
                        badge.title = "Interrupting arc — activity violates reset-safeness";
                        badge.style.color = "#f39c12";
                        badge.style.fontWeight = "bold";
                        const firstCell = tr.querySelector("td");
                        if (firstCell) firstCell.appendChild(badge);
                    }

                    tr.appendChild(tdTime);
                    tr.appendChild(tdArcs);
                    tbody.appendChild(tr);
                    rowsByTimestep[t] = tr;
                }

                profilePanelMain.appendChild(labelRow);
                profilePanelMain.appendChild(table);

                this.#parallelPanels.push({ rowsByTimestep, color, highlightBtn });
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

    /**
     * Open the Traversal Tree subworkspace and pass the parallel activity
     * profiles so the tree can highlight each activity's path in its own color.
     */
    async openTraversalTree() {
        const { default: TraversalTreeSubworkspaceManager } =
            await import("../../parallel/TraversalTreeSubworkspaceManager.mjs");

        // Convert each activity's profile to a sorted sequence of arc UIDs
        // by timestep — the tree manager uses this to match its symbolic
        // paths against the actual PAE-generated activities.
        const activityArcSequences = this.#activities.map((a, i) => ({
            index: i,
            name:  a.name,
            arcsByTimestep: Object.entries(a.profile)
                .map(([t, arcs]) => ({
                    timestep: Number(t),
                    arcUIDs:  [...arcs],
                }))
                .sort((x, y) => x.timestep - y.timestep),
        }));

        new TraversalTreeSubworkspaceManager(this.context, this.#modelSnapshot, {
            activityArcSequences,
        });
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
        // Always re-apply orange highlight for interrupting arcs (reset-safeness violations)
        for (const arcUID of this.#interruptingArcUIDs) {
            this.#drawingManager.highlightArc(arcUID, "#f39c12");
        }

        if (this.#isParallel) {
            this.#resetHighlightButtons();
            const colors = ACTIVITY_COLORS;
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
        this.#resetHighlightButtons();

        this.#drawingManager.clearHighlights();

        // Re-apply red for competing arcs before showing process-specific highlight
        for (const arcUID of this.#competingArcUIDs) {
            this.#drawingManager.highlightArc(arcUID, "#e74c3c");
        }
        // Re-apply orange for interrupting arcs (reset-safeness violations)
        for (const arcUID of this.#interruptingArcUIDs) {
            this.#drawingManager.highlightArc(arcUID, "#f39c12");
        }

        const colors = ACTIVITY_COLORS;

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

    /**
     * Highlights ALL arcs used by the given process across every timestep,
     * using that process's assigned color. Competing/interrupting arc highlights
     * are re-applied on top. All active row indicators are cleared so the user
     * can see that no single timestep is selected.
     * The "Highlight All" button for this process becomes disabled;
     * all other processes' buttons are re-enabled.
     *
     * @param {number} processIndex - 0-based index of the process
     */
    highlightAllArcsForProcess(processIndex) {
        this.#drawingManager.clearHighlights();

        // Re-apply persistent highlights for competing / interrupting arcs
        for (const arcUID of this.#competingArcUIDs) {
            this.#drawingManager.highlightArc(arcUID, "#e74c3c");
        }
        for (const arcUID of this.#interruptingArcUIDs) {
            this.#drawingManager.highlightArc(arcUID, "#f39c12");
        }

        const colors = ACTIVITY_COLORS;

        // Clear active rows and update button states across all process panels
        this.#parallelPanels.forEach((panel, idx) => {
            Object.values(panel.rowsByTimestep).forEach(r => r.classList.remove("active"));
            if (panel.highlightBtn) {
                panel.highlightBtn.disabled = (idx === processIndex);
                panel.highlightBtn.style.opacity = (idx === processIndex) ? "0.4" : "";
            }
        });

        // Collect every unique arc UID used by this process across all timesteps
        const activity = this.#activities[processIndex];
        const color = colors[processIndex % colors.length];
        const allArcUIDs = new Set();
        for (const arcs of Object.values(activity.profile)) {
            for (const arcUID of arcs) allArcUIDs.add(arcUID);
        }
        for (const arcUID of allArcUIDs) {
            this.#drawingManager.highlightArc(arcUID, color);
        }
    }

    /** Re-enables all "Highlight All" buttons (called when navigating by row or timestep). */
    #resetHighlightButtons() {
        this.#parallelPanels.forEach(panel => {
            if (panel.highlightBtn) {
                panel.highlightBtn.disabled = false;
                panel.highlightBtn.style.opacity = "";
            }
        });
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