    // ── Command palette (Ctrl/⌘+K) ──
    (() => {
      const scrim = $("#cmdk"), input = $("#cmdk-input"), list = $("#cmdk-list");
      const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
      $("#cmdk-kbd").textContent = mac ? "⌘K" : "Ctrl K";
      let items = [], sel = 0, lastFocus = null;
      const go = (tab) => { setActiveTab(tab); window.scrollTo(0, 0); };
      function build(q) {
        const deck = activeDeck();
        const out = [];
        state.folders.filter((d) => d.id !== pendingDeckDelete?.id).forEach((d) => out.push({ sec: "Decks", label: d.name, hint: `${folderCount(d.id)} cards`, run: () => { state.activeFolder = d.id; go("saved"); renderSavedCards(); } }));
        const act = (label, run, hint = "") => out.push({ sec: "Actions", label, hint, run });
        act("Go to Search", () => go("search"));
        act("Go to Decks", () => go("saved"));
        act("Go to Collection", () => go("collection"));
        act("New deck", () => openNewDeck());
        if (deck) {
          const cmd = deck.commanderId ? state.savedCards.find((c) => c.id === deck.commanderId) : null;
          act(`Autofill ${deck.name}`, () => { go("saved"); openAutofill(deck, cmd); });
          act(`Goldfish ${deck.name}`, () => openGoldfish(deck));
          act(`Analyze ${deck.name}`, () => { go("saved"); renderSavedCards(); setTimeout(() => $("#da-review-btn")?.click(), 60); });
          act(`Export ${deck.name}`, () => { go("saved"); renderSavedCards(); setTimeout(() => savedExportBtn?.click(), 60); });
          const path = lastDeckPath && lastDeckPath.deckId === deck.id ? lastDeckPath : null;
          const st = path?.steps[path.current];
          if (st?.action && !st.done) act(`Next step: ${st.title}`, () => st.action.run(), st.action.label);
        }
        act("Settings", () => showSettings());
        const theme = document.documentElement.dataset.theme;
        act(theme === "dark" ? "Switch to light mode" : "Switch to dark mode", () => { const v = theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = v; lsSet("theme", v); const s = $("#theme-select"); if (s) s.value = v; });
        if (deck && q) getFolderCards(deck.id).forEach((c) => out.push({ sec: `In ${deck.name}`, label: c.name, hint: isMaybe(deck.id, c.id) ? "maybeboard" : "", run: () => { go("saved"); showDetail(c); } }));
        const ql = q.toLowerCase();
        let hits = !ql ? out.filter((x) => x.sec !== `In ${deck?.name}`) : out.filter((x) => x.label.toLowerCase().includes(ql))
          .sort((a, b) => (b.label.toLowerCase().startsWith(ql) - a.label.toLowerCase().startsWith(ql)));
        hits = hits.slice(0, 40);
        if (q) hits.push({ sec: "Search", label: `Search cards for "${q}"`, hint: "↵", run: () => { go("search"); searchInput.value = q; doSearch(); } });
        return hits;
      }
      function render() {
        items = build(input.value.trim());
        sel = Math.max(0, Math.min(sel, items.length - 1));
        let sec = "", html = "";
        items.forEach((it, i) => {
          if (it.sec !== sec) { html += `<div class="cmdk-sec">${esc(it.sec)}</div>`; sec = it.sec; }
          html += `<button type="button" class="cmdk-item${i === sel ? " on" : ""}" role="option" aria-selected="${i === sel}" data-i="${i}"><span>${esc(it.label)}</span><small>${esc(it.hint || "")}</small></button>`;
        });
        list.innerHTML = html || `<div class="cmdk-empty">Nothing matches.</div>`;
        list.querySelector(".cmdk-item.on")?.scrollIntoView({ block: "nearest" });
      }
      function open() { lastFocus = document.activeElement; scrim.hidden = false; input.value = ""; sel = 0; render(); input.focus(); }
      function close() { scrim.hidden = true; lastFocus?.focus?.(); }
      function runSel() { const it = items[sel]; close(); it?.run(); }
      $("#cmdk-btn").addEventListener("click", open);
      scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
      list.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) { sel = +b.dataset.i; runSel(); } });
      input.addEventListener("input", () => { sel = 0; render(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); render(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); render(); }
        else if (e.key === "Enter") { e.preventDefault(); runSel(); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      });
      document.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); scrim.hidden ? open() : close(); }
      });
    })();

    // ── Card-name suggestions under the search field (Scryfall autocomplete; plain names only) ──
    (() => {
      const box = $("#ac-list");
      let timer = null, ctrl = null, names = [], sel = -1;
      const bar = () => searchInput.closest(".search-bar");
      const hide = () => { box.hidden = true; sel = -1; names = []; };
      function place() {
        const r = bar().getBoundingClientRect();
        box.style.left = r.left + "px"; box.style.top = r.bottom + 6 + "px"; box.style.width = r.width + "px";
      }
      function render(q) {
        if (!names.length) return hide();
        const re = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "i");
        box.innerHTML = names.map((n, i) => `<button type="button" class="ac-item${i === sel ? " on" : ""}" role="option" data-i="${i}">${esc(n).replace(re, "<mark>$1</mark>")}</button>`).join("");
        place();
        box.hidden = false;
      }
      searchInput.addEventListener("input", () => {
        clearTimeout(timer);
        const q = searchInput.value.trim();
        if (q.length < 2 || !isBareNameQuery(q) || q.includes("\n")) return hide();
        timer = setTimeout(async () => {
          ctrl?.abort(); ctrl = new AbortController();
          try {
            const r = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
            const d = await r.json();
            if (searchInput.value.trim() !== q) return;
            names = (d.data || []).slice(0, 8); sel = -1; render(q);
          } catch { /* offline or superseded */ }
        }, 160);
      });
      // Capture phase: runs before the field's own Enter-to-search handler.
      searchInput.addEventListener("keydown", (e) => {
        if (box.hidden) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          sel = e.key === "ArrowDown" ? Math.min(names.length - 1, sel + 1) : Math.max(-1, sel - 1);
          render(searchInput.value.trim());
        } else if (e.key === "Enter" && !e.shiftKey) {
          if (sel >= 0) searchInput.value = names[sel];
          hide();
        } else if (e.key === "Escape") { e.preventDefault(); hide(); }
      }, true);
      box.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the field
      box.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (!b) return; searchInput.value = names[+b.dataset.i]; hide(); doSearch(); });
      searchInput.addEventListener("blur", () => setTimeout(hide, 120));
      window.addEventListener("resize", () => { if (!box.hidden) place(); });
      window.addEventListener("scroll", () => { if (!box.hidden) place(); }, { passive: true });
    })();

    // ── Appearance: device / light / dark ──
    (() => {
      const sel = $("#theme-select");
      if (!sel) return;
      let t = "light";
      try { t = localStorage.getItem("theme") || "light"; } catch {}
      sel.value = t;
      sel.addEventListener("change", () => {
        const v = sel.value;
        if (v === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
        lsSet("theme", v);
      });
    })();

    // ── Maybeboard wiring ──
    (() => {
      const list = $("#mb-list"), pane = $("#mb-pane"), panel = $("#detail-panel");
      const cardById = (id) => state.savedCards.find((c) => c.id === id);
      list.addEventListener("click", (e) => {
        const row = e.target.closest("[data-mb-id]");
        if (!row) return;
        const card = cardById(row.dataset.mbId);
        if (!card) return;
        const act = e.target.closest("[data-mb-act]")?.dataset.mbAct;
        if (act === "back") return maybeMove(card, false);
        if (act === "remove") {
          const deck = activeDeck();
          if (!deck) return;
          setCardFolder(card, deck.id, false);
          renderSavedCards();
          showToast(`Removed ${card.name} from ${deck.name}`, { actionLabel: "Undo", ms: 5000, onAction: () => { setCardFolder(card, deck.id, true); setMaybe(deck.id, card.id, true); renderSavedCards(); } });
          return;
        }
        showDetail(card);
        list.querySelectorAll(".mb-row.sel").forEach((r) => r.classList.remove("sel"));
        row.classList.add("sel");
      });
      list.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-mb-id]")) { e.preventDefault(); e.target.click(); } });
      // Drag: deck tiles onto the list (cut), list rows onto the deck grid (back).
      list.addEventListener("dragstart", (e) => { const row = e.target.closest("[data-mb-id]"); if (!row) return; mbDrag = { id: row.dataset.mbId, from: "maybe" }; row.classList.add("dragging"); try { e.dataTransfer.setData("text/plain", row.textContent.trim()); e.dataTransfer.effectAllowed = "move"; } catch {} });
      list.addEventListener("dragend", () => { mbDrag = null; list.querySelectorAll(".dragging").forEach((x) => x.classList.remove("dragging")); savedGrid.classList.remove("mb-drop"); });
      const zone = (el, accepts, drop) => {
        el.addEventListener("dragover", (e) => { if (mbDrag && accepts()) { e.preventDefault(); el.classList.add("mb-drop"); } });
        el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove("mb-drop"); });
        el.addEventListener("drop", (e) => { if (!mbDrag || !accepts()) return; e.preventDefault(); el.classList.remove("mb-drop"); const card = cardById(mbDrag.id); mbDrag = null; if (card) drop(card); });
      };
      zone(pane, () => mbDrag.from === "deck", (card) => maybeMove(card, true));
      zone(savedGrid, () => mbDrag.from === "maybe", (card) => maybeMove(card, false));
      // Swap order: button, or drag the maybeboard header over the card pane.
      const swap = () => { mbUi.order = mbUi.order === "card" ? "maybe" : "card"; saveMbUi(); updateFocusStack(); };
      $("#mb-swap").addEventListener("click", swap);
      const head = $("#mb-head");
      let hd = null;
      head.addEventListener("pointerdown", (e) => { if (e.target.closest("button") || mbUi.popped || e.button !== 0) return; hd = { y: e.clientY }; head.setPointerCapture(e.pointerId); pane.classList.add("lift"); });
      head.addEventListener("pointermove", (e) => {
        if (!hd) return;
        const r = $("#focus-card-pane").getBoundingClientRect();
        $("#focus-card-pane").classList.toggle("swap-target", e.clientY > r.top && e.clientY < r.bottom);
      });
      head.addEventListener("pointerup", () => {
        if (!hd) return;
        hd = null; pane.classList.remove("lift");
        const t = $("#focus-card-pane");
        if (t.classList.contains("swap-target")) { t.classList.remove("swap-target"); swap(); }
      });
      // Resize: drag the divider, or arrow keys on it.
      const split = $("#focus-split");
      let sd = null;
      const setSplit = (clientY) => {
        const r = panel.getBoundingClientRect();
        const head = panel.querySelector(".detail-header").getBoundingClientRect();
        const top = head.bottom, span = r.bottom - top - 14;
        const firstShare = Math.max(0.15, Math.min(0.85, (clientY - top) / span));
        mbUi.split = mbUi.order === "card" ? firstShare : 1 - firstShare;
        updateFocusStack();
      };
      split.addEventListener("pointerdown", (e) => { sd = true; split.setPointerCapture(e.pointerId); split.classList.add("on"); });
      split.addEventListener("pointermove", (e) => { if (sd) setSplit(e.clientY); });
      split.addEventListener("pointerup", () => { if (!sd) return; sd = null; split.classList.remove("on"); saveMbUi(); });
      split.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const dir = (e.key === "ArrowUp" ? -0.05 : 0.05) * (mbUi.order === "card" ? 1 : -1);
        mbUi.split = Math.max(0.15, Math.min(0.85, mbUi.split + dir));
        saveMbUi(); updateFocusStack();
      });
      // Pop out / dock; the window moves by its title bar and resizes from its corner.
      $("#mb-pop").addEventListener("click", () => { mbUi.popped = true; saveMbUi(); renderSavedCards(); });
      $("#mb-dock").addEventListener("click", () => { mbUi.popped = false; saveMbUi(); renderSavedCards(); });
      const float = $("#mb-float"), fh = $("#mb-float-h");
      let fm = null;
      fh.addEventListener("pointerdown", (e) => { if (e.target.closest("button")) return; const r = float.getBoundingClientRect(); fm = { dx: e.clientX - r.left, dy: e.clientY - r.top }; fh.setPointerCapture(e.pointerId); });
      fh.addEventListener("pointermove", (e) => { if (!fm) return; mbUi.x = e.clientX - fm.dx; mbUi.y = e.clientY - fm.dy; updateFocusStack(); });
      fh.addEventListener("pointerup", () => { if (fm) { fm = null; saveMbUi(); } });
      if ("ResizeObserver" in window) new ResizeObserver(() => { if (float.hidden) return; mbUi.w = float.offsetWidth; mbUi.hgt = float.offsetHeight; saveMbUi(); }).observe(float);
      // Collapsing / expanding the Focus panel changes where the list lives.
      new MutationObserver(() => { if (state.activeTab === "saved") renderSavedCards(); else updateFocusStack(); }).observe(appShell, { attributes: true, attributeFilter: ["class"] });
      window.addEventListener("resize", () => updateFocusStack());
    })();

    // ═══ Phone layout (≤ 760px): bottom tabs, context switcher, sheets, long-press ═══
    // Desktop is untouched: every behaviour here is gated on isPhone().
    const phoneMq = window.matchMedia("(max-width: 760px)");
    const isPhone = () => phoneMq.matches;
    const mScrim = $("#m-scrim");
    const sidePanel = $("#m-sheet");
    // On phone the relevant side-panel section (decks / binders / recents) is moved into the
    // standalone sheet while it's open, then put back, so its listeners and renderers keep working.
    let borrowed = null;
    function borrowSection() {
      returnSection();
      const sel = state.activeTab === "saved" ? ".folders-section" : state.activeTab === "collection" ? ".binders-section" : ".history-section";
      const sec = $("#side-menu " + sel);
      if (!sec) return;
      borrowed = { sec, parent: sec.parentNode, next: sec.nextSibling };
      sidePanel.appendChild(sec);
    }
    function returnSection() {
      if (!borrowed) return;
      borrowed.parent.insertBefore(borrowed.sec, borrowed.next);
      borrowed = null;
    }
    const detailPanelEl = $("#detail-panel");
    function openSheet(el) {
      if (!isPhone() || !el) return;
      closeSheets(el);
      el.classList.add("m-open");
      el.scrollTop = 0;
      mScrim.classList.add("on");
    }
    function closeSheets(except = null) {
      [sidePanel, detailPanelEl].forEach((el) => { if (el !== except) el?.classList.remove("m-open"); });
      if (!except) { mScrim.classList.remove("on"); if (borrowed) setTimeout(() => { if (!sidePanel.classList.contains("m-open")) returnSection(); }, 300); }
    }
    mScrim.addEventListener("click", () => closeSheets());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isPhone()) closeSheets(); });
    // Swipe a sheet down (from its top) to close it.
    [sidePanel, detailPanelEl].forEach((el) => {
      let startY = null, dy = 0;
      el.addEventListener("touchstart", (e) => { if (!el.classList.contains("m-open") || el.scrollTop > 0) return; startY = e.touches[0].clientY; dy = 0; }, { passive: true });
      el.addEventListener("touchmove", (e) => {
        if (startY == null) return;
        dy = e.touches[0].clientY - startY;
        if (dy > 0) { el.classList.add("m-dragging"); el.style.transform = `translateY(${dy}px)`; }
      }, { passive: true });
      el.addEventListener("touchend", () => {
        if (startY == null) return;
        el.classList.remove("m-dragging");
        el.style.transform = "";
        if (dy > 90) closeSheets();
        startY = null;
      });
    });

    // Context switcher: the deck (Decks), the binder (Collection) or recent searches (Search).
    function updateMobileCtx() {
      const label = $("#m-ctx-label"), count = $("#m-ctx-count"), add = $("#m-ctx-add");
      if (!label) return;
      if (state.activeTab === "saved") {
        const deck = state.folders.find((f) => f.id === state.activeFolder);
        label.textContent = deck ? deck.name : "Choose a deck";
        count.textContent = state.folders.length > 1 ? `${state.folders.length} decks` : (deck ? `${folderCount(deck.id)} cards` : "");
        add.hidden = false;
      } else if (state.activeTab === "collection") {
        label.textContent = collectionUi.binder || "All cards";
        const n = collectionUi.binder ? (binderCounts().find(([b]) => b === collectionUi.binder)?.[1] || 0) : (collectionIndex?.list.length || 0);
        count.textContent = collectionIndex?.list.length ? n.toLocaleString() : "";
        add.hidden = true;
      } else {
        label.textContent = "Recent searches";
        count.textContent = "";
        add.hidden = true;
      }
      $("#m-ctx-icon").innerHTML = state.activeTab === "search" ? ICON_RECENTS : ICON_FOLDER;
    }
    $("#m-ctx").addEventListener("click", () => { updateMobileCtx(); borrowSection(); openSheet(sidePanel); });
    $("#m-ctx-add").addEventListener("click", () => openNewDeck());
    // Picking a deck / binder / recent search (or an action) closes the sheet.
    sidePanel.addEventListener("click", (e) => {
      if (!isPhone()) return;
      if (e.target.closest(".folder-edit, .renaming, .mb-pane")) return; // rename/delete and the maybeboard stay in the sheet
      if (e.target.closest(".folder-btn, [data-binder], .history-btn, .folder-add")) setTimeout(() => { closeSheets(); updateMobileCtx(); }, 0);
    });
    // Keep the label current as tabs, decks and binders change.
    const _setActiveTab = setActiveTab;
    setActiveTab = function (tab) { closeSheets(); _setActiveTab(tab); updateMobileCtx(); updateFocusStack(); if (tab === "search") renderBuildTarget(); if (isPhone()) window.scrollTo(0, 0); };
    const _renderFolderRail = renderFolderRail;
    renderFolderRail = function () { _renderFolderRail(); updateMobileCtx(); };
    const _renderBinderRail = renderBinderRail;
    renderBinderRail = function () { _renderBinderRail(); updateMobileCtx(); };

    // Tapping a card opens its details as a sheet (only for real taps, not background
    // refreshes that re-render the panel).
    const _showDetail = showDetail;
    showDetail = function (card) {
      _showDetail(card);
      const ev = window.event;
      if (isPhone() && ev && (ev.type === "click" || ev.type === "keydown" || ev.type === "touchend")) openSheet(detailPanelEl);
    };

    // Long-press a card (≈450ms) = right-click: opens the same action menu.
    let lp = null, lpFired = false;
    document.addEventListener("touchstart", (e) => {
      if (!isPhone() || e.touches.length !== 1) return;
      const el = e.target.closest(".card-item");
      if (!el) return;
      const t = e.touches[0];
      clearTimeout(lp?.timer);
      lp = { el, x: t.clientX, y: t.clientY, timer: setTimeout(() => {
        lpFired = true;
        navigator.vibrate?.(10);
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: t.clientX, clientY: t.clientY }));
      }, 450) };
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!lp) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > 10) { clearTimeout(lp.timer); lp = null; }
    }, { passive: true });
    document.addEventListener("touchend", () => { if (lp) { clearTimeout(lp.timer); lp = null; } });
    // The tap that ends a long-press must not also open the card.
    document.addEventListener("click", (e) => {
      if (!lpFired) return;
      lpFired = false;
      if (!e.target.closest(".context-menu")) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // Maybe chip → the maybeboard list in the bottom sheet (moved in while open, like the deck list).
    function openMaybeSheet() {
      returnSection();
      const pane = $("#mb-pane");
      borrowed = { sec: pane, parent: pane.parentNode, next: pane.nextSibling };
      sidePanel.appendChild(pane);
      renderMaybeList();
      openSheet(sidePanel);
    }
    document.addEventListener("click", (e) => { if (e.target.closest(".dp-maybe")) openMaybeSheet(); });

    // Swipe a deck card: left = maybeboard (or back to the deck), right = pin / unpin.
    let sw = null, swipeFired = false;
    savedGrid.addEventListener("pointerdown", (e) => {
      if (!isPhone() || e.pointerType === "mouse") return;
      const el = e.target.closest(".card-item[data-card-id]");
      if (!el || !activeDeck()) return;
      sw = { el, id: el.dataset.cardId, x: e.clientX, y: e.clientY, dx: 0, pid: e.pointerId, locked: false };
    });
    window.addEventListener("pointermove", (e) => {
      if (!sw || e.pointerId !== sw.pid) return;
      const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
      if (!sw.locked) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
        if (Math.abs(dx) < 10) return;
        sw.locked = true;
        if (lp) { clearTimeout(lp.timer); lp = null; } // a swipe is not a long-press
        sw.el.classList.add("swiping");
      }
      sw.dx = Math.max(-140, Math.min(140, dx));
      sw.el.style.transform = `translateX(${sw.dx}px) rotate(${sw.dx / 40}deg)`;
      const deck = activeDeck();
      const far = Math.abs(sw.dx) > 70;
      if (!far) delete sw.el.dataset.swipe;
      else if (sw.dx < 0) sw.el.dataset.swipe = isMaybe(deck.id, sw.id) ? "back" : "maybe";
      else sw.el.dataset.swipe = isPinned(deck.id, sw.id) ? "unpin" : "pin";
    }, { passive: true });
    const endSwipe = () => {
      if (!sw) return;
      const { el, id, dx, locked } = sw;
      sw = null;
      if (!locked) return;
      swipeFired = true;
      setTimeout(() => { swipeFired = false; }, 350);
      el.classList.remove("swiping");
      el.classList.add("swipe-back");
      el.style.transform = "";
      delete el.dataset.swipe;
      setTimeout(() => el.classList.remove("swipe-back"), 240);
      if (Math.abs(dx) <= 70) return;
      const deck = activeDeck();
      const card = state.savedCards.find((c) => c.id === id);
      if (!deck || !card) return;
      navigator.vibrate?.(10);
      if (dx < 0) setTimeout(() => maybeMove(card, !isMaybe(deck.id, id)), 160);
      else {
        const on = !isPinned(deck.id, id);
        setPinned(deck.id, id, on);
        setTimeout(() => { renderSavedCards(); showToast(on ? `Pinned ${card.name}: kept when trimming` : `Unpinned ${card.name}`, { actionLabel: "Undo", ms: 4000, onAction: () => { setPinned(deck.id, id, !on); renderSavedCards(); } }); }, 160);
      }
    };
    window.addEventListener("pointerup", endSwipe);
    window.addEventListener("pointercancel", () => { if (sw && !sw.locked) sw = null; else endSwipe(); });
    // The tap that ends a swipe must not also open the card.
    document.addEventListener("click", (e) => { if (swipeFired && e.target.closest("#saved-grid")) { e.preventDefault(); e.stopPropagation(); } }, true);

    // Phone: no collapsed side panels, a shorter search placeholder; restore on desktop.
    const desktopPlaceholder = searchInput.getAttribute("placeholder");
    function applyPhoneMode() {
      if (isPhone()) {
        appShell.classList.remove("nav-collapsed", "detail-collapsed");
        searchInput.setAttribute("placeholder", "Search spells…");
        updateMobileCtx();
      } else {
        closeSheets();
        searchInput.setAttribute("placeholder", desktopPlaceholder);
      }
    }
    phoneMq.addEventListener?.("change", applyPhoneMode);
    applyPhoneMode();
