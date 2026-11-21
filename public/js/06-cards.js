    // ── Double-faced cards ────────────────────────────────────────────
    // Only true two-image cards (transform/MDFC) get a flip button; split/adventure
    // cards share one image and have nothing to flip to.
    const ICON_FLIP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/></svg>`;
    function isDoubleFaced(card) {
      return Boolean(card.card_faces?.length >= 2 && card.card_faces[0].image_uris?.normal && card.card_faces[1].image_uris?.normal);
    }
    function faceImage(card, face) {
      return cachedImg(card.card_faces?.[face]?.image_uris?.normal) || getCardImage(card);
    }
    // Highest-resolution image Scryfall serves for a face, for printing proxies:
    // png is 745×1040 (~300 DPI at the real 63×88mm card size); large/normal are
    // smaller JPEGs and only stand in when a printing has no png.
    function facePrintImage(card, face) {
      const uris = card.card_faces?.[face]?.image_uris || card.image_uris || card.card_faces?.[0]?.image_uris;
      return uris?.png || uris?.large || uris?.normal || "";
    }
    // Shared per-tile flip wiring: toggles the tile's img between the two faces.
    function wireFlipBtn(el, card) {
      el.querySelector(".flip-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const face = el.dataset.face === "1" ? 0 : 1;
        el.dataset.face = String(face);
        el.querySelector("img").src = faceImage(card, face);
      });
    }
    function flipBtnHtml(card) {
      return isDoubleFaced(card) ? `<button class="icon-btn flip-btn" title="Flip card" aria-label="Flip card">${ICON_FLIP}</button>` : "";
    }

    // Render results
    // ── Card-type filter chips ──────────────────────────────────────────────
    // Client-side view filter over already-loaded cards, driven by the actual
    // Scryfall type line (types + subtypes), not a fixed list.
    // Deck-analysis (type bar/legend) still uses this fixed primary-type set.
    const CARD_TYPES = ["creature", "artifact", "enchantment", "instant", "sorcery", "land", "planeswalker", "battle"];
    const CARD_TYPE_LABEL = { creature: "Creature", artifact: "Artifact", enchantment: "Enchantment", instant: "Instant", sorcery: "Sorcery", land: "Land", planeswalker: "Planeswalker", battle: "Battle" };
    const CARD_TYPE_RE = {};
    CARD_TYPES.forEach((t) => { CARD_TYPE_RE[t] = new RegExp("\\b" + t + "\\b"); });

    // Word-boundary match against the whole type line (covers both faces of a
    // DFC) so a subtype like "Island" never counts as the "land" type.
    function cardTypes(card) {
      const tl = (card.type_line || "").toLowerCase();
      const found = new Set();
      CARD_TYPES.forEach((t) => { if (CARD_TYPE_RE[t].test(tl)) found.add(t); });
      return found;
    }

    // @testable type-helpers begin
    const TYPE_ROW_ORDER = ["Creature", "Artifact", "Enchantment", "Instant", "Sorcery", "Land", "Planeswalker", "Battle", "Kindred", "Legendary"];
    const KNOWN_TYPE_WORDS = new Set(["Artifact", "Battle", "Creature", "Enchantment", "Instant", "Kindred", "Land", "Planeswalker", "Sorcery"]);
    const SUBTYPES_SHOWN = 12;

    // Splits a Scryfall type line ("Legendary Creature — Human Wizard") into
    // its supertype/type words (left of the em dash) and subtype words
    // (right of it). "Tribal" is normalized to "Kindred".
    function parseTypeLine(card) {
      const types = new Set();
      const subtypes = new Set();
      const faces = (card.card_faces && card.card_faces.length && card.card_faces[0].type_line)
        ? card.card_faces.map((f) => f.type_line || "")
        : (card.type_line || "").split(" // ");
      faces.forEach((line) => {
        const [left, right] = line.split(" — ");
        (left || "").trim().split(/\s+/).filter(Boolean).forEach((word) => {
          if (word === "Tribal") { types.add("Kindred"); return; }
          if (word === "Legendary") { types.add("Legendary"); return; }
          if (KNOWN_TYPE_WORDS.has(word)) types.add(word);
        });
        if (right) right.trim().split(/\s+/).filter(Boolean).forEach((word) => subtypes.add(word));
      });
      return { types, subtypes };
    }

    // Builds the chip facets (present values + counts) over a card list, one
    // count per card per value. Types are ordered per TYPE_ROW_ORDER; subtypes
    // are ordered by count desc, then name.
    function typeFacets(cards) {
      const typeCounts = new Map();
      const subtypeCounts = new Map();
      cards.forEach((card) => {
        const { types, subtypes } = parseTypeLine(card);
        types.forEach((t) => typeCounts.set(t, (typeCounts.get(t) || 0) + 1));
        subtypes.forEach((s) => subtypeCounts.set(s, (subtypeCounts.get(s) || 0) + 1));
      });
      const types = TYPE_ROW_ORDER.filter((t) => typeCounts.has(t)).map((value) => ({ value, count: typeCounts.get(value) }));
      const subtypes = [...subtypeCounts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
      return { types, subtypes };
    }

    // OR within a row (types, subtypes), AND across rows. An empty filter passes everything.
    // After "Select all" (filter.excludeMode), the sets hold the *deselected* values
    // instead, and a card is hidden if it carries any of them.
    function matchesTypeFilter(card, filter) {
      const { types, subtypes } = parseTypeLine(card);
      if (filter.excludeMode) {
        return ![...filter.types].some((t) => types.has(t)) && ![...filter.subtypes].some((s) => subtypes.has(s));
      }
      const typeOk = !filter.types.size || [...filter.types].some((t) => types.has(t));
      const subtypeOk = !filter.subtypes.size || [...filter.subtypes].some((s) => subtypes.has(s));
      return typeOk && subtypeOk;
    }

    // Which subtype facets to render: the top `limit` by count/name, plus — when
    // collapsed — any selected subtype that fell outside that top slice, appended
    // in facet order, so an active filter never loses its visible chip.
    function visibleSubtypes(facets, selected, expanded, limit) {
      if (expanded) return facets;
      const top = facets.slice(0, limit);
      if (!selected || !selected.size) return top;
      const shown = new Set(top.map((f) => f.value));
      const extraSelected = facets.filter((f) => selected.has(f.value) && !shown.has(f.value));
      return extraSelected.length ? [...top, ...extraSelected] : top;
    }

    // @testable type-helpers end

    function makeTypeFilterState() { return { types: new Set(), subtypes: new Set(), expanded: false, excludeMode: false }; }
    const searchTypeFilter = makeTypeFilterState();
    const savedTypeFilter = makeTypeFilterState();
    const collectionTypeFilter = makeTypeFilterState();

    function toggleSet(set, value) { set.has(value) ? set.delete(value) : set.add(value); }

    function typeChip(label, active, onClick, extraClass = "") {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "type-chip" + (extraClass ? ` ${extraClass}` : "") + (active ? " active" : "");
      chip.textContent = label;
      chip.setAttribute("aria-pressed", String(active));
      chip.addEventListener("click", onClick);
      return chip;
    }

    // Renders the two-row type/subtype chip panel for a view (Search, Decks,
    // Collection) into `container`, driven by `cards` (the view's list before
    // type filtering) and mutating `filter` ({types, subtypes, expanded}) in
    // place. `onChange` re-renders the owning view (results + chips); the
    // "+N more"/"Show less" chip only re-renders this panel.
    function renderTypeFilterChips(container, cards, filter, onChange) {
      const facets = typeFacets(cards);
      const presentTypes = new Set(facets.types.map((f) => f.value));
      const presentSubtypes = new Set(facets.subtypes.map((f) => f.value));
      [...filter.types].forEach((t) => { if (!presentTypes.has(t)) filter.types.delete(t); });
      [...filter.subtypes].forEach((s) => { if (!presentSubtypes.has(s)) filter.subtypes.delete(s); });

      const showTypesRow = facets.types.length > 1 || filter.types.size > 0;
      const showSubtypesRow = facets.subtypes.length > 0;
      container.replaceChildren();
      if (!showTypesRow && !showSubtypesRow) { container.style.display = "none"; return; }
      container.style.display = "flex";

      // In excludeMode the sets hold deselected values, so a chip is lit when absent.
      const isOn = (set, value) => filter.excludeMode ? !set.has(value) : set.has(value);
      const selectAllChip = typeChip(filter.excludeMode ? "Deselect all" : "Select all", false, () => {
        filter.excludeMode = !filter.excludeMode;
        filter.types.clear();
        filter.subtypes.clear();
        onChange();
      }, "type-chip-more");

      if (showTypesRow) {
        const row = document.createElement("div");
        row.className = "type-row";
        facets.types.forEach(({ value, count }) => {
          row.appendChild(typeChip(`${value} ${count}`, isOn(filter.types, value), () => { toggleSet(filter.types, value); onChange(); }));
        });
        row.appendChild(selectAllChip);
        container.appendChild(row);
      }

      if (showSubtypesRow) {
        const row = document.createElement("div");
        row.className = "type-row";
        const visible = visibleSubtypes(facets.subtypes, filter.subtypes, filter.expanded, SUBTYPES_SHOWN);
        visible.forEach(({ value, count }) => {
          row.appendChild(typeChip(`${value} ${count}`, isOn(filter.subtypes, value), () => { toggleSet(filter.subtypes, value); onChange(); }));
        });
        if (facets.subtypes.length > SUBTYPES_SHOWN) {
          const label = filter.expanded ? "Show less" : `+${facets.subtypes.length - SUBTYPES_SHOWN} more`;
          row.appendChild(typeChip(label, false, () => { filter.expanded = !filter.expanded; renderTypeFilterChips(container, cards, filter, onChange); }, "type-chip-more"));
        }
        if (!showTypesRow) row.appendChild(selectAllChip);
        container.appendChild(row);
      }
    }

    // Render the current search results honoring the active type/subtype chips.
    function renderSearchView() {
      if (state.mode === "cuts" && state.cutView) return renderCutView();
      renderBuildTarget();
      renderTypeFilterChips(typeFilterEl, state.results, searchTypeFilter, renderSearchView);
      renderResults(state.results.filter((c) => matchesTypeFilter(c, searchTypeFilter)), false);
    }

    function renderResults(cards, append) {
      if (!append) resultsEl.innerHTML = "";
      // looked up once per render, not once per tile
      const savedIds = new Set(state.savedCards.map((s) => s.id));
      const deck = state.addingClosed ? null : activeDeck();
      const ident = deck ? deckIdentity(deck) : null;
      cards.forEach((card) => {
        const el = document.createElement("div");
        el.className = "card-item";
        const imgUrl = getCardImage(card);
        const price = getPrice(card);
        const isSaved = savedIds.has(card.id);
        const offColor = ident && (card.color_identity || []).some((c) => !ident.has(c));
        if (offColor) el.classList.add("off-deck");

        el.innerHTML = `
          <img src="${imgUrl}" alt="${esc(card.name)}" loading="lazy">
          ${aiMark(card)}
          ${deck ? (offColor ? `<span class="off-deck-tag">Outside ${esc([...ident].join("/") || "colourless")}</span>` : `<button class="add-to-deck" type="button" data-id="${card.id}"></button>`) : ""}
          <div class="card-info">
            <div class="card-text">
              <div class="card-name" title="${esc(card.name)}">${esc(card.name)}</div>
              <div class="card-price ${price ? "" : "no-price"}">${price || "No price"}</div>
            </div>
            <div class="card-tools">
              ${flipBtnHtml(card)}
              <button class="icon-btn save-btn ${isSaved ? "saved" : ""}" data-id="${card.id}" title="${isSaved ? "Saved" : "Save"}" aria-label="${isSaved ? "Remove from saved" : "Save"}">${bookmarkIcon(isSaved)}</button>
              <button class="icon-btn detail-btn" data-id="${card.id}" title="Details" aria-label="Details">${ICON_DOTS}</button>
            </div>
          </div>`;

        wireFlipBtn(el, card);
        const atd = el.querySelector(".add-to-deck");
        if (atd) {
          setAddBtnState(atd, cardFolders(card.id).includes(deck.id));
          atd.addEventListener("click", (e) => { e.stopPropagation(); toggleInActiveDeck(card); });
        }
        el.querySelector(".save-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          openSavePopover(card, e.currentTarget);
        });
        el.querySelector(".detail-btn").addEventListener("click", (e) => { e.stopPropagation(); showDetail(card); });
        el.addEventListener("click", (e) => { if (!e.target.closest("button, input, a, select")) showDetail(card); });
        el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openCardContextMenu(card, e.clientX, e.clientY, { deckActions: false }); });
        resultsEl.appendChild(el);
      });
      scheduleTiltInit(resultsEl);
    }

    // ── Commander combos ──────────────────────────────────────────────
    const comboNorm = (s) => (s || "").toLowerCase().split("//")[0].trim();

    async function loadCombos(commander) {
      const prevScrollY = window.scrollY; // remember where we were for "Back to search"
      setActiveTab("search");
      // Snapshot the current view so "Back to search" can restore it.
      state.preCombo = {
        mode: state.mode,
        aiVisible: aiSummary.style.display !== "none",
        sortVisible: sortBar.style.display !== "none",
        queryVisible: queryDisplay.classList.contains("visible"),
        scrollY: prevScrollY,
      };
      state.mode = "combos";
      state.comboContext = { commander, offset: 0 };
      const runToken = ++comboRun;

      aiSummary.style.display = "none";
      sortBar.style.display = "none";
      paginationEl.style.display = "none";
      typeFilterEl.style.display = "none";
      queryDisplay.classList.remove("visible");
      resultsEl.innerHTML = "";
      comboListEl = null;
      comboMoreBtn = null;
      comboHeaderTitle.textContent = `Combos for ${commander}`;
      comboHeader.style.display = "flex";
      window.scrollTo(0, 0); // combos are a fresh view — start at the header
      showStatus("Loading combos…");

      try {
        const { combos, hasMore } = await fetchCombosPage(commander, 0);
        if (runToken !== comboRun) return;
        if (!combos.length) {
          hideStatus();
          resultsEl.innerHTML = `<div class="empty-state combo-msg" style="display:block"><p>No combos found</p><small>Commander Spellbook lists no combos for ${esc(commander)}.</small></div>`;
          return;
        }
        const cardMap = await enrichComboCards(combos);
        if (runToken !== comboRun) return;
        hideStatus();
        renderComboPanels(combos, cardMap, false);
        state.comboContext.offset = combos.length;
        setComboMore(hasMore, runToken);
      } catch (err) {
        if (runToken !== comboRun) return;
        hideStatus();
        resultsEl.innerHTML = `<div class="empty-state combo-msg" style="display:block"><p>Couldn't load combos</p><small>${esc(err.message || "Please try again.")}</small></div>`;
      }
    }

    async function fetchCombosPage(commander, offset) {
      const res = await fetch(`/api/combos?commander=${encodeURIComponent(commander)}&offset=${offset}`);
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || "Couldn't load combos"); }
      const data = await res.json();
      return { combos: data.combos || [], hasMore: Boolean(data.hasMore) };
    }

    async function loadMoreCombos(runToken) {
      if (runToken !== comboRun || !state.comboContext) return;
      const btn = comboMoreBtn;
      if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
      try {
        const { commander, offset } = state.comboContext;
        const { combos, hasMore } = await fetchCombosPage(commander, offset);
        if (runToken !== comboRun) return;
        if (combos.length) {
          const cardMap = await enrichComboCards(combos);
          if (runToken !== comboRun) return;
          renderComboPanels(combos, cardMap, true);
          state.comboContext.offset += combos.length;
        }
        setComboMore(hasMore && combos.length > 0, runToken);
      } catch (err) {
        if (runToken !== comboRun) return;
        if (btn) { btn.disabled = false; btn.textContent = "Try again"; }
      }
    }

    // The "Load more combos" button lives after the list; rebuilt each page.
    function setComboMore(hasMore, runToken) {
      if (comboMoreBtn) { comboMoreBtn.remove(); comboMoreBtn = null; }
      if (!hasMore) return;
      comboMoreBtn = document.createElement("button");
      comboMoreBtn.className = "combo-more-btn combo-msg";
      comboMoreBtn.textContent = "Load more combos";
      comboMoreBtn.addEventListener("click", () => loadMoreCombos(runToken));
      resultsEl.appendChild(comboMoreBtn);
    }

    // Resolve combo pieces to full Scryfall cards so they open the Focus panel and show real art.
    async function enrichComboCards(combos) {
      const map = new Map();
      const names = [...new Set(combos.flatMap((c) => c.cards.map((cd) => cd.name)).filter(Boolean))].slice(0, 75);
      if (!names.length) return map;
      try {
        const res = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifiers: names.map((n) => ({ name: n })) }),
        });
        if (res.ok) {
          const data = await res.json();
          (data.data || []).forEach((card) => map.set(comboNorm(card.name), card));
        }
      } catch { /* fall back to name-only pieces */ }
      return map;
    }

    function renderComboPanels(combos, cardMap, append) {
      if (!append || !comboListEl) {
        resultsEl.innerHTML = "";
        comboListEl = document.createElement("div");
        comboListEl.className = "combo-list";
        resultsEl.appendChild(comboListEl);
      }
      combos.forEach((combo) => comboListEl.appendChild(buildComboPanel(combo, cardMap)));
    }

    function buildComboPanel(combo, cardMap) {
      const panel = document.createElement("div");
      panel.className = "combo-panel";

      // ── fanned card stack: front card fully shown, the rest peek out to the right ──
      // Card width matches the search-results cards (grid max of 300px, 488/680 ratio).
      const CARD_W = 300, PEEK = 70, RATIO = 680 / 488;
      const n = combo.cards.length;
      const stack = document.createElement("div");
      stack.className = "combo-stack";
      stack.style.width = `${CARD_W + (n - 1) * PEEK}px`;
      stack.style.height = `${Math.round(CARD_W * RATIO)}px`;

      const nodes = combo.cards.map((piece) => {
        const full = cardMap.get(comboNorm(piece.name));
        const btn = document.createElement("button");
        btn.className = "combo-card" + (full ? "" : " unresolved");
        btn.title = piece.name;
        btn.style.width = `${CARD_W}px`;
        const img = full ? getCardImage(full) : "";
        btn.innerHTML = img
          ? `<img src="${img}" alt="${esc(piece.name)}" loading="lazy">`
          : `<span class="combo-card-ph"></span>`;
        stack.appendChild(btn);
        return { btn, full, piece };
      });

      let order = nodes.map((_, i) => i); // stack order, front to back
      const layout = () => order.forEach((idx, pos) => {
        nodes[idx].btn.style.transform = `translateX(${pos * PEEK}px)`;
        nodes[idx].btn.style.zIndex = String(n - pos);
      });
      layout();

      nodes.forEach((node, i) => {
        node.btn.addEventListener("click", () => {
          order = [i, ...order.filter((x) => x !== i)]; // one click: promote to front…
          layout();
          if (node.full) showDetail(node.full);          // …and focus it
          else window.open(`https://scryfall.com/search?q=${encodeURIComponent(`!"${node.piece.name}"`)}`, "_blank");
        });
      });

      // ── body ──
      const body = document.createElement("div");
      body.className = "combo-body";
      const names = combo.cards.map((c) => esc(c.name)).join('<span class="plus">+</span>');
      const pop = combo.popularity > 0 ? `<span class="combo-pop"><b>${combo.popularity.toLocaleString()}</b> decks</span>` : "";
      const stepsHtml = (combo.steps && combo.steps.length)
        ? `<div class="produces-label steps-label">Steps</div><ol class="combo-steps">${combo.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`
        : "";
      const notesHtml = combo.notes ? `<div class="combo-notes">${esc(combo.notes)}</div>` : "";
      body.innerHTML = `
        <div class="combo-topline">
          <span class="combo-title">${names}</span>
          ${pop}
        </div>
        <div class="produces-label">Produces</div>
        <div class="combo-chips"></div>
        ${stepsHtml}
        ${notesHtml}
        <div class="combo-foot"><a class="combo-link" href="${esc(combo.url)}" target="_blank" rel="noopener">View on Spellbook &rarr;</a></div>`;
      renderProduces(body.querySelector(".combo-chips"), combo.produces);

      panel.appendChild(stack);
      panel.appendChild(body);
      return panel;
    }

    function renderProduces(container, produces) {
      const MAX = 3;
      const addChips = (items) => items.forEach((p) => {
        const chip = document.createElement("span");
        chip.className = "combo-chip";
        chip.textContent = p;
        container.appendChild(chip);
      });
      container.innerHTML = "";
      addChips(produces.slice(0, MAX));
      if (produces.length > MAX) {
        const more = document.createElement("button");
        more.className = "combo-chip more";
        more.textContent = `+${produces.length - MAX} more`;
        more.addEventListener("click", () => { container.innerHTML = ""; addChips(produces); });
        container.appendChild(more);
      }
    }

    function exitCombos() {
      comboRun++; // cancel any in-flight combo load
      comboHeader.style.display = "none";
      hideStatus();
      const pre = state.preCombo || {};
      state.mode = pre.mode || "search";
      renderSearchView(); // rebuild #results from the preserved previous results
      sortBar.style.display = (pre.sortVisible && state.results.length) ? "flex" : "none";
      aiSummary.style.display = pre.aiVisible ? "flex" : "none";
      if (pre.queryVisible) queryDisplay.classList.add("visible");
      // Restore scroll after the results DOM is rebuilt, so the page is tall enough.
      const y = pre.scrollY || 0;
      requestAnimationFrame(() => window.scrollTo(0, y));
    }

    // Set by renderSavedCards: the filtered main-deck cards on screen, which the deck
    // analysis's mana curve follows (so "Creatures only" shows where the creatures sit).
    let deckCurveView = null; // { folderId, cards, filtered }
    // Mana-value filter chips (shown while sorting by Mana value). Buckets 0..6, 7 = 7+.
    // Lands have no real mana value, so any MV selection hides them.
    const savedMvFilter = new Set();
    const mvBucket = (c) => Math.min(7, Math.max(0, Math.round(Number(c.cmc || 0))));
    // Shared by the Decks and Collection sort rows: chips 0..7+ with nonland counts, always
    // shown on both tabs (on === false hides them). Toggles `selected`.
    function renderMvChips(el, cards, { on, selected, onChange }) {
      if (!el) return;
      el.hidden = !on;
      if (!on) { el.replaceChildren(); return; }
      const counts = [0, 0, 0, 0, 0, 0, 0, 0];
      cards.forEach((c) => { if (!isLandCard(c)) counts[mvBucket(c)] += 1; });
      el.innerHTML = counts.map((n, i) => {
        const active = selected.has(i);
        return `<button type="button" class="mv-chip${active ? " active" : ""}" data-mv="${i}" aria-pressed="${active}" title="${n} card${n === 1 ? "" : "s"} at MV ${i === 7 ? "7+" : i}">${i === 7 ? "7+" : i}</button>`;
      }).join("");
      el.querySelectorAll(".mv-chip").forEach((b) => b.addEventListener("click", () => {
        const v = Number(b.dataset.mv);
        if (selected.has(v)) selected.delete(v); else selected.add(v);
        onChange();
      }));
    }
    const mvMatches = (c, selected) => !isLandCard(c) && selected.has(mvBucket(c));

    // Land-colour chips (shown while the type filter is on Lands). One colour = every land
    // that makes it; several = lands that make all of them (e.g. U+R finds Izzet duals and
    // Triomes); ◇ = lands that make no coloured mana (exclusive, like the identity pickers).
    // Fetch lands count as every colour — they can find any basic.
    function landColors(card) {
      if (/search your library for (a|an).*land|search your library for.*basic land/i.test(getOracleText(card))) return new Set(WUBRG);
      return new Set(cardProduces(card).filter((m) => WUBRG.includes(m)));
    }
    function landColorMatches(card, selected) {
      if (!selected.length) return true;
      if (!isLandCard(card)) return false;
      const made = landColors(card);
      if (selected.includes("C")) return made.size === 0;
      return selected.every((c) => made.has(c));
    }
    const typeFilterIsLands = (filter) => !filter.excludeMode && filter.types.has("Land");
    function renderLandChips(el, cards, { on, selected, onChange }) {
      if (!el) return;
      el.hidden = !on;
      if (!on) { el.replaceChildren(); return; }
      const lands = cards.filter(isLandCard);
      el.innerHTML = ["W", "U", "B", "R", "G", "C"].map((c) => {
        const n = lands.filter((l) => landColorMatches(l, [c])).length;
        const active = selected.includes(c);
        const label = c === "C" ? "Colourless only" : { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" }[c];
        return `<button type="button" class="color-toggle land-chip${active ? " active" : ""}" data-color="${c.toLowerCase()}" data-land="${c}" aria-pressed="${active}" title="${label} · ${n} land${n === 1 ? "" : "s"}">${MANA_SVG[c.toLowerCase()]}</button>`;
      }).join("");
      el.querySelectorAll("[data-land]").forEach((b) => b.addEventListener("click", () => {
        const next = toggleIdentityColor(selected, b.dataset.land);
        selected.splice(0, selected.length, ...next);
        onChange();
      }));
    }
    const savedLandFilter = [];
    const collectionLandFilter = [];
    let trimOpenKey = null; // trim-planner category whose cut list is open
    let trimShowAll = false;
    let trimCtx = null;

    // Mana-curve block of the deck analysis. Depends on the on-screen selection (deckCurveView),
    // so filter changes repaint just this (refreshDeckCurve) instead of the whole analysis.
    let daCurveCtx = null; // { folderId, cards, stats, profile, identityTags } from the last analysis render
    function deckCurveBlockHtml(ctx) {
      if (!ctx) return "";
      const { folderId, cards, stats, profile, identityTags } = ctx;
      const scoped = Boolean(deckCurveView && deckCurveView.folderId === folderId && deckCurveView.filtered);
      const spellsTarget = 100 - Math.round((profile.landTarget[0] + profile.landTarget[1]) / 2);
      const target = curveTarget(scoped ? deckCurveView.targetCards : cards, cards, spellsTarget, typeTargetsFor(identityLensKeys(identityTags)));
      const curve = scoped ? computeDeckStats(deckCurveView.cards, folderId).curve : stats.curve;
      const mvOnly = scoped && savedMvFilter.size ? savedMvFilter : null;
      return `<div class="da-h">Mana curve${scoped ? ` <span class="da2-approx">· current selection</span>` : ""}</div>${curveHtml(curve, target, mvOnly)}`;
    }
    function refreshDeckCurve() {
      const wrap = $("#da2-curve-wrap");
      if (!wrap || !daCurveCtx || daCurveCtx.folderId !== state.activeFolder) return false;
      wrap.innerHTML = deckCurveBlockHtml(daCurveCtx);
      return true;
    }

    // filtersOnly: only the view filters changed (text, type/color/MV chips) — the deck
    // itself didn't, so the analysis stays and only its mana curve is repainted.
    // ── Maybeboard list (Focus panel, pop-out window, or the phone sheet) ──
    const MB_TYPES = [["Creature", "Creatures"], ["Planeswalker", "Planeswalkers"], ["Battle", "Battles"], ["Instant", "Instants"], ["Sorcery", "Sorceries"], ["Artifact", "Artifacts"], ["Enchantment", "Enchantments"], ["Land", "Lands"]];
    // var + hoisted helpers: renderSavedCards can run before this line during start-up.
    function isPhoneNow() { return window.matchMedia("(max-width: 760px)").matches; }
    var mbUi = (() => {
      const d = { order: "card", split: 0.58, popped: false, x: null, y: null, w: 300, hgt: 420 };
      try { return { ...d, ...JSON.parse(localStorage.getItem("mb_ui") || "{}") }; } catch { return d; }
    })();
    const saveMbUi = () => lsSet("mb_ui", JSON.stringify(mbUi));
    var mbDrag = null; // { id, from: "deck" | "maybe" } while a card is dragged
    function mbTypeOf(card) {
      const tl = (card.type_line || card.card_faces?.[0]?.type_line || "").split("//")[0];
      return (MB_TYPES.find(([t]) => tl.includes(t)) || ["Other", "Other"])[0];
    }
    function costPipsHtml(cost) {
      const syms = (cost || "").split("//")[0].match(/\{[^}]+\}/g) || [];
      return `<span class="mc">${syms.map((s) => { const v = s.slice(1, -1).toUpperCase(); const k = /^[WUBRG]$/.test(v) ? v : (/^\d+$|^X$/.test(v) ? "N" : "H"); return `<i class="mc-${k}">${esc(v.replace("/", ""))}</i>`; }).join("")}</span>`;
    }
    // Is the list visible somewhere, so the grid can drop its Maybeboard section?
    function maybeListShown() {
      if (!mbUi) return false;
      if (isPhoneNow()) return true; // the deck bar's Maybe chip opens it as a sheet
      return mbUi.popped || !appShell.classList.contains("detail-collapsed");
    }
    function maybeCards(deck) { return deck ? getFolderCards(deck.id).filter((c) => isMaybe(deck.id, c.id)) : []; }
    function renderMaybeList() {
      if (!mbUi) return;
      updateFocusStack();
      const list = $("#mb-list");
      const deck = activeDeck();
      if (!list) return;
      const cards = maybeCards(deck);
      $("#mb-count").textContent = cards.length;
      const total = cards.reduce((n, c) => n + (parseFloat(c.prices?.eur || c.prices?.usd || 0) || 0) * cardQty(deck.id, c.id), 0);
      $("#mb-total").textContent = cards.length ? `€${total.toFixed(2)}` : "";
      if (!cards.length) {
        list.innerHTML = `<div class="mb-empty">${isPhoneNow() ? "Swipe a card left to move it here." : "Drag cards here to cut them from the deck."}<br><span>They stay in the deck's list, outside the 100.</span></div>`;
        return;
      }
      const groups = MB_TYPES.map(([t, label]) => [label, cards.filter((c) => mbTypeOf(c) === t)]);
      groups.push(["Other", cards.filter((c) => mbTypeOf(c) === "Other")]);
      const sel = state.detailCard?.id;
      list.innerHTML = groups.filter(([, l]) => l.length).map(([label, l]) => `
        <div class="mb-group"><h4><span>${label}</span><span>${l.length}</span></h4>
        ${l.sort((a, b) => (a.cmc || 0) - (b.cmc || 0) || a.name.localeCompare(b.name)).map((c) => `<div class="mb-row${c.id === sel ? " sel" : ""}" data-mb-id="${c.id}" draggable="${!isPhoneNow()}" tabindex="0" role="button" aria-label="Show ${escAttr(c.name)}">
          <span class="mb-nm">${esc(c.name)}</span>${costPipsHtml(c.mana_cost || c.card_faces?.[0]?.mana_cost)}<span class="mb-pr">${esc(getPrice(c) || "")}</span>
          <span class="mb-acts"><button type="button" data-mb-act="back" title="Back to the deck" aria-label="Move ${escAttr(c.name)} back to the deck">↑</button><button type="button" data-mb-act="remove" title="Remove from the deck" aria-label="Remove ${escAttr(c.name)} from the deck">✕</button></span>
        </div>`).join("")}</div>`).join("");
    }
    // Lay out the Focus panel: card only, or card + maybeboard stacked in the chosen order and split.
    function updateFocusStack() {
      const panel = $("#detail-panel");
      if (!panel || !mbUi) return;
      const deck = activeDeck();
      const onDecks = state.activeTab === "saved" && Boolean(deck);
      const stacked = onDecks && !isPhoneNow() && !mbUi.popped && !appShell.classList.contains("detail-collapsed");
      panel.classList.toggle("stacked", stacked);
      panel.classList.toggle("mb-first", mbUi.order === "maybe");
      const cardShare = mbUi.order === "card" ? mbUi.split : 1 - mbUi.split;
      panel.style.setProperty("--card-flex", String(cardShare));
      panel.style.setProperty("--mb-flex", String(1 - cardShare));
      const float = $("#mb-float"), pane = $("#mb-pane");
      const showFloat = onDecks && !isPhoneNow() && mbUi.popped;
      if (showFloat && pane.parentNode !== $("#mb-float-body")) $("#mb-float-body").appendChild(pane);
      if (!showFloat && pane.parentNode === $("#mb-float-body")) panel.appendChild(pane);
      float.hidden = !showFloat;
      if (showFloat) {
        const w = Math.min(Math.max(240, mbUi.w), innerWidth - 16), hh = Math.min(Math.max(200, mbUi.hgt), innerHeight - 16);
        float.style.width = w + "px"; float.style.height = hh + "px";
        float.style.left = Math.max(8, Math.min(innerWidth - w - 8, mbUi.x ?? innerWidth - w - 380)) + "px";
        float.style.top = Math.max(8, Math.min(innerHeight - 60, mbUi.y ?? 120)) + "px";
      }
      $("#mb-pop").hidden = mbUi.popped;
      $("#mb-swap").hidden = mbUi.popped;
    }
    function maybeMove(card, toMaybe, { toast = true } = {}) {
      const deck = activeDeck();
      if (!deck) return;
      setMaybe(deck.id, card.id, toMaybe);
      renderSavedCards();
      if (toast) showToast(toMaybe ? `Moved ${card.name} to the maybeboard` : `${card.name} is back in the deck`, { actionLabel: "Undo", ms: 5000, onAction: () => maybeMove(card, !toMaybe, { toast: false }) });
    }

    function renderSavedCards({ filtersOnly = false } = {}) {
      renderFolderRail();
      const filter = savedFilter.value.toLowerCase();
      const cards = sortCardsByField(
        getFolderCards(state.activeFolder).filter((c) => !filter || c.name.toLowerCase().includes(filter) || (c.type_line || "").toLowerCase().includes(filter)),
        state.savedSortField,
        state.savedSortDir
      );
      ensureActiveDeck();
      const isRealDeck = state.folders.some((f) => f.id === state.activeFolder);

      // Type chips reflect the folder/text-filtered set (both sections); then narrow to selection.
      renderTypeFilterChips(savedTypeFilterEl, cards, savedTypeFilter, () => renderSavedCards({ filtersOnly: true }));
      renderMvChips($("#saved-mv-chips"), cards, { on: true, selected: savedMvFilter, onChange: () => renderSavedCards({ filtersOnly: true }) });
      const mvActive = savedMvFilter.size > 0;
      const landsOn = typeFilterIsLands(savedTypeFilter);
      if (!landsOn) savedLandFilter.length = 0;
      renderLandChips($("#saved-land-chips"), cards.filter((c) => matchesTypeFilter(c, savedTypeFilter)), { on: landsOn, selected: savedLandFilter, onChange: () => renderSavedCards({ filtersOnly: true }) });
      const preMv = cards.filter((c) => matchesTypeFilter(c, savedTypeFilter)).filter((c) => deckColorMatch(c, deckColorFilter))
        .filter((c) => landColorMatches(c, savedLandFilter));
      const visible = preMv.filter((c) => !mvActive || (!isLandCard(c) && savedMvFilter.has(mvBucket(c))));

      // Maybeboard cards stay in the deck but are excluded from the main section and
      // everything that measures the deck (analysis, size, export) — see below.
      const mainVisible = isRealDeck ? visible.filter((c) => !isMaybe(state.activeFolder, c.id)) : visible;
      const maybeVisible = isRealDeck ? visible.filter((c) => isMaybe(state.activeFolder, c.id)) : [];
      renderDeckTools(isRealDeck, mainVisible);

      if (!mainVisible.length && !maybeVisible.length) {
        savedEmpty.style.display = "block";
        const anySaved = state.savedCards.length > 0;
        savedEmpty.querySelector("p").textContent = anySaved ? "Nothing in this deck" : "No saved cards yet";
        savedEmpty.querySelector("small").textContent = anySaved ? "Bookmark cards into this deck to see them here" : "Search for cards and save them to build your list";
      } else {
        savedEmpty.style.display = "none";
      }
      // Empty deck (or no decks yet): one clear next step instead of an empty grid.
      const noDecks = !state.folders.length;
      const deckEmpty = isRealDeck && getFolderCards(state.activeFolder).length === 0;
      const showStart = noDecks || deckEmpty;
      $("#deck-start").hidden = !showStart;
      if (showStart) {
        savedEmpty.style.display = "none";
        $("#deck-tools").style.display = "none";
        $("#deck-start-title").textContent = noDecks ? "Create your first deck" : "Start with a commander";
        $("#deck-start-pick").textContent = noDecks ? "New deck" : "Choose a commander";
        $("#deck-start-import").hidden = noDecks;
      }
      $("#saved-sort-bar").style.display = showStart ? "none" : "";
      state.savedVisible = mainVisible; // exact on-screen main-deck set, used by the export button
      if (savedExportBtn) savedExportBtn.disabled = mainVisible.length === 0;
      const playmatBtn = $("#saved-playmat-btn");
      if (playmatBtn) {
        // the whole deck goes to Playmat, so it's offered whenever the deck has cards, whatever the filters show
        const deckHasCards = isRealDeck && getFolderCards(state.activeFolder).some((c) => !isMaybe(state.activeFolder, c.id));
        playmatBtn.hidden = !isRealDeck;
        playmatBtn.disabled = !deckHasCards;
      }

      // A designated commander (only real decks have one) sorts to the front.
      const deck = state.folders.find((f) => f.id === state.activeFolder) || null;
      const commanderId = deck ? deck.commanderId || null : null;
      if (commanderId) {
        const ci = mainVisible.findIndex((c) => c.id === commanderId);
        if (ci > 0) mainVisible.unshift(mainVisible.splice(ci, 1)[0]);
      }

      // "All" and "Unsorted" are library buckets, not decks — analysis only for real decks.
      if (!isRealDeck) { dA.style.display = "none"; dA.innerHTML = ""; hideDeckProgress(); }
      else {
        const wholeDeck = getFolderCards(state.activeFolder).filter((c) => !isMaybe(state.activeFolder, c.id));
        // The mana curve follows the on-screen selection; everything else measures the whole deck.
        // targetCards: the same selection before the MV chips, so picking "MV 3" narrows the
        // bars without shrinking the target the dashed line is drawn from.
        const targetCards = isRealDeck ? preMv.filter((c) => !isMaybe(state.activeFolder, c.id)) : preMv;
        deckCurveView = { folderId: state.activeFolder, cards: mainVisible.slice(), targetCards, filtered: mainVisible.length !== wholeDeck.length };
        if (!(filtersOnly && refreshDeckCurve())) renderDeckAnalysis(deck, wholeDeck); // whole deck minus Maybeboard, not the filtered view
      }

      savedGrid.innerHTML = "";
      // Divider counts are quantity-weighted (basics ×N) so they match the deck totals.
      const qtySum = (list) => list.reduce((n, c) => n + cardQty(state.activeFolder, c.id), 0);
      const addDivider = (label) => {
        const divider = document.createElement("div");
        divider.className = "deck-section-divider";
        divider.textContent = label;
        savedGrid.appendChild(divider);
      };
      if (isRealDeck && mainVisible.length) addDivider(`Main deck · ${qtySum(mainVisible)}`);
      mainVisible.forEach((card) => renderCardTile(card, deck, commanderId, false));
      if (maybeVisible.length && !maybeListShown()) {
        addDivider(`Maybeboard · ${qtySum(maybeVisible)}`);
        maybeVisible.forEach((card) => renderCardTile(card, deck, commanderId, true));
      }
      scheduleTiltInit(savedGrid);
      renderMaybeList();
    }

    // Builds and appends one card tile to #saved-grid. Shared by the main-deck and
    // Maybeboard sections — `isMaybeCard` only changes styling and the badge.
    function renderCardTile(card, deck, commanderId, isMaybeCard) {
      const el = document.createElement("div");
      el.className = "card-item" + (isMaybeCard ? " maybe" : "");
      const imgUrl = getCardImage(card);
      const price = getPrice(card);
      const isCommander = card.id === commanderId;
      const crownBtn = (deck && isLegendaryCreature(card))
        ? `<button class="icon-btn crown-btn ${isCommander ? "is-commander" : ""}" data-id="${card.id}" title="${isCommander ? "Commander (click to unset)" : "Set as commander"}" aria-label="${isCommander ? "Unset commander" : "Set as commander"}">${ICON_CROWN}</button>`
        : "";
      // Basic lands in a real deck carry an editable per-deck count.
      const countBadge = (state.activeFolder !== "all" && isBasicLand(card))
        ? `<button class="count-badge" title="Click to edit quantity" aria-label="Edit quantity">×${cardQty(state.activeFolder, card.id)}</button>`
        : "";
      el.innerHTML = `
        <img src="${imgUrl}" alt="${esc(card.name)}" loading="lazy">
        ${aiMark(card)}
        ${countBadge}
        ${isCommander ? `<span class="commander-badge">${ICON_CROWN}Commander</span>` : ""}
        ${isMaybeCard ? `<span class="maybe-badge">Maybe</span>` : ""}
        ${deck && isPinned(deck.id, card.id) ? `<span class="pin-badge${countBadge ? " stacked" : ""}" title="Pinned — kept when trimming">${ICON_PIN}</span>` : ""}
        ${ownedQty(collectionIndex, card) > 0 ? `<span class="owned-chip${isCommander || isMaybeCard ? " stacked" : ""}">Owned</span>` : ""}
        <div class="card-info">
          <div class="card-text">
            <div class="card-name" title="${esc(card.name)}">${esc(card.name)}</div>
            <div class="card-price ${price ? "" : "no-price"}">${price || "No price"}</div>
          </div>
          <div class="card-tools">
            ${crownBtn}
            ${flipBtnHtml(card)}
            <button class="icon-btn saved save-btn" data-id="${card.id}" title="Saved" aria-label="Edit decks">${bookmarkIcon(true)}</button>
            <button class="icon-btn detail-btn" data-id="${card.id}" title="Details" aria-label="Details">${ICON_DOTS}</button>
          </div>
        </div>`;
      wireFlipBtn(el, card);
      el.querySelector(".crown-btn")?.addEventListener("click", (e) => { e.stopPropagation(); setDeckCommander(state.activeFolder, card.id); });
      el.querySelector(".count-badge")?.addEventListener("click", (e) => { e.stopPropagation(); startQtyEdit(e.currentTarget, card.id); });
      el.querySelector(".save-btn").addEventListener("click", (e) => { e.stopPropagation(); openSavePopover(card, e.currentTarget); });
      el.querySelector(".detail-btn").addEventListener("click", (e) => { e.stopPropagation(); showDetail(card); });
      el.addEventListener("click", (e) => { if (!e.target.closest("button, input, a, select")) showDetail(card); });
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openCardContextMenu(card, e.clientX, e.clientY); });
      el.dataset.cardId = card.id;
      if (deck && !isPhoneNow()) {
        el.draggable = true;
        el.addEventListener("dragstart", (e) => { mbDrag = { id: card.id, from: isMaybeCard ? "maybe" : "deck" }; el.classList.add("dragging"); try { e.dataTransfer.setData("text/plain", card.name); e.dataTransfer.effectAllowed = "move"; } catch {} });
        el.addEventListener("dragend", () => { mbDrag = null; el.classList.remove("dragging"); document.querySelectorAll(".mb-drop").forEach((x) => x.classList.remove("mb-drop")); });
      }
      savedGrid.appendChild(el);
    }

    // Swap a basic land's count badge for an inline number field; commit on Enter/blur.
    function startQtyEdit(badge, cardId) {
      const folderId = state.activeFolder;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.className = "count-edit";
      input.value = cardQty(folderId, cardId);
      badge.replaceWith(input);
      input.focus();
      input.select();
      let settled = false;
      const cancel = () => { if (!settled) { settled = true; renderSavedCards(); } };
      const commit = () => {
        if (settled) return;
        settled = true;
        setCardQty(folderId, cardId, input.value);
        renderFolderRail(); // deck size in the sidebar
        renderSavedCards(); // badge + deck analysis
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });
      input.addEventListener("blur", commit);
    }

    // Debounced: rebuilding the grid on every keystroke is wasted work mid-word.
    let savedFilterTimer = null;
    savedFilter.addEventListener("input", () => {
      clearTimeout(savedFilterTimer);
      savedFilterTimer = setTimeout(() => renderSavedCards({ filtersOnly: true }), 160);
    });

