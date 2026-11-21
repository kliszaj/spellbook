    // ── Decks tab: Game plan, Owned count, color filter ────────────────
    const DECK_NOTES_MAX_UI = 20000;

    function persistDeckNotes() {
      lsSet("deck_notes", JSON.stringify(state.deckNotes));
      queueOp({ type: "setDeckNotes", deckNotes: state.deckNotes });
    }
    function setDeckNotes(folderId, text) {
      const value = String(text || "").trim();
      if (value) state.deckNotes[folderId] = value;
      else delete state.deckNotes[folderId];
      persistDeckNotes();
    }

    function renderDeckTools(isRealDeck, mainVisible) {
      $("#deck-tools").style.display = "flex";
      const qty = (list) => list.reduce((n, c) => n + cardQty(state.activeFolder, c.id), 0);
      const allMain = getFolderCards(state.activeFolder).filter((c) => !isMaybe(state.activeFolder, c.id));
      $("#deck-showing").textContent = deckColorFilter.size ? `Showing ${qty(mainVisible)} of ${qty(allMain)}` : "";
      const own = isRealDeck && hasCollection() ? ownCount(collectionIndex, allMain.filter((c) => !isBasicLand(c))) : null;
      $("#deck-owned").textContent = own ? `Own ${own.owned} of ${own.total}` : "";
      const planBtn = $("#deck-gameplan-btn");
      planBtn.style.display = isRealDeck ? "" : "none";
      planBtn.textContent = state.deckNotes[state.activeFolder] ? "Game plan ✓" : "Game plan";
    }

    buildColorPicker($("#deck-colors"), deckColorFilter, () => renderSavedCards({ filtersOnly: true }), { colorless: true });

    const gameplanModal = $("#gameplan-modal");
    function updateGameplanCount() {
      const n = $("#gameplan-input").value.length;
      const counter = $("#gameplan-count");
      counter.textContent = n.toLocaleString();
      counter.classList.toggle("over", n > DECK_NOTES_MAX_UI);
      $("#gameplan-save").disabled = n > DECK_NOTES_MAX_UI;
    }
    $("#deck-gameplan-btn").addEventListener("click", () => {
      const deck = activeDeck();
      if (!deck) return;
      $("#gameplan-title").textContent = `Game plan · ${deck.name}`;
      $("#gameplan-input").value = state.deckNotes[deck.id] || "";
      updateGameplanCount();
      gameplanModal.classList.add("visible");
      setTimeout(() => $("#gameplan-input").focus(), 0);
    });
    $("#gameplan-input").addEventListener("input", updateGameplanCount);
    $("#gameplan-cancel").addEventListener("click", () => gameplanModal.classList.remove("visible"));
    gameplanModal.addEventListener("click", (e) => { if (e.target === gameplanModal) gameplanModal.classList.remove("visible"); });
    $("#gameplan-save").addEventListener("click", () => {
      const deck = activeDeck();
      if (deck) setDeckNotes(deck.id, $("#gameplan-input").value);
      gameplanModal.classList.remove("visible");
      renderSavedCards();
    });
    // ── Goldfish: play the deck against an empty table ──
    // Generic mana (colours aren't checked), London mulligan, on the play, summoning sickness,
    // commander tax, enters-tapped lands, mana rocks/dorks, draw spells and land-fetch ramp.
    const GF_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    function gfFront(c) { return c.card_faces?.[0] ? { ...c, ...c.card_faces[0], cmc: c.cmc } : c; }
    function gfProfile(card) {
      const fc = gfFront(card);
      const tl = (fc.type_line || "").toLowerCase();
      const ot = getOracleText(card).toLowerCase();
      const kw = (card.keywords || []).map((k) => k.toLowerCase());
      const p = { card, name: card.name, cmc: Number(card.cmc || 0), img: getCardImage(card) };
      const addClause = /\{t\}[^.:]*:\s*add ([^.]*)/.exec(ot);
      const makes = addClause ? Math.max(1, (addClause[1].match(/\{[wubrgc]\}/g) || []).length || (/one mana|mana of any/.test(addClause[1]) ? 1 : 1)) : 0;
      if (tl.includes("land")) { p.kind = "land"; p.makes = 1; p.etbTapped = /enters (the battlefield )?tapped/.test(ot) && !/unless|you may pay/.test(ot); return p; }
      if (tl.includes("creature")) {
        p.kind = "creature";
        p.pow = parseInt(fc.power, 10) || 0; p.tou = parseInt(fc.toughness, 10) || 0;
        p.haste = kw.includes("haste"); p.vigilance = kw.includes("vigilance");
        p.dork = makes; // mana creature
      } else if (tl.includes("artifact") && makes) { p.kind = "rock"; p.makes = makes; }
      else if (tl.includes("instant") || tl.includes("sorcery")) p.kind = "spell";
      else p.kind = "perm"; // enchantments, planeswalkers, other artifacts, battles
      const d = /draw (a|an|one|two|three|four|five|six|seven|x|\d+) cards?/.exec(ot);
      if (d && !/whenever|at the beginning/.test(ot.slice(0, d.index))) p.draws = GF_NUM[d[1]] || parseInt(d[1], 10) || 0;
      if (/search your library for [^.]*\bland/.test(ot) && /onto the battlefield/.test(ot)) { p.fetchLand = 1; if (/into your hand/.test(ot)) p.fetchHand = 1; }
      return p;
    }
    let gf = null; // the current game
    let gfDeck = null, gfCards = null, gfCmd = null, gfUid = 0;
    const gfShuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    function gfNew(silent = false) {
      const g = { lib: gfShuffle(gfCards.map((p) => ({ ...p, id: ++gfUid }))), hand: [], bf: [], gy: [], cmdIn: Boolean(gfCmd), tax: 0, turn: 0, life: 40, landPlayed: false, pool: 0, log: [], mulls: 0, phase: "mull", kill: null, pending: [] };
      gfDraw(g, 7);
      if (!silent) g.log.push({ t: 0, msg: "Shuffled and drew 7." });
      return g;
    }
    const gfDraw = (g, n = 1) => { for (let i = 0; i < n && g.lib.length; i++) g.hand.push(g.lib.shift()); };
    const gfSource = (p) => !p.tapped && (p.kind === "land" || p.kind === "rock" || (p.kind === "creature" && p.dork && !p.sick));
    const gfAvail = (g) => g.bf.filter(gfSource).reduce((n, p) => n + (p.makes || p.dork || 1), 0) + g.pool;
    function gfPay(g, n) {
      const fromPool = Math.min(g.pool, n); g.pool -= fromPool; n -= fromPool;
      const srcs = g.bf.filter(gfSource).sort((a, b) => (a.kind === "creature") - (b.kind === "creature") || (b.makes || 1) - (a.makes || 1));
      for (const p of srcs) { if (n <= 0) break; p.tapped = true; const m = p.makes || p.dork || 1; if (m > n) g.pool += m - n; n -= m; }
    }
    const gfCanPlay = (g, c) => g.phase === "main" && !g.kill && (c.kind === "land" ? !g.landPlayed : gfAvail(g) >= c.cmc);
    const gfCanCmd = (g) => g.cmdIn && g.phase === "main" && !g.kill && gfAvail(g) >= gfCmd.cmc + g.tax;
    function gfPlay(g, c, fromCmd = false) {
      if (c.kind === "land") {
        g.landPlayed = true; g.hand = g.hand.filter((x) => x !== c); g.bf.push({ ...c, tapped: Boolean(c.etbTapped) });
        g.log.push({ t: g.turn, msg: `Played <b>${esc(c.name)}</b>${c.etbTapped ? " (tapped)" : ""}.` });
        return;
      }
      const cost = c.cmc + (fromCmd ? g.tax : 0);
      if (gfAvail(g) < cost) return;
      gfPay(g, cost);
      if (fromCmd) { g.cmdIn = false; c = { ...gfCmd, id: "cmd" }; } else g.hand = g.hand.filter((x) => x !== c);
      const notes = [];
      if (c.draws) { gfDraw(g, c.draws); notes.push(`drew ${c.draws}`); }
      if (c.fetchLand) {
        const basics = g.lib.filter((x) => x.kind === "land" && isBasicLand(x.card));
        const pick = basics[0]; if (pick) { g.lib = g.lib.filter((x) => x !== pick); g.bf.push({ ...pick, tapped: true }); notes.push(`${pick.name} onto the battlefield`); }
        if (c.fetchHand) { const p2 = g.lib.find((x) => x.kind === "land" && isBasicLand(x.card)); if (p2) { g.lib = g.lib.filter((x) => x !== p2); g.hand.push(p2); notes.push(`${p2.name} to hand`); } }
        gfShuffle(g.lib);
      }
      if (c.kind === "spell") g.gy.push(c);
      else g.bf.push({ ...c, tapped: false, sick: c.kind === "creature" && !c.haste, attacked: false, fromCmd });
      g.log.push({ t: g.turn, msg: `Cast <b>${esc(c.name)}</b>${fromCmd ? ` from the command zone (tax ${g.tax})` : ""}${notes.length ? ` (${notes.join(", ")})` : ""}.` });
    }
    const gfAttackers = (g) => g.bf.filter((p) => p.kind === "creature" && !p.sick && !p.tapped && !p.attacked && p.pow > 0);
    function gfAttack(g) {
      const a = gfAttackers(g);
      if (!a.length || g.kill) return;
      const dmg = a.reduce((n, p) => n + p.pow, 0);
      a.forEach((p) => { p.attacked = true; if (!p.vigilance) p.tapped = true; });
      g.life = Math.max(0, g.life - dmg);
      g.log.push({ t: g.turn, msg: `Attacked with ${a.length} for <b>${dmg}</b>.` });
      if (g.life <= 0) { g.kill = g.turn; g.log.push({ t: g.turn, msg: `<b>Goldfish dead on turn ${g.turn}.</b>` }); }
    }
    function gfNextTurn(g) {
      if (g.kill) return;
      g.turn++;
      g.bf.forEach((p) => { p.tapped = false; p.sick = false; p.attacked = false; });
      g.pool = 0; g.landPlayed = false; g.phase = "main";
      if (g.turn > 1) gfDraw(g, 1);
      g.log.push({ t: g.turn, msg: g.turn > 1 ? "Untap, draw." : "On the play: no draw." });
    }
    function gfKeep(g) {
      if (g.mulls > 0) {
        const bottom = g.pending.length === Math.min(g.mulls, 7) ? g.pending : g.hand.slice().sort((a, b) => (a.kind === "land" ? -1 : -a.cmc) - (b.kind === "land" ? -1 : -b.cmc)).slice(0, g.mulls);
        g.hand = g.hand.filter((c) => !bottom.includes(c)); g.lib.push(...bottom);
        g.log.push({ t: 0, msg: `Kept ${g.hand.length}; ${bottom.length} to the bottom.` });
      } else g.log.push({ t: 0, msg: "Kept 7." });
      g.pending = [];
      gfNextTurn(g);
    }
    function gfMulligan(g) { g.lib.push(...g.hand); g.hand = []; gfShuffle(g.lib); gfDraw(g, 7); g.mulls++; g.pending = []; g.log.push({ t: 0, msg: `Mulligan ${g.mulls}: drew a new 7.` }); }
    // The simple pilot: best land, ramp, commander, the biggest useful spells, then attack.
    function gfAutoTurn(g) {
      if (g.phase === "mull") gfKeep(g);
      if (g.kill) return;
      if (!g.landPlayed) {
        const ls = g.hand.filter((c) => c.kind === "land");
        const land = ls.find((c) => !c.etbTapped && !isBasicLand(c.card)) || ls.find((c) => !c.etbTapped) || ls[0];
        if (land) gfPlay(g, land);
      }
      for (let guard = 0; guard < 25; guard++) {
        const ramp = g.hand.filter((c) => (c.kind === "rock" || c.dork || c.fetchLand) && gfAvail(g) >= c.cmc).sort((a, b) => a.cmc - b.cmc)[0];
        if (ramp) { gfPlay(g, ramp); continue; }
        if (gfCanCmd(g)) { gfPlay(g, gfCmd, true); continue; }
        const spell = g.hand.filter((c) => c.kind !== "land" && (c.kind !== "spell" || c.draws) && gfAvail(g) >= c.cmc).sort((a, b) => b.cmc - a.cmc)[0];
        if (spell) { gfPlay(g, spell); continue; }
        break;
      }
      gfAttack(g);
    }
    const gfVerdict = (hand) => { const l = hand.filter((c) => c.kind === "land").length, r = hand.filter((c) => c.kind === "rock" || c.dork).length; return l >= 3 && l <= 5 ? ["ok", `${l} lands${r ? ` + ${r} ramp` : ""} · keepable`] : l === 2 && r ? ["ok", `2 lands + ${r} ramp · risky but fine`] : ["meh", `${l} land${l === 1 ? "" : "s"} · consider a mulligan`]; };
    function gfCardHtml(c, cls = "") {
      const pt = c.kind === "creature" ? `<span class="gf-pt">${c.pow}/${c.tou}</span>` : "";
      return `<button type="button" class="gf-c ${cls}" data-gfid="${c.id}" title="${escAttr(c.name)}"><img src="${escAttr(c.img)}" alt="${escAttr(c.name)}" loading="lazy" draggable="false">${pt}</button>`;
    }
    function gfRender() {
      const g = gf, el = (id) => document.getElementById(id);
      const a = gfAvail(g);
      const perms = g.bf.filter((p) => p.kind === "creature" || p.kind === "perm");
      const mana = g.bf.filter((p) => p.kind === "land" || p.kind === "rock");
      const pow = g.bf.filter((p) => p.kind === "creature").reduce((n, p) => n + p.pow, 0);
      const lands = g.bf.filter((p) => p.kind === "land").length;
      el("gf-sub").textContent = g.phase === "mull" ? "Opening hand" : `Turn ${g.turn}${g.kill ? " · goldfish dead" : ""}`;
      el("gf-life-m").textContent = `${g.life} life`;
      el("gf-tax").innerHTML = gfCmd ? `tax <b>${g.tax}</b>` : "";
      el("gf-cmd").innerHTML = !gfCmd ? `<span class="gf-muted">No commander set</span>` : g.cmdIn ? gfCardHtml({ ...gfCmd, id: "cmd" }, gfCanCmd(g) ? "can" : "cant") : `<span class="gf-muted">On the battlefield</span>`;
      el("gf-lib").textContent = g.lib.length;
      el("gf-gyn").textContent = g.gy.length;
      el("gf-gy").innerHTML = g.gy.map((c) => `<span class="gf-chip">${esc(c.name)}</span>`).join("") || `<span class="gf-muted">Empty</span>`;
      el("gf-perm").innerHTML = perms.map((p) => gfCardHtml(p, `${p.tapped ? "tapped" : ""} ${p.sick ? "sick" : ""}`)).join("") || `<span class="gf-muted">Nothing yet.</span>`;
      el("gf-lands").innerHTML = mana.map((p) => gfCardHtml(p, p.tapped ? "tapped" : "")).join("") || `<span class="gf-muted">Play a land from your hand.</span>`;
      el("gf-power").textContent = pow ? `${pow} power on board` : "";
      el("gf-landn").textContent = `${lands} land${lands === 1 ? "" : "s"}`;
      el("gf-handn").textContent = g.hand.length;
      const cmdInHand = isPhone() && gfCmd && g.cmdIn && g.phase === "main" ? gfCardHtml({ ...gfCmd, id: "cmd" }, gfCanCmd(g) ? "can cmd" : "cant cmd") : "";
      el("gf-hand").innerHTML = cmdInHand + g.hand.map((c) => gfCardHtml(c, gfCanPlay(g, c) ? "can" : "cant")).join("");
      el("gf-life").textContent = g.life;
      el("gf-life").classList.toggle("low", g.life <= 10);
      el("gf-lifebar").style.width = (g.life / 40) * 100 + "%";
      el("gf-kill").innerHTML = g.kill ? `<div class="gf-killmsg">Dead on turn ${g.kill}</div>` : "";
      el("gf-mana").textContent = a;
      el("gf-drop").textContent = g.landPlayed ? "used" : "ready";
      let lt = -1;
      el("gf-log").innerHTML = g.log.slice(-60).map((l) => { const head = l.t !== lt ? `<div class="gf-tn">${l.t ? `TURN ${l.t}` : "SETUP"}</div>` : ""; lt = l.t; return head + `<div>${l.msg}</div>`; }).join("");
      el("gf-log").scrollTop = 1e6;
      document.querySelectorAll('[data-gf="attack"]').forEach((b) => (b.disabled = !gfAttackers(g).length || !!g.kill));
      document.querySelectorAll('[data-gf="next"]').forEach((b) => (b.disabled = g.phase === "mull" || !!g.kill));
      el("gf-mull").hidden = g.phase !== "mull";
      if (g.phase === "mull") {
        el("gf-mtitle").textContent = g.mulls ? `Mulligan ${g.mulls}: put ${g.mulls} on the bottom` : "Opening hand";
        el("gf-mnote").textContent = g.mulls ? `Click ${g.mulls} card${g.mulls === 1 ? "" : "s"} to put on the bottom (London mulligan), then Keep.` : "You're on the play. Keep, or mulligan for a new 7.";
        el("gf-mhand").innerHTML = g.hand.map((c) => gfCardHtml(c, g.pending.includes(c) ? "bottom" : "")).join("");
        const [cls, txt] = gfVerdict(g.hand.filter((c) => !g.pending.includes(c)));
        el("gf-verdict").className = "gf-verdict " + cls; el("gf-verdict").textContent = txt;
        document.querySelector('[data-gf="keep"]').disabled = g.mulls > 0 && g.pending.length !== Math.min(g.mulls, 7);
      }
    }
    function gfRunSim() {
      const N = 500, kills = [], stuck = [];
      for (let i = 0; i < N; i++) {
        const s = gfNew(true);
        const l = s.hand.filter((c) => c.kind === "land").length;
        if (l < 2 || l > 5) gfMulligan(s);
        gfKeep(s);
        let miss = false;
        for (let t = 0; t < 14 && !s.kill; t++) { if (t > 0) gfNextTurn(s); gfAutoTurn(s); if (s.turn <= 4 && !s.landPlayed) miss = true; }
        kills.push(s.kill || 15); stuck.push(miss);
      }
      const avg = kills.reduce((x, y) => x + y, 0) / N, med = kills.slice().sort((x, y) => x - y)[N >> 1];
      const buckets = Array.from({ length: 10 }, (_, i) => i + 5);
      const counts = buckets.map((t) => kills.filter((k) => (t === 14 ? k >= 14 : t === 5 ? k <= 5 : k === t)).length);
      const max = Math.max(...counts, 1), best = counts.indexOf(max);
      document.getElementById("gf-sim").innerHTML = `
        <div class="gf-stat"><span>Average kill turn</span><b>${avg.toFixed(1)}</b></div>
        <div class="gf-stat"><span>Median</span><b>${med}</b></div>
        <div class="gf-stat"><span>Missed a land drop by turn 4</span><b>${Math.round(stuck.filter(Boolean).length / N * 100)}%</b></div>
        <div class="gf-hist">${counts.map((c, i) => `<div title="Turn ${buckets[i]}${i === 9 ? "+" : i === 0 ? " or earlier" : ""}: ${c} games"><i class="${i === best ? "best" : ""}" style="height:${(c / max) * 64}px"></i><span>${i === 0 ? "≤5" : buckets[i] + (i === 9 ? "+" : "")}</span></div>`).join("")}</div>
        <p class="gf-muted">The same simple pilot as "Play it for me". Colours aren't checked.</p>`;
    }
    function openGoldfish(deck) {
      const cards = getFolderCards(deck.id).filter((c) => !isMaybe(deck.id, c.id));
      const cmdCard = deck.commanderId ? cards.find((c) => c.id === deck.commanderId) : null;
      gfDeck = deck;
      gfCmd = cmdCard ? { ...gfProfile(cmdCard), id: "cmd" } : null;
      gfCards = [];
      cards.forEach((c) => { if (c.id === deck.commanderId) return; const q = cardQty(deck.id, c.id); const p = gfProfile(c); for (let i = 0; i < q; i++) gfCards.push(p); });
      if (gfCards.length < 20) { showToast("Add more cards before goldfishing — the deck needs at least 20."); return; }
      gf = gfNew();
      document.getElementById("gf-deckname").textContent = deck.name;
      document.getElementById("gf-sim").innerHTML = `<span class="gf-muted">Kill-turn spread and averages appear here.</span>`;
      document.getElementById("gf").hidden = false;
      document.body.classList.add("gf-open");
      gfRender();
      document.getElementById("gf-close").focus();
    }
    function closeGoldfish() { document.getElementById("gf").hidden = true; document.body.classList.remove("gf-open"); gfCloseSheet(); }
    let gfSheetId = null;
    function gfOpenSheet(id) {
      const c = id === "cmd" ? { ...gfCmd, id: "cmd" } : gf.hand.find((x) => String(x.id) === id);
      if (!c) return;
      gfSheetId = id;
      document.getElementById("gf-sheet-card").innerHTML = gfCardHtml(c, "big");
      const ok = id === "cmd" ? gfCanCmd(gf) : gfCanPlay(gf, c);
      const b = document.getElementById("gf-sheet-play");
      b.disabled = !ok;
      b.textContent = c.kind === "land" ? (ok ? "Play land" : "Land already played") : ok ? `Cast (${c.cmc + (id === "cmd" ? gf.tax : 0)} mana)` : "Not enough mana";
      document.getElementById("gf-sheet").hidden = false; document.getElementById("gf-sheet-scrim").hidden = false;
    }
    function gfCloseSheet() { document.getElementById("gf-sheet").hidden = true; document.getElementById("gf-sheet-scrim").hidden = true; }
    (() => {
      const root = document.getElementById("gf");
      document.getElementById("gf-close").addEventListener("click", closeGoldfish);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !root.hidden) { if (!document.getElementById("gf-sheet").hidden) gfCloseSheet(); else closeGoldfish(); } });
      document.getElementById("gf-sheet-scrim").addEventListener("click", gfCloseSheet);
      document.getElementById("gf-sheet-close").addEventListener("click", gfCloseSheet);
      document.getElementById("gf-sheet-play").addEventListener("click", () => { if (gfSheetId === "cmd") gfPlay(gf, gfCmd, true); else { const c = gf.hand.find((x) => String(x.id) === gfSheetId); if (c) gfPlay(gf, c); } gfCloseSheet(); gfRender(); });
      root.addEventListener("click", (e) => {
        if (!gf) return;
        const act = e.target.closest("[data-gf]")?.dataset.gf;
        if (act === "new") { gf = gfNew(); return gfRender(); }
        if (act === "keep") { gfKeep(gf); return gfRender(); }
        if (act === "mull") { gfMulligan(gf); return gfRender(); }
        if (act === "attack") { gfAttack(gf); return gfRender(); }
        if (act === "next") { gfNextTurn(gf); return gfRender(); }
        if (act === "auto") { if (gf.phase === "main" && (gf.landPlayed || gf.bf.some((p) => p.attacked))) gfNextTurn(gf); gfAutoTurn(gf); return gfRender(); }
        if (act === "sim") { const b = e.target.closest("[data-gf]"); b.disabled = true; b.textContent = "Running…"; setTimeout(() => { gfRunSim(); b.disabled = false; b.textContent = "Run again"; }, 20); return; }
        const cardEl = e.target.closest(".gf-c");
        if (!cardEl) return;
        const id = cardEl.dataset.gfid;
        if (cardEl.closest("#gf-mhand")) { const c = gf.hand.find((x) => String(x.id) === id); if (!c || !gf.mulls) return; gf.pending.includes(c) ? (gf.pending = gf.pending.filter((x) => x !== c)) : gf.pending.length < Math.min(gf.mulls, 7) && gf.pending.push(c); return gfRender(); }
        if (cardEl.closest("#gf-hand") && isPhone()) return gfOpenSheet(id);
        if (cardEl.closest("#gf-hand, #gf-cmd")) {
          if (id === "cmd") { if (gfCanCmd(gf)) gfPlay(gf, gfCmd, true); }
          else { const c = gf.hand.find((x) => String(x.id) === id); if (c && gfCanPlay(gf, c)) gfPlay(gf, c); }
          return gfRender();
        }
        const p = gf.bf.find((x) => String(x.id) === id);
        if (p && gfSource(p) && gf.phase === "main") { p.tapped = true; gf.pool += p.makes || p.dork || 1; gfRender(); }
      });
    })();

