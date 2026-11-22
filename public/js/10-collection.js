    // ── Animated "spellcasting" loader: Magic-flavoured words that type in, hold, erase, change ──
    const LOADING_WORDS = [
      "Untapping", "Shuffling the library", "Consulting the Oracle", "Channeling mana",
      "Scrying", "Drawing cards", "Searching your library", "Resolving the stack",
      "Tapping for mana", "Summoning", "Cracking a fetchland", "Brewing",
      "Casting Demonic Tutor", "Flipping through the binder", "Reading the Gatherer",
      "Divining", "Untapping permanents", "Paying the mana cost", "Milling",
      "Counting devotion", "Goldfishing", "Mulliganing", "Sacrificing for value",
    ];
    let loadingTimer = null;
    function shuffled(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    }
    function startLoadingAnimation() {
      stopLoadingAnimation();
      statusEl.className = "status loading";
      statusEl.style.display = "block";
      statusEl.innerHTML = '<span class="load-text"></span><span class="load-cursor">▍</span>';
      const textEl = statusEl.querySelector(".load-text");
      let pool = shuffled(LOADING_WORDS);
      let wi = 0, ci = 0, phase = "typing", word = pool[0];
      function tick() {
        if (phase === "typing") {
          ci++;
          textEl.textContent = word.slice(0, ci) + "…";
          if (ci >= word.length) { phase = "holding"; loadingTimer = setTimeout(tick, 1000); return; }
          loadingTimer = setTimeout(tick, 42 + Math.random() * 45);
        } else if (phase === "holding") {
          phase = "deleting";
          loadingTimer = setTimeout(tick, 30);
        } else {
          ci--;
          textEl.textContent = word.slice(0, Math.max(0, ci)) + (ci > 0 ? "…" : "");
          if (ci <= 0) {
            wi++;
            if (wi >= pool.length) { pool = shuffled(LOADING_WORDS); wi = 0; }
            word = pool[wi]; phase = "typing";
            loadingTimer = setTimeout(tick, 200);
            return;
          }
          loadingTimer = setTimeout(tick, 22);
        }
      }
      tick();
    }
    function stopLoadingAnimation() {
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
    }

    // 3D tilt effect: intentionally subtle, matching the saved-card feel.
    const ROTATE_AMP = 2.0;
    const SCALE_HOVER = 1;
    const TILT_EASE = 0.12;

    function scheduleTiltInit(container) {
      requestAnimationFrame(() => requestAnimationFrame(() => initTilt(container)));
    }

    function initTilt(container) {
      container.querySelectorAll(".card-item").forEach((card) => {
        if (card._tiltBound) return;
        card._tiltBound = true;

        let animId = null;
        let targetRx = 0, targetRy = 0;
        let currentRx = 0, currentRy = 0;

        function springTo() {
          currentRx += (targetRx - currentRx) * TILT_EASE;
          currentRy += (targetRy - currentRy) * TILT_EASE;
          card.style.transform = `perspective(800px) rotateX(${currentRx}deg) rotateY(${currentRy}deg) scale(${card._hovered ? SCALE_HOVER : 1})`;
          if (Math.abs(targetRx - currentRx) > 0.05 || Math.abs(targetRy - currentRy) > 0.05) {
            animId = requestAnimationFrame(springTo);
          } else {
            card.style.transform = `perspective(800px) rotateX(${targetRx}deg) rotateY(${targetRy}deg) scale(${card._hovered ? SCALE_HOVER : 1})`;
            animId = null;
          }
        }

        function startAnim() {
          if (!animId) animId = requestAnimationFrame(springTo);
        }

        // Geometry captured once per hover (while the card is at rest), so the
        // tilt target is never fed back the card's own live, already-tilted rect
        // — that feedback loop is what made the tilt erratic.
        let cx = 0, cy = 0, hw = 1, hh = 1;
        let geomReady = false;

        function captureGeom() {
          const rect = card.getBoundingClientRect();
          cx = rect.left + rect.width / 2;
          cy = rect.top + rect.height / 2;
          hw = rect.width / 2 || 1;
          hh = rect.height / 2 || 1;
          geomReady = true;
        }

        const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

        card.addEventListener("mouseenter", () => {
          captureGeom();
          card._hovered = true;
          startAnim();
        });

        card.addEventListener("mousemove", (e) => {
          // mouseenter doesn't fire if the cursor was already over the card when
          // these listeners attached (e.g. results rendered under the pointer).
          // Capture geometry now — the card is still at rest — so we never run
          // with the initial cx=0/hh=1 placeholders, which would whip the card
          // around hundreds of degrees and look like it's flipping over.
          if (!geomReady) { captureGeom(); card._hovered = true; }
          // Clamp to the card's own bounds so the tilt can never exceed
          // ±ROTATE_AMP, even if the captured geometry goes stale (e.g. scroll).
          targetRx = clamp1((e.clientY - cy) / hh) * -ROTATE_AMP;
          targetRy = clamp1((e.clientX - cx) / hw) * ROTATE_AMP;
          startAnim();
        });

        card.addEventListener("mouseleave", () => {
          card._hovered = false;
          geomReady = false;
          targetRx = 0;
          targetRy = 0;
          startAnim();
        });
      });
    }

    // ── Collection (ManaBox import) ─────────────────────────────────────
    // @testable collection-helpers begin
    function buildCollectionIndex(data) {
      const byOracle = new Map();
      for (const e of Object.values(data?.entries || {})) {
        const card = data.cards?.[e.scryfallId];
        const oid = card && (card.oracle_id || card.card_faces?.[0]?.oracle_id);
        if (!oid) continue;
        let item = byOracle.get(oid);
        if (!item) { item = { oracleId: oid, card, qty: 0, scryfallIds: [], binders: new Set() }; byOracle.set(oid, item); }
        item.qty += e.qty;
        if (!item.scryfallIds.includes(e.scryfallId)) item.scryfallIds.push(e.scryfallId);
        const binder = String(e.binder || "").trim();
        if (binder) item.binders.add(binder);
      }
      return { byOracle, list: [...byOracle.values()] };
    }
    function ownedQty(index, card) {
      if (!index || !card) return 0;
      const oid = card.oracle_id || card.card_faces?.[0]?.oracle_id;
      return (oid && index.byOracle.get(oid)?.qty) || 0;
    }
    // Identity pickers ("fits within" semantics): C means colorless-only, so it can't be
    // combined with colors — picking C clears the colors and picking a color clears C.
    function toggleIdentityColor(selected, key) {
      const isC = (k) => k.toLowerCase() === "c";
      if (selected.includes(key)) return selected.filter((k) => k !== key);
      return isC(key) ? [key] : [...selected.filter((k) => !isC(k)), key];
    }
    function filterCollectionItems(items, { query = "", colors = [], binder = "" } = {}) {
      const q = query.trim().toLowerCase();
      const allowed = new Set([...colors].map((c) => c.toUpperCase()));
      return items.filter((it) =>
        (!q || it.card.name.toLowerCase().includes(q))
        && (!allowed.size || (it.card.color_identity || []).every((c) => allowed.has(c)))
        && (!binder || it.binders.has(binder)));
    }
    function collectionTotals(data, index) {
      let copies = 0;
      let value = 0;
      for (const e of Object.values(data?.entries || {})) {
        const card = data.cards?.[e.scryfallId];
        if (!card) continue;
        const p = card.prices || {};
        copies += e.qty;
        value += e.qty * (Number(e.foil === "normal" ? (p.eur ?? p.eur_foil) : (p.eur_foil ?? p.eur)) || 0);
      }
      return { unique: index ? index.list.length : 0, copies, value };
    }
    // Decks tab filter: a card shows if its identity contains any selected color; "C" = colorless.
    function deckColorMatch(card, selected) {
      if (!selected.size) return true;
      const ci = card.color_identity || [];
      if (!ci.length) return selected.has("C");
      return ci.some((c) => selected.has(c));
    }
    function ownCount(index, cards) {
      const distinct = new Map();
      for (const c of cards) distinct.set(c.oracle_id || c.card_faces?.[0]?.oracle_id || c.name, c);
      let owned = 0;
      for (const c of distinct.values()) if (ownedQty(index, c) > 0) owned++;
      return { owned, total: distinct.size };
    }
    // @testable collection-helpers end

    // Keep in sync with lib/collection.js's MANUAL_BINDER.
    const MANUAL_BINDER = "Marked in Spellbook";
    // Owned state for the right-click toggle and the focus panel:
    // "none" (never owned), "manual" (owned only via a manual mark, toggle available),
    // or "manabox" (owned via a ManaBox entry — the toggle is disabled).
    function ownedInfo(card) {
      if (!card) return { state: "none", qty: 0 };
      const oid = card.oracle_id || card.card_faces?.[0]?.oracle_id;
      const item = oid && collectionIndex ? collectionIndex.byOracle.get(oid) : null;
      if (!item || !item.qty) return { state: "none", qty: 0 };
      const manualOnly = item.binders.size === 1 && item.binders.has(MANUAL_BINDER);
      return { state: manualOnly ? "manual" : "manabox", qty: item.qty };
    }
    // Oracle ids (or card id fallback) with an owned-toggle POST in flight, so a
    // double-click (or a fast repeat click on the context menu) can't fire twice.
    const ownedToggleInFlight = new Set();

    // POST the owned toggle, then refresh whatever's currently showing this card.
    async function toggleOwned(card) {
      const info = ownedInfo(card);
      if (info.state === "manabox") return;
      const oracleId = card.oracle_id || card.card_faces?.[0]?.oracle_id;
      const key = oracleId || card.id;
      if (ownedToggleInFlight.has(key)) return;
      ownedToggleInFlight.add(key);
      const ownedToggleBtn = $("#detail-owned-toggle");
      const disablingDetailBtn = Boolean(state.detailCard && state.detailCard.id === card.id);
      if (disablingDetailBtn) ownedToggleBtn.disabled = true;
      try {
        const res = await fetch("/api/collection/owned", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scryfallId: card.id, oracleId, owned: info.state === "none" }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Couldn't update the collection");
        collectionData = data;
        collectionIndex = buildCollectionIndex(data);
        collectionLoading = Promise.resolve(data);
        if (state.activeTab === "saved") renderSavedCards();
        if (state.activeTab === "collection") { renderCollection(true); refreshSwapsStatus(); }
        if (state.detailCard) showDetail(state.detailCard);
        updateSwapTilesOwned(card);
      } catch (err) {
        // #status lives inside #search-content — invisible from the Decks/Collection
        // tabs, the Swaps view, or behind the detail panel — so fall back to alert()
        // there; only Search with no Swaps view open can show it inline.
        if (state.activeTab === "search" && !swapsContext) showStatus(err.message, true);
        else showToast(err.message);
      } finally {
        ownedToggleInFlight.delete(key);
        if (disablingDetailBtn) ownedToggleBtn.disabled = false;
      }
    }

    const COLLECTION_PAGE = 60;
    const COLOR_NAMES = { w: "White", u: "Blue", b: "Black", r: "Red", g: "Green", c: "Colorless" };
    const collectionUi = { colors: new Set(), query: "", binder: "", sortField: "name", sortDir: "asc", shown: 0, notice: "" };
    let collectionLoading = null;
    let swapsStatusTimer = null;

    function loadCollection(force = false) {
      if (collectionLoading && !force) return collectionLoading;
      collectionLoading = fetch("/api/collection")
        .then((r) => { if (!r.ok) throw new Error("Couldn't load your collection"); return r.json(); })
        .then((data) => { collectionData = data; collectionIndex = buildCollectionIndex(data); return data; })
        .catch((err) => { collectionLoading = null; throw err; });
      return collectionLoading;
    }
    const hasCollection = () => Boolean(collectionIndex && collectionIndex.list.length);

    // exclusiveColorless: C is "colorless only" and can't be combined with colors (identity pickers).
    function buildColorPicker(container, selected, onChange, { colorless = false, exclusiveColorless = false } = {}) {
      container.replaceChildren();
      const syncAll = () => container.querySelectorAll(".color-toggle").forEach((b) => b._sync());
      (colorless ? ["w", "u", "b", "r", "g", "c"] : ["w", "u", "b", "r", "g"]).forEach((c) => {
        const key = c.toUpperCase();
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "color-toggle";
        btn.dataset.color = c;
        btn.title = COLOR_NAMES[c];
        btn.setAttribute("aria-label", COLOR_NAMES[c]);
        btn.innerHTML = MANA_SVG[c];
        const sync = () => { const on = selected.has(key); btn.classList.toggle("active", on); btn.setAttribute("aria-pressed", String(on)); };
        btn._sync = sync;
        btn.addEventListener("click", () => {
          if (exclusiveColorless) {
            const next = toggleIdentityColor([...selected], key);
            selected.clear();
            next.forEach((k) => selected.add(k));
          } else if (selected.has(key)) selected.delete(key);
          else selected.add(key);
          syncAll();
          onChange();
        });
        sync();
        container.appendChild(btn);
      });
    }

    async function openCollectionTab() {
      try { await loadCollection(); } catch (err) { $("#collection-stats").textContent = err.message; return; }
      renderCollection(true);
      refreshSwapsStatus();
    }

    function renderCollectionHeader() {
      const stats = $("#collection-stats");
      if (!hasCollection()) { stats.textContent = "No collection uploaded yet"; return; }
      const t = collectionTotals(collectionData, collectionIndex);
      const synced = collectionData.syncedAt ? ` · Synced ${new Date(collectionData.syncedAt).toLocaleDateString()}` : "";
      stats.textContent = `${t.unique.toLocaleString()} unique · ${t.copies.toLocaleString()} copies · €${t.value.toFixed(2)}${synced}`;
      if (collectionUi.notice) {
        const note = document.createElement("span");
        note.className = "collection-notice";
        note.textContent = collectionUi.notice;
        stats.appendChild(note);
      }
    }

    function renderBinderOptions() {
      const sel = $("#collection-binder");
      const binders = [...new Set(collectionIndex ? collectionIndex.list.flatMap((it) => [...it.binders]) : [])].sort();
      const current = collectionUi.binder;
      sel.replaceChildren(new Option("All binders", ""), ...binders.map((b) => new Option(b, b)));
      sel.value = binders.includes(current) ? current : "";
      collectionUi.binder = sel.value;
      sel.style.display = "none"; // binders live in the side panel now
    }

    function collectionTile(it) {
      const card = it.card;
      const el = document.createElement("div");
      el.className = "card-item";
      const price = getPrice(card);
      const isSaved = isCardSaved(card.id);
      el.innerHTML = `
        <img src="${getCardImage(card)}" alt="${esc(card.name)}" loading="lazy">
        ${it.qty > 1 ? `<span class="qty-chip">×${it.qty}</span>` : ""}
        <div class="card-info">
          <div class="card-text">
            <div class="card-name" title="${esc(card.name)}">${esc(card.name)}</div>
            <div class="card-price ${price ? "" : "no-price"}">${price || "No price"}</div>
          </div>
          <div class="card-tools">
            ${flipBtnHtml(card)}
            <button class="icon-btn save-btn ${isSaved ? "saved" : ""}" data-id="${card.id}" title="${isSaved ? "Saved" : "Save"}" aria-label="Save to a deck">${bookmarkIcon(isSaved)}</button>
            <button class="icon-btn detail-btn" title="Details" aria-label="Details">${ICON_DOTS}</button>
          </div>
        </div>`;
      wireFlipBtn(el, card);
      el.querySelector(".save-btn").addEventListener("click", (e) => { e.stopPropagation(); openSavePopover(card, e.currentTarget); });
      el.querySelector(".detail-btn").addEventListener("click", (e) => { e.stopPropagation(); showDetail(card); });
      el.addEventListener("click", (e) => { if (!e.target.closest("button, input, a, select")) showDetail(card); });
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openCardContextMenu(card, e.clientX, e.clientY, { deckActions: false }); });
      return el;
    }

    function renderCollection(reset) {
      const grid = $("#collection-grid");
      renderCollectionHeader();
      renderBinderOptions();
      renderBinderRail();
      $("#collection-empty").style.display = hasCollection() ? "none" : "block";
      let items = [];
      if (hasCollection()) {
        const filtered = filterCollectionItems(collectionIndex.list, { query: collectionUi.query, colors: [...collectionUi.colors], binder: collectionUi.binder });
        const byId = new Map(filtered.map((it) => [it.card.id, it]));
        renderFilterUi({
          f: collectionDrawer, cards: filtered.map((it) => it.card), pruneFrom: collectionIndex.list.map((it) => it.card),
          btn: $("#collection-filters-btn"), count: $("#collection-filters-count"), drawer: $("#collection-drawer"), pills: $("#collection-pills"),
          colors: { set: collectionUi.colors, picker: $("#collection-colors") }, onChange: () => renderCollection(true),
        });
        const mvFiltered = filtered.filter((it) => drawerMatch(it.card, collectionDrawer));
        const showing = $("#collection-showing");
        if (showing) showing.textContent = mvFiltered.length === collectionIndex.list.length ? "" : `Showing ${mvFiltered.length.toLocaleString()} of ${collectionIndex.list.length.toLocaleString()}`;
        items = sortCardsByField(mvFiltered.map((it) => it.card), collectionUi.sortField, collectionUi.sortDir).map((c) => byId.get(c.id));
      } else {
        $("#collection-drawer").hidden = true;
        $("#collection-pills").replaceChildren();
        $("#collection-showing").textContent = "";
      }
      if (reset) { grid.replaceChildren(); collectionUi.shown = 0; }
      const next = items.slice(collectionUi.shown, collectionUi.shown + COLLECTION_PAGE);
      next.forEach((it) => grid.appendChild(collectionTile(it)));
      collectionUi.shown += next.length;
      $("#collection-more-wrap").style.display = collectionUi.shown < items.length ? "flex" : "none";
      scheduleTiltInit(grid);
    }

    async function fetchSwapsStatus() {
      const r = await fetch("/api/swaps/status");
      if (!r.ok) throw new Error("Couldn't load swap status");
      return r.json();
    }

    function swapsStatusText(st) {
      switch (st.phase) {
        case "awaiting-confirmation":
          return `Profile ${st.pending.toLocaleString()} cards for swaps${st.estimate ? ` (≈ $${st.estimate.usd.toFixed(2)} on ${st.estimate.model}${st.estimate.batch ? ", half-price batch — takes a few minutes, up to an hour" : ""})` : ""}`;
        case "profiling":
          if (st.batch && !st.profiled) return `Profiling ${st.pending.toLocaleString()} cards as a half-price batch… usually a few minutes, up to an hour. You can leave this page.`;
          return `Profiling cards for swaps… ${(st.total - st.pending).toLocaleString()} / ${st.total.toLocaleString()}`;
        case "embedding": return `Preparing matching… ${st.embedded.toLocaleString()} cards`;
        case "ready": return st.aiAvailable ? "Ready for swaps" : "Ready for swaps · add an API key in Settings for deck-aware matches";
        case "error": return `Preparing swaps failed: ${st.error}`;
        default: return "";
      }
    }

    async function refreshSwapsStatus() {
      clearTimeout(swapsStatusTimer);
      const el = $("#collection-swaps-status");
      let st;
      try { st = await fetchSwapsStatus(); } catch (err) { el.textContent = err.message; return; }
      el.replaceChildren();
      const text = document.createElement("span");
      text.textContent = swapsStatusText(st);
      el.appendChild(text);
      if (st.phase === "awaiting-confirmation" || st.phase === "error") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "export-btn";
        btn.textContent = st.phase === "error" ? "Retry" : "Start";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          await fetch("/api/swaps/prepare", { method: "POST" }).catch(() => {});
          refreshSwapsStatus();
        });
        el.appendChild(btn);
      }
      const spend = document.createElement("span");
      spend.className = "swaps-spend";
      spend.textContent = `AI spend this month: $${(st.spend?.monthUsd || 0).toFixed(2)}`;
      el.appendChild(spend);
      if ((st.phase === "profiling" || st.phase === "embedding") && state.activeTab === "collection") {
        swapsStatusTimer = setTimeout(refreshSwapsStatus, 2000);
      }
    }

    buildColorPicker($("#collection-colors"), collectionUi.colors, () => renderCollection(true), { colorless: true, exclusiveColorless: true });
    wireFiltersButton($("#collection-filters-btn"), collectionDrawer);
    let collectionFilterTimer = null;
    $("#collection-filter").addEventListener("input", (e) => {
      collectionUi.query = e.target.value;
      clearTimeout(collectionFilterTimer);
      collectionFilterTimer = setTimeout(() => renderCollection(true), 160);
    });
    $("#collection-binder").addEventListener("change", (e) => { collectionUi.binder = e.target.value; renderCollection(true); });
    $("#collection-sort").addEventListener("change", (e) => { collectionUi.sortField = e.target.value; renderCollection(true); });
    const collectionSortDirBtn = $("#collection-sort-dir");
    updateSortDirButton(collectionSortDirBtn, collectionUi.sortDir);
    collectionSortDirBtn.addEventListener("click", () => {
      collectionUi.sortDir = collectionUi.sortDir === "asc" ? "desc" : "asc";
      updateSortDirButton(collectionSortDirBtn, collectionUi.sortDir);
      renderCollection(true);
    });
    $("#collection-more-btn").addEventListener("click", () => renderCollection(false));
    // Endless scroll: load the next page as the bottom of the grid comes into view
    // (the button stays as a fallback, e.g. for keyboard users).
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting) && $("#collection-more-wrap").style.display !== "none" && state.activeTab === "collection") renderCollection(false);
      }, { rootMargin: "800px 0px" }).observe($("#collection-more-wrap"));
    }

    // Upload: pick file → server preview → choose mode → confirm.
    const uploadModal = $("#collection-upload-modal");
    let uploadPreview = null;
    const uploadMode = () => document.querySelector('input[name="upload-mode"]:checked')?.value || "sync";
    function closeUploadModal() { uploadModal.classList.remove("visible"); uploadPreview = null; }

    function renderUploadPreview() {
      if (!uploadPreview) return;
      const mode = uploadMode();
      const p = uploadPreview[mode];
      const s = p.summary;
      $("#upload-summary").textContent = mode === "sync"
        ? `+${s.added} new · ${s.changed} quantity changes · ${s.removed} removed → ${s.totalAfter.toLocaleString()} cards`
        : `+${s.added} new · ${s.increased} more copies${s.skipped ? ` · ${s.skipped} cards already imported, skipped` : ""} → ${s.totalAfter.toLocaleString()} cards`;
      $("#upload-warning").textContent = mode === "sync" ? p.warning || "" : "";
      const groups = mode === "sync"
        ? [["New", p.details.added], ["Quantity changes", p.details.changed], ["Removed", p.details.removed]]
        : [["New", p.details.added], ["More copies", p.details.increased], ["Already imported (skipped)", p.details.skipped]];
      const wrap = $("#upload-details");
      wrap.replaceChildren();
      groups.filter(([, list]) => list.length).forEach(([label, list]) => {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = `${label} (${list.length})`;
        details.appendChild(summary);
        const ul = document.createElement("ul");
        list.slice(0, 500).forEach((r) => {
          const li = document.createElement("li");
          const qty = r.qtyAfter != null ? `${r.qtyBefore} → ${r.qtyAfter}` : `${r.qty}×`;
          li.textContent = `${qty} ${r.name} (${r.set} #${r.number}${r.foil !== "normal" ? `, ${r.foil}` : ""})${r.binder ? ` · ${r.binder}` : ""}`;
          ul.appendChild(li);
        });
        if (list.length > 500) { const li = document.createElement("li"); li.textContent = `…and ${list.length - 500} more`; ul.appendChild(li); }
        details.appendChild(ul);
        wrap.appendChild(details);
      });
    }

    let pendingUploadBinder = null; // binder-name override for the next CSV upload
    $("#collection-upload-btn").addEventListener("click", () => { pendingUploadBinder = null; $("#collection-file").click(); });

    // Binders panel (side menu, Collection tab): filter by binder, upload a CSV, or upload a
    // CSV into a new named binder. Replaces the binder dropdown on the sort row.
    function binderCounts() {
      const counts = new Map();
      (collectionIndex?.list || []).forEach((it) => it.binders.forEach((b) => counts.set(b, (counts.get(b) || 0) + 1)));
      return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }
    function renderBinderRail() {
      const el = $("#binder-rail");
      if (!el) return;
      const all = collectionIndex?.list.length || 0;
      const row = (id, name, n) => `<button class="folder-btn ${collectionUi.binder === id ? "active" : ""}" data-binder="${esc(id)}" type="button"><span class="folder-name">${esc(name)}</span><span class="folder-count">${n.toLocaleString()}</span></button>`;
      el.innerHTML = `<div class="rail-label">Binders</div>
        ${hasCollection() ? row("", "All cards", all) + binderCounts().map(([b, n]) => row(b, b, n)).join("") : `<div class="rail-empty">No collection yet</div>`}
        <div class="rail-divider"></div>
        <button class="folder-add" type="button" id="binder-upload-btn"><span class="add-ico">${ICON_ADD_UPLOAD}</span>Upload CSV</button>
        <button class="folder-add" type="button" id="binder-new-btn"><span class="add-ico">${ICON_ADD_BINDER}</span>New binder from CSV</button>`;
    }
    $("#binder-rail").addEventListener("click", (e) => {
      const b = e.target.closest("[data-binder]");
      if (b) { collectionUi.binder = b.dataset.binder; renderCollection(true); return; }
      if (e.target.closest("#binder-upload-btn")) { pendingUploadBinder = null; $("#collection-file").click(); return; }
      if (e.target.closest("#binder-new-btn")) {
        // Name the binder in place, then pick the CSV (every card in it goes into the binder).
        const btn = $("#binder-new-btn");
        const row = document.createElement("div");
        row.className = "folder-btn renaming binder-name-row";
        row.innerHTML = `<input class="folder-rename" type="text" placeholder="Binder name" aria-label="New binder name" maxlength="60"><button type="button" class="binder-name-go">Choose CSV</button>`;
        btn.replaceWith(row);
        const input = row.querySelector("input");
        input.focus();
        const go = () => {
          const name = input.value.trim();
          if (!name) { input.focus(); return; }
          pendingUploadBinder = name;
          $("#collection-file").click();
          renderBinderRail();
        };
        row.querySelector(".binder-name-go").addEventListener("click", (ev) => { ev.stopPropagation(); go(); });
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); go(); }
          if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); renderBinderRail(); }
        });
        input.addEventListener("blur", () => setTimeout(() => { if (!row.contains(document.activeElement) && row.isConnected && !input.value.trim()) renderBinderRail(); }, 150));
      }
    });
    $("#collection-file").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      const binder = pendingUploadBinder;
      pendingUploadBinder = null;
      uploadPreview = null;
      ["#upload-summary", "#upload-warning", "#upload-details"].forEach((s) => { $(s).textContent = ""; });
      $("#upload-status").textContent = "Reading file…";
      $("#upload-confirm").disabled = true;
      uploadModal.classList.add("visible");
      try {
        const res = await fetch("/api/collection/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csv: await file.text(), ...(binder ? { binder } : {}) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Couldn't read that file");
        uploadPreview = data;
        // A binder upload can only add (a sync from one binder's file would wipe the others).
        const syncRadio = document.querySelector('input[name="upload-mode"][value="sync"]');
        if (syncRadio) { syncRadio.disabled = Boolean(data.binder); syncRadio.closest("label")?.classList.toggle("disabled", Boolean(data.binder)); }
        $("#upload-status").dataset.binder = data.binder || "";
        document.querySelector(`input[name="upload-mode"][value="${data.defaultMode}"]`).checked = true;
        $("#upload-status").textContent = data.binder ? `Every card in this file goes into the binder "${data.binder}".` : "";
        renderUploadPreview();
        $("#upload-confirm").disabled = false;
      } catch (err) {
        $("#upload-status").textContent = err.message;
      }
    });
    document.querySelectorAll('input[name="upload-mode"]').forEach((r) => r.addEventListener("change", renderUploadPreview));
    $("#upload-cancel").addEventListener("click", closeUploadModal);
    uploadModal.addEventListener("click", (e) => { if (e.target === uploadModal) closeUploadModal(); });
    $("#upload-confirm").addEventListener("click", async () => {
      if (!uploadPreview) return;
      const btn = $("#upload-confirm");
      btn.disabled = true;
      $("#upload-status").textContent = "Looking up new cards on Scryfall…";
      try {
        const res = await fetch("/api/collection/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ previewId: uploadPreview.previewId, mode: uploadMode() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Sync failed");
        collectionData = data;
        collectionIndex = buildCollectionIndex(data);
        collectionLoading = Promise.resolve(data);
        collectionUi.notice = data.unmatched?.length ? `${data.unmatched.length} cards couldn't be matched on Scryfall` : "";
        closeUploadModal();
        renderCollection(true);
        refreshSwapsStatus();
      } catch (err) {
        $("#upload-status").textContent = err.message;
        btn.disabled = false;
      }
    });

    // Load the collection in the background so badges and View Swaps know about it.
    loadCollection()
      .then(() => {
        if (state.activeTab === "saved") renderSavedCards();
        if (state.detailCard) showDetail(state.detailCard);
      })
      .catch(() => {});

    // ── View Swaps ──────────────────────────────────────────────────────
    let swapsContext = null; // { card, payload, prev: { tab, activeFolder, scrollY } }
    let swapsRun = 0;        // cancels stale requests when the view changes

    // Deck context is sent only when the card belongs to the active deck.
    function swapsDeckPayload(card) {
      const deck = activeDeck();
      if (!deck || !cardFolders(card.id).includes(deck.id)) return { colorIdentity: card.color_identity || [], deck: null };
      const cards = getFolderCards(deck.id).filter((c) => !isMaybe(deck.id, c.id));
      const commander = deck.commanderId ? cards.find((c) => c.id === deck.commanderId) : null;
      const review = deckReviewCache[deck.id]?.data;
      return {
        colorIdentity: commander ? commander.color_identity || [] : card.color_identity || [],
        deck: {
          id: deck.id,
          name: deck.name,
          commander: commander ? { name: commander.name, typeLine: commander.type_line || "", text: getOracleText(commander) } : null,
          gamePlan: (state.deckNotes || {})[deck.id] || "",
          identityTags: Array.isArray(review?.identityTags) ? review.identityTags : [],
          cardNames: cards.map((c) => c.name),
          signature: deckSig(cards, deck.id, commander?.name),
        },
      };
    }

    function closeSwapsView() {
      if (!swapsContext) return;
      swapsContext = null;
      swapsRun++;
      $("#swaps-view").classList.remove("visible");
    }

    function exitSwaps() {
      const prev = swapsContext?.prev;
      closeSwapsView();
      if (!prev) return;
      state.activeFolder = prev.activeFolder;
      setActiveTab(prev.tab);
      requestAnimationFrame(() => window.scrollTo(0, prev.scrollY || 0));
    }

    async function openSwaps(card) {
      const prev = swapsContext?.prev || { tab: state.activeTab, activeFolder: state.activeFolder, scrollY: window.scrollY };
      swapsContext = { card, payload: swapsDeckPayload(card), prev };
      const run = ++swapsRun;
      $("#search-content").classList.add("hidden");
      $("#saved-section").classList.remove("visible");
      $("#collection-section").classList.remove("visible");
      $("#swaps-view").classList.add("visible");
      window.scrollTo(0, 0);
      renderSwapsOriginal(card, swapsContext.payload.deck);
      await requestSwaps(run);
    }

    function setSwapsState(text, { retry = false, start = false, reprepare = false } = {}) {
      $("#swaps-grid").replaceChildren();
      const note = $("#swaps-note");
      note.replaceChildren();
      $("#swaps-summary").textContent = text;
      if (!retry && !start) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "export-btn";
      btn.textContent = start ? "Start" : "Retry";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        if (start || reprepare) await fetch("/api/swaps/prepare", { method: "POST" }).catch(() => {});
        requestSwaps(swapsRun);
      });
      note.appendChild(btn);
    }

    async function requestSwaps(run) {
      if (!swapsContext) return;
      const { card, payload } = swapsContext;
      setSwapsState(payload.deck ? `Matching against ${payload.deck.name}'s game plan…` : "Finding swaps in your collection…");
      let res;
      let data;
      try {
        res = await fetch("/api/swaps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ card, colorIdentity: payload.colorIdentity, deck: payload.deck }),
        });
        data = await res.json();
      } catch {
        if (run === swapsRun) setSwapsState("Couldn't reach Spellbook.", { retry: true });
        return;
      }
      if (run !== swapsRun) return;
      if (res.status === 202) {
        setSwapsState(swapsStatusText(data.status) || "Preparing your collection for swaps…");
        setTimeout(() => { if (run === swapsRun) requestSwaps(run); }, 2000);
        return;
      }
      if (res.status === 409 && data.needsConfirmation) {
        setSwapsState(`${swapsStatusText(data.status)} first.`, { start: true });
        return;
      }
      if (!res.ok) {
        // A failed prepare job leaves /api/swaps returning 503 forever until preparation is
        // restarted — Retry here must re-run prepare, not just re-request the same error.
        const reprepare = res.status === 503 && data.status?.phase === "error";
        setSwapsState(data.error || "Swaps failed.", { retry: true, reprepare });
        return;
      }
      renderSwapsResults(data);
    }

    function renderSwapsOriginal(card, deck) {
      $("#swaps-title").textContent = `Swaps for ${card.name}`;
      const price = getPrice(card);
      $("#swaps-original").innerHTML = `
        <img src="${getCardImage(card)}" alt="${esc(card.name)}">
        <div class="swaps-original-text">
          <div class="swaps-original-type">${esc(card.type_line || "")}</div>
          <div class="oracle-text">${esc(getOracleText(card))}</div>
          <div class="swaps-original-price">${price ? esc(price) : "No price"}</div>
          ${deck ? `<div class="swaps-deck">In ${esc(deck.name)}${deck.gamePlan ? "" : " · add a Game plan to this deck for better matches"}</div>` : ""}
        </div>`;
    }

    const cardEur = (card) => { const p = card?.prices || {}; return Number(p.eur || p.eur_foil || 0); };

    function swapTile(r, originalPrice) {
      const card = r.card;
      const el = document.createElement("div");
      el.className = "card-item swap-item";
      const oracleId = card.oracle_id || card.card_faces?.[0]?.oracle_id || "";
      if (oracleId) el.dataset.oracleId = oracleId;
      const price = getPrice(card);
      const saves = originalPrice - cardEur(card);
      const owned = ownedQty(collectionIndex, card) || 1;
      const isSaved = isCardSaved(card.id);
      const scryfall = card.scryfall_uri || `https://scryfall.com/search?q=${encodeURIComponent(`!"${card.name}"`)}`;
      el.innerHTML = `
        <img src="${getCardImage(card)}" alt="${esc(card.name)}" loading="lazy">
        <div class="card-info">
          <div class="card-text">
            <div class="card-name" title="${esc(card.name)}">${esc(card.name)}</div>
            <div class="card-price ${price ? "" : "no-price"}">${price || "No price"}${saves > 0 ? ` · saves €${saves.toFixed(2)}` : ""}</div>
          </div>
          <div class="card-tools">
            <button class="icon-btn save-btn ${isSaved ? "saved" : ""}" data-id="${card.id}" title="Add to a deck" aria-label="Add to a deck">${bookmarkIcon(isSaved)}</button>
            <button class="icon-btn detail-btn" title="Details" aria-label="Details">${ICON_DOTS}</button>
          </div>
        </div>
        <div class="swap-meta">
          <div class="swap-bar" role="meter" aria-label="Match" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.match}"><span style="width:${r.match}%"></span></div>
          <div class="swap-match">${r.match}% match · Owned ×<span class="swap-owned-qty">${owned}</span></div>
          ${r.reason ? `<div class="swap-reason">${esc(r.reason)}</div>` : ""}
          <div class="swap-links"><a href="${esc(scryfall)}" target="_blank" rel="noopener">Scryfall</a> · <a href="https://edhrec.com/cards/${edhrecSlug(card.name)}" target="_blank" rel="noopener">EDHREC</a></div>
        </div>`;
      el.querySelector(".save-btn").addEventListener("click", (e) => { e.stopPropagation(); openSavePopover(card, e.currentTarget); });
      el.querySelector(".detail-btn").addEventListener("click", (e) => { e.stopPropagation(); showDetail(card); });
      el.addEventListener("click", (e) => { if (!e.target.closest("button, input, a, select")) showDetail(card); });
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openCardContextMenu(card, e.clientX, e.clientY, { deckActions: false }); });
      return el;
    }

    // After toggling owned on a card, patch just that card's "Owned ×N" in any
    // rendered swap tile — never re-run requestSwaps here, since that can trigger
    // a paid AI ranking call.
    function updateSwapTilesOwned(card) {
      if (!swapsContext) return;
      const oracleId = card.oracle_id || card.card_faces?.[0]?.oracle_id;
      if (!oracleId) return;
      const owned = ownedQty(collectionIndex, card) || 1;
      $("#swaps-grid").querySelectorAll(`.swap-item[data-oracle-id="${oracleId}"]`).forEach((tile) => {
        const qtyEl = tile.querySelector(".swap-owned-qty");
        if (qtyEl) qtyEl.textContent = owned;
      });
    }

    function renderSwapsResults(data) {
      const { card } = swapsContext;
      const grid = $("#swaps-grid");
      grid.replaceChildren();
      const note = $("#swaps-note");
      note.replaceChildren();
      $("#swaps-summary").textContent = data.results.length
        ? `${data.results.length} card${data.results.length === 1 ? "" : "s"} from your collection can replace ${card.name}.`
        : "No match found in your collection.";
      if (data.mode === "local") {
        const msg = document.createElement("span");
        msg.textContent = data.aiError
          ? `AI ranking failed (${data.aiError}) — showing text-based matches.`
          : "Deck-aware matching is off — add an API key in Settings.";
        note.appendChild(msg);
        if (data.aiError) {
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "export-btn";
          retry.textContent = "Retry";
          retry.addEventListener("click", () => requestSwaps(swapsRun));
          note.appendChild(retry);
        }
      }
      const originalPrice = cardEur(card);
      data.results.forEach((r) => grid.appendChild(swapTile(r, originalPrice)));
      scheduleTiltInit(grid);
    }

    $("#swaps-back-btn").addEventListener("click", exitSwaps);

