    const state = {
      hasApiKey: false,
      aiSettings: null,
      savedCards: JSON.parse(localStorage.getItem("saved_cards") || "[]"),
      results: [],
      currentQuery: "",
      nextPage: null,
      activeTab: "search",
      detailCard: null,
      colorIdentity: [], // session-only: always starts deselected on a fresh page load
      sortField: "cmc",
      sortDir: "asc",
      savedSortField: "cmc",
      savedSortDir: "asc",
      folders: JSON.parse(localStorage.getItem("card_folders") || "[]"),
      membership: JSON.parse(localStorage.getItem("card_membership") || "null"),
      quantities: JSON.parse(localStorage.getItem("card_quantities") || "{}"),
      maybeboard: JSON.parse(localStorage.getItem("card_maybeboard") || "{}"),
      pins: JSON.parse(localStorage.getItem("card_pins") || "{}"),
      deckNotes: JSON.parse(localStorage.getItem("deck_notes") || "{}"),
      activeFolder: "all",
      popoverCard: null,
      mode: "search",
      recommendOrder: [],
      forceAiSearch: JSON.parse(localStorage.getItem("force_ai_search") || "false"),
    };

    const DEFAULT_FOLDER = "default";
    const DEFAULT_FOLDER_NAME = "Unsorted";
    let syncReady = false;
    let activeSearchRun = 0;
    let activeSearchController = null;
    let searchGlowFrame = null;
    let comboRun = 0; // cancels stale combo loads when a newer action supersedes them
    let comboListEl = null; // the .combo-list currently in the results area
    let comboMoreBtn = null; // the "Load more combos" button, if shown
    let collectionData = null;   // /api/collection payload
    let collectionIndex = null;  // buildCollectionIndex(collectionData)
    const deckColorFilter = new Set(); // Decks tab color filter (session-only), used in Task 11

    const $ = (sel) => document.querySelector(sel);
    // localStorage is a best-effort cache: a full quota (phones cap it at ~5MB) must never
    // abort applying server state.
    function lsSet(key, value) { try { localStorage.setItem(key, value); } catch { /* quota full — server copy is authoritative */ } }
    const appShell = $("#app-shell");
    const searchInput = $("#search-input");
    const searchBtn = $("#search-btn");
    const aiSearchToggle = $("#ai-search-toggle");
    const queryDisplay = $("#query-display");
    const queryText = $("#query-text");
    const statusEl = $("#status");
    const resultsEl = $("#results");
    const paginationEl = $("#pagination");
    const loadMoreBtn = $("#load-more-btn");
    const sortBar = $("#sort-bar");
    const sortField = $("#sort-field");
    const sortDir = $("#sort-dir");
    const savedSortField = $("#saved-sort-field");
    const savedSortDir = $("#saved-sort-dir");
    const savedCountEl = $("#saved-count");
    const savedCountRailEl = $("#saved-count-rail");
    const savedGrid = $("#saved-grid");
    const savedEmpty = $("#saved-empty");
    const savedFilter = $("#saved-filter");
    const savedExportBtn = $("#saved-export-btn");
    const comboHeader = $("#combo-header");
    const comboHeaderTitle = $("#combo-header-title");
    const comboBackBtn = $("#combo-back-btn");
    const detailCombosBtn = $("#detail-combos-btn");
    const detailEdhrecBtn = $("#detail-edhrec-btn");
    const typeFilterEl = $("#type-filter");
    const savedTypeFilterEl = $("#saved-type-filter");
    const sideMenu = $("#side-menu");
    const folderRail = $("#folder-rail");
    const historyList = $("#history-list");
    const cacheList = $("#cache-list");
    const aiSummary = $("#ai-summary");
    const aiSummaryText = $("#ai-summary-text");
    const savePopover = $("#save-popover");
    const popList = $("#pop-list");
    const popAddBtn = $("#pop-add-btn");
    const popAddForm = $("#pop-add-form");
    const popAddInput = $("#pop-add-input");
    const cardContextMenu = $("#card-context-menu");
    const navCollapseBtn = $("#nav-collapse-btn");
    const detailCollapseBtn = $("#detail-collapse-btn");
    const ICON_RECENTS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>`;
    const ICON_WAND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9"/></svg>`;
    const ICON_LIST_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 12H3M16 6H3M16 18H3M18 9v6M21 12h-6"/></svg>`;
    const ICON_ADD_PLUS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
    const ICON_ADD_UPLOAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>`;
    const ICON_ADD_BINDER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6M9 13h6"/></svg>`;
    const ICON_FOLDER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
    const ICON_CHEVRON_LEFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`;
    // The rail header icon reflects the active tab: recents (clock) for Search, folder for Saved.
    function railModeIcon() { return state.activeTab === "saved" || state.activeTab === "collection" ? ICON_FOLDER : ICON_RECENTS; }
    function navPanelLabel() { return state.activeTab === "saved" ? "decks" : "recents"; }
    function updateNavCollapseButton() {
      const collapsed = appShell.classList.contains("nav-collapsed");
      const action = collapsed ? "Expand" : "Collapse";
      navCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
      navCollapseBtn.title = `${action} ${navPanelLabel()}`;
      navCollapseBtn.setAttribute("aria-label", navCollapseBtn.title);
      navCollapseBtn.innerHTML = collapsed ? railModeIcon() : ICON_CHEVRON_LEFT;
    }
    function updateRailIcon() {
      const saved = state.activeTab === "saved";
      const label = saved ? "Decks" : "Recents";
      const railIcon = $("#rail-icon");
      if (railIcon) { railIcon.innerHTML = railModeIcon(); railIcon.title = label; railIcon.setAttribute("aria-label", label); }
      updateNavCollapseButton();
    }
    const ICON_SORT_ASC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 5-6 6"/><path d="m12 5 6 6"/><path d="M12 5v14"/></svg>`;
    const ICON_SORT_DESC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-6-6"/><path d="m12 19 6-6"/><path d="M12 5v14"/></svg>`;

    function updateSortDirButton(btn, dir) {
      btn.dataset.dir = dir;
      btn.innerHTML = dir === "asc" ? ICON_SORT_ASC : ICON_SORT_DESC;
      btn.title = dir === "asc" ? "Ascending" : "Descending";
      btn.setAttribute("aria-label", btn.title);
    }

    migrateMembership();
    updateSavedCount();
    renderFolderRail();
    updateAiSearchToggle();
    updateSortDirButton(sortDir, state.sortDir);
    updateSortDirButton(savedSortDir, state.savedSortDir);
    loadApiSettings();

    // Color identity
    const identityDisplay = $("#identity-display");

    // Inline mana-symbol SVGs (from public/assets), colored via currentColor and
    // centered by preserveAspectRatio — avoids CSS-mask sub-pixel offset.
    const MANA_SVG = {
      w: "<svg class=\"mana-glyph\" viewBox=\"0 0 430.084 432.338\" preserveAspectRatio=\"xMidYMid meet\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M429.934 247.995c-29.609-16.683-48.547-25.025-56.889-25.025q-9.13 0-14.203 13.978c-3.382 9.319-10.221 13.903-20.441 13.903-4.208 0-12.7-1.503-25.626-4.509-7.215 10.972-10.822 18.036-10.822 21.042 0 4.208 3.081 9.093 9.319 14.804 6.237 5.712 11.423 8.492 15.706 8.492 2.706 0 6.388-.526 11.047-1.728 4.659-1.127 7.741-1.729 9.319-1.729 4.659 0 6.989 8.568 6.989 25.627 0 16.307-3.758 41.332-11.348 75.075-9.845-38.703-20.29-58.016-31.262-58.016-1.503 0-4.66 1.127-9.394 3.457-4.735 2.254-8.267 3.381-10.521 3.381-10.972 0-20.817-10.07-29.609-30.135-17.435 2.63-26.153 11.573-26.153 26.754 0 7.59 3.532 13.677 10.521 18.186 6.989 4.584 10.521 7.816 10.521 9.694 0 10.221-14.954 26.002-44.939 47.195-15.932 11.347-26.904 19.313-32.991 23.897 5.26-6.838 10.596-15.706 15.932-26.753 6.087-12.475 9.093-22.169 9.093-29.008 0-3.758-4.359-9.093-13.076-15.932q-13.076-10.258-13.076-21.643c0-6.463 2.254-14.429 6.838-23.898-4.96-5.711-10.821-8.567-17.66-8.567-15.18 0-22.771 4.96-22.771 14.805v15.33c.376 12.55-9.093 18.788-28.481 18.788-14.805 0-39.605-3.457-74.549-10.221 39.453-9.844 59.143-21.267 59.143-34.118 0 1.503-.752-3.006-2.255-13.677-1.503-11.724 6.839-22.395 25.025-31.864q-5.073-26.152-27.279-26.152c-2.255 0-6.463 3.983-12.475 11.949-6.087 7.966-11.724 11.949-17.059 11.949-9.093 0-20.892-9.845-35.246-29.609-6.838-9.845-17.284-24.424-31.262-43.813 8.717 4.584 17.435 9.093 26.152 13.677 11.348 5.336 20.516 7.966 27.28 7.966 5.335 0 10.521-4.659 15.631-13.978s11.874-13.978 20.215-13.978c1.127 0 8.718 2.255 22.771 6.839 7.214-10.972 10.821-19.163 10.821-24.499 0-4.584-2.78-9.769-8.266-15.631q-8.229-8.793-15.105-8.793c-1.879 0-4.81.602-8.793 1.729s-6.914 1.728-8.792 1.728c-6.839 0-10.221-8.567-10.221-25.626 0-4.584 4.359-30.511 13.076-77.931-.376 5.712 2.104 16.308 7.365 31.864 6.463 18.938 14.053 28.482 22.77 28.482 1.503 0 4.585-1.127 9.094-3.382 4.584-2.254 8.116-3.382 10.821-3.382 8.718 0 15.932 4.96 21.643 14.805l8.568 15.331c7.965 0 14.579-2.856 19.914-8.492 5.336-5.712 7.966-12.55 7.966-20.516 0-8.342-3.532-14.73-10.521-19.088-7.064-4.359-10.521-7.666-10.521-9.92 0-7.966 12.55-21.418 37.575-40.356C229.508 11.573 242.66 2.705 248.672 0c-16.308 22.019-24.499 38.101-24.499 48.321 0 5.336 3.231 10.972 9.694 17.059 7.966 7.215 12.55 12.325 13.677 15.331q5.637 13.076-1.127 35.846c10.221 7.215 18.036 10.822 23.297 10.822 10.972 0 16.458-5.711 16.458-17.059 0-1.127-.451-4.734-1.428-10.822s-1.203-9.469-.827-10.22c1.503-5.336 11.949-7.966 31.263-7.966 12.174 0 37.349 3.382 75.676 10.22-8.342 2.255-20.892 5.712-37.575 10.221q-22.771 6.876-22.771 15.331c0 2.63.977 7.214 2.856 13.677s2.856 11.197 2.856 14.203c0 5.336-3.382 10.221-10.221 14.805l-19.313 13.677c4.584 8.342 7.59 13.302 9.093 14.805 3.757 4.584 8.943 6.838 15.33 6.838 4.585 0 8.718-3.983 12.55-11.949 3.758-7.965 9.845-11.948 18.187-11.948 10.22 0 21.793 9.469 34.719 28.482 7.215 10.671 18.412 26.753 33.517 48.396m-126.252-32.991c0-24.273-8.943-45.315-26.754-63.126-17.81-17.81-38.852-26.753-63.126-26.753-24.649 0-45.916 8.792-63.727 26.453-17.811 17.66-26.904 38.777-27.28 63.426-.375 24.274 8.643 45.241 27.055 62.826 18.411 17.66 39.754 26.453 64.027 26.453 25.777 0 47.345-8.417 64.554-25.326 17.285-16.834 25.702-38.176 25.326-63.953m-8.567 0c0 23.147-7.741 42.31-23.297 57.415-15.556 15.18-34.869 22.77-58.016 22.77-22.394 0-41.558-7.74-57.414-23.296-15.932-15.556-23.898-34.494-23.898-56.889 0-22.019 8.041-40.881 24.198-56.588 16.158-15.706 35.171-23.597 57.19-23.597s41.032 7.966 57.189 23.898c16.082 15.932 24.198 34.719 24.198 56.287\" style=\"fill-rule:nonzero\"/></svg>",
      u: "<svg class=\"mana-glyph\" viewBox=\"0 0 225.944 362.9\" preserveAspectRatio=\"xMidYMid meet\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M193.602 329.953q-32.378 32.948-79.757 32.947c-35.448 0-63.569-12.129-84.371-36.403Q-.002 291.823 0 238.091c0-38.522 16.76-82.455 50.276-131.769C77.615 65.881 109.787 30.436 146.776 0c-5.397 24.66-8.085 42.182-8.085 52.584 0 23.893 7.503 47.196 22.527 69.927 18.496 26.964 32.548 47.014 42.19 60.096 15.024 22.741 22.536 44.887 22.536 66.448q0 47.973-32.345 80.899m-.582-123.374c-5.776-12.903-12.521-21.472-20.227-25.716 1.154 2.317 1.736 5.591 1.736 9.829 0 8.094-2.309 19.645-6.939 34.667l-7.503 23.118c0 13.482 6.727 20.227 20.218 20.227 14.248 0 21.382-9.446 21.382-28.321 0-9.622-2.886-20.885-8.667-33.808\" style=\"fill-rule:nonzero\"/></svg>",
      b: "<svg class=\"mana-glyph\" viewBox=\"0 0 367.108 380.936\" preserveAspectRatio=\"xMidYMid meet\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M366.883 184.193c0 24.875-9.018 41.859-27.129 50.877-5.261 2.63-21.869 6.237-49.75 10.746-18.111 3.006-27.129 9.995-27.129 20.892v45.766c0 1.879.601 7.741 1.728 17.51l1.729 18.111c0 5.637-1.353 14.88-3.983 27.731a2504 2504 0 0 1-24.875 5.11c-3.006-11.348-4.509-19.013-4.509-23.221 0-1.879.451-4.735 1.428-8.492.902-3.758 1.428-6.614 1.428-8.492 0-2.631-2.33-9.995-7.064-22.019h-8.793c-1.127 1.878-1.578 4.358-1.202 7.364 1.503 6.388 2.104 11.874 1.728 16.383-6.387 4.509-15.255 10.596-26.603 18.111-2.63-.751-3.607-1.127-2.856-1.127v-40.13q-1.127-2.818-5.636-2.255h-6.763l-6.764 53.132c-5.26.375-11.723.375-19.238 0-2.631-12.4-7.365-30.887-14.129-55.386h-4.509c-4.133 13.226-6.387 20.366-6.763 21.493 0 1.503.451 4.434 1.428 8.792.902 4.359 1.428 7.29 1.428 8.793 0 1.127-.376 3.983-1.128 8.492l-1.728 13.602c-.752.752-1.728 1.127-2.856 1.127-11.272 0-18.862-2.855-22.62-8.492-3.757-5.636-5.26-13.602-4.509-23.747l4.509-67.861q0-1.69 1.127-4.509c.752-1.878 1.128-3.231 1.128-3.983 0-3.006-3.232-9.018-9.62-18.111-1.127-.376-6.989-1.728-17.51-3.983q-9.581-2.254-37.875-7.891C13.001 233.642 0 212.75 0 175.776c0-55.01 22.62-100.851 67.86-137.374 1.879 10.145 5.111 23.747 9.62 40.731 3.381.752 10.746 2.48 22.019 5.11 2.254.752 13.752 4.885 34.493 12.475q-15.894-9.582-41.257-31.112c-6.388-7.515-9.619-20.14-9.619-37.876 0-4.133 7.139-9.018 21.493-14.729 12.775-5.261 22.47-8.267 28.857-9.018C153.832 1.353 169.463 0 180.435 0c47.119 0 85.221 12.099 114.228 36.222-9.393 10.972-25.626 22.621-48.622 35.02 9.094.376 22.245-3.156 39.604-10.746 17.36-7.515 24.725-11.273 22.019-11.273 3.006 0 9.094 6.012 18.112 18.111 6.763 9.018 12.249 17.135 16.382 24.349 12.024 21.493 20.141 44.714 24.349 69.589 0 8.718.15 14.88.601 18.637v4.509zM150.3 194.338c0-16.232-7.064-31.563-21.192-46.067s-29.309-21.793-45.541-21.793c-14.354 0-26.979 6.087-37.876 18.186-10.972 12.174-16.383 25.626-16.383 40.431 0 12.926 6.238 21.267 18.638 25.025 7.89 2.254 19.013 3.607 33.366 3.983h31.112c25.251.375 37.876-6.238 37.876-19.765m61.623 70.115v-17.51a572 572 0 0 1-7.891-15.255c-2.254-7.515-6.387-18.111-12.475-31.638l-6.237 66.132q0 7.89-3.382 7.89-2.255 0-3.381-1.127c-2.631-39.98-3.983-57.264-3.983-52.004v-19.764c-.752-1.127-1.654-1.729-2.781-1.729-12.851 13.227-19.238 34.494-19.238 63.878q0 24.348 4.509 29.985c3.006-.752 6.387-2.104 10.145-3.983 1.503-.752 5.862-1.127 13.001-1.127s15.856 2.254 26.002 6.763c3.757 0 5.636-10.145 5.636-30.511m127.83-78.757c0-15.18-5.636-28.707-16.984-40.656-11.347-11.949-24.348-17.886-39.002-17.886-15.857 0-30.662 7.214-44.414 21.794-13.753 14.504-20.666 29.684-20.666 45.541 0 13.226 6.387 19.764 19.238 19.764h65.005c24.499-.376 36.748-9.845 36.748-28.482\" style=\"fill-rule:nonzero\"/></svg>",
      r: "<svg class=\"mana-glyph\" viewBox=\"0 0 347.72 387.035\" preserveAspectRatio=\"xMidYMid meet\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M341.482 269.789c-16.833 40.206-50.35 60.271-100.4 60.271-9.169 0-19.163 1.127-29.835 3.457-16.082 3.457-24.123 8.266-24.123 14.353 0 1.879 1.353 4.134 3.983 6.614 2.705 2.48 4.96 3.757 6.914 3.757-9.544 0-3.081.301 19.539.827 22.62.601 36.748.826 42.46.826-33.292 19.539-88.978 28.482-167.059 26.979-25.626-.375-47.645-11.648-65.982-33.892C8.943 331.939 0 308.417 0 282.415c0-27.505 9.244-50.952 27.881-70.341 18.562-19.313 41.633-29.008 69.138-29.008 6.087 0 14.279 1.353 24.424 3.983 10.145 2.706 16.909 3.983 20.365 3.983 14.129 0 31.789-5.862 52.831-17.51s31.037-17.51 29.835-17.51c-3.833 40.205-17.21 67.184-40.206 80.937-16.458 9.544-24.649 18.938-24.649 28.106 0 5.711 3.457 10.371 10.296 13.752q8.003 4.059 17.81 4.059c9.92 0 19.69-6.088 29.309-18.337 9.544-12.25 13.752-23.372 12.625-33.292-1.127-11.498-.376-25.25 2.33-41.332q1.127-6.876 8.341-16.909c4.81-6.688 9.093-10.822 12.926-12.325 0 3.457-1.202 9.169-3.757 17.21-2.48 8.041-3.758 13.978-3.758 17.81 0 8.417 2.255 14.955 6.914 19.539 6.914-2.705 13.001-11.272 18.337-25.851 4.584-11.122 7.289-21.794 8.041-32.164-16.083-.752-31.488-8.042-46.218-21.794-14.729-13.752-22.094-28.707-22.094-44.789 0-2.706.376-5.336 1.127-8.042 2.255 3.457 5.712 8.793 10.296 16.083 6.538 9.544 11.498 14.353 14.955 14.353 4.584 0 6.914-4.809 6.914-14.353 0-12.25-3.232-23.372-9.77-33.292-7.289-11.874-16.683-17.811-28.106-17.811-5.336 0-13.377 2.856-24.123 8.643-10.747 5.711-20.516 8.642-29.309 8.642q-4.058 0-35.621-10.371c37.124-6.087 55.686-11.648 55.686-16.608 0-13.001-25.476-21.793-76.352-26.378-4.96-.375-14.128-1.127-27.58-2.329q2.254-2.818 32.69-6.313C118.737.977 130.837 0 137.675 0c91.082 0 148.873 44.189 173.372 132.64 4.208-3.456 6.312-9.318 6.312-17.434 0-10.446-3.081-23.673-9.168-39.605-2.33-6.162-5.937-15.48-10.897-27.955 31.338 39.98 47.044 77.855 47.044 113.627 0 18.862-4.434 35.921-13.226 51.327-5.712 10.371-16.458 23.672-32.165 39.83-15.706 16.157-26.377 28.632-32.164 37.5 21.042-5.712 34.87-10.146 41.333-13.227 14.504-6.463 27.73-16.232 39.604-29.308 0 4.96-2.104 12.475-6.313 22.394M91.232 44.189c0 6.914-3.832 11.272-11.498 13.226l-14.954 2.33c-5.336 2.705-13.227 13.226-23.522 31.563q-1.691-8.568-5.186-24.123c-3.457.375-9.168 3.457-17.209 9.168-3.457 2.705-9.018 6.688-16.683 12.024 2.329-13.752 9.919-27.73 22.995-41.934C38.928 30.737 52.38 22.921 65.381 22.921c17.209 0 25.851 7.064 25.851 21.268m99.875 52.83c0 6.538-3.532 11.949-10.596 16.383s-14.053 6.613-20.967 6.613c-9.168 0-17.435-5.185-24.649-15.481-8.793-12.625-17.811-20.816-26.979-24.724 1.879-1.879 4.208-2.856 6.914-2.856 3.456 0 9.243 2.706 17.51 8.041 8.191 5.336 13.451 8.041 15.781 8.041 1.879 0 5.035-2.705 9.469-8.041 4.434-5.335 9.243-8.041 14.654-8.041q18.938 0 18.938 20.065\" style=\"fill-rule:nonzero\"/></svg>",
      g: "<svg class=\"mana-glyph\" viewBox=\"0 0 393.786 400.476\" preserveAspectRatio=\"xMidYMid meet\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M393.711 224.699c0 7.515-2.931 14.279-8.717 20.291s-12.475 9.018-19.99 9.018c-12.024 0-20.817-5.636-26.453-16.909l-26.453-1.127c-5.636 0-16.758 2.48-33.216 7.365-17.661 4.884-27.806 8.792-30.436 11.798q-6.2 6.763-10.145 31.563c-2.255 13.527-3.382 23.447-3.382 29.835 0 10.145 1.578 17.585 4.81 22.244 3.231 4.66 9.769 8.643 19.689 11.799s16.082 4.96 18.337 5.335c1.503 0 3.907-.15 7.364-.526h6.764c4.885 0 9.92.752 15.18 2.255 7.515 2.254 10.747 5.26 9.619 9.018-5.26-.752-14.429.376-27.58 3.382l15.782 7.89q0 6.764-19.164 6.764c-3.381 0-7.965-.752-13.827-2.255-5.787-1.503-9.695-2.254-11.573-2.254h-7.29q-.564 5.636-3.382 16.909-9.58-.564-22.545-11.273c-8.642-7.139-14.053-10.671-16.307-10.671-2.255 0-5.486 3.607-9.544 10.671-4.134 7.139-6.163 12.024-6.163 14.655q-7.327-3.947-12.399-14.655c-1.503-4.885-3.157-9.769-5.035-14.654-3.758.376-10.672 8.266-20.817 23.672h-2.856c-.751-1.127-3.607-9.018-8.417-23.672q-17.472-5.637-32.69-5.636-7.327 0-22.545 3.381l-15.781-1.127c2.254-2.254 8.792-6.538 19.689-12.926q19.163-11.272 29.308-11.272c1.128 0 2.631.225 4.509.601s3.382.601 4.509.601c2.631 0 6.839-1.428 12.701-4.208 5.786-2.781 9.168-5.336 10.145-7.59.977-2.255 1.428-8.117 1.428-17.435 0-21.418-5.636-37.35-16.909-47.871q-14.654-14.09-48.472-20.29c-6.012 21.417-22.92 32.089-50.651 32.089-9.018 0-18.036-5.411-27.054-16.308C4.509 252.054 0 242.134 0 233.116c0-13.903 5.786-25.325 17.434-34.343-9.393-9.77-14.053-19.69-14.053-29.835 0-9.394 2.931-17.66 8.718-24.8 5.786-7.139 13.452-11.272 22.845-12.399-.751-12.024 3.157-20.291 11.799-24.8-4.133-4.133-6.162-11.423-6.162-21.944 0-12.4 4.133-22.695 12.399-30.962 8.267-8.266 18.563-12.399 30.962-12.399 13.527 0 24.574 4.734 33.217 14.128C128.055 18.563 151.502 0 187.574 0q28.182 0 49.599 22.545 7.891 8.456 7.891 9.018c-4.509 0-2.254-.826 6.764-2.555 9.018-1.653 15.556-2.555 19.689-2.555 14.654 0 27.58 5.411 38.853 16.308q14.654 14.654 20.29 37.199 3.946.564 12.4 3.382 12.4 6.2 12.4 21.418c0 1.878-1.503 5.486-4.509 10.671q36.072 20.29 36.072 56.363 0 10.145-7.891 28.181 14.654 8.454 14.654 24.799m-232.063 24.8v-7.29c0-8.642-4.209-16.533-12.701-23.672-8.416-7.139-16.984-10.671-25.626-10.671-10.521 0-20.29 2.405-29.308 7.289 19.914-1.127 42.459 10.371 67.56 34.344m-10.146-69.814c-5.636-6.388-10.521-12.926-14.654-19.69-15.782 4.133-23.672 8.793-23.672 14.053 4.509-.375 11.047.451 19.689 2.555s14.805 3.082 18.637 3.082m34.344-17.435v-24.8c-9.018-1.503-14.504-2.254-16.308-2.254v8.416l16.308 18.563m73.196-15.782c-4.509-1.879-12.926-5.636-25.325-11.272v48.471c17.66-10.145 26.077-22.545 25.325-37.199m30.962 66.508-12.4-15.18a4706 4706 0 0 0-22.845 16.082c-7.741 5.411-14.354 11.573-19.99 18.336 16.908-9.018 35.32-15.405 55.16-19.163\" style=\"fill-rule:nonzero\"/></svg>",
      c: "<svg class=\"mana-glyph\" viewBox=\"10 10 80 80\" preserveAspectRatio=\"xMidYMid meet\" fill=\"currentColor\" aria-hidden=\"true\"><path fill-rule=\"evenodd\" d=\"M49.687 12.026c2.475 4.968 5.504 9.793 9.096 14.475 1.528 1.966 3.279 4.021 5.254 6.147 1.948 2.126 4.11 4.253 6.451 6.344 2.359 2.091 4.941 4.074 7.756 5.951 2.815 1.876 5.843 3.592 9.096 5.129-4.78 2.556-9.516 5.665-14.225 9.346-1.956 1.537-4.003 3.306-6.147 5.325-2.126 2.002-4.217 4.2-6.263 6.576-2.046 2.412-4.012 5.004-5.897 7.827-1.877 2.806-3.583 5.79-5.12 8.953-2.395-4.7-5.379-9.346-8.962-13.956-3.074-3.931-6.96-8.059-11.66-12.42-4.691-4.36-10.373-8.238-17.03-11.651 4.789-2.484 9.525-5.557 14.224-9.221 4.012-3.163 8.149-7.112 12.411-11.848 4.27-4.736 7.933-10.383 11.016-16.977zM52.444 31.013c1.238 2.484 2.752 4.896 4.548 7.237 0.764 0.983 1.639 2.010 2.627 3.074 0.974 1.063 2.055 2.127 3.225 3.172 1.179 1.046 2.470 2.037 3.878 2.975 1.407 0.938 2.921 1.796 4.548 2.564-2.390 1.278-4.758 2.833-7.112 4.673-0.978 0.768-2.002 1.653-3.074 2.663-1.063 1.001-2.108 2.100-3.131 3.288-1.023 1.206-2.006 2.502-2.949 3.913-0.939 1.403-1.792 2.895-2.560 4.476-1.198-2.350-2.689-4.673-4.481-6.978-1.537-1.966-3.480-4.029-5.830-6.210-2.345-2.180-5.186-4.119-8.515-5.825 2.394-1.242 4.763-2.779 7.112-4.611 2.006-1.581 4.074-3.556 6.205-5.924 2.135-2.368 3.966-5.191 5.508-8.489z\"/></svg>",
    };

    function updateIdentityDisplay() {
      const id = state.colorIdentity.join("").toUpperCase();
      identityDisplay.textContent = id;
      document.querySelectorAll("#search-content .color-toggle").forEach((btn) => {
        const on = state.colorIdentity.includes(btn.dataset.color);
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-pressed", String(on));
      });
    }

    document.querySelectorAll("#search-content .color-toggle").forEach((btn) => {
      const svg = MANA_SVG[btn.dataset.color];
      if (svg) btn.innerHTML = svg;
      btn.addEventListener("click", () => {
        state.colorIdentity = toggleIdentityColor(state.colorIdentity, btn.dataset.color);
        updateIdentityDisplay(); // colour identity is session-only — not persisted or synced
      });
    });

    updateIdentityDisplay();

    // Tabs
    function setActiveTab(tab) {
      state.activeTab = tab;
      document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(`[data-tab="${tab}"]`).forEach((b) => b.classList.add("active"));
      sideMenu.classList.remove("search-mode", "saved-mode", "collection-mode");
      sideMenu.classList.add(tab === "saved" ? "saved-mode" : tab === "collection" ? "collection-mode" : "search-mode");
      updateRailIcon();
      if (typeof closeSwapsView === "function") closeSwapsView();
      $("#search-content").classList.toggle("hidden", tab !== "search");
      $("#saved-section").classList.toggle("visible", tab === "saved");
      $("#collection-section").classList.toggle("visible", tab === "collection");
      if (tab === "saved") renderSavedCards();
      if (tab === "collection") openCollectionTab();
    }

    document.querySelectorAll(".tab-btn, .rail-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActiveTab(btn.dataset.tab);
      });
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector(".af-scrim:not([hidden]), .modal-overlay.visible, .card-lightbox:not([hidden])")) return;
      const box = { search: "#search-input", saved: "#saved-filter", collection: "#collection-filter" }[state.activeTab];
      const el = box && $(box);
      if (!el) return;
      e.preventDefault();
      el.focus();
      el.select?.();
    });

    // Settings
    $("#settings-btn").addEventListener("click", showSettings);
    $("#settings-cancel").addEventListener("click", hideSettings);
    $("#settings-save").addEventListener("click", async () => {
      await saveApiSettings({
        preferredAiProvider: $("#preferred-ai-provider").value,
        anthropicApiKey: $("#anthropic-api-key-input").value.trim(),
        openaiApiKey: $("#openai-api-key-input").value.trim(),
        anthropicModel: $("#anthropic-model-input").value.trim(),
        openaiModel: $("#openai-model-input").value.trim(),
        playmatUrl: $("#playmat-url-input").value.trim(),
      });
    });

    async function loadApiSettings() {
      const localKey = localStorage.getItem("claude_api_key") || "";
      if (localKey) {
        await saveApiSettings({ anthropicApiKey: localKey }, { migrated: true });
        localStorage.removeItem("claude_api_key");
      }
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error("Could not load settings");
        const data = await res.json();
        applyApiSettings(data);
      } catch (err) {
        console.warn(err);
      }
      if (!state.hasApiKey) showSettings();
    }

    function applyApiSettings(data) {
      state.aiSettings = data || null;
      state.hasApiKey = Boolean(data?.hasApiKey);
      renderSearchHistory();
      renderCacheList();
    }

    function providerStatusText(provider) {
      const source = provider?.source || "none";
      if (!provider?.hasApiKey) return "Not set";
      return source === "environment" ? "Env key" : "Saved key";
    }

    function paintProviderStatus(id, provider) {
      const el = $(id);
      if (!el) return;
      el.textContent = providerStatusText(provider);
      el.classList.toggle("ready", Boolean(provider?.hasApiKey));
      el.classList.toggle("missing", !provider?.hasApiKey);
    }

    async function saveApiSettings(payload, options = {}) {
      const body = {};
      if (payload.preferredAiProvider) body.preferredAiProvider = payload.preferredAiProvider;
      if (payload.anthropicApiKey) body.anthropicApiKey = payload.anthropicApiKey;
      if (payload.openaiApiKey) body.openaiApiKey = payload.openaiApiKey;
      if (payload.anthropicModel) body.anthropicModel = payload.anthropicModel;
      if (payload.openaiModel) body.openaiModel = payload.openaiModel;
      if (typeof payload.playmatUrl === "string") body.playmatUrl = payload.playmatUrl;
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showStatus(err.error || "Could not save settings", true);
        return;
      }
      applyApiSettings(await res.json());
      localStorage.removeItem("claude_api_key");
      if (!options.migrated) hideSettings();
    }

    // Select a model in a provider dropdown; if the saved value isn't a listed
    // option (a custom or older model), add it so it still shows and persists.
    function setModelSelect(sel, value, fallback) {
      const el = $(sel);
      if (!el) return;
      const v = value || fallback;
      if (v && !Array.from(el.options).some((o) => o.value === v)) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v + " · custom";
        el.insertBefore(opt, el.firstChild);
      }
      el.value = v;
    }

    function showSettings() {
      const settings = state.aiSettings || {};
      const providers = settings.providers || {};
      $("#preferred-ai-provider").value = settings.preferredAiProvider || "anthropic";
      $("#anthropic-api-key-input").value = "";
      $("#openai-api-key-input").value = "";
      $("#playmat-url-input").value = settings.playmatUrl || "";
      setModelSelect("#anthropic-model-input", providers.anthropic?.model, "claude-sonnet-5-5");
      setModelSelect("#openai-model-input", providers.openai?.model, "gpt-6.1-sol");
      paintProviderStatus("#anthropic-key-status", providers.anthropic);
      paintProviderStatus("#openai-key-status", providers.openai);
      $("#settings-modal").classList.add("visible");
    }
    function hideSettings() { $("#settings-modal").classList.remove("visible"); }

    // Search
    function autoSizeSearchInput() {
      searchInput.style.height = "auto";
      searchInput.style.height = `${Math.min(searchInput.scrollHeight, 132)}px`;
    }

    searchInput.addEventListener("input", autoSizeSearchInput);
    searchInput.addEventListener("keydown", (e) => {
      // Enter submits; Shift+Enter (or Ctrl/Cmd+Enter) adds a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSearch();
      }
    });
    searchBtn.addEventListener("click", doSearch);
    aiSearchToggle.addEventListener("click", () => {
      state.forceAiSearch = !state.forceAiSearch;
      lsSet("force_ai_search", JSON.stringify(state.forceAiSearch));
      updateAiSearchToggle();
      queueOp({ type: "setSettings", forceAiSearch: state.forceAiSearch });
    });
    autoSizeSearchInput();

    historyList.addEventListener("click", (e) => {
      const removeBtn = e.target.closest(".history-remove");
      if (removeBtn) {
        removeSearch(removeBtn.dataset.query || "", removeBtn.dataset.ci || "", removeBtn.dataset.forceAi === "true", removeBtn.dataset.cacheKey || "");
        return;
      }
      const btn = e.target.closest(".history-btn");
      if (!btn) return;
      runHistorySearch(btn.dataset.query || "", btn.dataset.ci || "", btn.dataset.forceAi === "true");
    });

    cacheList.addEventListener("click", (e) => {
      const btn = e.target.closest(".cache-btn");
      if (!btn) return;
      runHistorySearch(btn.dataset.query || "", btn.dataset.ci || "", btn.dataset.forceAi === "true");
    });

    // Side panels blur + fade their contents: closing fades out first, then collapses (the
    // contents become display:none, which can't animate); opening expands, then blurs in.
    const PANEL_FADE_MS = 170;
    const PANEL_WIDEN_MS = 230; // matches the .app-shell grid-template-columns transition (0.22s)
    const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    function togglePanel(panel, cls, onDone) {
      if (panel._panelAnim) return; // ignore clicks mid-animation
      const closing = !appShell.classList.contains(cls);
      if (reduceMotion()) { appShell.classList.toggle(cls); onDone(); return; }
      if (closing) {
        panel._panelAnim = true;
        panel.classList.add("panel-fading-out");
        setTimeout(() => {
          appShell.classList.add(cls);
          panel.classList.remove("panel-fading-out");
          panel._panelAnim = false;
          onDone();
        }, PANEL_FADE_MS);
      } else {
        // Widen first with the contents hidden and skipped by layout (no text re-wrapping
        // every frame), then blur them in once the column has reached its full width.
        panel._panelAnim = true;
        panel.classList.remove("panel-fading-in");
        panel.classList.add("panel-opening");
        appShell.classList.remove(cls);
        onDone();
        setTimeout(() => {
          panel.classList.remove("panel-opening");
          panel.classList.add("panel-fading-in");
          panel._panelAnim = false;
          setTimeout(() => panel.classList.remove("panel-fading-in"), 380);
        }, PANEL_WIDEN_MS);
      }
    }

    navCollapseBtn.addEventListener("click", () => {
      togglePanel($(".side-menu"), "nav-collapsed", updateNavCollapseButton);
    });

    detailCollapseBtn.addEventListener("click", () => togglePanel($(".detail-panel"), "detail-collapsed", () => {
      const collapsed = appShell.classList.contains("detail-collapsed");
      detailCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
      detailCollapseBtn.title = collapsed ? "Expand focus" : "Collapse focus";
      detailCollapseBtn.setAttribute("aria-label", detailCollapseBtn.title);
      detailCollapseBtn.innerHTML = collapsed
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
    }));

