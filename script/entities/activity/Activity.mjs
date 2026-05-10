import { generateUniqueID } from "../../utils.mjs";
import VisualComponent from "../model/visual/VisualComponent.mjs";

export default class Activity {
    /**
     * @typedef {number} ArcUID
     * @typedef {number} VertexUID
     * @typedef {{ [timestep: number]: Set<ArcUID> }} ActivityProfile
     * @typedef {"aes" | "direct" | "ae" | "import"} ActivityOrigin
     * @typedef {{
     *      pass: boolean,
     *      title: string,
     *      description: string
     * }} ActivityConclusion
     * 
     * @typedef {{ [vertexUID: number]: { 
     *      T_reached: Set<number>, 
     *      T_condition_satisfied: { 
     *          arcUID: number,  
     *          checkedTime: number
     *      }[] 
     * } }} TimelinessOfResponse
     */

    /** @type {string} */
    id;

    /** @type {string} */
    name;

    /** @type {ActivityOrigin} */
    origin;

    /** @type {VertexUID} */
    source;

    /** @type {VertexUID} */
    sink;

    /** @type {ActivityConclusion} */
    conclusion;
    
    /** @type {ActivityProfile} */
    profile;

    /** @type {TimelinessOfResponse} */
    tor;

    /** @type {string | null} */
    parallelGroupId;

    /** @type {number[]} — arc UIDs that caused competition (PAE only) */
    competingArcUIDs;

    /** @type {number[]} — arc UIDs that caused process interruption (PAE only) */
    interruptingArcUIDs;

    /** @type {number[]} — process IDs of activities this one interrupts/is interrupted by */
    interruptingActivityIds;

    /** @type {number | null} — PAE process ID this activity was derived from
     *  (for color-registry lookups so the activity-profile UI and the
     *  traversal-tree share colors). null for non-PAE activities. */
    paeProcessId;

    /**
     * @param {{ 
     *     id: string, 
     *     name: string, 
     *     origin: ActivityOrigin, 
     *     source: VertexUID, 
     *     sink: VertexUID, 
     *     conclusion: ActivityConclusion, 
     *     profile: ActivityProfile,
     *     tor: TimelinessOfResponse,
     *     parallelGroupId: string | null
     * }} values 
     */
    constructor(values) {
        this.id = values.id || generateUniqueID();
        this.name = values.name;
        this.origin = values.origin;
        this.source = values.source;
        this.sink = values.sink;
        this.conclusion = values.conclusion;
        this.profile = values.profile;
        this.tor = values.tor;
        this.parallelGroupId = values.parallelGroupId || null;
        this.competingArcUIDs = values.competingArcUIDs || [];
        this.interruptingArcUIDs    = values.interruptingArcUIDs    ?? [];
        this.interruptingActivityIds= values.interruptingActivityIds ?? [];
        this.paeProcessId           = values.paeProcessId           ?? null;
    }
}