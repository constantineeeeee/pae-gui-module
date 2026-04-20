/*
PAESimulationManager
Integrates the Parallel Activity Extraction algorithm (pae.mjs / Doñoz 2024)
into the same simulation infrastructure used by AESimulationManager.

Key differences from AESimulationManager:
  - PAE runs all processes simultaneously — there is no interactive step-by-step
    arc selection by the user. The algorithm is executed in full on #start().
  - Instead of a single activityProfile, the result is a set of per-process
    activity profiles (parallelActivitySets[]).
  - Steps are synthesised from the PAEResult for display purposes only; the
    algorithm itself is not driven by the step list.
  - saveActivity() saves each parallel process as a separate Activity object
    that is tagged with a shared "parallel group" identifier.
*/

import Activity from "../../../entities/activity/Activity.mjs";
import VisualRDLTModel from "../../../entities/model/visual/VisualRDLTModel.mjs";
import { parallelActivityExtraction } from "../../../services/pae.mjs";
import {
    buildArcMap,
    buildArcsAdjacencyMatrix,
    buildRBSMatrix,
    buildVertexMap,
    generateUniqueID,
} from "../../../utils.mjs";
import ModelContext from "../../model/ModelContext.mjs";

export class PAESimulationManager {
    /** @type {ModelContext} */
    context;

    /** @type {string} */
    id;

    /**
     * @typedef {number} ComponentID
     * @type {{
     *   name:   string,
     *   source: ComponentID,
     *   sink:   ComponentID,
     * }}
     */
    configs;

    /** @type {VisualRDLTModel} */
    #modelSnapshot;

    /**
     * Resolves when #initialize() has finished running the PAE algorithm.
     * Await this before reading any result from the manager.
     * @type {Promise<void>}
     */
    ready;

    /**
     * The raw PAEResult returned by parallelActivityExtraction().
     * null means the algorithm returned null (deadlock / no parallel activities).
     *
     * @type {import("../../../services/pae.mjs").PAEResult | null}
     */
    #result = null;

    /**
     * Flattened list of { processId, groupIndex, activityProfile } for display.
     *
     * @type {{
     *   processId:       number,
     *   groupIndex:      number,
     *   activityProfile: { [timeStep: number]: Set<number> }
     * }[]}
     */
    #processEntries = [];

    /**
     * Cache shared with aes.mjs helpers.
     * @type {{ arcs: {}[], vertices: {}[], aeCache: {} }}
     */
    #cache = { arcs: [], vertices: [], aeCache: {} };

    /**
     * @param {ModelContext}     context
     * @param {{ name, source, sink }} configs
     * @param {VisualRDLTModel}  visualModelSnapshot
     */
    constructor(context, configs, visualModelSnapshot) {
        this.context = context;
        this.id = generateUniqueID();
        this.configs = configs;
        this.#modelSnapshot = visualModelSnapshot;

        this.ready = this.#initialize();
    }

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    async #initialize() {
        // Build the same cache shape that aes.mjs and pae.mjs both consume
        const vertices = this.#modelSnapshot.getAllComponents().map(v => v.simplify());
        const arcs     = this.#modelSnapshot.getAllArcs().map(a => a.simplify());

        this.#cache.vertices = vertices;
        this.#cache.arcs     = arcs;

        const vertexMap = buildVertexMap(vertices);

        this.#cache.aeCache = {
            arcs,
            vertexMap,
            arcMap:      buildArcMap(arcs),
            arcsMatrix:  buildArcsAdjacencyMatrix(arcs),
            rbsMatrix:   buildRBSMatrix(vertexMap, arcs),
        };

        // Run PAE — the algorithm executes fully here (not step-by-step)
        this.#result = parallelActivityExtraction(
            this.configs.source,
            this.configs.sink,
            this.#cache.aeCache,
        );

        // Flatten the result into a display-friendly list
        this.#processEntries = this.#flattenResult(this.#result);
    }

    // -------------------------------------------------------------------------
    // Result accessors — consumed by whatever panel/drawing manager you wire up
    // -------------------------------------------------------------------------

    /**
     * True when PAE found at least one set of parallel maximal activities.
     * @returns {boolean}
     */
    get isParallel() {
        return this.#result?.isParallel ?? false;
    }

    /**
     * True when PAE returned null (deadlock) or found no done processes.
     * @returns {boolean}
     */
    get isDeadlock() {
        return this.#result === null || this.#result.parallelActivitySets.length === 0;
    }

    /**
     * Number of parallel groups found.
     * @returns {number}
     */
    get groupCount() {
        return this.#result?.parallelActivitySets.length ?? 0;
    }

    /**
     * Returns all flattened process entries for display.
     * Each entry has: processId, groupIndex, activityProfile.
     *
     * @returns {typeof this.#processEntries}
     */
    getProcessEntries() {
        return this.#processEntries;
    }

    /**
     * Returns the process entries belonging to a specific parallel group.
     *
     * @param {number} groupIndex
     * @returns {typeof this.#processEntries}
     */
    getProcessEntriesForGroup(groupIndex) {
        return this.#processEntries.filter(e => e.groupIndex === groupIndex);
    }

    /**
     * Returns the raw PAEResult for advanced consumers.
     * @returns {import("../../../services/pae.mjs").PAEResult | null}
     */
    getRawResult() {
        return this.#result;
    }

    /**
     * Returns a human-readable summary of the PAE result.
     * Mirrors the conclusion object shape used by Activity / AES panels.
     *
     * @returns {{ pass: boolean, title: string, description: string }}
     */
    getConclusion() {
        if (this.isDeadlock) {
            return {
                pass:        false,
                title:       "No parallel maximal activities found",
                description:
                    "The PAE algorithm encountered a deadlock or resource exhaustion " +
                    "before all processes could complete simultaneously. " +
                    "The RDLT does not produce parallel maximal activities for the " +
                    `given source (${this.#vertexLabel(this.configs.source)}) and ` +
                    `sink (${this.#vertexLabel(this.configs.sink)}).`,
            };
        }

        if (!this.isParallel) {
            return {
                pass:        false,
                title:       "Activities found but are not parallel",
                description:
                    `${this.groupCount} group(s) of maximal activities were extracted, ` +
                    "but they do not satisfy all conditions for parallelism " +
                    "(same input/output vertices, no process interruptions, " +
                    "no competing activities, simultaneous completion).",
            };
        }

        return {
            pass:        true,
            title:       `${this.groupCount} set(s) of parallel maximal activities found`,
            description:
                "All extracted maximal activities share the same source and sink, " +
                "do not interrupt each other, have no competing processes, and " +
                "complete at the same time step.",
        };
    }

    /**
     * Returns the arcs involved in a given group (union across all processes in
     * that group) — useful for highlighting in a drawing manager.
     *
     * @param {number} groupIndex
     * @returns {Set<number>}  set of arc UIDs
     */
    getArcsForGroup(groupIndex) {
        const arcs = new Set();
        for (const entry of this.getProcessEntriesForGroup(groupIndex)) {
            for (const ts in entry.activityProfile) {
                for (const arcUID of entry.activityProfile[ts]) {
                    arcs.add(arcUID);
                }
            }
        }
        return arcs;
    }

    /**
     * Returns the arc UIDs that are shared between two or more processes
     * within a group (i.e. shared resources).
     *
     * @param {number} groupIndex
     * @returns {Set<number>}
     */
    getSharedArcsForGroup(groupIndex) {
        const entries  = this.getProcessEntriesForGroup(groupIndex);
        const seen     = new Set();
        const shared   = new Set();
        for (const entry of entries) {
            for (const ts in entry.activityProfile) {
                for (const arcUID of entry.activityProfile[ts]) {
                    if (seen.has(arcUID)) shared.add(arcUID);
                    else seen.add(arcUID);
                }
            }
        }
        return shared;
    }

    // -------------------------------------------------------------------------
    // Saving — mirrors AESimulationManager.saveActivity()
    // -------------------------------------------------------------------------

    /**
     * Saves all parallel processes from a given group as separate Activity
     * objects, each tagged with the same parallelGroupId.
     *
     * Call this when the user confirms they want to save the result.
     *
     * @param {string} baseName    — user-supplied name prefix
     * @param {number} groupIndex  — which parallel group to save (default 0)
     */
    saveParallelActivities(baseName, groupIndex = 0) {
        const entries = this.getProcessEntriesForGroup(groupIndex);
        if (entries.length === 0) return;

        const conclusion = this.getConclusion();
        const parallelGroupId = generateUniqueID(); // shared tag across the group

        entries.forEach((entry, idx) => {
            const name = entries.length === 1
                ? (baseName.trim() || "<Untitled PAE Activity>")
                : `${baseName.trim() || "<Untitled PAE Activity>"} — Process ${idx + 1}`;

            const activity = new Activity({
                name,
                source:         this.configs.source,
                sink:           this.configs.sink,
                origin:         "pae",              // distinguishes from "aes" activities
                parallelGroupId,                    // shared key — consumers can group by this
                conclusion,
                profile:        entry.activityProfile,
                tor:            {},                 // PAE does not compute TOR per-process
            });

            this.context.managers.activities.addActivity(activity);
        });

        this.context.managers.workspace.gotoMainModel();
        this.context.managers.workspace.showPanel("execute");
    }

    // -------------------------------------------------------------------------
    // Helpers for display managers
    // -------------------------------------------------------------------------

    /** @returns {string} */
    getVertexIdentifier(vertexUID) {
        return this.#modelSnapshot.getComponent(vertexUID)?.identifier ?? String(vertexUID);
    }

    /** @returns {[string, string]} */
    getArcIdentifierPair(arcUID) {
        const arc = this.#modelSnapshot.getArc(arcUID);
        if (!arc) return ["", ""];
        return [
            this.#modelSnapshot.getComponent(arc.fromVertexUID)?.identifier ?? "",
            this.#modelSnapshot.getComponent(arc.toVertexUID)?.identifier  ?? "",
        ];
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Flattens a PAEResult into an array of { processId, groupIndex, activityProfile }.
     *
     * @param {import("../../../services/pae.mjs").PAEResult | null} result
     * @returns {typeof this.#processEntries}
     */
    #flattenResult(result) {
        if (!result || result.parallelActivitySets.length === 0) return [];

        const entries = [];
        result.parallelActivitySets.forEach((actSet, groupIndex) => {
            for (const [processIdStr, activityProfile] of Object.entries(actSet)) {
                entries.push({
                    processId:      Number(processIdStr),
                    groupIndex,
                    activityProfile,
                });
            }
        });
        return entries;
    }

    /** @param {number} vertexUID @returns {string} */
    #vertexLabel(vertexUID) {
        return this.#modelSnapshot.getComponent(vertexUID)?.identifier ?? String(vertexUID);
    }
}