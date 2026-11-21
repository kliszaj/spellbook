    function startSearchRun() {
      activeSearchRun += 1;
      if (activeSearchController) activeSearchController.abort();
      activeSearchController = new AbortController();
      return { run: activeSearchRun, signal: activeSearchController.signal };
    }

    function isActiveSearch(run) {
      return run === activeSearchRun;
    }

    // Guarantee the mandatory Commander filters are present even if the AI — or a
    // stale, persisted translateCache entry — left them out. Existing commander
    // filters are stripped and re-appended after the grouped core query so an
    // ungrouped "A or B" cannot leak off-identity cards from the left side.
    // A query with no Scryfall operator characters is treated as a plain card name.
    function isBareNameQuery(q) {
      return !/[:<>=]/.test(q || "");
    }

    // @testable query-chips begin
    function hasTopLevelOr(query) {
      let inQuote = false;
      let depth = 0;
      for (let i = 0; i < query.length; i++) {
        const ch = query[i];
        if (ch === '"' && query[i - 1] !== "\\") inQuote = !inQuote;
        if (inQuote) continue;
        if (ch === "(") depth++;
        else if (ch === ")" && depth > 0) depth--;
        else if (depth === 0 && /\bor\b/i.test(query.slice(i, i + 2))) {
          const before = query[i - 1];
          const after = query[i + 2];
          if ((!before || /\s|\(/.test(before)) && (!after || /\s|\)/.test(after))) return true;
        }
      }
      return false;
    }

    function stripCommanderFilters(query) {
      return (query || "")
        .replace(/\bf(?:ormat)?:commander\b/gi, "")
        .replace(/\bgame:paper\b/gi, "")
        .replace(/\b(?:id|identity)\s*(?:<=|>=|!=|=|<|>|:)\s*[a-z]+\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    function tokenizeScryfallQuery(query) {
      const tokens = [];
      let buf = "";
      let inQuote = false;
      let depth = 0;
      for (let i = 0; i < query.length; i++) {
        const ch = query[i];
        if (ch === '"' && query[i - 1] !== "\\") inQuote = !inQuote;
        if (!inQuote) {
          if (ch === "(") depth++;
          if (ch === ")" && depth > 0) depth--;
          if (/\s/.test(ch) && depth === 0) {
            if (buf) tokens.push(buf);
            buf = "";
            continue;
          }
        }
        buf += ch;
      }
      if (buf) tokens.push(buf);
      return tokens;
    }

    // ── Query chips: the AI's Scryfall query as plain-English conditions you can switch off or add to ──
    const CHIP_OPS = { "<=": "≤ ", ">=": "≥ ", "<": "< ", ">": "> ", "!=": "≠ ", "=": "", ":": "" };
    const CHIP_COLOURS = { w: "White", u: "Blue", b: "Black", r: "Red", g: "Green", c: "Colourless", m: "Multicolour" };
    const CHIP_KEYS = {
      t: "Type", type: "Type", o: "Text", oracle: "Text", fo: "Text", fulloracle: "Text", kw: "Keyword", keyword: "Keyword",
      c: "Colour", color: "Colour", colour: "Colour", mv: "Mana value", cmc: "Mana value", manavalue: "Mana value",
      pow: "Power", power: "Power", tou: "Toughness", toughness: "Toughness", loy: "Loyalty", loyalty: "Loyalty",
      eur: "Price", usd: "Price", r: "Rarity", rarity: "Rarity", is: "Is", has: "Has", not: "Is not",
      s: "Set", e: "Set", set: "Set", edition: "Set", f: "Legal in", format: "Legal in", legal: "Legal in",
      function: "Role", otag: "Role", oracletag: "Role", art: "Art", atag: "Art", a: "Artist", artist: "Artist",
      year: "Year", date: "Date", m: "Mana cost", mana: "Mana cost", produces: "Makes mana", id: "Identity", identity: "Identity",
    };
    const chipUnquote = (v) => String(v).replace(/^"(.*)"$/, "$1");
    const chipTitleCase = (v) => v.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());

    // One query term → { key, label } for its chip; null for terms that aren't conditions (sort order).
    function describeQueryTerm(term) {
      const neg = term.startsWith("-");
      const t = neg ? term.slice(1) : term;
      const not = (key) => (neg ? `Not ${key.toLowerCase()}` : key);
      if (t.startsWith("(")) return { key: neg ? "None of" : "Any of", label: t.slice(1, -1).replace(/\s+or\s+/gi, " / ") };
      const m = /^([a-z]+)(<=|>=|!=|:|=|<|>)(.+)$/i.exec(t);
      if (!m) return { key: not("Name"), label: chipUnquote(t) };
      const [, rawKey, op, rawVal] = m;
      const key = rawKey.toLowerCase();
      if (["order", "direction", "dir", "unique", "prefer", "include", "lang", "game"].includes(key)) return null;
      const val = chipUnquote(rawVal);
      const opText = CHIP_OPS[op] ?? `${op} `;
      const label = (() => {
        if (key === "eur") return `${opText}€${val}`;
        if (key === "usd") return `${opText}$${val}`;
        if (["o", "oracle", "fo", "fulloracle"].includes(key)) return `“${val}”`;
        if (["c", "color", "colour", "id", "identity"].includes(key) && /^[wubrgcm]+$/i.test(val)) {
          const names = [...val.toLowerCase()].map((ch) => CHIP_COLOURS[ch]).join(" + ");
          return (key === "id" || key === "identity") && op === "<=" ? `within ${names}` : `${opText}${names}`;
        }
        if (["s", "e", "set", "edition"].includes(key)) return val.toUpperCase();
        if (["t", "type", "kw", "keyword", "is", "has", "not", "f", "format", "legal", "function", "otag", "oracletag", "r", "rarity"].includes(key)) {
          return chipTitleCase(val);
        }
        return `${opText}${val}`;
      })();
      return { key: not(CHIP_KEYS[key] || rawKey), label };
    }

    // The core query (without the Commander filters) as chips. A top-level "or" can't be split into ANDed
    // conditions without changing its meaning, so such a query stays one chip.
    function queryChips(core) {
      const text = String(core || "").trim();
      if (!text) return [];
      if (hasTopLevelOr(text)) return [{ term: text, key: "Any of", label: text.replace(/\s+or\s+/gi, " / ") }];
      return tokenizeScryfallQuery(text)
        .map((term) => ({ term, ...(describeQueryTerm(term) || {}) }))
        .filter((chip) => chip.key);
    }

    // The core query from the chips still switched on, plus any added terms.
    function rebuildQuery(chips, off = new Set(), added = []) {
      return [...chips.filter((chip) => !off.has(chip.term)).map((chip) => chip.term), ...added].join(" ").trim();
    }
    // @testable query-chips end

    function repairLeadingOrGroup(query) {
      if (!query || query.trim().startsWith("(")) return query;
      const tokens = tokenizeScryfallQuery(query);
      if (tokens.length < 4 || tokens[1]?.toLowerCase() !== "or") return query;
      let end = 0;
      while (tokens[end + 1]?.toLowerCase() === "or" && tokens[end + 2]) end += 2;
      if (end < 2 || end >= tokens.length - 1) return query;
      return `(${tokens.slice(0, end + 1).join(" ")}) ${tokens.slice(end + 1).join(" ")}`;
    }

    function withCommanderFilters(query) {
      const core = repairLeadingOrGroup(stripCommanderFilters(query));
      const terms = [];
      if (core) terms.push(hasTopLevelOr(core) ? `(${core})` : core);
      terms.push("f:commander");
      const id = state.colorIdentity.join("").toLowerCase();
      if (id) terms.push(`id<=${id}`);
      terms.push("game:paper");
      return terms.join(" ").replace(/\s{2,}/g, " ").trim();
    }

    function matchesSelectedIdentity(card) {
      if (!state.colorIdentity.length) return true;
      const allowed = new Set(state.colorIdentity.map((c) => c.toUpperCase()));
      return (card.color_identity || []).every((c) => allowed.has(c));
    }

    function filterSelectedIdentity(cards) {
      return state.colorIdentity.length ? (cards || []).filter(matchesSelectedIdentity) : (cards || []);
    }

    async function doSearch() {
      const query = searchInput.value.trim();
      if (!query) return;
      if (!state.hasApiKey) return showSettings();

      // The button stays enabled while searching — clicking (or Enter) mid-search
      // starts a new run that supersedes this one: startSearchRun() aborts the old
      // controller and every await below re-checks isActiveSearch before touching UI.
      const searchRun = startSearchRun();
      state.buildTarget = null;
      state.cutView = null;
      searchBtn.textContent = "Searching...";
      startLoadingAnimation();
      queryDisplay.classList.remove("visible");
      showQueryRepair(null);
      aiSummary.style.display = "none";
      comboHeader.style.display = "none";
      comboRun++; // supersede any in-flight combo load
      resultsEl.innerHTML = "";
      paginationEl.style.display = "none";
      sortBar.style.display = "none";
      searchTypeFilter.types.clear();
      searchTypeFilter.subtypes.clear();
      searchTypeFilter.excludeMode = false;
      searchTypeFilter.expanded = false;
      typeFilterEl.style.display = "none";
      typeFilterEl.replaceChildren();
      state.results = [];
      state.nextPage = null;

      const ci = state.colorIdentity.join("") || null;
      const forceAiSearch = state.forceAiSearch;
      try {
        // Fast path: a plain card name (no Scryfall syntax) → look it up directly,
        // no AI and no commander filters. Tries an exact name match first (so
        // "Sol Ring" shows Sol Ring, not every card containing those words), then a
        // looser contains-search, and only falls back to AI if nothing matches.
        if (!forceAiSearch && isBareNameQuery(query)) {
          state.mode = "search";
          setSortMode("search");
          const exactQuery = `!"${query.replace(/"/g, "")}"`;
          let usedQuery = exactQuery;
          let found = await searchScryfall(exactQuery, null, searchRun.run, searchRun.signal, { silent: true });
          if (!isActiveSearch(searchRun.run)) return;
          if (!found) {
            usedQuery = query;
            found = await searchScryfall(query, null, searchRun.run, searchRun.signal, { silent: true });
            if (!isActiveSearch(searchRun.run)) return;
          }
          if (found > 0) {
            state.currentQuery = usedQuery; // lets sort/pagination re-run the same lookup
            queryDisplay.classList.remove("visible"); // identical to what you typed — nothing to show
            rememberSearch(query, ci, forceAiSearch, { type: "query" });
            return;
          }
          state.results = []; // no name match — reset and let the AI take a crack
          state.nextPage = null;
          resultsEl.innerHTML = "";
        }

        let data = getCachedTranslate(query, ci, forceAiSearch);
        if (!data) {
          const res = await fetch("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, colorIdentity: ci, forceAiSearch }),
            signal: searchRun.signal,
          });
          if (!isActiveSearch(searchRun.run)) return;
          if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Translation failed"); }
          data = await res.json();
          if (!isActiveSearch(searchRun.run)) return;
          putCachedTranslate(query, ci, forceAiSearch, data);
        }
        rememberSearch(query, ci, forceAiSearch, data);
        if (!isActiveSearch(searchRun.run)) return;

        if (data.type === "cards") {
          // Recommendation path — AI returned a curated list of card names.
          state.mode = "recommend";
          state.currentQuery = "";
          await resolveRecommendations(data.cards || [], data.summary || "", searchRun.run, searchRun.signal);
        } else {
          // Search path — AI returned a Scryfall query string.
          state.mode = "search";
          setSortMode("search");
          const scryfallQuery = withCommanderFilters(data.query || data.scryfallQuery || "");
          state.currentQuery = scryfallQuery;
          const core = stripCommanderFilters(scryfallQuery).trim();
          showQueryChips(scryfallQuery);
          queryDisplay.classList.toggle("visible", Boolean(core) && core.toLowerCase() !== query.trim().toLowerCase());
          // The server ran the AI's query and had it repaired (syntax error or nothing found): say what changed.
          showQueryRepair(data.repaired);
          await searchScryfall(scryfallQuery, null, searchRun.run, searchRun.signal);
        }
      } catch (err) {
        if (err.name === "AbortError" || !isActiveSearch(searchRun.run)) return;
        showStatus(err.message, true);
      } finally {
        // Only the latest run resets the label; superseded runs leave "Searching...".
        if (isActiveSearch(searchRun.run)) {
          searchBtn.textContent = "Search";
        }
      }
    }

    // Resolve AI-recommended card names to full Scryfall cards (batch), preserving AI ranking.
    async function resolveRecommendations(entries, summary, run = activeSearchRun, signal = activeSearchController?.signal) {
      const list = (entries || []).filter((e) => e && e.name).slice(0, 75);
      if (!list.length) { showStatus("No recommendations came back — try rephrasing.", true); return; }
      try {
        const res = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifiers: list.map((e) => ({ name: e.name })) }),
          signal,
        });
        if (!isActiveSearch(run)) return;
        if (!res.ok) { const err = await res.json(); throw new Error(err.details || "Couldn't look up the recommended cards"); }
        const data = await res.json();
        if (!isActiveSearch(run)) return;

        // Reorder Scryfall results to match the AI's ranking, and attach each reason.
        const norm = (s) => (s || "").toLowerCase().split("//")[0].trim();
        const found = data.data || [];
        const used = new Set();
        const ordered = [];
        list.forEach((entry) => {
          const want = norm(entry.name);
          const idx = found.findIndex((c, i) => !used.has(i) && (norm(c.name) === want || norm(c.name).startsWith(want)));
          if (idx >= 0) {
            used.add(idx);
            const card = found[idx];
            card._reason = entry.reason || "";
            ordered.push(card);
          }
        });
        found.forEach((c, i) => { if (!used.has(i)) ordered.push(c); }); // any unmatched extras

        const legalOrdered = filterSelectedIdentity(ordered);
        state.recommendOrder = legalOrdered.slice(); // preserve AI ranking for "Recommended" sort
        state.results = legalOrdered;
        hideStatus();
        renderSearchView();
        paginationEl.style.display = "none";
        setSortMode("recommend"); // client-side sorting; defaults to the AI's order
        sortBar.style.display = legalOrdered.length ? "flex" : "none";

        const notFound = (data.not_found || []).length;
        aiSummaryText.innerHTML = esc(summary) + (notFound ? ` <span class="ai-not-found">(${notFound} suggestion${notFound === 1 ? "" : "s"} couldn't be matched on Scryfall)</span>` : "");
        aiSummary.style.display = legalOrdered.length || summary ? "flex" : "none";
        if (!legalOrdered.length) showStatus("None of the recommended cards matched the selected color identity.", true);
      } catch (err) {
        if (err.name === "AbortError" || !isActiveSearch(run)) return;
        showStatus(err.message, true);
      }
    }

    // The dropdown is the single source of truth for ordering. Strip any inline
    // order:/direction:/dir: tokens the AI baked into the query — Scryfall lets an
    // inline order: keyword override the URL `order=` param, which silently
    // ignored the user's sort choice and made results look randomly ordered.
    function stripInlineOrder(query) {
      return query
        .replace(/\b(?:order|direction|dir)\s*:\s*[^\s)]+/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    // Returns the number of cards added. With opts.silent, an error/empty result
    // stays quiet and returns 0 so the caller can fall back (e.g. to AI search).
    async function searchScryfall(query, pageUrl, run = activeSearchRun, signal = activeSearchController?.signal, opts = {}) {
      try {
        const url = pageUrl || `https://api.scryfall.com/cards/search?q=${encodeURIComponent(stripInlineOrder(query))}&unique=cards&order=${state.sortField}&dir=${state.sortDir}`;
        const res = await fetch(url, { signal });
        if (!isActiveSearch(run)) return 0;
        if (!res.ok) {
          if (opts.silent) return 0;
          const err = await res.json(); throw new Error(err.details || "No cards found — try rephrasing");
        }
        const data = await res.json();
        if (!isActiveSearch(run)) return 0;
        const legalCards = filterSelectedIdentity(data.data);
        state.results.push(...legalCards);
        state.nextPage = data.has_more ? data.next_page : null;
        hideStatus();
        if (pageUrl && state.mode !== "cuts") {
          // Load more: add only the new page's tiles instead of rebuilding every card already shown
          renderTypeFilterChips(typeFilterEl, state.results, searchTypeFilter, renderSearchView);
          renderResults(legalCards.filter((c) => matchesTypeFilter(c, searchTypeFilter)), true);
        } else {
          renderSearchView();
        }
        paginationEl.style.display = state.nextPage ? "flex" : "none";
        sortBar.style.display = state.results.length ? "flex" : "none";
        return legalCards.length;
      } catch (err) {
        if (err.name === "AbortError" || !isActiveSearch(run)) return 0;
        if (opts.silent) return 0;
        showStatus(err.message, true);
        return 0;
      }
    }

    // Re-run the current (already-translated) query with the chosen Scryfall ordering
    function applySort() {
      if (!state.currentQuery) return;
      resultsEl.innerHTML = "";
      state.results = [];
      state.nextPage = null;
      paginationEl.style.display = "none";
      showStatus("Sorting...");
      // a new run: an older sort or Load more still in flight can't add its cards to these results
      const { run, signal } = startSearchRun();
      searchScryfall(state.currentQuery, null, run, signal);
    }

    // ── Query chips (UI) ──
    // The query under the search bar as chips: switching one off (or adding a preset) re-runs Scryfall only,
    // with no AI call. The Commander filters are shown as locked chips; the code view is one click away.
    const queryChipsEl = $("#query-chips");
    const queryCodeBtn = $("#query-code-btn");
    const queryRepairEl = $("#query-repair");
    const CHIP_PRESETS = [
      { term: "eur<=2", label: "Under €2" },
      { term: "mv<=3", label: "Mana value ≤ 3" },
      { term: "t:creature", label: "Creatures only" },
    ];
    let queryChipState = { chips: [], off: new Set(), added: [], adding: false, idTerm: "" };
    const ID_TERM = /\b(?:id|identity)\s*(?:<=|>=|!=|=|<|>|:)\s*[a-z]+\b/i;

    // Keeps the colour identity the query came with (the AI's, or a deck's for guided build), so switching a
    // chip off never widens the colours.
    function showQueryChips(fullQuery) {
      const idTerm = (ID_TERM.exec(fullQuery || "") || [""])[0];
      queryChipState = { chips: queryChips(stripCommanderFilters(fullQuery)), off: new Set(), added: [], adding: false, idTerm };
      renderQueryChips();
    }
    function chipQuery() {
      const { chips, off, added, idTerm } = queryChipState;
      const core = repairLeadingOrGroup(rebuildQuery(chips, off, added));
      return [core ? (hasTopLevelOr(core) ? `(${core})` : core) : "", "f:commander", idTerm, "game:paper"].filter(Boolean).join(" ");
    }

    function renderQueryChips() {
      const { chips, off, added, adding } = queryChipState;
      const core = rebuildQuery(chips, off, added);
      queryText.textContent = core || state.currentQuery;
      queryText.title = state.currentQuery; // full query (with f:commander / identity) on hover
      const chipHtml = (chip, i, kind) => {
        const isOff = off.has(chip.term);
        const action = kind === "added" ? "Remove" : isOff ? "Put back" : "Switch off";
        return `<span class="qchip${isOff ? " off" : ""}"><span class="qchip-k">${esc(chip.key)}</span> ${esc(chip.label)}`
          + `<button type="button" class="qchip-x" data-chip="${kind}:${i}" aria-label="${esc(`${action} ${chip.key} ${chip.label}`)}" title="${action}">${isOff ? "↺" : "×"}</button></span>`;
      };
      const addedChips = added.map((term) => ({ term, ...(describeQueryTerm(term) || { key: "Added", label: term }) }));
      const idChip = queryChipState.idTerm ? describeQueryTerm(queryChipState.idTerm.replace(/^identity/i, "id")) : null;
      const ident = idChip
        ? `<span class="qchip lock" title="Always on: your commander's colours"><span class="qchip-k">Colours</span> ${esc(idChip.label)}</span>`
        : "";
      const presets = CHIP_PRESETS.filter((p) => !added.includes(p.term) && !chips.some((c) => c.term === p.term));
      queryChipsEl.innerHTML = chips.map((c, i) => chipHtml(c, i, "chip")).join("")
        + addedChips.map((c, i) => chipHtml(c, i, "added")).join("")
        + ident
        + `<span class="qchip lock" title="Always on: Commander-legal paper cards"><span class="qchip-k">Legal</span> Commander</span>`
        + (adding
          ? presets.map((p) => `<button type="button" class="qchip add" data-preset="${esc(p.term)}">+ ${esc(p.label)}</button>`).join("")
          : presets.length ? `<button type="button" class="qchip add" data-chip-add aria-expanded="false">+ Add</button>` : "");
    }

    function rerunFromChips() {
      state.currentQuery = chipQuery();
      renderQueryChips();
      resultsEl.innerHTML = "";
      state.results = [];
      state.nextPage = null;
      paginationEl.style.display = "none";
      showStatus("Searching…");
      const { run, signal } = startSearchRun();
      searchScryfall(state.currentQuery, null, run, signal);
    }

    queryChipsEl.addEventListener("click", (e) => {
      const x = e.target.closest("[data-chip]");
      if (x) {
        const [kind, i] = x.dataset.chip.split(":");
        if (kind === "added") queryChipState.added.splice(Number(i), 1);
        else {
          const term = queryChipState.chips[Number(i)]?.term;
          if (queryChipState.off.has(term)) queryChipState.off.delete(term); else queryChipState.off.add(term);
        }
        rerunFromChips();
        // keep keyboard focus on the same chip's button after the re-render
        queryChipsEl.querySelector(`[data-chip="${x.dataset.chip}"]`)?.focus();
        return;
      }
      if (e.target.closest("[data-chip-add]")) {
        queryChipState.adding = true;
        renderQueryChips();
        queryChipsEl.querySelector("[data-preset]")?.focus();
        return;
      }
      const preset = e.target.closest("[data-preset]");
      if (preset) {
        queryChipState.added.push(preset.dataset.preset);
        queryChipState.adding = false;
        rerunFromChips();
      }
    });

    queryCodeBtn.addEventListener("click", () => {
      const showCode = queryText.hidden;
      queryText.hidden = !showCode;
      queryChipsEl.hidden = showCode;
      queryCodeBtn.setAttribute("aria-pressed", String(showCode));
      queryCodeBtn.title = showCode ? "Show the conditions" : "Show the Scryfall query";
      queryCodeBtn.setAttribute("aria-label", queryCodeBtn.title);
    });

    // "Fix it before you see it": the note when the server had the AI repair its query, with a way back to the
    // query as first written.
    let queryRepairFrom = "";
    function showQueryRepair(repaired) {
      queryRepairFrom = repaired?.from || "";
      queryRepairEl.hidden = !repaired;
      if (!repaired) return;
      $("#query-repair-text").textContent = repaired.note
        || (repaired.reason === "invalid" ? "I fixed a mistake in the search." : "Nothing matched exactly, so I widened the search.");
    }
    $("#query-repair-undo").addEventListener("click", () => {
      if (!queryRepairFrom) return;
      state.currentQuery = withCommanderFilters(queryRepairFrom);
      showQueryChips(state.currentQuery);
      showQueryRepair(null);
      queryDisplay.classList.add("visible");
      rerunFromChips();
    });

    // Add/remove the "Recommended" (AI order) option depending on the active mode.
    function setSortMode(mode) {
      const aiOpt = sortField.querySelector('option[value="ai"]');
      if (mode === "recommend") {
        if (!aiOpt) {
          const o = document.createElement("option");
          o.value = "ai"; o.textContent = "Recommended";
          sortField.insertBefore(o, sortField.firstChild);
        }
        state.sortField = "ai"; sortField.value = "ai";
        state.sortDir = "asc";
        updateSortDirButton(sortDir, state.sortDir);
      } else {
        if (aiOpt) aiOpt.remove();
        if (state.sortField === "ai") { state.sortField = "cmc"; sortField.value = "cmc"; }
      }
    }

    const statVal = (s) => {
      if (s === undefined || s === null || s === "") return -Infinity;
      const n = parseFloat(s);
      return isNaN(n) ? -Infinity : n; // "*"/"X" sort to the bottom (asc)
    };
    const priceNum = (c) => {
      const p = c.prices?.eur ?? c.prices?.eur_foil;
      const n = p != null ? parseFloat(p) : NaN;
      return isNaN(n) ? null : n;
    };

    function sortCardsByField(cards, field, direction) {
      const mul = direction === "desc" ? -1 : 1;
      return cards.slice().sort((a, b) => {
        if (field === "eur") {
          const av = priceNum(a), bv = priceNum(b);
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return (av - bv) * mul;
        }
        let cmp = 0;
        if (field === "name") cmp = (a.name || "").localeCompare(b.name || "");
        else if (field === "cmc") cmp = (a.cmc ?? 0) - (b.cmc ?? 0);
        else if (field === "power") cmp = statVal(a.power) - statVal(b.power);
        else if (field === "toughness") cmp = statVal(a.toughness) - statVal(b.toughness);
        return cmp * mul;
      });
    }

    // Sort the recommendation results in-place on the client (no Scryfall re-query).
    function clientSortCards() {
      let cards = (state.recommendOrder || state.results).slice();
      const f = state.sortField;
      if (f === "ai") {
        if (state.sortDir === "desc") cards.reverse();
      } else {
        cards = sortCardsByField(cards, f, state.sortDir);
      }
      state.results = cards;
      renderSearchView();
    }

    sortField.addEventListener("change", () => {
      state.sortField = sortField.value;
      if (state.mode === "recommend") clientSortCards(); else applySort();
    });
    sortDir.addEventListener("click", () => {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      updateSortDirButton(sortDir, state.sortDir);
      if (state.mode === "recommend") clientSortCards(); else applySort();
    });

    savedSortField.addEventListener("change", () => {
      state.savedSortField = savedSortField.value;
      renderSavedCards();
    });
    savedSortDir.addEventListener("click", () => {
      state.savedSortDir = state.savedSortDir === "asc" ? "desc" : "asc";
      updateSortDirButton(savedSortDir, state.savedSortDir);
      renderSavedCards();
    });

