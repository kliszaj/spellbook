    // ── Cache the AI's /api/translate response (skips Claude + web search on repeat asks) ──
    const TRANSLATE_CACHE_KEY = "translate_cache_v1";
    const SEARCH_HISTORY_KEY = "search_history_v1";
    const TRANSLATE_CACHE_MAX = 60;
    const SEARCH_HISTORY_MAX = 10;
    const TRANSLATE_CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days
    function activeAiCacheKey() {
      const provider = state.aiSettings?.preferredAiProvider || "anthropic";
      const model = state.aiSettings?.providers?.[provider]?.model || "";
      return `${provider}:${model}`;
    }
    const translateCacheKey = (q, ci, forceAi = false, aiKey = activeAiCacheKey()) => `${aiKey}|${forceAi ? "ai" : "query"}|${ci || ""}|${q.trim().toLowerCase().replace(/\s+/g, " ")}`;
    const legacyTranslateCacheKey = (q, ci, forceAi = false) => `${forceAi ? "ai" : "query"}|${ci || ""}|${q.trim().toLowerCase().replace(/\s+/g, " ")}`;
    function historyAiCacheKey(item) {
      return item?.provider ? `${item.provider}:${item.model || ""}` : activeAiCacheKey();
    }
    function historyCacheKey(item) {
      return translateCacheKey(item?.q || "", item?.ci || "", !!item?.forceAi, historyAiCacheKey(item));
    }
    function sameSearchIdentity(item, q, ci, forceAi) {
      return legacyTranslateCacheKey(item?.q || "", item?.ci || "", !!item?.forceAi) === legacyTranslateCacheKey(q, ci, forceAi);
    }
    function readTranslateCache() { try { return JSON.parse(localStorage.getItem(TRANSLATE_CACHE_KEY) || "{}"); } catch { return {}; } }
    function readSearchHistory() { try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]"); } catch { return []; } }
    function updateAiSearchToggle() {
      aiSearchToggle.classList.toggle("active", state.forceAiSearch);
      const bar = aiSearchToggle.closest(".search-bar");
      bar?.classList.toggle("ai-active", state.forceAiSearch);
      aiSearchToggle.setAttribute("aria-pressed", String(state.forceAiSearch));
      aiSearchToggle.title = state.forceAiSearch ? "AI web search on" : "Force AI web search";
      aiSearchToggle.setAttribute("aria-label", aiSearchToggle.title);
      setSearchGlowRunning(state.forceAiSearch);
    }

    function setSearchGlowRunning(active) {
      const bar = aiSearchToggle.closest(".search-bar");
      if (!bar) return;
      if (!active || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        if (searchGlowFrame) cancelAnimationFrame(searchGlowFrame);
        searchGlowFrame = null;
        bar.style.setProperty("--edge-proximity", active ? "86" : "0");
        bar.style.setProperty("--cursor-angle", "110deg");
        return;
      }
      if (searchGlowFrame) return;
      const start = performance.now();
      const tick = (now) => {
        const lap = ((now - start) % 6200) / 6200;
        const angle = 110 + lap * 360;
        const pulse = 88 + Math.sin(lap * Math.PI * 2) * 5;
        bar.style.setProperty("--cursor-angle", `${angle.toFixed(2)}deg`);
        bar.style.setProperty("--edge-proximity", pulse.toFixed(2));
        searchGlowFrame = requestAnimationFrame(tick);
      };
      searchGlowFrame = requestAnimationFrame(tick);
    }
    function getCachedTranslate(q, ci, forceAi) {
      const c = readTranslateCache(); const hit = c[translateCacheKey(q, ci, forceAi)];
      return hit && (Date.now() - hit.ts) < TRANSLATE_CACHE_TTL ? hit.data : null;
    }
    function putCachedTranslate(q, ci, forceAi, data) {
      const c = readTranslateCache();
      c[translateCacheKey(q, ci, forceAi)] = { ts: Date.now(), data };
      const keys = Object.keys(c);
      if (keys.length > TRANSLATE_CACHE_MAX) {
        keys.sort((a, b) => c[a].ts - c[b].ts).slice(0, keys.length - TRANSLATE_CACHE_MAX).forEach((k) => delete c[k]);
      }
      try { lsSet(TRANSLATE_CACHE_KEY, JSON.stringify(c)); } catch {}
      renderCacheList();
      queueOp({ type: "setCaches", translateCache: readTranslateCache() });
    }
    function rememberSearch(q, ci, forceAi, data) {
      const provider = state.aiSettings?.preferredAiProvider || "anthropic";
      const model = state.aiSettings?.providers?.[provider]?.model || "";
      const item = { q, ci: ci || "", forceAi: !!forceAi, type: data?.type || "query", provider, model, ts: Date.now() };
      const history = readSearchHistory().filter((h) => historyCacheKey(h) !== historyCacheKey(item));
      history.unshift(item);
      try { lsSet(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, SEARCH_HISTORY_MAX))); } catch {}
      renderSearchHistory();
      queueOp({ type: "setCaches", searchHistory: readSearchHistory() });
    }
    function removeSearch(q, ci, forceAi, exactKey = "") {
      const candidateKeys = new Set([
        exactKey,
        translateCacheKey(q, ci, forceAi),
        legacyTranslateCacheKey(q, ci, forceAi),
      ].filter(Boolean));
      const history = readSearchHistory().filter((h) => !sameSearchIdentity(h, q, ci, forceAi));
      const cache = readTranslateCache();
      for (const key of Object.keys(cache)) {
        const d = cacheDisplayKey(key);
        if (candidateKeys.has(key) || sameSearchIdentity(d, q, ci, forceAi)) delete cache[key];
      }
      try { lsSet(SEARCH_HISTORY_KEY, JSON.stringify(history)); } catch {}
      try { lsSet(TRANSLATE_CACHE_KEY, JSON.stringify(cache)); } catch {}
      renderSearchHistory();
      renderCacheList();
      queueOp({ type: "setCaches", searchHistory: readSearchHistory(), translateCache: readTranslateCache() });
    }
    function runHistorySearch(q, ci, forceAi) {
      searchInput.value = q;
      autoSizeSearchInput();
      state.forceAiSearch = !!forceAi;
      lsSet("force_ai_search", JSON.stringify(state.forceAiSearch));
      updateAiSearchToggle();
      state.colorIdentity = (ci || "").split("").filter(Boolean); // session-only, not persisted
      updateIdentityDisplay();
      queueOp({ type: "setSettings", forceAiSearch: state.forceAiSearch });
      setActiveTab("search");
      doSearch();
    }
    function cacheDisplayKey(key) {
      const parts = key.split("|");
      if (parts.length >= 4 && parts[0].includes(":")) {
        return { aiKey: parts[0], forceAi: parts[1] === "ai", ci: parts[2], q: parts.slice(3).join("|") };
      }
      return parts.length >= 3
        ? { aiKey: "", forceAi: parts[0] === "ai", ci: parts[1], q: parts.slice(2).join("|") }
        : { forceAi: false, ci: parts[0], q: parts.slice(1).join("|") };
    }
    function cacheMatchesActiveProvider(key) {
      const d = cacheDisplayKey(key);
      return !d.aiKey || d.aiKey === activeAiCacheKey();
    }
    function renderSearchHistory() {
      const cache = readTranslateCache();
      const cacheItems = Object.entries(cache)
        .filter(([, v]) => v && (Date.now() - v.ts) < TRANSLATE_CACHE_TTL)
        .filter(([key]) => cacheMatchesActiveProvider(key))
        .map(([key, v]) => ({ ...cacheDisplayKey(key), cacheKey: key, ts: v.ts, cached: true }));
      const seen = new Set();
      const items = [...readSearchHistory().map((h) => {
          const key = historyCacheKey(h);
          return { ...h, cacheKey: key, cached: !!cache[key] || !!cache[legacyTranslateCacheKey(h.q || "", h.ci || "", !!h.forceAi)] };
        }), ...cacheItems]
        .filter((h) => {
          const key = h.cacheKey || historyCacheKey(h);
          if (!h.q || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, SEARCH_HISTORY_MAX);
      if (!items.length) {
        historyList.innerHTML = `<div class="rail-empty">Recent searches appear here.</div>`;
        return;
      }
      historyList.innerHTML = items.map((h) => `
        <div class="history-row">
          <button class="history-btn" data-query="${esc(h.q || "")}" data-ci="${esc(h.ci || "")}" data-force-ai="${h.forceAi ? "true" : "false"}">
            <span>${esc(h.q || "")}</span>
          </button>
          <button class="history-remove" data-query="${esc(h.q || "")}" data-ci="${esc(h.ci || "")}" data-force-ai="${h.forceAi ? "true" : "false"}" data-cache-key="${esc(h.cacheKey || "")}" title="Remove" aria-label="Remove ${esc(h.q || "search")}">&times;</button>
        </div>`).join("");
    }
    function renderCacheList() {
      const cache = readTranslateCache();
      const entries = Object.entries(cache)
        .filter(([, v]) => v && (Date.now() - v.ts) < TRANSLATE_CACHE_TTL)
        .filter(([key]) => cacheMatchesActiveProvider(key))
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, 8);
      if (!entries.length) {
        cacheList.innerHTML = `<div class="rail-empty">Cached translations will show up here.</div>`;
        return;
      }
      cacheList.innerHTML = entries.map(([key, v]) => {
        const d = cacheDisplayKey(key);
        const label = d.q || "cached search";
        const type = v.data?.type === "cards" ? "AI picks" : "query";
        return `<button class="cache-btn" data-query="${esc(label)}" data-ci="${esc(d.ci || "")}" data-force-ai="${d.forceAi ? "true" : "false"}">
          <span>${esc(label)}</span>
          <span class="cache-meta">${type}</span>
        </button>`;
      }).join("");
    }
    renderSearchHistory();
    renderCacheList();
    loadAppState();

    function currentAppStatePayload() {
      return {
        savedCards: state.savedCards,
        folders: state.folders,
        membership: state.membership,
        quantities: state.quantities,
        maybeboard: state.maybeboard,
        pins: state.pins,
        deckNotes: state.deckNotes,
        colorIdentity: state.colorIdentity,
        translateCache: readTranslateCache(),
        searchHistory: readSearchHistory(),
        forceAiSearch: state.forceAiSearch,
      };
    }

    function hasUsefulAppState(data) {
      return Boolean(
        (Array.isArray(data.savedCards) && data.savedCards.length) ||
        (Array.isArray(data.folders) && data.folders.length) ||
        (data.membership && typeof data.membership === "object" && Object.keys(data.membership).length) ||
        (data.quantities && typeof data.quantities === "object" && Object.keys(data.quantities).length) ||
        (data.maybeboard && typeof data.maybeboard === "object" && Object.keys(data.maybeboard).length) ||
        (data.pins && typeof data.pins === "object" && Object.keys(data.pins).length) ||
        (data.deckNotes && typeof data.deckNotes === "object" && Object.keys(data.deckNotes).length) ||
        (Array.isArray(data.colorIdentity) && data.colorIdentity.length) ||
        data.forceAiSearch ||
        (data.translateCache && typeof data.translateCache === "object" && Object.keys(data.translateCache).length) ||
        (Array.isArray(data.searchHistory) && data.searchHistory.length)
      );
    }

    function applyAppState(data) {
      if (!data || typeof data !== "object") return;
      if (Array.isArray(data.savedCards)) {
        state.savedCards = data.savedCards;
        lsSet("saved_cards", JSON.stringify(state.savedCards));
      }
      if (Array.isArray(data.folders)) {
        state.folders = data.folders;
        lsSet("card_folders", JSON.stringify(state.folders));
      }
      if (data.membership && typeof data.membership === "object") {
        state.membership = data.membership;
        lsSet("card_membership", JSON.stringify(state.membership));
      }
      if (data.quantities && typeof data.quantities === "object") {
        state.quantities = data.quantities;
        lsSet("card_quantities", JSON.stringify(state.quantities));
      }
      if (data.maybeboard && typeof data.maybeboard === "object") {
        state.maybeboard = data.maybeboard;
        lsSet("card_maybeboard", JSON.stringify(state.maybeboard));
      }
      if (data.pins && typeof data.pins === "object") {
        state.pins = data.pins;
        lsSet("card_pins", JSON.stringify(state.pins));
      }
      if (data.deckNotes && typeof data.deckNotes === "object") {
        state.deckNotes = data.deckNotes;
        lsSet("deck_notes", JSON.stringify(state.deckNotes));
      }
      // colorIdentity is intentionally NOT restored here — it stays session-only.
      if (typeof data.forceAiSearch === "boolean") {
        state.forceAiSearch = data.forceAiSearch;
        lsSet("force_ai_search", JSON.stringify(state.forceAiSearch));
      }
      if (data.translateCache && typeof data.translateCache === "object") {
        lsSet(TRANSLATE_CACHE_KEY, JSON.stringify(data.translateCache));
      }
      if (Array.isArray(data.searchHistory)) {
        lsSet(SEARCH_HISTORY_KEY, JSON.stringify(data.searchHistory));
      }
      migrateMembership();
      retireUnsorted();
      updateIdentityDisplay();
      updateAiSearchToggle();
      updateSavedCount();
      renderFolderRail();
      renderSearchHistory();
      renderCacheList();
      if (state.activeTab === "saved") renderSavedCards();
    }

    function mergeById(a = [], b = []) {
      const merged = new Map();
      [...a, ...b].forEach((item) => {
        if (item && item.id) merged.set(item.id, { ...merged.get(item.id), ...item });
      });
      return [...merged.values()];
    }

    function mergeMembership(a, b) {
      const merged = {};
      [a, b].forEach((source) => {
        if (!source || typeof source !== "object") return;
        Object.entries(source).forEach(([cardId, folders]) => {
          const next = new Set(merged[cardId] || []);
          (Array.isArray(folders) ? folders : []).forEach((folderId) => next.add(folderId));
          merged[cardId] = [...next];
        });
      });
      return Object.keys(merged).length ? merged : null;
    }

    // Per-folder basic-land counts. Union folders; within a folder, b (local) wins.
    function mergeQuantities(a, b) {
      const merged = {};
      [a, b].forEach((source) => {
        if (!source || typeof source !== "object") return;
        Object.entries(source).forEach(([folderId, counts]) => {
          if (!counts || typeof counts !== "object") return;
          merged[folderId] = { ...(merged[folderId] || {}), ...counts };
        });
      });
      return merged;
    }

    // Per-deck Maybeboard flags. Union folders; within a folder, b (local) wins.
    function mergeMaybeboard(a, b) {
      const merged = {};
      [a, b].forEach((source) => {
        if (!source || typeof source !== "object") return;
        Object.entries(source).forEach(([folderId, flags]) => {
          if (!flags || typeof flags !== "object") return;
          merged[folderId] = { ...(merged[folderId] || {}), ...flags };
        });
      });
      return merged;
    }

    function mergeTranslateCache(a = {}, b = {}) {
      const merged = { ...a };
      Object.entries(b || {}).forEach(([key, value]) => {
        if (!merged[key] || (value?.ts || 0) > (merged[key]?.ts || 0)) merged[key] = value;
      });
      return merged;
    }

    function mergeSearchHistory(a = [], b = []) {
      const merged = new Map();
      [...a, ...b].forEach((item) => {
        if (!item || !item.q) return;
        const key = translateCacheKey(item.q || "", item.ci || "", !!item.forceAi);
        if (!merged.has(key) || (item.ts || 0) > (merged.get(key).ts || 0)) merged.set(key, item);
      });
      return [...merged.values()].sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, SEARCH_HISTORY_MAX);
    }

    function mergeAppState(localState, serverState) {
      localState = localState || {};
      serverState = serverState || {};
      return {
        savedCards: mergeById(serverState.savedCards, localState.savedCards),
        folders: mergeById(serverState.folders, localState.folders),
        membership: mergeMembership(serverState.membership, localState.membership),
        quantities: mergeQuantities(serverState.quantities, localState.quantities),
        maybeboard: mergeMaybeboard(serverState.maybeboard, localState.maybeboard),
        pins: mergeMaybeboard(serverState.pins, localState.pins),
        // Server-authoritative: edits already reach the server via the setDeckNotes op, so a
        // stale device merging here must never revert a newer Game plan or resurrect a cleared
        // one. Local notes only seed an empty/new server (first-device migration).
        deckNotes: hasUsefulAppState(serverState) ? (serverState.deckNotes || {}) : (localState.deckNotes || {}),
        colorIdentity: Array.isArray(localState.colorIdentity) && localState.colorIdentity.length
          ? localState.colorIdentity
          : (serverState.colorIdentity || []),
        translateCache: mergeTranslateCache(serverState.translateCache, localState.translateCache),
        searchHistory: mergeSearchHistory(serverState.searchHistory, localState.searchHistory),
        forceAiSearch: typeof localState.forceAiSearch === "boolean" ? localState.forceAiSearch : Boolean(serverState.forceAiSearch),
      };
    }

    async function loadAppState() {
      try {
        const res = await fetch("/api/app-state");
        if (!res.ok) throw new Error("Could not load saved app state");
        const serverState = await res.json();
        // Union this device's local copy with the shared server copy, show it, then
        // push the union up ONCE (server merges) so nothing is lost migrating to sync.
        const mergedState = mergeAppState(currentAppStatePayload(), serverState);
        applyAppState(mergedState);
        const putRes = await fetch("/api/app-state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(currentAppStatePayload()),
        });
        if (putRes.ok) {
          const synced = await putRes.json();
          lastSyncedSig = JSON.stringify([
            synced.savedCards, synced.folders, synced.membership, synced.quantities, synced.maybeboard, synced.pins, synced.deckNotes,
            synced.colorIdentity, synced.forceAiSearch,
            synced.searchHistory, synced.translateCache,
          ]);
        }
      } catch (err) {
        console.warn(err);
      } finally {
        syncReady = true;
        startStateSync();
      }
    }

