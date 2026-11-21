    // ── Guided build: commander → core roles → theme → mana → cut to 100 ──
    // Scryfall oracle tags per role (checked against the live API); used to open Search
    // already filtered for the step's job, ordered by EDHREC popularity. No AI involved.
    const ROLE_SEARCH = {
      ramp: "otag:ramp", draw: "otag:draw", removal: "otag:removal -otag:board-wipe", wipes: "otag:board-wipe",
      tutors: "otag:tutor", interaction: "(otag:counterspell or (otag:removal (t:instant or kw:flash)))",
      graveyardHate: "otag:graveyard-hate", protection: "(otag:gives-protection or otag:gives-hexproof or otag:gives-indestructible)",
    };
    const PATH_ROLE_KEYS = ["ramp", "draw", "removal", "wipes", "interaction"];
    let pathSel = null;      // a step the user clicked to read (null = the current step)
    let lastDeckPath = null;
    // Pure-ish: everything it reads is passed in or derived from the deck's cards.
    function deckPath(deck, cards, pre = {}) {
      const folderId = deck.id;
      const s = pre.s || computeDeckStats(cards, folderId);
      const commander = pre.commander !== undefined ? pre.commander : (deck.commanderId ? cards.find((c) => c.id === deck.commanderId) : null);
      const colors = deckColors(cards, commander);
      const tags = deckReviewCache[folderId]?.data?.identityTags;
      const profile = pre.profile || effectiveDeckProfile(Array.isArray(tags) ? tags : []);
      const counts = pre.counts || countsFromRoleDetails(detectRoleDetails(cards, folderId, profilesFromCache(cards)));
      const sources = pre.sources || colorSourceStats(cards, folderId, colors);
      const items = computeGrade(counts, sources, s, profile).items;
      const short = (keys) => items.filter((i) => keys(i.key) && i.status === "low").sort((a, b) => (b.weight * (b.lo - b.value)) - (a.weight * (a.lo - a.value)));
      const id = colors.join("").toLowerCase() || "c";
      const steps = [];

      steps.push(commander
        ? { key: "commander", label: "Commander", sub: commander.name, done: true, title: `Commander: ${commander.name}`, note: "Change it from the empty-deck screen or the card's crown." }
        : { key: "commander", label: "Commander", sub: "Not set", done: false, title: "Pick a commander", note: "Everything else is built around it.", action: { label: "Choose a commander", run: () => openNewDeck({ deck }) } });

      const roleShort = short((k) => PATH_ROLE_KEYS.includes(k));
      const r0 = roleShort[0];
      steps.push(r0
        ? { key: "roles", label: "Core roles", sub: `${roleShort.length} role${roleShort.length === 1 ? "" : "s"} short`, done: false,
            title: `Add ${Math.ceil(r0.lo - r0.value)} ${r0.label.toLowerCase()}`, note: `You have ${fmtScoreNum(r0.value)} of ${r0.lo}.${roleShort.length > 1 ? ` Also short: ${roleShort.slice(1).map((i) => i.label.toLowerCase()).join(", ")}.` : ""}`,
            action: { label: `Find ${r0.label.toLowerCase()}`, run: () => guidedSearch(deck, { role: r0.key, label: r0.label, want: r0.lo, query: `${ROLE_SEARCH[r0.key]} id<=${id}` }) } }
        : { key: "roles", label: "Core roles", sub: "On target", done: true, title: "Core roles are covered", note: "Ramp, draw, removal, wipes and interaction are all at target." });

      const landLo = profile.landTarget[0];
      const landsOwed = Math.max(0, landLo - s.lands);
      const themeOpen = Math.max(0, 100 - s.total - landsOwed);
      steps.push(themeOpen > 0
        ? { key: "theme", label: "Theme", sub: `${themeOpen} slot${themeOpen === 1 ? "" : "s"} open`, done: false, title: `Fill ${themeOpen} slot${themeOpen === 1 ? "" : "s"} with your theme`, note: "Autofill picks from EDHREC within your budget.", action: { label: "Autofill", run: () => openAutofill(deck, commander) } }
        : { key: "theme", label: "Theme", sub: "Filled", done: true, title: "Theme slots are filled", note: `${s.total - s.lands} nonland cards.` });

      const manaShort = short((k) => k === "lands" || k.startsWith("source-"));
      const curve = items.find((i) => i.key === "curve");
      const landsHigh = items.find((i) => i.key === "lands" && i.status === "high");
      const m0 = manaShort[0];
      let mana;
      if (m0 && m0.key === "lands") mana = { title: `Add ${Math.ceil(m0.lo - m0.value)} lands`, note: `You have ${s.lands}; aim for ${m0.lo}–${m0.hi}.`, action: { label: "Find lands", run: () => guidedSearch(deck, { role: "lands", label: "Lands", want: m0.lo, query: `t:land -t:basic id<=${id}` }) } };
      else if (m0) { const col = m0.key.slice(7).toLowerCase(); mana = { title: `More ${m0.label.toLowerCase()}`, note: `${fmtScoreNum(m0.value)} of ${m0.lo} needed.`, action: { label: `Find ${COLOR_FULL[col.toUpperCase()] || ""} sources`.replace("  ", " "), run: () => guidedSearch(deck, { role: m0.key, label: m0.label, want: m0.lo, query: `(t:land or otag:ramp) produces:${col} id<=${id}` }) } }; }
      else if (landsHigh) mana = { title: `Cut ${Math.ceil(landsHigh.value - landsHigh.hi)} lands`, note: `${s.lands} lands is above the ${landsHigh.hi} target.` };
      else if (curve && curve.status === "high") mana = { title: "Lower your curve", note: `Average MV ${s.avgMv.toFixed(1)}; aim for ${curve.hi} or less.` };
      steps.push(mana
        ? { key: "mana", label: "Mana", sub: `${s.lands} lands`, done: false, ...mana }
        : { key: "mana", label: "Mana", sub: `${s.lands} lands · ok`, done: true, title: "Mana base on target", note: `${s.lands} lands, colour sources covered, avg MV ${s.avgMv.toFixed(1)}.` });

      const over = s.total - 100;
      const openCuts = () => {
        daTab = "build"; trimOpenKey = null; trimShowAll = false;
        try { lsSet("deck_analysis_tab", daTab); } catch {}
        renderSavedCards();
        requestAnimationFrame(() => {
          const target = $("#da2-trim") || dA;
          const covered = ($("header")?.offsetHeight || 0) + ($("#deck-progress")?.offsetHeight || 0) + 20;
          window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - covered, behavior: "smooth" });
          target.classList.remove("da2-flash"); void target.offsetWidth; target.classList.add("da2-flash");
        });
      };
      steps.push(over > 0
        ? { key: "cut", label: "Cut to 100", sub: `${over} over`, done: false, title: `Cut ${over} card${over === 1 ? "" : "s"}`, note: "Cuts go to the maybeboard, so nothing is lost.", action: { label: "Show cut suggestions", run: () => openCutView(deck, openCuts) } }
        : { key: "cut", label: "Cut to 100", sub: s.total === 100 ? "100 ✓" : `${s.total} now`, done: s.total === 100, title: s.total === 100 ? "Exactly 100" : `${100 - s.total} to go`, note: s.total === 100 ? "Deck is complete." : "Add cards first; cut once you're over 100." });

      // Over 100, cutting comes first; otherwise the first unfinished step in order.
      let current = over > 0 ? 4 : steps.findIndex((st) => !st.done);
      if (current < 0) current = 4;
      return { steps, current, deckId: deck.id };
    }
    function deckPathHtml(path) {
      if (!path) return "";
      const sel = pathSel != null && path.steps[pathSel] ? pathSel : path.current;
      const st = path.steps[sel];
      const isNow = sel === path.current;
      const allDone = path.steps.every((x) => x.done);
      return `
        <div class="dp-path">
          <div class="dp-steps" role="list">${path.steps.map((x, i) => `<button type="button" role="listitem" class="dp-step${x.done ? " done" : ""}${i === path.current && !allDone ? " now" : ""}${i === sel && !isNow ? " sel" : ""}" data-path-step="${i}" title="${escAttr(x.sub)}"><em>${x.done ? "✓" : i + 1}</em><span>${esc(x.label)}</span></button>`).join("")}</div>
          <div class="dp-next${allDone ? " done" : ""}"><div class="dp-next-t"><span class="dp-next-step">Step ${sel + 1}/5</span>${isNow && !allDone && !st.done ? "Next: " : ""}${esc(st.title)}<small>${esc(st.note)}</small></div>${st.action && !st.done ? `<button class="dp-next-btn" type="button">${esc(st.action.label)}</button>` : ""}</div>
        </div>`;
    }
    function wireDeckPath(el) {
      const btn = el.querySelector(".dp-next-btn");
      if (!btn || !lastDeckPath) return;
      const sel = pathSel != null && lastDeckPath.steps[pathSel] ? pathSel : lastDeckPath.current;
      btn.addEventListener("click", () => { pathSel = null; lastDeckPath.steps[sel].action?.run(); });
    }

    // Cut view: the remove twin of the Add view. Suggested cuts as full cards with a Cut button,
    // a "Cutting from" bar counting down to 100, and Back to deck.
    function openCutView(deck, fallback) {
      if (!trimCtx || trimCtx.folderId !== deck.id || !trimCtx.budget) { fallback?.(); return; }
      const sug = trimSuggested(trimCtx.budget, trimCtx);
      state.cutView = { folderId: deck.id, items: sug.slice(0, Math.max(24, trimCtx.budget.toCut * 3)), cut: new Set() };
      state.buildTarget = null;
      setActiveTab("search");
      startSearchRun(); // supersede any search still loading
      state.mode = "cuts";
      queryDisplay.classList.remove("visible");
      aiSummary.style.display = "none";
      comboHeader.style.display = "none";
      paginationEl.style.display = "none";
      sortBar.style.display = "none";
      typeFilterEl.style.display = "none";
      hideStatus();
      renderCutView();
      window.scrollTo(0, 0);
    }
    function deckMainTotal(folderId) { return getFolderCards(folderId).filter((c) => !isMaybe(folderId, c.id)).reduce((n, c) => n + cardQty(folderId, c.id), 0); }
    function renderCutView() {
      const cv = state.cutView;
      if (!cv) return;
      renderBuildTarget();
      resultsEl.innerHTML = "";
      cv.items.forEach((x, i) => {
        const card = x.card;
        const isCut = isMaybe(cv.folderId, card.id);
        const el = document.createElement("div");
        el.className = "card-item cut-tile" + (isCut ? " is-cut" : "");
        const reason = x.why.split(" · ")[0] || "";
        el.innerHTML = `
          <img src="${getCardImage(card)}" alt="${escAttr(card.name)}" loading="lazy">
          <span class="cut-rank" title="Suggestion #${i + 1}">${i + 1}</span>
          <button class="add-to-deck cut-btn${isCut ? " in" : ""}" type="button" aria-label="${isCut ? `Put ${escAttr(card.name)} back in the deck` : `Cut ${escAttr(card.name)} to the maybeboard`}">${isCut ? '<span aria-hidden="true">✓</span><span class="atd-l">Cut</span>' : '<span aria-hidden="true">−</span><span class="atd-l">Cut</span>'}</button>
          <div class="card-info cut-info"><div class="card-text"><div class="card-name" title="${escAttr(card.name)}">${esc(card.name)}</div><div class="card-price cut-why" title="${escAttr(x.why)}">${esc(reason)}</div></div></div>`;
        el.querySelector(".cut-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          const now = !isMaybe(cv.folderId, card.id);
          setMaybe(cv.folderId, card.id, now);
          renderCutView();
          renderFolderRail();
          if (now) showToast(`Cut ${card.name} to the maybeboard`, { actionLabel: "Undo", ms: 4000, onAction: () => { setMaybe(cv.folderId, card.id, false); renderCutView(); renderFolderRail(); } });
        });
        el.addEventListener("click", (e) => { if (!e.target.closest("button")) showDetail(card); });
        el.addEventListener("contextmenu", (e) => { e.preventDefault(); openCardContextMenu(card, e.clientX, e.clientY); });
        resultsEl.appendChild(el);
      });
    }

    // Open Search for one job ("removal for this deck"): a direct Scryfall query, no AI.
    // The "Adding to" bar then tracks that job's progress as cards are added.
    async function guidedSearch(deck, { role, label, want, query }) {
      state.buildTarget = { folderId: deck.id, role, label, want };
      state.cutView = null;
      setActiveTab("search");
      const searchRun = startSearchRun();
      queryDisplay.classList.remove("visible");
      aiSummary.style.display = "none";
      comboHeader.style.display = "none";
      comboRun++;
      resultsEl.innerHTML = "";
      paginationEl.style.display = "none";
      sortBar.style.display = "none";
      searchTypeFilter.types.clear();
      searchTypeFilter.subtypes.clear();
      typeFilterEl.style.display = "none";
      typeFilterEl.replaceChildren();
      state.results = [];
      state.nextPage = null;
      state.mode = "search";
      setSortMode("search");
      state.sortField = "edhrec"; state.sortDir = "asc";
      sortField.value = "edhrec";
      const full = `${query} f:commander -t:basic game:paper`;
      state.currentQuery = full;
      showQueryChips(full);
      queryDisplay.classList.add("visible");
      searchInput.value = "";
      renderBuildTarget();
      showSkeletons(resultsEl);
      window.scrollTo(0, 0);
      await searchScryfall(full, null, searchRun.run, searchRun.signal);
    }

    // How many cards in the deck fill a job right now (role, lands, or a colour's sources).
    function buildTargetHave(t) {
      const deck = state.folders.find((x) => x.id === t.folderId);
      if (!deck) return 0;
      const cards = getFolderCards(deck.id).filter((c) => !isMaybe(deck.id, c.id));
      if (t.role === "lands") return computeDeckStats(cards, deck.id).lands;
      if (t.role.startsWith("source-")) {
        const commander = deck.commanderId ? cards.find((c) => c.id === deck.commanderId) : null;
        return colorSourceStats(cards, deck.id, deckColors(cards, commander)).find((x) => x.c === t.role.slice(7))?.have || 0;
      }
      return countsFromRoleDetails(detectRoleDetails(cards, deck.id, profilesFromCache(cards)))[t.role] || 0;
    }
    function deckIdentity(deck) {
      if (!deck?.commanderId) return null;
      const cmd = state.savedCards.find((c) => c.id === deck.commanderId);
      return cmd ? new Set(cmd.color_identity || []) : null;
    }
    function renderBuildTarget() {
      const el = $("#build-target");
      if (!el) return;
      if (state.mode === "cuts" && state.cutView) {
        const cv = state.cutView;
        const d = state.folders.find((x) => x.id === cv.folderId);
        if (!d) { el.hidden = true; return; }
        const total = deckMainTotal(d.id), over = total - 100;
        const ident = deckIdentity(d);
        const start = Math.max(total, 100 + (trimCtx?.folderId === d.id ? trimCtx.budget.toCut : 0));
        const done = Math.max(0, start - total), need = Math.max(1, start - 100);
        el.innerHTML = `<span class="bt-lbl">Cutting from</span>
          <span class="bt-deck">${ident ? manaPipsHtml([...ident]) : ""}<b>${esc(d.name)}</b></span>
          <span class="bt-goal">${over > 0 ? `${over} to cut` : over === 0 ? "100 ✓" : `${-over} under 100`} <span class="bt-bar"><i class="${over <= 0 ? "ok" : ""}" style="width:${Math.min(100, (done / need) * 100)}%"></i></span>${total}/100</span>
          <button class="bt-back" type="button" id="bt-back">← Back to deck</button>`;
        el.classList.add("cutting");
        el.hidden = false;
        $("#bt-back").addEventListener("click", () => { state.cutView = null; state.mode = "search"; el.classList.remove("cutting"); resultsEl.innerHTML = ""; setActiveTab("saved"); window.scrollTo(0, 0); });
        return;
      }
      el.classList.remove("cutting");
      const deck = activeDeck();
      if (!deck || state.mode === "combos") { el.hidden = true; return; }
      const t = state.buildTarget && state.buildTarget.folderId === deck.id ? state.buildTarget : null;
      const cards = getFolderCards(deck.id).filter((c) => !isMaybe(deck.id, c.id));
      const total = cards.reduce((n, c) => n + cardQty(deck.id, c.id), 0);
      const ident = deckIdentity(deck);
      const pips = ident ? manaPipsHtml([...ident]) : "";
      let goal = "";
      if (t) {
        const have = buildTargetHave(t);
        const pct = Math.min(100, (have / Math.max(1, t.want)) * 100);
        goal = `<span class="bt-goal" title="${escAttr(t.label)}: ${fmtScoreNum(have)} of ${t.want}">${esc(t.label)} <span class="bt-bar"><i class="${have >= t.want ? "ok" : ""}" style="width:${pct}%"></i></span>${fmtScoreNum(have)}/${t.want}</span>`;
      } else {
        goal = `<span class="bt-goal">${total}/100</span>`;
      }
      el.innerHTML = `<span class="bt-lbl">Adding to</span>
        <label class="bt-deck">${pips}<select id="bt-deck-select" aria-label="Deck to add cards to">${state.folders.filter((x) => x.id !== pendingDeckDelete?.id).map((x) => `<option value="${x.id}"${x.id === deck.id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
        ${goal}
        ${t ? `<button class="bt-back" type="button" id="bt-back">← Back to deck</button>` : ""}`;
      el.hidden = false;
      $("#bt-deck-select").addEventListener("change", (e) => { state.activeFolder = e.target.value; state.buildTarget = null; renderBuildTarget(); renderSearchView(); renderFolderRail(); });
      $("#bt-back")?.addEventListener("click", () => { state.buildTarget = null; setActiveTab("saved"); window.scrollTo(0, 0); });
    }
    // Add / un-add a search result to the deck in the "Adding to" bar.
    function toggleInActiveDeck(card) {
      const deck = activeDeck();
      if (!deck) return;
      const inDeck = cardFolders(card.id).includes(deck.id);
      setCardFolder(card, deck.id, !inDeck);
      if (!inDeck && isMaybe(deck.id, card.id)) setMaybe(deck.id, card.id, false);
      renderBuildTarget();
      renderFolderRail();
      document.querySelectorAll(`.add-to-deck[data-id="${card.id}"]`).forEach((b) => setAddBtnState(b, !inDeck));
      if (!inDeck) showToast(`Added ${card.name} to ${deck.name}`, { actionLabel: "Undo", ms: 4000, onAction: () => toggleInActiveDeck(card) });
    }
    function setAddBtnState(btn, inDeck) {
      btn.classList.toggle("in", inDeck);
      btn.innerHTML = inDeck ? `<span aria-hidden="true">✓</span><span class="atd-l">In deck</span>` : `<span aria-hidden="true">+</span><span class="atd-l">Add</span>`;
      btn.setAttribute("aria-label", inDeck ? "Remove from the deck" : "Add to the deck");
      btn.title = inDeck ? "In the deck — click to remove" : "Add to the deck";
    }
    // Shimmer placeholders while results load.
    function showSkeletons(el, n = 10) {
      el.innerHTML = Array.from({ length: n }, () => `<div class="card-skeleton" aria-hidden="true"></div>`).join("");
    }

    function renderDeckProgress({ name, colors, s, grade, path = null }) {
      const el = $("#deck-progress");
      if (!el) return;
      lastDeckPath = path;
      if (el.dataset.deck !== name) pathSel = null; // a clicked step is per deck
      const over = Math.max(0, s.total - 100);
      const within = Math.min(s.total, 100);
      const scale = Math.max(100, s.total);
      const pill = s.total > 100 ? `<span class="dp-pill cut">${over} to cut</span>`
        : s.total < 100 ? `<span class="dp-pill">${100 - s.total} to go</span>` : `<span class="dp-pill ok">100 ✓</span>`;
      el.innerHTML = `
        <div class="dp-id">${esc(name)}${colors.length ? manaPipsHtml(colors) : ""}<small>${s.total}/100 · ${s.lands} lands · avg MV ${s.avgMv.toFixed(1)} · €${s.price.toFixed(2)}</small></div>
        <div class="dp-bar" title="${s.total} of 100${over ? `, ${over} over` : ""}"><i class="in" style="width:${(within / scale) * 100}%"></i><i class="over" style="width:${(over / scale) * 100}%"></i></div>
        ${pill}
        ${grade ? `<span class="dp-grade ${gradeTone(grade)}" id="deck-progress-grade">${grade}</span>` : ""}
        <button class="dp-maybe" type="button" aria-label="Open the maybeboard">Maybe <b>${maybeCards(activeDeck()).length}</b></button>
        ${path ? deckPathHtml(path) : ""}`;
      el.querySelectorAll("[data-path-step]").forEach((b) => b.addEventListener("click", () => { pathSel = +b.dataset.pathStep; el.querySelector(".dp-path").outerHTML = deckPathHtml(lastDeckPath).replace(/^\s+/, ""); wireDeckPath(el); }));
      wireDeckPath(el);
      const switched = el.dataset.deck !== name;
      el.dataset.deck = name;
      el.hidden = false;
      if (switched) { el.classList.remove("dp-enter"); void el.offsetWidth; el.classList.add("dp-enter"); } // replay the entrance
    }
    // The bar sits below the filters and sticks under the header once you scroll past it;
    // a sentinel just above it tells us when it's stuck, so it can tighten up and lift.
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => {
        $("#deck-progress")?.classList.toggle("stuck", !entry.isIntersecting && entry.boundingClientRect.top < 80);
      }, { rootMargin: "-73px 0px 0px 0px", threshold: 0 }).observe($("#deck-progress-sentinel"));
    }
    function hideDeckProgress() { const el = $("#deck-progress"); if (el) { el.hidden = true; el.innerHTML = ""; } }

    // Small bottom toast with an optional action (e.g. Undo).
    let toastTimer = null;
    function showToast(message, { actionLabel, onAction, ms = 7000 } = {}) {
      document.querySelector(".app-toast")?.remove();
      clearTimeout(toastTimer);
      const t = document.createElement("div");
      t.className = "app-toast";
      t.setAttribute("role", "status");
      t.innerHTML = `<span>${esc(message)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ""}`;
      t.querySelector("button")?.addEventListener("click", () => { t.remove(); onAction?.(); });
      document.body.appendChild(t);
      toastTimer = setTimeout(() => t.remove(), ms);
    }

    // Scryfall land-cycle lookups per color identity, cached for the session.
    const stapleLandCache = new Map();
    async function stapleLandsFor(colors) {
      const ci = colors.join("").toLowerCase() || "c";
      if (stapleLandCache.has(ci)) return stapleLandCache.get(ci);
      const out = {};
      for (const cycle of STAPLE_LAND_CYCLES) {
        if (cycle === "tricycleland" && colors.length < 3) continue;
        try {
          const q = `is:${cycle} id<=${ci} f:commander game:paper`;
          const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=name`);
          out[cycle] = r.ok ? ((await r.json()).data || []).map((c) => c.name) : [];
        } catch { out[cycle] = []; }
        await new Promise((res) => setTimeout(res, 110)); // Scryfall asks for ≤10 requests/s
      }
      stapleLandCache.set(ci, out);
      return out;
    }

    // One click: work out the missing staples and add them straight to the main deck.
    // Bracket 1–2 decks get no Game Changers; a bracket 3 deck may fill up to 3 in total.
    async function addStaplesToDeck(deck, commander) {
      const btn = $("#da2-staples-btn");
      const folderId = deck.id;
      if (btn) { btn.disabled = true; btn.querySelector("span").textContent = "Finding staples…"; }
      try {
        const deckCards = getFolderCards(folderId);
        const main = deckCards.filter((c) => !isMaybe(folderId, c.id));
        const colors = deckColors(main, commander);
        const inDeck = new Set(deckCards.map((c) => frontFaceName(c.name).toLowerCase()));
        const [gc, landsByCycle, edhrec] = await Promise.all([
          loadGameChangers(),
          stapleLandsFor(colors),
          commander ? fetch(`/api/edhrec/commander?name=${encodeURIComponent(commander.name)}`).then((r) => (r.ok ? r.json() : { cards: [] })).catch(() => ({ cards: [] })) : { cards: [] },
        ]);
        const gcInDeck = main.filter((c) => gc.has(frontFaceName(c.name).toLowerCase())).length;
        const gcAllowance = (deckBracket[folderId] || 2) >= 3 ? Math.max(0, 3 - gcInDeck) : 0;
        const pipWeight = {};
        colorSourceStats(main, folderId, colors).forEach((src) => { pipWeight[src.c] = src.pips; });
        const names = pickStaples({ colors, inDeck, edhrec: edhrec.cards || [], landsByCycle, gameChangers: gc, gcAllowance, pipWeight });
        if (!names.length) { showToast("No staples missing — this deck already has them."); return; }
        const found = [];
        for (let i = 0; i < names.length; i += 75) {
          const res = await fetch("https://api.scryfall.com/cards/collection", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifiers: names.slice(i, i + 75).map((n) => ({ name: n })) }),
          });
          if (res.ok) found.push(...((await res.json()).data || []));
        }
        const added = found.filter((card) => !cardFolders(card.id).includes(folderId));
        added.forEach((card) => setCardFolder(card, folderId, true));
        renderFolderRail();
        renderSavedCards();
        const owned = added.filter((c) => ownedQty(collectionIndex, c) > 0).length;
        const buy = added.filter((c) => ownedQty(collectionIndex, c) === 0).reduce((sum, c) => sum + (priceNum(c) || 0), 0);
        showToast(`Added ${added.length} staples${hasCollection() ? ` (${owned} owned · €${buy.toFixed(2)} to buy)` : ""}`, {
          actionLabel: "Undo",
          onAction: () => { added.forEach((card) => setCardFolder(card, folderId, false)); renderFolderRail(); renderSavedCards(); },
        });
      } catch (err) {
        showToast(`Couldn't add staples: ${err.message || "network error"}`);
      } finally {
        const b = $("#da2-staples-btn");
        if (b) { b.disabled = false; b.querySelector("span").textContent = "Add staples"; }
      }
    }

    // Playtest tab: turns 1–5 simulator (runs in the browser, free). Lands carry their
    // colours and whether they enter tapped; cheap spells carry their colour needs.
    function renderSimSection(library, roleDetails, commander, colors) {
      const el = $("#da2-sim");
      if (!el) return;
      const rampNames = new Set((roleDetails.ramp?.cards || []).map((c) => c.name));
      const landMeta = new Map();
      const lib = library.map((c) => {
        const land = playableAsLand(c);
        if (land && !landMeta.has(c.id)) {
          const oracle = getOracleText(c);
          const fetches = /search your library for (a|an).*land|search your library for.*basic land/i.test(oracle);
          landMeta.set(c.id, { produces: fetches ? colors.slice() : [...new Set(cardProduces(c).filter((m) => WUBRG.includes(m)))], tapped: fetches ? false : landEntersTapped(oracle) });
        }
        return { land, ramp: rampNames.has(c.name), cmc: Number(c.cmc || 0), ...(land ? landMeta.get(c.id) : {}) };
      });
      const spells = [...new Map(library.filter((c) => !playableAsLand(c)).map((c) => [c.id, c])).values()]
        .filter((c) => (c.cmc || 0) >= 1 && (c.cmc || 0) <= 3)
        .map((c) => {
          const req = {};
          Object.entries(coloredPipCounts(c)).forEach(([col, n]) => { if (n > 0) req[col] = n; });
          return { cmc: Math.round(c.cmc), req };
        });
      const mv = commander ? Math.round(commander.cmc || 0) : 0;
      const r = simulateTurns({ library: lib, commanderMv: mv, trials: 4000, spells });
      const pct = (p) => `${Math.round(p * 100)}%`;
      const maxMana = Math.max(1, ...r.avgMana);
      const bars = r.avgMana.map((m, i) => `<div class="sim-col"><span class="sim-val">${m.toFixed(1)}</span><i style="height:${(m / maxMana) * 100}%"></i><span class="sim-x">T${i + 1}</span></div>`).join("");
      const stat = (label, value, tone, title) => `<div class="da2-hand-line"${title ? ` title="${escAttr(title)}"` : ""}><span>${label}</span><b class="da2-odds da2-odds-${tone}">${value}</b></div>`;
      const cmdLines = commander && r.commanderOnCurve != null
        ? stat(`${esc(frontFaceName(commander.name))} on turn ${mv}`, pct(r.commanderOnCurve), oddsTone("commanderOnCurve", r.commanderOnCurve))
          + (r.commanderByNext != null ? stat(`…or by turn ${mv + 1}`, pct(r.commanderByNext), oddsTone("commanderOnCurve", r.commanderByNext)) : "")
        : "";
      // Per colour: a source by turn 2, two sources by turn 3 (for double-pip spells).
      const doubles = new Set(spells.flatMap((s) => Object.entries(s.req).filter(([, n]) => n >= 2).map(([c]) => c)));
      const colorTone = (p, good, ok) => (p >= good ? "good" : p >= ok ? "ok" : "bad");
      const colorCells = colors.filter((c) => spells.some((s) => s.req[c]) || doubles.has(c)).map((c) => `
        <div class="sim-color">
          <span class="da2-srcpip da2-sb-${c.toLowerCase()}">${MANA_SVG[c.toLowerCase()]}</span>
          <span>by T2 <b class="da2-odds da2-odds-${colorTone(r.colorByT2[c], 0.8, 0.65)}">${pct(r.colorByT2[c])}</b></span>
          ${doubles.has(c) ? `<span>${c}${c} by T3 <b class="da2-odds da2-odds-${colorTone(r.doubleByT3[c], 0.6, 0.45)}">${pct(r.doubleByT3[c])}</b></span>` : ""}
        </div>`).join("");
      el.innerHTML = `
        <div class="da-h">Turns 1–5 · ${r.trials.toLocaleString()} simulated games on the play</div>
        <div class="sim-chart" aria-label="Average mana available per turn">${bars}</div>
        <div class="sim-cap">Average mana available each turn (lands + ramp; tapped lands count from the next turn)</div>
        <div class="da2-hand-odds">
          ${r.spellsOnCurve != null ? stat("Cheap spells castable on curve (right colours)", pct(r.spellsOnCurve), r.spellsOnCurve >= 0.7 ? "good" : r.spellsOnCurve >= 0.55 ? "ok" : "bad", "Your 1–3 mana spells: the chance you have enough mana of the right colours on the turn matching their mana value.") : ""}
          ${cmdLines}
          ${stat("Missed a land drop by turn 4", pct(r.missedDrop), r.missedDrop <= 0.47 ? "good" : r.missedDrop <= 0.6 ? "ok" : "bad", "Lower is better. A typical 37-land deck misses one in about 44% of games.")}
          ${stat("Lands in play on turn 5", r.avgLandsT5.toFixed(1), r.avgLandsT5 >= 3.8 ? "good" : r.avgLandsT5 >= 3.4 ? "ok" : "bad", "A typical 37-land deck averages about 3.9.")}
        </div>
        ${colorCells ? `<div class="da-h" style="margin-top:12px">Colours in time</div><div class="sim-colors">${colorCells}</div>` : ""}
        <div class="sim-note">Plays a land each turn when it can (untapped first) and casts ramp cheapest-first; each ramp piece adds one colourless mana from the next turn. Shocklands count as untapped. No mulligans.</div>`;
    }

    function renderDeckAnalysis(deck, cards) {
      if (!cards.length) { dA.style.display = "none"; dA.innerHTML = ""; hideDeckProgress(); return; }
      const collapsed = localStorage.getItem("deck_analysis_collapsed") === "true";
      const folderId = deck ? deck.id : state.activeFolder;
      const s = computeDeckStats(cards, folderId);
      const commander = deck && deck.commanderId ? cards.find((c) => c.id === deck.commanderId) : null;
      const colors = deckColors(cards, commander);
      const deckName = deck ? deck.name : "All saved cards";

      // Below a near-complete count, targets calibrated for a 100-card deck would flag
      // everything as "short" — noise. Show only the deck's identity + a build prompt.
      if (s.total < ANALYSIS_MIN_CARDS) {
        renderDeckProgress({ name: deckName, colors, s, grade: null, path: deck ? deckPath(deck, cards) : null });
        dA.innerHTML = `
          ${deck ? `<div class="da2-actions"><div class="da2-actions-btns"><button class="da2-autofill-btn" id="da2-autofill-btn" type="button">${ICON_WAND}<span>Autofill</span></button></div></div>` : ""}
          <div class="da2-building"><b>Deck analysis unlocks at ${ANALYSIS_MIN_CARDS} cards.</b> You have ${s.total} — keep building and the grade, role ledger, bracket and mana checks will appear here.</div>`;
        dA.style.display = "block";
        dA.classList.remove("collapsed");
        $("#da2-autofill-btn")?.addEventListener("click", () => { if (deck) openAutofill(deck, commander); });
        return;
      }
      // The AI review persists across deck edits (stale reads beat losing the analysis
      // on every add); only a Re-analyze — or a cache-version bump — replaces it.
      const sig = deckSig(cards, folderId, commander?.name);
      // The sample hand survives incidental re-renders (AI profile loads, grade recompute)
      // but resets once the deck itself changes — same signature the review cache keys on.
      if (handStateSig !== sig) { handState = null; handStateSig = sig; edhrecShowAll = false; daOpenRole = null; }
      const reviewEntry = deckReviewCache[folderId];
      const validEntry = reviewEntry && typeof reviewEntry.sig === "string" && reviewEntry.sig.startsWith(`${DECK_REVIEW_CACHE_VERSION}|`) ? reviewEntry : null;
      const cached = validEntry ? validEntry.data : null;
      const staleReview = Boolean(validEntry && validEntry.sig !== sig);
      const identityTags = Array.isArray(cached?.identityTags) ? cached.identityTags : [];
      const profile = effectiveDeckProfile(identityTags);
      const sources = colorSourceStats(cards, folderId, colors);
      // Profile-based counts are canonical whenever a card has an AI profile; a card without
      // one falls back to the rule-based classifier. Never the AI review's cached counts —
      // those stay confined to verdict/identityTags/add/trim (see renderAiExtras).
      const profiles = profilesFromCache(cards);
      const roleDetails = detectRoleDetails(cards, folderId, profiles);
      const counts = countsFromRoleDetails(roleDetails);
      const flow = cardFlowStats(roleDetails);
      const wincons = detectWinCons(cards, profiles);

      const grade = applyAiGradeContext(computeGrade(counts, sources, s, profile), cached);
      const verdict = (cached && cached.verdict) ? cached.verdict : gapSummary(grade.items, { total: s.total });
      const subnoteText = staleReview ? "Deck changed since the last analysis — showing the previous AI read. Re-analyze to refresh." : "";
      const gradeBadgeHtml = s.total >= 90
        ? `<div class="da2-badge ${gradeTone(grade.letter)}" id="da2-grade" title="${grade.score}% weighted health score · ${grade.passed}/${grade.total} checks on target"><b>${grade.letter}</b></div>`
        : `<div class="da2-badge in-progress" title="${s.total} of 100 cards · a full grade appears at 90"><b>${100 - s.total}</b><small>to go</small></div>`;

      daCtx = { folderId, sources, stats: s, profile, roleDetails, flow, counts }; // let AI review refine the grade while retaining card-level evidence
      daCurveCtx = { folderId, cards, stats: s, profile, identityTags }; // lets filter changes repaint only the mana curve
      // A review for this exact deck is still running (see reviewDeckWithAI) — the button
      // and fix-wrap must keep showing that, even though this render was triggered by
      // something else entirely (profiles/EDHREC loading), not the review itself.
      const reviewing = daReviewInFlight.has(folderId);

      const cb = colorBalanceFor(cards, folderId, colors, sources);
      const toCutKpi = s.total > 100
        ? { n: s.total - 100, label: "to cut", tone: "bad" }
        : s.total < 100 ? { n: 100 - s.total, label: "to go", tone: "" } : { n: 100, label: "cards · complete", tone: "good" };
      renderDeckProgress({ name: deckName, colors, s, grade: s.total >= 90 ? grade.letter : null, path: deck ? deckPath(deck, cards, { s, counts, sources, profile, commander }) : null });
      const tab = DA_TABS.some(([k]) => k === daTab) ? daTab : "overview";
      const tabBtn = ([k, label]) => {
        const badge = k === "build" && s.total > 100 ? ` <span class="da2-tab-badge">${s.total - 100}</span>` : "";
        return `<button type="button" class="da2-tab${k === tab ? " on" : ""}" role="tab" data-da-tab="${k}" aria-selected="${k === tab}" aria-controls="da2-pane-${k}">${label}${badge}</button>`;
      };
      const pane = (k, html) => `<div class="da2-pane" id="da2-pane-${k}" role="tabpanel" data-pane="${k}" ${k === tab ? "" : "hidden"}>${html}</div>`;

      dA.innerHTML = `
        <div class="da2-actions">
          <div class="da2-bracket" id="da2-bracket" title="Estimating bracket…">${bracketDialHtml(null)}</div>
          <div class="da2-actions-btns">
            <button class="da2-autofill-btn" id="da2-autofill-btn" type="button" title="Fill the deck to 100 from EDHREC: ramp, draw, removal, your themes and lands, within a budget">✦ Autofill</button>
            <button class="da2-staples-btn" id="da2-staples-btn" type="button" title="Adds the staples this deck is missing for its colors — rocks, dual lands, and the commander's most-played cards — straight to the main deck">${ICON_LIST_PLUS}<span>Add staples</span></button>
            <button class="da-review-btn" id="da-review-btn" ${reviewing ? "disabled" : ""}>${ICON_SPARKLE}<span class="da-review-label">${reviewing ? "Analyzing…" : (cached ? "Re-analyze" : "Analyze")}</span></button>
          </div>
          <button class="da2-collapse-btn" id="da2-collapse-btn" title="${collapsed ? "Expand deck analysis" : "Collapse deck analysis"}" aria-label="${collapsed ? "Expand deck analysis" : "Collapse deck analysis"}" aria-expanded="${collapsed ? "false" : "true"}">${collapseChevronHtml()}</button>
        </div>
        <div class="da2-body">
        <div class="da2-tabs" role="tablist" aria-label="Deck analysis">${DA_TABS.map(tabBtn).join("")}</div>
        ${pane("overview", `
          <div class="ov-hero">
            ${gradeBadgeHtml}
            <div class="ov-hero-text">
              <div class="da2-vhead" id="da2-verdict">${esc(verdict)}</div>
              <div class="ov-sub">${(() => { const n = chipGroups(grade.items).attention.length; return `${n ? `<b class="warn">${n} to fix</b>` : `<b class="good">All checks on target</b>`} · <b class="${toCutKpi.tone}">${toCutKpi.n}</b> ${toCutKpi.label} · avg MV ${s.avgMv.toFixed(1)}`; })()}</div>
            </div>
          </div>
          <div class="da2-vsub" id="da2-subnote" ${subnoteText ? "" : "hidden"}>${subnoteText}</div>
          ${daProfileLineHtml(folderId)}
          ${deckIdentityHtml(identityTags, Boolean(cached))}
          <div class="da2-card da2-overview-card">
            <div class="da2-chips-card" id="da2-chips-card">${chipsCardHtml(grade.items)}</div>
            <div class="da2-role-detail" id="da2-role-detail" hidden></div>
            <div class="da2-wc">
              <div class="da2-wc-line" id="da2-wc-line">${winConditionsLineHtml(wincons)}</div>
              <div class="da2-wc-sub" id="da2-combos" style="display:none"></div>
            </div>
          </div>`)}
        ${pane("build", `
          ${s.total > 100 ? `<section class="da2-card" id="da2-trim"></section>` : `<div class="da2-card da2-vsub">The trim planner appears when the deck is over 100 cards. It's at ${s.total} now.</div>`}
          <div class="da2-card">${typeGuideHtml(s.typeCounts, typeTargetsFor(identityLensKeys(identityTags)))}</div>`)}
        ${pane("mana", `
          <div class="mana-grid">
            <div class="mana-col">
              <div class="da2-card da2-mana-card"><div id="da2-curve-wrap">${deckCurveBlockHtml(daCurveCtx)}</div></div>
              ${(() => { const b = basicsSuggestionHtml(cards, folderId, sources, profile.landTarget[0], s.lands); return b ? `<div class="da2-card">${b}</div>` : ""; })()}
            </div>
            <div class="mana-col">
              <div class="da2-card"><div class="da-h">Colours</div>${colorsTableHtml(sources, cb.balance)}</div>
              <div class="da2-card mana-swaps"><div id="da2-land-swaps"></div></div>
            </div>
          </div>`)}
        ${pane("playtest", `
          <section class="da2-card gf-entry"><div><div class="da-h">Goldfish</div><p>Play the deck turn by turn against an empty table: mulligan, lands, spells, attacks, and the turn it would win. Or run 500 games.</p></div><button class="gf-open-btn" type="button" id="gf-open-btn">Goldfish this deck</button></section>
          <section class="da2-card" id="da2-opening-hand" hidden></section>
          <section class="da2-card" id="da2-sim"></section>`)}
        ${pane("ideas", `
          <div class="da2-card">
            <div class="da-h">AI suggestions</div>
            <div class="da2-fix-wrap" id="da2-fix-wrap">${reviewing ? `<div class="da2-fix"><span class="da2-chip muted">Analyzing ${cards.length} cards…</span></div>` : (cached ? fixRowsHtml(cached) : `<div class="da2-vsub">Click Analyze for swaps with reasons and a full read of the deck.</div>`)}</div>
          </div>
          <section class="da2-card" id="da2-edhrec" hidden></section>`)}
        </div>`;
      dA.style.display = "block";
      dA.classList.toggle("collapsed", collapsed);
      wireDeckTabs();
      $("#da2-staples-btn")?.addEventListener("click", () => { if (deck) addStaplesToDeck(deck, commander); });
      $("#da2-autofill-btn")?.addEventListener("click", () => { if (deck) openAutofill(deck, commander); });
      $("#gf-open-btn")?.addEventListener("click", () => { if (deck) openGoldfish(deck); });
      const fixWrapEl = $("#da2-fix-wrap");
      fixWrapEl?.addEventListener("click", (e) => {
        const chip = e.target.closest(".da2-card-chip");
        if (chip) { e.stopPropagation(); openCardByName(chip.dataset.card); }
      });
      // "toggle" doesn't bubble — listen in the capture phase to remember the open state.
      fixWrapEl?.addEventListener("toggle", (e) => { if (e.target.id === "da2-full") daFullOpen = e.target.open; }, true);
      fixWrapEl?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const chip = e.target.closest(".da2-card-chip");
        if (chip) { e.preventDefault(); openCardByName(chip.dataset.card); }
      });
      $("#da-review-btn").addEventListener("click", () => reviewDeckWithAI(cards, folderId, commander, wincons));
      $("#da2-collapse-btn")?.addEventListener("click", () => {
        const next = !dA.classList.contains("collapsed");
        dA.classList.toggle("collapsed", next);
        lsSet("deck_analysis_collapsed", String(next));
        const btn = $("#da2-collapse-btn");
        if (btn) {
          btn.setAttribute("aria-expanded", String(!next));
          btn.title = next ? "Expand deck analysis" : "Collapse deck analysis";
          btn.setAttribute("aria-label", btn.title);
        }
      });
      if (cached && !reviewing) renderAiExtras(cached); // reviewing already painted its own pending fix-wrap above
      wireDeckAnalysisChips();
      wireDeckProfileLine(deck, cards, folderId);
      enhanceBracket(cards, folderId);
      if (commander) enhanceCombos(commander.name, folderId);
      ensureDeckProfiles(deck, cards, folderId);
      // Free, no network — real decks only (this branch never runs otherwise).
      if (deck) {
        const library = openingHandLibrary(cards, folderId, deck.commanderId || null);
        const ramp = rampCountForLibrary(roleDetails, cards, commander);
        // A >100-card pool is judged as if already trimmed: same ratios, 99-card library.
        const N = library.length;
        const odds = openingHandOdds({ N: Math.min(N, 99), lands: projectTo99(s.lands, N), ramp: projectTo99(ramp, N), commanderMv: commander ? (commander.cmc || 0) : undefined });
        renderOpeningHandSection(library, odds, commander, { projected: N > 99 });
        renderSimSection(library, roleDetails, commander, colors);
        renderLandSwaps(folderId, cards, colors, cb.lands, cb.balance);
        if (s.total > 100) {
          const ed = commander ? edhrecCache.get(commanderSlug(commander.name)) : null;
          const edhrecByName = ed && ed.status === "ready" ? new Map((ed.data.cards || []).map((c) => [edhrecNameKey(c.name), c])) : null;
          const typeTargets = typeTargetsFor(identityLensKeys(identityTags));
          const spellsHave = (s.typeCounts.instant || 0) + (s.typeCounts.sorcery || 0);
          const rows = [
            { key: "lands", label: "Lands", have: s.lands, lo: profile.landTarget[0], hi: profile.landTarget[1] },
            ...ROLE_KEYS.map((k) => ({ key: k, label: AI_LABEL[k] || k, have: counts[k] || 0, lo: profile.roleTargets[k][0], hi: profile.roleTargets[k][1] })),
            ...TYPE_GUIDE_ROWS.map(([k, label]) => ({ key: k, label, have: k === "spells" ? spellsHave : (s.typeCounts[k] || 0), lo: typeTargets[k][0], hi: typeTargets[k][1] })),
          ];
          trimCtx = { budget: trimBudget(rows, s.total), cards, folderId, commander, roleDetails, edhrecByName };
          renderTrimPanel();
        }
        renderEdhrecSection(deck, commander, folderId);
      }
    }

    // `daReviewInFlight` guards this against a second paid request while one is already
    // running for THIS deck: a click is ignored (the button is also rendered disabled —
    // see renderDeckAnalysis — but this is the authoritative guard, since that render may
    // be stale). It's per-deck (a Set of folderIds) — a different deck's review may run
    // concurrently; only a second click for the same deck is a no-op. Elements are
    // re-queried once the request settles rather than using `btn`/`fixWrap` captured
    // before the await, since an async re-render triggered by something else (profiles/
    // EDHREC loading) may have replaced the panel — and with it those elements — while
    // this was in flight.
    async function reviewDeckWithAI(cards, folderId, commander, winConditions) {
      if (!state.hasApiKey) return showSettings();
      if (daReviewInFlight.has(folderId)) return; // this deck's review is already running — ignore the click
      daReviewInFlight.add(folderId);
      rerenderDeckAnalysisIfActive(folderId); // paint the disabled "Analyzing…" button + pending note now
      let err = null;
      try {
        // A card with an AI profile sends its short summary instead of the full rules text
        // (about half the tokens); unprofiled cards fall back to the rules text.
        const payload = cards.slice(0, 250).map((c) => {
          const summary = profileCache.get(cardOracleId(c))?.summary || "";
          return { name: c.name, type_line: c.type_line || "", cmc: c.cmc || 0, ...(summary ? { summary } : { oracle_text: getOracleText(c) }) };
        });
        const res = await fetch("/api/deck-review", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cards: payload,
            commander: commander?.name || "",
            commanderText: commander ? `${commander.type_line || ""} :: ${getOracleText(commander)}` : "",
            colorIdentity: deckColors(cards, commander),
            bracket: deckBracket[folderId] ?? null,
            gamePlan: state.deckNotes[folderId] || "",
            winConditions: winConditions || [],
          }),
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || "Review failed"); }
        const data = await res.json();
        deckReviewCache[folderId] = { sig: deckSig(cards, folderId, commander?.name), data }; // cache per deck version — no re-spend on re-open
        persistDeckReviews();
      } catch (e) {
        err = e;
      } finally {
        daReviewInFlight.delete(folderId);
      }
      if (state.activeFolder !== folderId) return; // deck switched while this was in flight
      if (err) {
        // No cached data to build a full re-render from — patch the current DOM directly,
        // re-queried now so this never lands in an element replaced while awaiting above.
        const btn = $("#da-review-btn");
        const fixWrap = $("#da2-fix-wrap");
        if (btn) {
          btn.disabled = false;
          const l = btn.querySelector(".da-review-label");
          if (l) l.textContent = deckReviewCache[folderId] ? "Re-analyze" : "Analyze";
        }
        if (fixWrap) fixWrap.innerHTML = `<div class="da2-fix"><span class="da2-chip trim">${esc(err.message || "Analysis failed")}</span></div>`;
      } else {
        rerenderDeckAnalysisIfActive(folderId); // full repaint: new grade/chips/verdict/fix rows/identity tags
      }
    }

    // Detail modal
    function showDetail(card) {
      state.detailCard = card;
      const imgUrl = getCardImage(card);
      const price = getPrice(card);
      const foilPrice = card.prices?.eur_foil ? `€${card.prices.eur_foil}` : "N/A";
      const isSaved = state.savedCards.some((s) => s.id === card.id);
      $("#detail-img").src = imgUrl;
      $("#detail-name").textContent = card.name;
      const reasonEl = $("#detail-reason");
      if (card._reason) {
        reasonEl.innerHTML = `<div class="reason-label">${ICON_SPARKLE}Why this card</div><div class="reason-text"></div>`;
        reasonEl.querySelector(".reason-text").textContent = card._reason;
        reasonEl.style.display = "block";
      } else { reasonEl.style.display = "none"; }
      $("#detail-type").textContent = card.type_line || "Unknown";
      $("#detail-mana").textContent = card.mana_cost || "None";
      $("#detail-set").textContent = `${card.set_name || "Unknown"} (${(card.set || "").toUpperCase()})`;
      $("#detail-rarity").textContent = capitalize(card.rarity || "unknown");
      $("#detail-price").textContent = price || "N/A";
      $("#detail-foil-price").textContent = foilPrice;
      $("#detail-oracle").textContent = getOracleText(card);
      if (card.power !== undefined && card.toughness !== undefined) {
        $("#detail-pt").textContent = `${card.power}/${card.toughness}`;
        $("#detail-pt-row").style.display = ""; // fall back to .detail-row's grid so P/T aligns with the other rows
      } else { $("#detail-pt-row").style.display = "none"; }
      const owned = ownedQty(collectionIndex, card);
      $("#detail-owned").textContent = owned ? `×${owned}` : "Not owned";
      $("#detail-owned-row").style.display = hasCollection() ? "" : "none";
      const ownedInfoDetail = ownedInfo(card);
      const ownedToggle = $("#detail-owned-toggle");
      if (ownedInfoDetail.state === "manabox") {
        ownedToggle.style.display = "none";
      } else {
        ownedToggle.style.display = hasCollection() ? "" : "none";
        ownedToggle.textContent = ownedInfoDetail.state === "manual" ? "Unmark owned" : "Mark as owned";
      }
      $("#detail-swaps-btn").style.display = hasCollection() && !isBasicLand(card) ? "" : "none";
      const saveBtn = $("#detail-save-btn");
      saveBtn.textContent = isSaved ? "Saved" : "Save";
      saveBtn.className = isSaved ? "saved" : "";
      detailFace = 0;
      $("#detail-flip-btn").style.display = isDoubleFaced(card) ? "" : "none";
      const maybeBtn = $("#detail-maybe-btn");
      const detailDeck = activeDeck();
      if (detailDeck && cardFolders(card.id).includes(detailDeck.id) && detailDeck.commanderId !== card.id) {
        maybeBtn.textContent = isMaybe(detailDeck.id, card.id) ? "Move to main deck" : "Mark as Maybe";
        maybeBtn.style.display = "";
      } else {
        maybeBtn.style.display = "none";
      }
      detailCombosBtn.style.display = cardShowsCombos(card) ? "" : "none";
      detailEdhrecBtn.style.display = cardShowsCombos(card) ? "" : "none";
      $("#detail-panel").classList.remove("empty");
    }

    // Only legendary creatures can be a deck's commander.
    function isLegendaryCreature(card) {
      const t = (card.type_line || "").toLowerCase();
      return t.includes("legendary") && t.includes("creature");
    }

    // Show the Combos button for any card that could take part in a combo — i.e.
    // every card except basic lands and tokens, which never do.
    function cardShowsCombos(card) {
      const t = (card.type_line || "").toLowerCase();
      if (t.includes("basic") && t.includes("land")) return false;
      if (card.layout === "token" || t.includes("token")) return false;
      return true;
    }
    // Commander Spellbook / Cardmarket list DFCs under the front-face name.
    function frontFaceName(name) {
      return String(name || "").split(" // ")[0].trim();
    }
    // EDHREC card pages are name-slugged, e.g. "Krenko, Mob Boss" -> krenko-mob-boss.
    function edhrecSlug(name) {
      return frontFaceName(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    }

    detailCombosBtn.addEventListener("click", () => {
      if (state.detailCard) loadCombos(frontFaceName(state.detailCard.name));
    });
    detailEdhrecBtn.addEventListener("click", () => {
      if (state.detailCard) window.open(`https://edhrec.com/cards/${edhrecSlug(state.detailCard.name)}`, "_blank");
    });
    $("#detail-swaps-btn").addEventListener("click", () => {
      if (state.detailCard) openSwaps(state.detailCard);
    });
    comboBackBtn.addEventListener("click", exitCombos);

    $("#detail-save-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!state.detailCard) return;
      openSavePopover(state.detailCard, e.currentTarget);
    });

    let detailFace = 0; // which face of a double-faced card the focus panel is showing
    // Largest JPEG Scryfall serves for a face (672×936), via the server image cache.
    function largeImage(card, face = 0) {
      const uris = card.card_faces?.[face]?.image_uris || card.image_uris || card.card_faces?.[0]?.image_uris;
      return cachedImg(uris?.large || uris?.normal || "");
    }
    const lightbox = $("#card-lightbox");
    let lightboxReturnFocus = null;
    function openLightbox() {
      const card = state.detailCard;
      if (!card) return;
      const img = $("#card-lightbox-img");
      img.src = largeImage(card, isDoubleFaced(card) ? detailFace : 0);
      img.alt = card.name;
      lightboxReturnFocus = document.activeElement;
      lightbox.hidden = false;
      $("#card-lightbox-close").focus();
    }
    function closeLightbox() {
      if (lightbox.hidden) return;
      lightbox.hidden = true;
      lightboxReturnFocus?.focus?.();
    }
    $("#detail-zoom").addEventListener("click", (e) => { e.stopPropagation(); openLightbox(); });
    lightbox.addEventListener("click", closeLightbox); // anywhere, including the image, closes it
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });
    $("#detail-flip-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!state.detailCard) return;
      detailFace = detailFace === 1 ? 0 : 1;
      $("#detail-img").src = faceImage(state.detailCard, detailFace);
    });

    $("#detail-maybe-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const card = state.detailCard;
      const deck = activeDeck();
      if (!card || !deck) return;
      setMaybe(deck.id, card.id, !isMaybe(deck.id, card.id));
      renderSavedCards();
      showDetail(card);
    });

    $("#detail-owned-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.detailCard) toggleOwned(state.detailCard);
    });

    // ── Download the print-resolution image (proxies) ─────────────────
    // Scryfall's image CDN sends Access-Control-Allow-Origin:*, so we can pull the
    // png as a blob and hand it to a synthetic <a download>. A cross-origin href
    // would ignore the download attribute and navigate instead, hence the blob.
    function printImageFilename(card, face) {
      // Only transform/MDFC cards have a per-face image worth naming by its face;
      // split/adventure cards share one image showing the whole card.
      const name = (isDoubleFaced(card) && card.card_faces?.[face]?.name) || card.name || "card";
      const set = (card.set || "").toUpperCase();
      const parts = [name, set && `(${set})`, card.collector_number].filter(Boolean);
      // Split cards are named "Fire // Ice"; keep the halves readable before the
      // slash strip below turns them into one run-on word.
      const safe = parts.join(" ")
        .replace(/\s*\/\/\s*/g, " - ")
        // Strip characters Windows/macOS reject in filenames, plus trailing dots.
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ").trim().replace(/\.+$/, "");
      return `${safe || "card"}.png`;
    }

    $("#detail-download-btn").addEventListener("click", async (e) => {
      const card = state.detailCard;
      if (!card) return;
      const url = facePrintImage(card, detailFace);
      if (!url) { showStatus("No printable image for this card.", true); return; }
      const btn = e.currentTarget;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Downloading…";
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Scryfall returned ${res.status}`);
        const blob = await res.blob();
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = printImageFilename(card, detailFace);
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoking synchronously after click() cancels the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(href), 10000);
        btn.textContent = "Saved ✓";
      } catch (err) {
        // Blob path failed (offline, CORS change, blocked fetch) — leave the user
        // with the image open so they can still save it by hand.
        console.error("Card image download failed:", err);
        btn.textContent = "Opened ↗";
        window.open(url, "_blank");
      } finally {
        setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 1500);
      }
    });

    $("#detail-scryfall-btn").addEventListener("click", () => {
      if (state.detailCard?.scryfall_uri) window.open(state.detailCard.scryfall_uri, "_blank");
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (cardContextMenu.classList.contains("visible")) { closeCardContextMenu(); return; }
        if (savePopover.classList.contains("visible")) { closeSavePopover(); return; }
        if (importModal.classList.contains("visible")) { hideImport(); return; }
        hideSettings();
      }
    });

