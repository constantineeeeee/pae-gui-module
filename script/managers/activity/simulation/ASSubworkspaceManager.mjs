import { TabGroupManager } from "../../workspace/TabGroupManager.mjs";
import { TabManager } from "../../workspace/TabManager.mjs";
import { ActivitySimulationManager } from "./ActivitySimulationManager.mjs";

export class ASSubworkspaceManager {
    
    /** @type {ActivitySimulationManager} */
    #simulationManager;
    
    /** @type {HTMLDivElement} */
    #rootAreaElement;

    /**
     * @type {{
     *      main: HTMLDivElement,
     *      buttons: { actions: { [action: string]: HTMLButtonElement } },
     *      header: { main: HTMLDivElement },
     *      panels: { [panelID: string]: HTMLDivElement }
     * }}
     */
    #view = {
        header: {},
        buttons: { actions: {} },
        panels: {}
    };

    /** 
     * @type {{
     *  left: TabGroupManager,
     *  right: TabGroupManager
     * }} 
     * */
    #tabs = { left: null, right: null };

    /** @type {} */
    constructor(simulationManager, rootAreaElement) {
        this.#simulationManager = simulationManager;
        this.#rootAreaElement = rootAreaElement;
        this.#initializeView();
        this.#initializeTabs();
    }

    #initializeView() {
        this.#view.main = this.#rootAreaElement.querySelector(".as-main");

        const headerElement = this.#rootAreaElement.querySelector(".as-main > header");
        this.#view.header = {
            main: headerElement.querySelector(".as-status-view"),
        };

        // Initialize panels
        [...this.#rootAreaElement.querySelectorAll(".panel")].forEach(
            panel => {
                const panelID = panel.getAttribute("data-panel-id");
                this.#view.panels[panelID] = panel;
        });

        // Initialize action buttons
        [...this.#rootAreaElement.querySelectorAll('button[data-as-action]')].forEach(
            button => {
                const action = button.getAttribute("data-as-action");
                this.#view.buttons.actions[action] = button;
                button.addEventListener("click", () => this.#onActionClicked(action));
        });
    }

    #onActionClicked(action) {
        switch(action) {
            case "prev": 
                this.#simulationManager.prev();
            break;
            case "next": 
                this.#simulationManager.next();
            break;
            case "traversal-tree":
                this.#simulationManager.openTraversalTree();
            break;
        }
    }

    /**
     * Show or hide the traversal tree button based on whether the simulation
     * has multiple parallel activities. Called by ActivitySimulationManager
     * after it determines isParallel.
     * @param {boolean} visible
     */
    setTraversalTreeButtonVisible(visible) {
        const btn = this.#view.buttons.actions["traversal-tree"];
        if (btn) btn.style.display = visible ? "" : "none";
    }

    #initializeTabs() {
        const leftPanelsTabButtonsContainer = this.#rootAreaElement.querySelector(".left-panels > .tab-buttons");
        const leftPanelsTabAreaContainer = this.#rootAreaElement.querySelector(".left-panels > .panel-tabs");

        const rightPanelsTabButtonsContainer = this.#rootAreaElement.querySelector(".right-panels > .tab-buttons");
        const rightPanelsTabAreaContainer = this.#rootAreaElement.querySelector(".right-panels > .panel-tabs");


        this.#tabs.left = new TabGroupManager(this, leftPanelsTabButtonsContainer, leftPanelsTabAreaContainer);
        this.#tabs.right = new TabGroupManager(this, rightPanelsTabButtonsContainer, rightPanelsTabAreaContainer);
        
        this.#tabs.left.loadTab(TabManager.load(
            this, "details", "Activity Details",
            leftPanelsTabButtonsContainer.querySelector(".tab-button[data-tab-id='details']"),
            leftPanelsTabAreaContainer.querySelector(".tab-area[data-tab-id='details']")
        ));
        
        this.#tabs.right.loadTab(TabManager.load(
            this, "profile", "Activity Profile",
            rightPanelsTabButtonsContainer.querySelector(".tab-button[data-tab-id='profile']"),
            rightPanelsTabAreaContainer.querySelector(".tab-area[data-tab-id='profile']")
        ));
        
        this.#tabs.right.loadTab(TabManager.load(
            this, "tor", "Timeliness of Response",
            rightPanelsTabButtonsContainer.querySelector(".tab-button[data-tab-id='tor']"),
            rightPanelsTabAreaContainer.querySelector(".tab-area[data-tab-id='tor']")
        ));
        
        this.#tabs.left.selectTab("details");
        this.#tabs.right.selectTab("profile");
    }
}