    // ── Deck analysis ─────────────────────────────────────────────────
    const dA = $("#deck-analysis");
    const ANALYSIS_MIN_CARDS = 60; // below this, a deck is too incomplete to judge against 100-card targets
    const LAND_TARGET = [36, 38];
    const MV_TARGET = [3.0, 3.5];
    const BASE_ROLE_TARGETS = {
      ramp: [8, 12], draw: [10, null], removal: [6, 10], wipes: [3, 5],
      tutors: [2, 8], interaction: [8, null], graveyardHate: [1, null], protection: [3, null],
    };
    const AI_TARGETS = BASE_ROLE_TARGETS;
    const AI_LABEL = {
      ramp: "Ramp", draw: "Card draw", removal: "Removal", wipes: "Board wipes",
      tutors: "Tutors", interaction: "Responsive interaction", graveyardHate: "Graveyard hate", protection: "Protection",
    };
    const ROLE_WEIGHTS = {
      ramp: 1.25, draw: 1.35, removal: 1.2, wipes: 0.75,
      tutors: 0.55, interaction: 1.0, graveyardHate: 0.45, protection: 0.75,
    };
    const DECK_STYLE_PROFILES = {
      default: {
        label: "Default",
        note: "Generic Commander defaults",
        roleTargets: BASE_ROLE_TARGETS,
        landTarget: LAND_TARGET,
        mvTarget: MV_TARGET,
        roleWeights: ROLE_WEIGHTS,
      },
      graveyard: {
        label: "Graveyard",
        note: "Values engines and recursion over generic hate",
        roleTargets: { ...BASE_ROLE_TARGETS, draw: [9, null], wipes: [1, 3], tutors: [3, 8], protection: [4, null], graveyardHate: [0, null] },
        landTarget: [35, 38],
        mvTarget: [2.9, 3.6],
        roleWeights: { ...ROLE_WEIGHTS, wipes: 0.4, graveyardHate: 0.15, protection: 0.95, tutors: 0.75 },
      },
      spellslinger: {
        label: "Spellslinger",
        note: "Rewards cheap draw and instant-speed play",
        roleTargets: { ...BASE_ROLE_TARGETS, ramp: [7, 11], draw: [11, null], wipes: [2, 4], interaction: [10, null], protection: [2, null] },
        landTarget: [34, 37],
        mvTarget: [2.6, 3.25],
        roleWeights: { ...ROLE_WEIGHTS, draw: 1.5, interaction: 1.25, wipes: 0.55 },
      },
      aristocrats: {
        label: "Aristocrats",
        note: "Allows lower wipes if the deck wins through engines",
        roleTargets: { ...BASE_ROLE_TARGETS, draw: [10, null], removal: [7, 11], wipes: [1, 3], interaction: [6, null], protection: [2, null] },
        landTarget: [35, 38],
        mvTarget: [2.8, 3.45],
        roleWeights: { ...ROLE_WEIGHTS, draw: 1.45, removal: 1.25, wipes: 0.5 },
      },
      battlecruiser: {
        label: "Battlecruiser",
        note: "Needs more mana and protection for expensive threats",
        roleTargets: { ...BASE_ROLE_TARGETS, ramp: [10, 14], draw: [10, null], interaction: [6, null], protection: [4, null] },
        landTarget: [37, 40],
        mvTarget: [3.2, 4.15],
        roleWeights: { ...ROLE_WEIGHTS, ramp: 1.55, protection: 1.05, interaction: 0.75 },
      },
      aggro: {
        label: "Aggro",
        note: "Lower curve, fewer wipes, more early pressure",
        roleTargets: { ...BASE_ROLE_TARGETS, ramp: [7, 10], draw: [9, null], removal: [7, 11], wipes: [1, 3], interaction: [6, null] },
        landTarget: [34, 37],
        mvTarget: [2.4, 3.2],
        roleWeights: { ...ROLE_WEIGHTS, removal: 1.3, wipes: 0.35, draw: 1.2 },
      },
      casual: {
        label: "Precon/Casual",
        note: "Softer targets for relaxed or upgraded-precon decks",
        roleTargets: { ...BASE_ROLE_TARGETS, ramp: [7, 11], draw: [8, null], removal: [5, 9], wipes: [2, 4], tutors: [0, 5], interaction: [5, null], protection: [2, null] },
        landTarget: [35, 39],
        mvTarget: [2.9, 3.75],
        roleWeights: { ...ROLE_WEIGHTS, tutors: 0.2, graveyardHate: 0.25 },
      },
      cedh: {
        label: "High-power",
        note: "More interaction and tutors; fewer lands can be normal",
        roleTargets: { ...BASE_ROLE_TARGETS, ramp: [10, 16], draw: [11, null], removal: [7, 11], wipes: [1, 3], tutors: [5, 12], interaction: [12, null], protection: [3, null] },
        landTarget: [28, 34],
        mvTarget: [1.8, 2.9],
        roleWeights: { ...ROLE_WEIGHTS, tutors: 1.0, interaction: 1.45, ramp: 1.35, wipes: 0.25 },
      },
    };
    // Identity is supplied by the AI review. Only tags that materially change healthy
    // Commander targets are mapped to an internal lens; every other label remains descriptive.
    const IDENTITY_TAG_LENSES = {
      "Graveyard": "graveyard", "Reanimator": "graveyard", "Dredge": "graveyard", "Sacrifice": "aristocrats", "Aristocrats": "aristocrats", "Tokens": "aristocrats", "Saprolings": "aristocrats", "Typal: Fungi": "aristocrats", "Typal: Saproling": "aristocrats",
      "Spellslinger": "spellslinger", "Storm": "spellslinger", "Burn": "spellslinger", "Wheels": "spellslinger",
      "Aggro": "aggro", "Voltron": "aggro", "Combat Damage": "aggro", "Power Matters": "aggro", "Equipment": "aggro", "Auras": "aggro", "Extra Combats": "aggro", "Infect": "aggro",
      "Battlecruiser": "battlecruiser", "Lands Matter": "battlecruiser", "Landfall": "battlecruiser", "Ramp": "battlecruiser",
      "cEDH": "cedh", "Combo": "cedh", "Turbo": "cedh", "Farm": "cedh",
      "Casual": "casual", "Budget": "casual", "Jank": "casual",
    };
    const isLandCard = (c) => cardTypes(c).has("land");

    function computeDeckStats(cards, folderId) {
      const qty = (c) => cardQty(folderId, c.id); // 1 for everything but multi-count basics
      const nonland = cards.filter((c) => !isLandCard(c));
      const curve = [0, 0, 0, 0, 0, 0, 0, 0]; // buckets 0..6, index 7 = 7+
      nonland.forEach((c) => { curve[Math.min(7, Math.max(0, Math.round(c.cmc || 0)))] += qty(c); });
      const nonlandCount = nonland.reduce((s, c) => s + qty(c), 0);
      const avgMv = nonlandCount ? nonland.reduce((s, c) => s + (c.cmc || 0) * qty(c), 0) / nonlandCount : 0;
      const price = cards.reduce((s, c) => s + (priceNum(c) || 0) * qty(c), 0);
      const typeCounts = {};
      CARD_TYPES.forEach((t) => (typeCounts[t] = 0));
      cards.forEach((c) => cardTypes(c).forEach((t) => { if (typeCounts[t] !== undefined) typeCounts[t] += qty(c); }));
      const total = cards.reduce((s, c) => s + qty(c), 0);
      return { total, lands: total - nonlandCount, curve, avgMv, price, typeCounts };
    }

    const meterStatus = (v, lo, hi) => (v < lo ? "low" : (hi != null && v > hi ? "high" : "ok"));

    // Summary tile that also carries its target + status (folds the old check meters in).
    function statTile(num, cap, value, lo, hi) {
      const hasT = lo != null && value != null;
      const stt = hasT ? meterStatus(value, lo, hi) : "";
      const tgt = hasT ? (hi != null ? `${lo}–${hi}` : `${lo}+`) : "";
      return `<div class="da-tile ${stt}"><span class="da-num">${num}</span><span class="da-cap">${cap}</span>${hasT ? `<span class="da-tgt"><span class="dot ${stt}"></span>${tgt}</span>` : ""}</div>`;
    }

    // What the dashed line targets: the finished 100-card deck's spells, or — when the view
    // is filtered to a single card type — that type's typical count in a 100-card deck.
    // Other filters (colors, text) get the selection's share of the deck's spells.
    function curveTarget(viewCards, deckCards, spellsTarget, typeTargets) {
      const spells = (list) => list.filter((c) => !isLandCard(c));
      const view = spells(viewCards);
      if (!view.length) return { n: 0, label: "" };
      const mid = (r) => Math.round((r[0] + r[1]) / 2);
      const has = (c, t) => cardTypes(c).has(t);
      const onlyType = [
        ["creature", "creatures", (c) => has(c, "creature")],
        ["spells", "instants + sorceries", (c) => has(c, "instant") || has(c, "sorcery")],
        ["artifact", "artifacts", (c) => has(c, "artifact")],
        ["enchantment", "enchantments", (c) => has(c, "enchantment")],
        ["planeswalker", "planeswalkers", (c) => has(c, "planeswalker")],
      ].find(([, , test]) => view.every(test));
      if (view.length === spells(deckCards).length) return { n: spellsTarget, label: `Target for a 100-card deck (~${spellsTarget} spells)` };
      if (onlyType) {
        const n = mid(typeTargets[onlyType[0]]);
        return { n, label: `Target for ~${n} ${onlyType[1]} in a 100-card deck` };
      }
      const n = Math.max(1, Math.round((spellsTarget * view.length) / Math.max(1, spells(deckCards).length)));
      return { n, label: `Target for this share of a 100-card deck (~${n} spells)` };
    }

    // mvOnly: when the MV chips narrow the view, only those columns are live; the rest dim.
    function curveHtml(curve, target, mvOnly = null) {
      const n = curve.reduce((a, b) => a + b, 0);
      const ideal = typicalCurve(target.n);
      const max = Math.max(1, ...curve, ...ideal);
      const peak = Math.max(...curve);
      const labels = ["0", "1", "2", "3", "4", "5", "6", "7+"];
      // Heights are a share of the track minus the count label (≈18px) above each bar.
      const h = (v) => `calc((100% - 18px) * ${(v / max).toFixed(4)})`;
      const cols = curve.map((c, i) => {
        const live = !mvOnly || mvOnly.has(i);
        const tgt = Math.round(ideal[i]);
        const over = target.n ? c - tgt : 0;
        const tip = `MV ${labels[i]}: ${c} card${c === 1 ? "" : "s"}${target.n ? ` · target ≈ ${tgt}${over >= 2 ? ` · cut ~${over}` : over <= -2 ? ` · room for ~${-over}` : ""}` : ""}`;
        return `
        <div class="curve-col${live ? "" : " dim"}" title="${live ? tip : `MV ${labels[i]}: not in the selected mana values`}">
          <span class="curve-track">
            <span class="curve-count${over >= 2 ? " over" : ""}">${c}</span>
            <span class="curve-bar ${c === peak && c > 0 ? "peak" : ""}" style="height:${h(c)}"></span>
            ${target.n && live ? `<span class="curve-ideal" style="bottom:${h(ideal[i])}"></span>` : ""}
          </span>
          <span class="curve-x">${labels[i]}</span>
        </div>`;
      }).join("");
      const legend = n
        ? `<span class="curve-legend-line"></span>${esc(target.label)} · hover a column for cuts`
        : "No nonland cards in this selection";
      return `<div class="curve">${cols}</div><div class="curve-legend">${legend}</div>`;
    }

    // A light, honest read of the curve against a typical *midrange* Commander deck.
    // Not a verdict (curve quality is archetype-specific) — the AI review judges the real plan.
    function curveReadHtml(s) {
      const n = s.curve.reduce((a, b) => a + b, 0);
      if (n < 10) return `<div class="curve-read muted"><span class="dot"></span>Add a few more cards to assess the curve.</div>`;
      const topShare = (s.curve[5] + s.curve[6] + s.curve[7]) / n; // MV 5+
      const cheapShare = (s.curve[0] + s.curve[1] + s.curve[2]) / n; // MV ≤2
      let st = "ok", msg = "Healthy midrange curve";
      if (s.avgMv >= 3.6 || topShare > 0.30) { st = "high"; msg = "Leans top-heavy — may be slow to start"; }
      else if (cheapShare < 0.25) { st = "low"; msg = "Light on cheap plays (MV ≤ 2)"; }
      else if (s.avgMv <= 2.5) { msg = "Low, aggressive curve"; }
      return `<div class="curve-read"><span class="dot ${st}"></span>${msg}</div>
        <div class="curve-note">vs a typical midrange deck — the AI review judges your actual plan.</div>`;
    }

    function typeBarHtml(typeCounts) {
      const total = CARD_TYPES.reduce((s, t) => s + typeCounts[t], 0) || 1;
      const segs = CARD_TYPES.filter((t) => typeCounts[t] > 0);
      const bar = segs.map((t) => `<span class="type-seg type-${t}" style="width:${(typeCounts[t] / total) * 100}%" title="${CARD_TYPE_LABEL[t]}: ${typeCounts[t]}"></span>`).join("");
      const legend = segs.map((t) => `<span class="type-leg"><span class="type-dot type-${t}"></span>${CARD_TYPE_LABEL[t]} ${typeCounts[t]}</span>`).join("");
      return `<div class="type-bar">${bar}</div><div class="type-legend">${legend}</div>`;
    }

    function colorCheckHtml(commander, cards) {
      if (!commander) return "";
      const ci = new Set(commander.color_identity || []);
      const pips = ["W", "U", "B", "R", "G"].filter((x) => ci.has(x));
      const pipHtml = pips.length ? pips.map((x) => `<span class="pip">${MANA_SVG[x.toLowerCase()]}</span>`).join("") : `<span class="pip-c">Colorless</span>`;
      const offenders = cards.filter((c) => c.id !== commander.id && (c.color_identity || []).some((x) => !ci.has(x)));
      const status = offenders.length ? `<span class="ci-warn">⚠ ${offenders.length} outside identity</span>` : `<span class="ci-ok">All cards on-identity</span>`;
      const list = offenders.length ? `<div class="ci-list">${offenders.slice(0, 15).map((c) => esc(c.name)).join(", ")}${offenders.length > 15 ? "…" : ""}</div>` : "";
      return `<div class="da-block da-ci"><div class="da-h">Color identity <span class="ci-pips">${pipHtml}</span></div>${status}${list}</div>`;
    }

    // ═══ Deck Analysis 2.0 helpers ═══════════════════════════════════
    const WUBRG = ["W", "U", "B", "R", "G"];
    const COLOR_FULL = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
    const STATUS_COLOR = { ok: "#16A34A", low: "#D97706", high: "#DC2626" };
    const BRACKET_NAMES = { 1: "Exhibition", 2: "Core", 3: "Upgraded", 4: "Optimized", 5: "cEDH" };
    const GRADE_SCALE = [[0.92, "A"], [0.85, "A−"], [0.78, "B+"], [0.70, "B"], [0.62, "B−"], [0.54, "C+"], [0.45, "C"], [0.32, "C−"], [0, "D"]];
    // WUBRG-ordered color-combo names (guilds / shards / wedges / nephilim / 5c).
    const COLOR_COMBO_NAMES = {
      "": "Colorless", W: "Mono-White", U: "Mono-Blue", B: "Mono-Black", R: "Mono-Red", G: "Mono-Green",
      WU: "Azorius", WB: "Orzhov", WR: "Boros", WG: "Selesnya", UB: "Dimir", UR: "Izzet", UG: "Simic", BR: "Rakdos", BG: "Golgari", RG: "Gruul",
      WUB: "Esper", WUR: "Jeskai", WUG: "Bant", WBR: "Mardu", WBG: "Abzan", WRG: "Naya", UBR: "Grixis", UBG: "Sultai", URG: "Temur", BRG: "Jund",
      WUBR: "Yore-Tiller", WUBG: "Witch-Maw", WURG: "Ink-Treader", WBRG: "Dune-Brood", UBRG: "Glint-Eye", WUBRG: "Five-Color",
    };
    function colorComboName(colors) { const k = WUBRG.filter((c) => colors.includes(c)).join(""); return COLOR_COMBO_NAMES[k] || k || "Colorless"; }
    function deckColors(cards, commander) {
      if (commander && Array.isArray(commander.color_identity)) return commander.color_identity.slice();
      const s = new Set(); cards.forEach((c) => (c.color_identity || []).forEach((x) => s.add(x))); return [...s];
    }
    function manaPipsHtml(colors) { return `<span class="da2-pips">${WUBRG.filter((c) => colors.includes(c)).map((c) => `<span class="da2-pip da2-sb-${c.toLowerCase()}">${MANA_SVG[c.toLowerCase()]}</span>`).join("")}</span>`; }
    // A deck is rarely a single archetype — blend the profiles of every archetype its
    // tags imply into one composite lens: targets are averaged, weights taken at their max
    // (so if any archetype leans hard on a role, the blended lens still cares about it).
    function identityLensKeys(tags) {
      return [...new Set((tags || []).map((tag) => IDENTITY_TAG_LENSES[tag]).filter((k) => k && k !== "default"))];
    }
    function blendProfiles(tags) {
      const lensKeys = [...new Set((tags || [])
        .map((tag) => IDENTITY_TAG_LENSES[tag])
        .filter((k) => k && DECK_STYLE_PROFILES[k] && k !== "default"))];
      if (!lensKeys.length) return DECK_STYLE_PROFILES.default;
      const profiles = lensKeys.map((k) => DECK_STYLE_PROFILES[k]);
      const label = lensKeys.map((k) => DECK_STYLE_PROFILES[k].label).join(" + ");
      if (profiles.length === 1) return { ...profiles[0], label };
      const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const blendRange = (field, decimals) => {
        const lo = avg(profiles.map((p) => p[field][0]));
        const open = profiles.some((p) => p[field][1] == null);
        const hi = open ? null : avg(profiles.map((p) => p[field][1]));
        const r = (x) => (decimals ? Math.round(x * 10) / 10 : Math.round(x));
        return [r(lo), hi == null ? null : r(hi)];
      };
      const roleTargets = {};
      Object.keys(BASE_ROLE_TARGETS).forEach((role) => {
        const ranges = profiles.map((p) => (p.roleTargets || BASE_ROLE_TARGETS)[role]);
        const hiOpen = ranges.some((t) => t[1] == null);
        roleTargets[role] = [Math.round(avg(ranges.map((t) => t[0]))), hiOpen ? null : Math.round(avg(ranges.map((t) => t[1])))];
      });
      const roleWeights = {};
      Object.keys(ROLE_WEIGHTS).forEach((role) => {
        roleWeights[role] = Math.max(...profiles.map((p) => (p.roleWeights || ROLE_WEIGHTS)[role] || 0));
      });
      return {
        label,
        note: `Blended from ${profiles.length} archetypes`,
        roleTargets,
        roleWeights,
        landTarget: blendRange("landTarget", false),
        mvTarget: blendRange("mvTarget", true),
      };
    }
    function effectiveDeckProfile(identityTags = []) {
      return blendProfiles(identityTags);
    }
    function deckIdentityHtml(identityTags, analyzed) {
      if (!analyzed) return "";
      const chips = identityTags.length
        ? identityTags.map((tag) => `<span class="da2-tag-chip">${esc(tag)}</span>`).join("")
        : `<span class="da2-tag-chip"><span>No clear identity returned</span></span>`;
      return `<div class="da2-tags"><span class="da2-tags-label">Deck identity</span>${chips}<span class="da2-approx">AI-derived</span></div>`;
    }

    function cardProduces(card) {
      if (Array.isArray(card.produced_mana)) return card.produced_mana;
      if (Array.isArray(card.card_faces)) { const s = new Set(); card.card_faces.forEach((f) => (f.produced_mana || []).forEach((m) => s.add(m))); return [...s]; }
      return [];
    }
    function cardManaCost(card) {
      if (card.mana_cost) return card.mana_cost;
      if (Array.isArray(card.card_faces)) return card.card_faces.map((f) => f.mana_cost || "").join("");
      return "";
    }
    function coloredPipCounts(card) {
      const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
      (cardManaCost(card).match(/\{[^}]+\}/g) || []).forEach((sym) => {
        WUBRG.forEach((col) => { if (sym.includes(col)) pips[col] += 1; });
      });
      return pips;
    }

    // Per color: weighted sources you have vs. what pip-demand suggests you need.
    // Lands count most; mana rocks/dorks count, but less because they need a setup turn.
    function colorSourceStats(cards, folderId, colors) {
      const have = { W: 0, U: 0, B: 0, R: 0, G: 0 }, rawHave = { W: 0, U: 0, B: 0, R: 0, G: 0 };
      const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 }, earlyPips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
      let lands = 0;
      cards.forEach((c) => {
        const q = cardQty(folderId, c.id);
        const isLand = isLandCard(c);
        if (isLand) lands += q;
        const oracle = getOracleText(c);
        const isFetchLand = isLand && /search your library for (a|an).*land|search your library for.*basic land/i.test(oracle);
        const sourceWeight = isLand
          ? (isFetchLand ? 0.7 : (/enters? the battlefield tapped|enters? tapped/i.test(oracle) ? 0.85 : 1))
          : 0.55;
        const produced = new Set(cardProduces(c));
        if (isFetchLand) colors.forEach((m) => produced.add(m));
        produced.forEach((m) => {
          if (have[m] !== undefined) {
            rawHave[m] += q;
            have[m] += q * sourceWeight;
          }
        });
        if (!isLand) {
          const cps = coloredPipCounts(c);
          WUBRG.forEach((col) => {
            pips[col] += cps[col] * q;
            if ((c.cmc || 0) <= 2) earlyPips[col] += cps[col] * q;
          });
        }
      });
      const totalPips = WUBRG.reduce((s, c) => s + pips[c], 0) || 1;
      return WUBRG.filter((c) => colors.includes(c)).map((c) => {
        const share = pips[c] / totalPips;
        const splash = share > 0 && share < 0.16 && earlyPips[c] <= 1;
        const baseNeed = Math.round(lands * (0.12 + share * 0.5));
        const earlyNeed = earlyPips[c] >= 8 ? 3 : (earlyPips[c] >= 4 ? 2 : (earlyPips[c] >= 2 ? 1 : 0));
        const floor = pips[c] > 0 ? (splash ? 3 : 5) : 0;
        const need = Math.max(floor, baseNeed + earlyNeed);
        const weightedHave = Math.round(have[c] * 10) / 10;
        const status = weightedHave >= need ? "ok" : (weightedHave >= need - 2 ? "low" : "high");
        return { c, have: weightedHave, rawHave: rawHave[c], need, status, pips: pips[c], earlyPips: earlyPips[c], splash };
      });
    }
    const ROLE_KEYS = ["ramp", "draw", "removal", "wipes", "tutors", "interaction", "graveyardHate", "protection"];
    // oracle_id (or the front face's, for a DFC) — the key both the profile store and the
    // deck-profiles API index by.
    function cardOracleId(card) { return card?.oracle_id || card?.card_faces?.[0]?.oracle_id || null; }

    // The ledger intentionally keeps the heuristic's card-level evidence, even after an AI
    // review refines a count. That makes the AI adjustment visible rather than opaque.
    function classifyRoleCard(c) {
      const tl = (c.type_line || "").toLowerCase();
      const ot = getOracleText(c).toLowerCase();
      const isLand = tl.includes("land");
      const isInstant = tl.includes("instant") || /\bflash\b|cast .* as though .* flash|activate only as an instant/.test(ot);
      const isActivatedAnswer = !tl.includes("sorcery") && /\}[^\n]*:\s*(destroy|exile|return|counter)/.test(ot);
      const removal = /destroy target|exile target|return target .*to (its|their) owner|put target .* on (the top|bottom) of|deals? \d+ damage to (target|any target)|fights? target|target creature gets -|counter target activated|counter target triggered|counter target spell/.test(ot);
      const massRemoval = /(?:destroy|exile|return) all (creatures|nonland permanents|artifacts|enchantments)|(?:destroy|exile) each (creature|nonland permanent)|deals? \d+ damage to each (other )?creature|deals? damage equal to .* to each (other )?creature|all creatures get -|each player sacrifices (all|two|three|\d+)|sacrifice all/.test(ot);
      const friendlyMassEffect = /(exile|return|phase out) (each|all|any number of) creatures? you control/.test(ot);
      const setupDependent = /\bsacrifice\b|\btoken\b|combat damage|\battacks?\b|\bdies\b|whenever (another |a )?creature|if .* died|each player draws|exile.*graveyard/.test(ot);
      const roles = {};
      const add = (role, conditional = false, note = "", extra = {}) => { roles[role] = { conditional, note, ...extra }; };
      if (!isLand && (/\badd \{/.test(ot) || /whenever .* add \{/.test(ot) || /mana of any (one )?color/.test(ot) || /search your library for .*\bland\b/.test(ot) || /put .*\bland[s]?\b.*onto the battlefield/.test(ot) || /lands? you control.*add[s]? an additional/.test(ot) || /treasure token/.test(ot))) add("ramp", setupDependent, setupDependent ? "Setup or one-shot mana" : "Reliable mana source");
      if (/draw (a|one|two|three|four|x|\w+) cards?/.test(ot) || /whenever .*draw a card/.test(ot) || /you may play .*from (the top of|your graveyard)/.test(ot) || /look at the top card .* you may (cast|play)/.test(ot)) add("draw", setupDependent, setupDependent ? "Needs board state or setup" : "Direct card access");
      if (removal) add("removal", false, "Opponent-facing answer", { instant: isInstant, targets: [...removalTargetTypes(ot)] });
      if (massRemoval && !friendlyMassEffect) add("wipes", false, "Mass removal");
      if (/search your library for (a|an|up to)/.test(ot) && !/basic land/.test(ot)) add("tutors", false, "Finds a specific card");
      if (removal && (isInstant || isActivatedAnswer) || /counter target spell|counter target activated|counter target triggered/.test(ot)) add("interaction", false, "Reactive opponent-facing answer");
      if (/exile.*graveyard|graveyard.*exile|from a graveyard|can't leave graveyards|cards in graveyards can't|graveyards? are exiled/.test(ot)) add("graveyardHate", false, "Disrupts graveyards");
      if (/hexproof|indestructible|protection from|\bward\b|\bshroud\b|can't be countered|phase out|prevent all damage|regenerate|can't lose the game|return .* you control .* to (its|their) owner's hand/.test(ot)) add("protection", false, "Protects your board or commander");
      return roles;
    }

    // AI card profiles are canonical when available (fixes flicker counted as removal,
    // "draw cards equal to …" missed, narrow win-condition text matching); a card with no
    // profile falls back to the rule-based classifier. `profiles` is keyed by oracle id.
    function detectRoleDetails(cards, folderId, profiles = null) {
      const details = Object.fromEntries(ROLE_KEYS.map((key) => [key, { count: 0, cards: [] }]));
      cards.forEach((c) => {
        if (isBasicLand(c)) return;
        const q = cardQty(folderId, c.id);
        const profile = profiles ? profiles[cardOracleId(c)] : null;
        const roles = profile ? rolesFromProfile(c, profile) : classifyRoleCard(c);
        const source = profile ? "ai" : "rules";
        Object.entries(roles).forEach(([role, meta]) => {
          details[role].count += q;
          details[role].cards.push({ name: c.name, qty: q, cmc: Number(c.cmc || 0), source, ...meta });
        });
      });
      return details;
    }

    function countsFromRoleDetails(details) {
      return Object.fromEntries(ROLE_KEYS.map((key) => [key, details[key].count]));
    }

    function detectRoles(cards, folderId) { return countsFromRoleDetails(detectRoleDetails(cards, folderId)); }

    function cardFlowStats(details) {
      const out = { total: 0, early: 0, conditional: 0, late: 0 };
      (details.draw?.cards || []).forEach((card) => {
        out.total += card.qty;
        if (card.conditional) out.conditional += card.qty;
        else if (card.cmc <= 3) out.early += card.qty;
        else out.late += card.qty;
      });
      return out;
    }
    function detectMassLandDenial(cards) {
      return cards.some((c) => /destroy all lands|each player sacrifices? (a|all|two|three|\w+) lands?|destroy target land.*for each/.test(getOracleText(c).toLowerCase()));
    }
    // Only cards that actively END the game in your favor. "can't lose the game"
    // (Platinum Angel, Cloudsteel Kirin) is protection/stall, and "you lose the game"
    // is a drawback (Demonic Pact) — neither is a win condition. Union of the text match
    // (narrow — only literal "win/lose the game" phrasing) and any profiled card tagged
    // wincon (broader — the AI judges by function, e.g. infinite-damage or mill-out combos).
    function detectWinCons(cards, profiles = null) {
      const names = [];
      cards.forEach((c) => {
        if (isBasicLand(c)) return;
        const profile = profiles ? profiles[cardOracleId(c)] : null;
        const textMatch = /you win the game|wins the game|each opponent loses the game|target player loses the game/.test(getOracleText(c).toLowerCase());
        if (textMatch || isWincon(profile)) names.push(c.name);
      });
      return [...new Set(names)];
    }

    function fmtScoreNum(n) {
      return Number.isInteger(n) ? String(n) : Number(n).toFixed(1);
    }
    function targetLabel(lo, hi) {
      if ((lo === 0 || lo == null) && hi != null) return `<=${fmtScoreNum(hi)}`;
      return hi != null ? `${fmtScoreNum(lo)}-${fmtScoreNum(hi)}` : `${fmtScoreNum(lo)}+`;
    }
    function scoreCheck(value, lo, hi) {
      if (lo != null && value < lo) {
        const score = lo ? Math.max(0, value / lo) : 1;
        return { score, status: "low", pass: false, severity: score < 0.5 ? "critical" : (score < 0.75 ? "major" : "minor") };
      }
      if (hi != null && value > hi) {
        const overBy = value - hi;
        const score = Math.max(0, 1 - overBy / Math.max(4, hi * 0.35));
        return { score, status: "high", pass: false, severity: score < 0.65 ? "major" : "minor" };
      }
      return { score: 1, status: "ok", pass: true, severity: "ok" };
    }
    function computeGrade(counts, sources, s, profile = DECK_STYLE_PROFILES.default) {
      const items = [];
      const add = ({ group, key, label, value, lo, hi, weight, valueLabel, note }) => {
        const result = scoreCheck(value, lo, hi);
        items.push({
          group, key, label, value, lo, hi, weight, status: result.status, severity: result.severity, pass: result.pass,
          score: result.score, valueLabel: valueLabel || fmtScoreNum(value), target: targetLabel(lo, hi),
          note: note || (result.pass ? "On target" : (result.status === "low" ? `Short by ${fmtScoreNum(lo - value)}` : `Above target by ${fmtScoreNum(value - hi)}`)),
        });
      };
      add({ group: "Core", key: "lands", label: "Lands", value: s.lands, lo: profile.landTarget[0], hi: profile.landTarget[1], weight: 1.6, note: "Main deck mana base" });
      add({ group: "Core", key: "curve", label: "Average MV", value: s.avgMv, lo: 0, hi: profile.mvTarget[1], weight: 0.8, valueLabel: s.avgMv.toFixed(1), note: "Curve pressure, not power level" });
      sources.forEach((src) => {
        if (src.need <= 0) return;
        const colorName = COLOR_FULL[src.c];
        add({
          group: "Core", key: `source-${src.c}`, label: `${colorName} sources`,
          value: src.have, lo: src.need, hi: null, weight: src.splash ? 0.65 : 1.1,
          valueLabel: fmtScoreNum(src.have),
          note: src.splash ? "Light splash allowance" : `${src.earlyPips || 0} early pip${src.earlyPips === 1 ? "" : "s"} considered`,
        });
      });
      const targets = profile.roleTargets || BASE_ROLE_TARGETS;
      const weights = profile.roleWeights || ROLE_WEIGHTS;
      Object.keys(targets).forEach((k) => {
        const [lo, hi] = targets[k];
        const group = ["ramp", "draw", "removal", "interaction"].includes(k) ? "Core roles" : "Support roles";
        add({ group, key: k, label: AI_LABEL[k], value: counts[k] || 0, lo, hi, weight: weights[k] || 0.6 });
      });
      const totalWeight = items.reduce((sum, item) => sum + item.weight, 0) || 1;
      const rawPct = items.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;
      const critical = items.filter((item) => item.severity === "critical" && item.weight >= 0.7).length;
      const majorCore = items.filter((item) => item.severity === "major" && item.weight >= 1).length;
      let pct = rawPct - critical * 0.045 - majorCore * 0.03;
      if (critical >= 2 && majorCore >= 1) pct = Math.min(pct, 0.74);
      else if (critical >= 2) pct = Math.min(pct, 0.78);
      pct = Math.max(0, Math.min(1, pct));
      const passed = items.filter((item) => item.pass).length;
      return {
        letter: GRADE_SCALE.find((g) => pct >= g[0])[1],
        passed,
        total: items.length,
        pct,
        score: Math.round(pct * 100),
        rawScore: Math.round(rawPct * 100),
        items,
        profileLabel: profile.label,
        profileNote: profile.note,
      };
    }
    function gradeTone(letter) {
      const first = String(letter || "").charAt(0);
      if (first === "A") return "grade-a";
      if (first === "B") return "grade-b";
      if (first === "C") return "grade-c";
      return "grade-d";
    }

    // ═══ Analysis UI helpers (pure) ═══════════════════════════════════
    // No DOM, no dependency on anything outside this block — evaluated in isolation by
    // scripts/check-analysis-ui.mjs. Two groups: role-source mapping (getOracleText through
    // isWincon), consumed by detectRoleDetails/detectWinCons; and grade-item formatting
    // (severityRank through chipGroups), consumed by the summary sentence and chip rows.
    // @testable analysis-helpers begin
    function getOracleText(card) {
      if (card.oracle_text) return card.oracle_text;
      if (card.card_faces) return card.card_faces.map((f) => f.oracle_text || "").join("\n---\n");
      return "";
    }
    const REMOVAL_TARGET_TYPES = ["creature", "artifact", "enchantment", "planeswalker"];
    // Scans every "target ..." clause (a fixed window after each occurrence, not a single
    // greedy regex) so compound phrasing like "target creature or planeswalker" or
    // "target artifact, creature, or enchantment" still finds every type named.
    function removalTargetTypes(ot) {
      const types = new Set();
      let from = 0;
      for (let i = ot.indexOf("target ", from); i >= 0; i = ot.indexOf("target ", from)) {
        const window = ot.slice(i, i + 60);
        if (/\bpermanent\b/.test(window)) REMOVAL_TARGET_TYPES.forEach((t) => types.add(t));
        else REMOVAL_TARGET_TYPES.forEach((t) => { if (new RegExp(`\\b${t}\\b`).test(window)) types.add(t); });
        from = i + 7;
      }
      if (/\bany target\b/.test(ot)) types.add("creature");
      return types;
    }
    // Maps an AI card profile (lib/profiles.js MECHANICS tags) to the same role shape
    // classifyRoleCard returns, so detectRoleDetails can use either source interchangeably.
    // Instant-speed / removal-target detection still reads the card itself (mirrors
    // classifyRoleCard's checks) since the profile carries no type line or rules text.
    function rolesFromProfile(card, profile) {
      const mechanics = new Set(Array.isArray(profile?.mechanics) ? profile.mechanics : []);
      const tl = (card?.type_line || "").toLowerCase();
      const ot = getOracleText(card || {}).toLowerCase();
      const isInstant = tl.includes("instant") || /\bflash\b|cast .* as though .* flash|activate only as an instant/.test(ot);
      const isActivatedAnswer = !tl.includes("sorcery") && /\}[^\n]*:\s*(destroy|exile|return|counter)/.test(ot);
      const roles = {};
      const add = (role, extra = {}) => { roles[role] = { conditional: false, note: profile?.summary || "", ...extra }; };
      if (mechanics.has("ramp") || mechanics.has("fast-mana")) add("ramp");
      if (mechanics.has("card-draw")) add("draw");
      const isRemoval = mechanics.has("spot-removal") || mechanics.has("bounce");
      if (isRemoval) add("removal", { instant: isInstant, targets: [...removalTargetTypes(ot)] });
      if (mechanics.has("board-wipe")) add("wipes");
      if (mechanics.has("tutor")) add("tutors");
      if (mechanics.has("counterspell") || (isRemoval && (isInstant || isActivatedAnswer))) add("interaction");
      if (mechanics.has("graveyard-hate")) add("graveyardHate");
      if (mechanics.has("protection")) add("protection");
      return roles;
    }
    function isWincon(profile) {
      return Boolean(profile && Array.isArray(profile.mechanics) && profile.mechanics.includes("wincon"));
    }
    function severityRank(sev) { return sev === "critical" ? 0 : (sev === "major" ? 1 : 2); }
    function sortWorstFirst(items) {
      return [...items].sort((a, b) => a.score - b.score || severityRank(a.severity) - severityRank(b.severity));
    }
    function fmtGapNum(n) { return Number.isInteger(n) ? String(n) : Number(n).toFixed(1); }
    // One sentence naming the worst gaps, e.g. "In progress — 12 cards to go. Biggest gaps:
    // Lands 30/36, Ramp 5/8, Interaction 3/8." Replaced by the AI verdict once cached.
    function gapSummary(items, { total, maxGaps = 3 } = {}) {
      const failing = sortWorstFirst(items.filter((it) => !it.pass));
      const inProgress = typeof total === "number" && total < 90;
      const prefix = inProgress ? `In progress — ${100 - total} cards to go. ` : "";
      if (!failing.length) return `${prefix}On target across the board.`;
      const bits = failing.slice(0, maxGaps).map((it) => `${it.label} ${it.valueLabel}/${fmtGapNum(it.status === "high" ? it.hi : it.lo)}`);
      return `${prefix}Biggest gaps: ${bits.join(", ")}.`;
    }
    // Splits grade items into "needs attention" (failing, worst first) and "on target"
    // (passing) chips. The five per-color source items collapse into a single chip in
    // each group, since five near-identical "1/5 Short" rows was the redundancy to cut.
    function chipGroups(items) {
      const isColorKey = (key) => typeof key === "string" && key.startsWith("source-");
      const colorItems = items.filter((it) => isColorKey(it.key));
      const otherItems = items.filter((it) => !isColorKey(it.key));
      const withText = (it) => ({
        ...it,
        text: it.pass ? `${it.label} ${it.valueLabel}` : `${it.label} ${it.valueLabel}/${fmtGapNum(it.status === "high" ? it.hi : it.lo)}`,
      });
      const attention = sortWorstFirst(otherItems.filter((it) => !it.pass)).map(withText);
      const onTarget = otherItems.filter((it) => it.pass).map(withText);
      if (colorItems.length) {
        const order = ["W", "U", "B", "R", "G"];
        const shortColors = order.filter((c) => colorItems.some((it) => it.key === `source-${c}` && !it.pass));
        if (shortColors.length) attention.push({ key: "colors", label: "Colors", pass: false, text: `Colors short: ${shortColors.join(" ")}` });
        else onTarget.push({ key: "colors", label: "Colors", pass: true, text: "Colors OK" });
      }
      return { attention, onTarget };
    }

    // ── Opening-hand odds (hypergeometric) ──────────────────────────────
    // Exact hypergeometric via log-factorials, so C(99, k)-scale terms never overflow.
    function logFactorial(n) {
      let s = 0;
      for (let i = 2; i <= n; i++) s += Math.log(i);
      return s;
    }
    function logChoose(n, k) {
      if (k < 0 || k > n || n < 0) return -Infinity;
      return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
    }
    // P(X ≥ k) drawing n cards from a population of N with K successes, no replacement.
    function hypergeomAtLeast(N, K, n, k) {
      if (k <= 0) return 1;
      const maxK = Math.min(n, K);
      if (k > maxK) return 0;
      const logDenom = logChoose(N, n);
      let p = 0;
      for (let i = k; i <= maxK; i++) p += Math.exp(logChoose(K, i) + logChoose(N - K, n - i) - logDenom);
      return Math.min(1, Math.max(0, p));
    }
    // Opening-hand odds for a library of size N with K_L lands and K_R ramp pieces (both
    // quantity-weighted, commander excluded), on the play. commanderMv, when given, is the
    // commander's mana value — commanderOnCurve is an approximation that pools lands + ramp
    // into one "mana source" count, since a ramp piece isn't literally a land.
    function openingHandOdds({ N, lands, ramp, commanderMv }) {
      const out = {
        landsIn7: hypergeomAtLeast(N, lands, 7, 3),
        keepableLands: Math.max(0, hypergeomAtLeast(N, lands, 7, 2) - hypergeomAtLeast(N, lands, 7, 6)),
        rampByT2: hypergeomAtLeast(N, ramp, 8, 1), // opening 7 + the turn-2 draw on the play
      };
      const mv = Math.round(commanderMv); // a fractional mv (average of split costs etc.) doesn't map to a turn
      if (mv >= 1) {
        const seenBy = 7 + (mv - 1);
        out.commanderOnCurve = hypergeomAtLeast(N, lands + ramp, seenBy, mv);
      }
      return out;
    }
    // Typical Commander nonland curve (MV 0..6, 7+) for a ~63-spell midrange deck —
    // avg MV ≈ 3.1. Stored as shares so it scales to any selection (e.g. just creatures).
    const TYPICAL_CURVE = [1, 10, 15, 14, 10, 7, 4, 2];
    function typicalCurve(n) {
      const total = TYPICAL_CURVE.reduce((a, b) => a + b, 0);
      return TYPICAL_CURVE.map((v) => (v / total) * n);
    }
    // Typical card-type counts for a 100-card Commander deck — the Commander version of a
    // prerelease "15–18 creatures, 17 lands" sheet. Archetypes shift them (see typeTargetsFor).
    const TYPE_TARGETS = { creature: [25, 30], spells: [10, 15], artifact: [5, 10], enchantment: [3, 8], planeswalker: [0, 3] };
    const TYPE_TARGET_OVERRIDES = {
      spellslinger: { creature: [8, 15], spells: [25, 35] },
      aggro: { creature: [30, 38], spells: [8, 14] },
      aristocrats: { creature: [28, 35] },
      battlecruiser: { creature: [22, 30] },
      cedh: { creature: [10, 20], spells: [20, 30], artifact: [8, 15] },
    };
    // Averages the ranges of every archetype lens the deck's tags map to (like blendProfiles).
    function typeTargetsFor(lensKeys = []) {
      const lenses = lensKeys.filter((k) => TYPE_TARGET_OVERRIDES[k]);
      const out = {};
      Object.keys(TYPE_TARGETS).forEach((t) => {
        const ranges = lenses.length ? lenses.map((k) => TYPE_TARGET_OVERRIDES[k][t] || TYPE_TARGETS[t]) : [TYPE_TARGETS[t]];
        const avg = (i) => Math.round(ranges.reduce((s, r) => s + r[i], 0) / ranges.length);
        out[t] = [avg(0), avg(1)];
      });
      return out;
    }
    // Splits n basic lands across colors by their share of colored mana symbols (largest
    // remainder, so the parts always add up to n). Colors with no symbols get none.
    function suggestBasicSplit(pips, n) {
      const cols = Object.keys(pips).filter((c) => pips[c] > 0);
      const total = cols.reduce((s, c) => s + pips[c], 0);
      const out = {};
      if (!total || n <= 0) return out;
      const raw = cols.map((c) => ({ c, v: (pips[c] / total) * n }));
      raw.forEach((r) => { out[r.c] = Math.floor(r.v); });
      let left = n - raw.reduce((s, r) => s + out[r.c], 0);
      raw.sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)) || pips[b.c] - pips[a.c]);
      for (let i = 0; left > 0; i = (i + 1) % raw.length, left--) out[raw[i].c] += 1;
      return out;
    }
    // Trim planner: per category, how a >100-card pool compares with the final deck's
    // targets. Categories overlap (a ramp creature counts twice), so the per-row cuts are
    // guidance; the headline is total - 100. hi == null means "no upper limit" (never cut).
    function trimBudget(rows, total) {
      const out = rows.map((r) => {
        const cut = r.hi != null && r.have > r.hi ? r.have - r.hi : 0;
        const add = r.have < r.lo ? r.lo - r.have : 0;
        return { ...r, action: cut ? "cut" : add ? "add" : "ok", n: cut || add };
      });
      const rank = { cut: 0, add: 1, ok: 2 };
      out.sort((a, b) => rank[a.action] - rank[b.action] || b.n - a.n);
      return { toCut: Math.max(0, total - 100), rows: out };
    }
    // Keep-score for ranking cut candidates (higher = keep). EDHREC inclusion (0..1) and
    // synergy (-1..1) for this commander when known, a bonus per extra role the card fills,
    // and a small mana-value penalty (a pricier card doing the same job cuts first).
    function cutKeepScore({ inclusion = null, synergy = 0, roles = 0, cmc = 0 }) {
      return (inclusion == null ? 0.15 : inclusion) * 60 + synergy * 25 + Math.max(0, roles - 1) * 10 - cmc * 2.5;
    }
    // Scales a count from an N-card library to a 99-card one (projected odds for a pool).
    function projectTo99(count, N) {
      return N > 99 ? Math.round((count * 99) / N) : count;
    }
    // ── Turns 1–5 simulator (Monte Carlo) ─────────────────────────────
    // Plays the first `turns` turns of `trials` random games on the play: one land per turn
    // when the hand has one, then casts ramp greedily (cheapest first); every ramp piece
    // (rock, dork, land-fetch spell) adds one mana from the next turn.
    // `library` items: { land: bool, ramp: bool, cmc: number }.
    function simulateTurns({ library, commanderMv = 0, trials = 4000, turns = 5, rng = Math.random, spells = [] }) {
      // library items: { land, ramp, cmc, produces?: ["U","R"], tapped?: bool }.
      // spells: cheap-spell colour requirements { cmc, req: { U: 2, R: 1 } } to test on curve.
      const COLORS = ["W", "U", "B", "R", "G"];
      const out = {
        trials, avgMana: Array(turns).fill(0), commanderOnCurve: null, commanderByNext: null, missedDrop: 0, avgLandsT5: 0,
        colorByT2: {}, doubleByT3: {}, spellsOnCurve: null,
      };
      COLORS.forEach((c) => { out.colorByT2[c] = 0; out.doubleByT3[c] = 0; });
      if (!library.length) return out;
      const mv = Math.round(commanderMv);
      const cheap = spells.filter((s) => s.cmc >= 1 && s.cmc <= turns);
      let onCurve = 0, byNext = 0, spellHits = 0;
      const deck = library.slice();
      for (let t = 0; t < trials; t++) {
        // (A >99-card pool needs no down-sampling: the first cards of a shuffled pool are
        // distributed like the first cards of a random 99-card deck drawn from it.)
        const need = Math.min(deck.length, 7 + turns);
        for (let i = 0; i < need; i++) {
          const j = i + Math.floor(rng() * (deck.length - i));
          [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        const hand = deck.slice(0, 7);
        let next = 7, ramp = 0, pendingRamp = 0, missed = false, castTurn = null;
        const ready = []; // lands usable this turn
        let entering = null; // a tapped land played this turn — usable from the next
        const perTurn = []; // { mana, sources } after each turn's land drop
        for (let turn = 1; turn <= turns; turn++) {
          if (turn > 1 && next < deck.length) hand.push(deck[next++]);
          ramp += pendingRamp; pendingRamp = 0;
          if (entering) { ready.push(entering); entering = null; }
          // Prefer an untapped land when there's a choice.
          let li = hand.findIndex((c) => c.land && !c.tapped);
          if (li < 0) li = hand.findIndex((c) => c.land);
          if (li >= 0) {
            const land = hand.splice(li, 1)[0];
            if (land.tapped) entering = land; else ready.push(land);
          } else if (turn <= 4) missed = true;
          const available = ready.length + ramp;
          const sources = {};
          COLORS.forEach((c) => { sources[c] = 0; });
          ready.forEach((l) => (l.produces || []).forEach((c) => { if (c in sources) sources[c]++; }));
          perTurn.push({ mana: available, sources });
          out.avgMana[turn - 1] += available;
          if (castTurn == null && mv > 0 && available >= mv) castTurn = turn;
          let spend = available;
          hand.filter((c) => c.ramp && !c.land).sort((a, b) => a.cmc - b.cmc).forEach((c) => {
            if (c.cmc <= spend) { spend -= c.cmc; pendingRamp++; hand.splice(hand.indexOf(c), 1); }
          });
        }
        if (castTurn != null && castTurn <= mv) onCurve++;
        if (castTurn != null && castTurn <= mv + 1) byNext++;
        if (missed) out.missedDrop++;
        out.avgLandsT5 += ready.length + (entering ? 1 : 0);
        if (turns >= 2) COLORS.forEach((c) => { if (perTurn[1].sources[c] >= 1) out.colorByT2[c]++; });
        if (turns >= 3) COLORS.forEach((c) => { if (perTurn[2].sources[c] >= 2) out.doubleByT3[c]++; });
        // Could each cheap spell be cast on the turn matching its mana value?
        for (const sp of cheap) {
          const st = perTurn[sp.cmc - 1];
          if (st.mana >= sp.cmc && Object.entries(sp.req).every(([c, n]) => st.sources[c] >= n)) spellHits++;
        }
      }
      out.avgMana = out.avgMana.map((m) => m / trials);
      out.missedDrop /= trials;
      out.avgLandsT5 /= trials;
      COLORS.forEach((c) => { out.colorByT2[c] /= trials; out.doubleByT3[c] /= trials; });
      if (cheap.length) out.spellsOnCurve = spellHits / (trials * cheap.length);
      if (mv > 0 && mv <= turns) out.commanderOnCurve = onCurve / trials;
      if (mv > 0 && mv + 1 <= turns) out.commanderByNext = byNext / trials;
      return out;
    }

    // Whether a land usually enters tapped in the early turns. Shocklands ("If you don't,
    // it enters tapped") count as untapped — you pay the life. Check/fast lands ("unless you
    // control…") are untapped early; slow lands (need two or more other lands) are tapped early.
    function landEntersTapped(oracle) {
      const t = String(oracle || "").toLowerCase();
      if (!/enters (the battlefield )?tapped/.test(t)) return false;
      if (/if you don't, (it|this land) enters (the battlefield )?tapped/.test(t)) return false;
      if (/unless you control two or more other lands/.test(t)) return true;
      if (/unless/.test(t)) return false;
      return true;
    }

    // Supply vs demand per colour: each colour's share of the deck's coloured mana symbols
    // next to its share of the lands' colour sources. A gap of 8+ points is flagged.
    function colorBalance({ pips, landSources }) {
      const cols = Object.keys(pips).filter((c) => pips[c] > 0 || landSources[c] > 0);
      const pipTotal = cols.reduce((s, c) => s + (pips[c] || 0), 0) || 1;
      const srcTotal = cols.reduce((s, c) => s + (landSources[c] || 0), 0) || 1;
      return cols.map((c) => {
        const pipShare = (pips[c] || 0) / pipTotal;
        const srcShare = (landSources[c] || 0) / srcTotal;
        const delta = srcShare - pipShare;
        return { c, pips: pips[c] || 0, sources: landSources[c] || 0, pipShare, srcShare, delta, status: delta <= -0.08 ? "short" : delta >= 0.08 ? "over" : "ok" };
      }).sort((a, b) => b.pipShare - a.pipShare);
    }

    // Lands to cut for a better colour mix: the ones whose colours lean most toward the
    // over-supplied side, tapped lands first. Lands that make any colour are never cut.
    function suggestLandCuts(lands, balance, max = 5) {
      const byColor = Object.fromEntries(balance.map((b) => [b.c, b.delta]));
      return lands
        .filter((l) => l.produces.length > 0 && l.produces.length < 5)
        .map((l) => ({ ...l, score: l.produces.reduce((s, c) => s + (byColor[c] || 0), 0) / l.produces.length + (l.tapped ? 0.03 : 0) }))
        .filter((l) => l.score > 0.02)
        .sort((a, b) => b.score - a.score)
        .slice(0, max);
    }

    // Pairs each land cut with an in-budget replacement that makes the short colours.
    // Budget per swap: up to 1.5x the cut's price + €1; owned lands and basics count as
    // free. Candidates { name, produces, tapped, eur, owned, basic }; better candidates
    // make more of the short colours, enter untapped (strongly preferred), are owned, then cost less.
    function pairLandSwaps(cuts, candidates, balance) {
      const shortness = Object.fromEntries(balance.map((b) => [b.c, Math.max(0, -b.delta)]));
      // A tapped land arrives a turn late, so it counts half — a tapped dual rarely beats an untapped basic.
      const value = (c) => c.produces.reduce((s, col) => s + (shortness[col] || 0), 0) * (c.tapped ? 0.5 : 1) + (c.owned ? 0.02 : 0);
      const pool = candidates.filter((c) => value(c) > 0).sort((a, b) => value(b) - value(a) || (a.eur || 0) - (b.eur || 0));
      const used = new Set();
      return cuts.map((cut) => {
        const budget = (cut.eur || 0) * 1.5 + 1;
        const cost = (c) => (c.owned || c.basic ? 0 : (c.eur || 0));
        let pick = pool.find((c) => (c.basic || !used.has(c.name)) && cost(c) <= budget);
        const overBudget = !pick;
        if (!pick) pick = pool.find((c) => !used.has(c.name)) || null;
        if (pick && !pick.basic) used.add(pick.name);
        return { cut, add: pick, overBudget: Boolean(pick) && overBudget };
      });
    }

    // ── One-click staples ─────────────────────────────────────────────
    const STAPLE_UNIVERSAL = ["Sol Ring", "Arcane Signet", "Swiftfoot Boots", "Lightning Greaves"];
    const STAPLE_MULTICOLOR = ["Command Tower", "Exotic Orchard", "Fellwar Stone"];
    // Signet + Talisman per color pair (keys in WUBRG order).
    const STAPLE_PAIR_ROCKS = {
      WU: ["Azorius Signet", "Talisman of Progress"], WB: ["Orzhov Signet", "Talisman of Hierarchy"],
      WR: ["Boros Signet", "Talisman of Conviction"], WG: ["Selesnya Signet", "Talisman of Unity"],
      UB: ["Dimir Signet", "Talisman of Dominance"], UR: ["Izzet Signet", "Talisman of Creativity"],
      UG: ["Simic Signet", "Talisman of Curiosity"], BR: ["Rakdos Signet", "Talisman of Indulgence"],
      BG: ["Golgari Signet", "Talisman of Resilience"], RG: ["Gruul Signet", "Talisman of Impulse"],
    };
    // Land cycles in priority order (Scryfall `is:` names). Triomes only matter at 3+ colors.
    const STAPLE_LAND_CYCLES = ["tricycleland", "shockland", "pathway", "checkland", "bondland", "painland", "fastland", "slowland"];
    // Picks the staples a deck is missing, in priority order. `landsByCycle` maps a cycle to
    // the names Scryfall returned for this color identity; `edhrec` is the commander's card
    // list; `pipWeight` orders color pairs by how much the deck uses them. Game Changers are
    // skipped once `gcAllowance` runs out (0 for bracket 1–2 decks).
    function pickStaples({ colors = [], inDeck = new Set(), edhrec = [], landsByCycle = {}, gameChangers = new Set(), gcAllowance = 0, pipWeight = {}, maxRocks = 4, maxLands = 10, maxEdhrec = 6 }) {
      const picked = [];
      const seen = new Set(inDeck);
      let gcLeft = gcAllowance;
      const take = (name) => {
        const key = name.toLowerCase();
        if (seen.has(key)) return false;
        if (gameChangers.has(key)) { if (gcLeft <= 0) return false; gcLeft--; }
        seen.add(key);
        picked.push(name);
        return true;
      };
      STAPLE_UNIVERSAL.forEach(take);
      if (colors.length >= 2) STAPLE_MULTICOLOR.forEach(take);
      const order = "WUBRG";
      const pairs = [];
      for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) {
        const [a, b] = [colors[i], colors[j]].sort((x, y) => order.indexOf(x) - order.indexOf(y));
        pairs.push({ key: a + b, w: (pipWeight[a] || 0) + (pipWeight[b] || 0) });
      }
      pairs.sort((x, y) => y.w - x.w);
      let rocks = 0;
      for (const p of pairs) {
        for (const name of STAPLE_PAIR_ROCKS[p.key] || []) { if (rocks < maxRocks && take(name)) rocks++; }
      }
      let lands = 0;
      for (const cycle of STAPLE_LAND_CYCLES) {
        if (cycle === "tricycleland" && colors.length < 3) continue;
        for (const name of landsByCycle[cycle] || []) { if (lands < maxLands && take(name)) lands++; }
      }
      edhrec
        .filter((c) => c.inclusion >= 0.35 && !/land/i.test(c.category || ""))
        .sort((a, b) => b.inclusion - a.inclusion)
        .slice(0, maxEdhrec * 3)
        .reduce((n, c) => (n < maxEdhrec && take(c.name) ? n + 1 : n), 0);
      return picked;
    }
    // ── Autofill planner ───────────────────────────────────────────────
    // Fills steps in order (ramp → draw → removal → wipes → themes → rest → lands). Each
    // step has a `need` and a `pool` of candidates { name, eur, owned, score, gc }, best
    // first. A card is taken once across all steps. Owned cards cost nothing (and, with
    // ownedFirst, rank first); a card over the per-card cap or the remaining total budget
    // is skipped and the next one (a "spare") takes its place. Game Changers are allowed
    // only while `gcAllowance` lasts. A card with no known price (eur null) is only taken
    // when owned. The budget is paced: each step may spend its share of what's left, in
    // proportion to how many cards it still needs, so early steps can't starve the lands.
    // Returns per-step picks plus totals.
    // backfill: optional { label, pool } — after the steps, the slots non-land steps left
    // empty are filled from this pool with whatever budget remains (so a short step adds
    // other good spells instead of leaving the gap to basic lands).
    function planAutofill({ steps, budget = Infinity, cap = Infinity, onlyOwned = false, ownedFirst = true, gcAllowance = 0, taken = new Set(), backfill = null }) {
      const used = new Set([...taken].map((n) => n.toLowerCase()));
      let spent = 0, gcLeft = gcAllowance;
      let needLeft = steps.reduce((n, s) => n + s.need, 0);
      const out = steps.map((step) => {
        const stepBudget = budget === Infinity ? Infinity : (budget - spent) * (step.need / Math.max(1, needLeft));
        needLeft -= step.need;
        let stepSpent = 0;
        const pool = step.pool.slice().sort((a, b) =>
          (ownedFirst ? Number(b.owned) - Number(a.owned) : 0) || b.score - a.score);
        const picks = [];
        for (const c of pool) {
          if (picks.length >= step.need) break;
          const key = c.name.toLowerCase();
          if (used.has(key)) continue;
          if (onlyOwned && !c.owned) continue;
          if (!c.owned && c.eur == null) continue; // unknown price: never assume it's free
          const cost = c.owned ? 0 : c.eur;
          if (!c.owned && cost > cap) continue;
          if (stepSpent + cost > stepBudget + 1e-9) continue;
          if (c.gc) { if (gcLeft <= 0) continue; gcLeft--; }
          used.add(key);
          spent += cost;
          stepSpent += cost;
          picks.push({ ...c, cost });
        }
        return { key: step.key, label: step.label, target: step.target || "", need: step.need, picks, short: Math.max(0, step.need - picks.length) };
      });
      const gap = out.reduce((n, s, i) => n + (steps[i].land ? 0 : s.short), 0);
      if (backfill && gap > 0) {
        const more = planAutofill({ steps: [{ key: "backfill", label: backfill.label || "Backfill", need: gap, pool: backfill.pool }], budget: budget === Infinity ? Infinity : Math.max(0, budget - spent), cap, onlyOwned, ownedFirst, gcAllowance: gcLeft, taken: used });
        if (more.added) { out.push(more.steps[0]); spent += more.spent; }
      }
      const all = out.flatMap((s) => s.picks);
      return { steps: out, spent, added: all.length, owned: all.filter((c) => c.owned).length };
    }
    // How many cards each autofill step should add, from the deck's current counts and its
    // targets. Spells fill to 100 minus the land target; themes get ~8 each from what's left.
    function autofillNeeds({ total, lands, counts, profile, themeCount = 0 }) {
      const mid = (r) => Math.round((r[0] + (r[1] ?? r[0])) / 2);
      const landTarget = mid(profile.landTarget);
      const spellRoom = Math.max(0, 100 - landTarget - (total - lands));
      const t = profile.roleTargets;
      const want = {
        ramp: Math.max(0, mid(t.ramp) - (counts.ramp || 0)),
        draw: Math.max(0, (t.draw[1] ?? t.draw[0] + 2) - (counts.draw || 0)),
        removal: Math.max(0, (t.removal[1] ?? t.removal[0]) - (counts.removal || 0)),
        wipes: Math.max(0, t.wipes[0] - (counts.wipes || 0)),
      };
      let room = spellRoom;
      const take = (n) => { const k = Math.min(n, room); room -= k; return k; };
      const out = { ramp: take(want.ramp), draw: take(want.draw), removal: take(want.removal), wipes: take(want.wipes) };
      out.theme = take(themeCount * 8);
      out.rest = room;
      out.lands = Math.max(0, landTarget - lands);
      out.landTarget = landTarget;
      return out;
    }
    // [good, borderline] floors per opening-hand stat, calibrated on a 99-card library:
    // 36 lands → 3+ lands 50%, keepable 79%; 10 ramp → ramp by T2 59%; 36 lands + 10 ramp
    // → a 3-drop commander on curve 88%. Below the borderline floor reads as bad.
    const ODDS_BANDS = {
      landsIn7: [0.48, 0.35],
      keepableLands: [0.75, 0.6],
      rampByT2: [0.55, 0.35],
      commanderOnCurve: [0.75, 0.55],
    };
    function oddsTone(stat, p) {
      const [good, ok] = ODDS_BANDS[stat] || [0.6, 0.4];
      return p >= good ? "good" : p >= ok ? "ok" : "bad";
    }
    // Fisher–Yates partial shuffle — draws min(n, cards.length) distinct elements uniformly
    // without replacement. `rng` is injectable so callers/tests can seed it.
    function drawRandom(cards, n, rng = Math.random) {
      const pool = cards.slice();
      const count = Math.min(n, pool.length);
      for (let i = 0; i < count; i++) {
        const j = i + Math.floor(rng() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, count);
    }

    // ── EDHREC × collection ──────────────────────────────────────────
    // Import-free copy of lib/edhrec.js's commanderSlug — the client needs the same slug
    // (for the footnote link) without pulling in a server module; scripts/check-analysis-ui.mjs
    // asserts this copy and the server's stay in lockstep.
    function commanderSlug(name) {
      return String(name || "")
        .split(" // ")[0]
        .trim()
        .toLowerCase()
        .replace(/'/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }
    // Front face, case-insensitive — local to this block (mirrors the outer frontFaceName)
    // so the block stays evaluable in isolation.
    function edhrecNameKey(name) {
      return String(name || "").split(" // ")[0].trim().toLowerCase();
    }
    // EDHREC cards the collection owns and that aren't already in the deck, sorted by
    // synergy desc then inclusion desc. `ownedByName` maps a normalized name to the owned
    // card object (used for the thumb/save/detail actions); `deckNames` is the set of
    // normalized names already in the deck (main + Maybeboard).
    // Local to this block (mirrors the outer isBasicLand) — basics are always in every
    // Commander deck's card pool, so EDHREC's "you already own this" is never a useful pick.
    function edhrecIsBasicLand(card) {
      const tl = (card && card.type_line) || "";
      return tl.includes("Basic") && tl.includes("Land");
    }
    function edhrecPicks(edhrecCards, ownedByName, deckNames) {
      return (edhrecCards || [])
        .map((c) => ({ ...c, card: ownedByName.get(edhrecNameKey(c.name)) }))
        .filter((c) => c.card && !edhrecIsBasicLand(c.card) && !deckNames.has(edhrecNameKey(c.name)))
        .sort((a, b) => b.synergy - a.synergy || b.inclusion - a.inclusion);
    }
    // Escapes a string for safe interpolation inside a double-quoted HTML attribute (e.g.
    // title="..."). esc() (the DOM textContent→innerHTML round-trip used for element text)
    // escapes &, <, > but not quotes — fine for text nodes, not for an attribute value: AI-
    // or card-derived text containing a `"` would otherwise break out of the attribute and
    // inject markup. Self-contained (no DOM) so it can live in this pure block.
    function escAttr(str) {
      return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
    // @testable analysis-helpers end

    function bracketDialHtml(bracket) {
      const segs = [1, 2, 3, 4, 5].map((i) => `<span class="seg ${bracket && i <= bracket ? "on" : ""}"></span>`).join("");
      return `<span class="segs">${segs}</span><span class="lbl">${bracket ? `Bracket ${bracket} · ${BRACKET_NAMES[bracket]}` : "Bracket …"}</span>`;
    }
    function collapseChevronHtml() {
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>`;
    }
    function compactNote(note, max = 96) {
      const clean = String(note || "").replace(/\s+/g, " ").trim();
      if (clean.length <= max) return clean;
      return clean.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
    }
    function applyAiGradeContext(grade, data) {
      if (!data || !data.roleNotes) return grade;
      return {
        ...grade,
        aiRead: true,
        items: grade.items.map((item) => {
          const note = data.roleNotes[item.key];
          const conf = data.confidence && data.confidence[item.key];
          if (!note && conf == null) return item;
          const confidence = conf == null ? "" : ` · AI confidence ${Math.round(Number(conf) * 100)}%`;
          return { ...item, note: `${compactNote(note || item.note, 78)}${confidence}` };
        }),
      };
    }
    function updateGradeUi(grade) {
      const g = $("#da2-grade");
      if (g) {
        const b = g.querySelector("b");
        if (b) b.textContent = grade.letter;
        g.className = `da2-badge ${gradeTone(grade.letter)}`;
        g.title = `${grade.score}% weighted health score · ${grade.passed}/${grade.total} checks on target`;
      }
      const pg = $("#deck-progress-grade");
      if (pg) { pg.textContent = grade.letter; pg.className = `dp-grade ${gradeTone(grade.letter)}`; }
    }

    // Game Changers list (for the bracket) — fetched once, cached.
    let gameChangersPromise = null;
    function loadGameChangers() {
      if (!gameChangersPromise) gameChangersPromise = fetch("/api/game-changers")
        .then((r) => (r.ok ? r.json() : { names: [] }))
        .then((d) => new Set((d.names || []).map((n) => frontFaceName(n).toLowerCase())))
        .catch(() => new Set());
      return gameChangersPromise;
    }
    // folderId -> { sig, data } — persisted so an AI review survives reloads; the stored
    // sig is compared to the live deck signature on render, so it self-invalidates on edits.
    const DECK_REVIEW_CACHE_VERSION = 3;
    const deckReviewCache = JSON.parse(localStorage.getItem("deck_reviews") || "{}");
    function persistDeckReviews() { try { lsSet("deck_reviews", JSON.stringify(deckReviewCache)); } catch (e) { /* quota — keep the in-memory copy */ } }
    let daCtx = null; // current panel context — lets AI extras recompute grade/gaps/drawer
    // folderIds currently running a POST /api/deck-review — one in-flight review per deck,
    // and a different deck's review may run concurrently. While a folderId is in this set,
    // renderDeckAnalysis paints that deck's Analyze button disabled with an in-progress
    // label and a pending note instead of a fresh clickable button — an async re-render
    // triggered by something else (profiles/EDHREC loading) while a review is in flight
    // must not resurrect a clickable "Analyze" (a second click would be a second paid
    // review) or drop the pending note.
    const daReviewInFlight = new Set();
    // Role key whose detail panel is open (see wireDeckAnalysisChips), or null. Remembered
    // so an incidental re-render (profiles/EDHREC loading, grade recompute) reopens it
    // instead of silently closing it.
    let daOpenRole = null;
    function deckSig(cards, folderId, commanderName = "") { return `${DECK_REVIEW_CACHE_VERSION}|${commanderName}|${cards.map((c) => c.id + ":" + cardQty(folderId, c.id)).sort().join("|")}`; }

    // ═══ Deck card profiles (AI role source) ══════════════════════════
    // In-memory cache of AI card profiles by oracle id — populated from /api/deck-profiles
    // and read synchronously by detectRoleDetails/detectWinCons on every render.
    const profileCache = new Map();
    function cacheProfiles(profiles) { Object.entries(profiles || {}).forEach(([oid, p]) => profileCache.set(oid, p)); }
    function nonBasicCards(cards) { return cards.filter((c) => !isBasicLand(c)); }
    function profilesFromCache(cards) {
      const out = {};
      nonBasicCards(cards).forEach((c) => { const oid = cardOracleId(c); if (oid && profileCache.has(oid)) out[oid] = profileCache.get(oid); });
      return out;
    }
    function deckProfilesSig(folderId, cards) {
      const ids = [...new Set(nonBasicCards(cards).map(cardOracleId).filter(Boolean))].sort();
      return `${folderId}|${ids.join(",")}`;
    }
    async function postJson(url, body) {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    }
    // Re-renders the deck analysis panel for `folderId` with the deck's current cards —
    // never a `cards` array some earlier caller captured before an await, which could be
    // stale by the time an async re-render (profile prepare, EDHREC load) actually runs.
    function rerenderDeckAnalysisIfActive(folderId) {
      if (state.activeFolder !== folderId) return; // deck switched while this was in flight
      const activeDeck = state.folders.find((f) => f.id === folderId);
      if (!activeDeck) return;
      renderDeckAnalysis(activeDeck, getFolderCards(folderId).filter((c) => !isMaybe(folderId, c.id)));
    }
    // Current profile line state, scoped to the folder it's for (so switching decks while
    // one is in flight doesn't flash the previous deck's status): null, or
    // { folderId, phase: "profiling" | "awaiting-confirm" | "skipped" | "error", missing, estimate, skipped, error }.
    let daProfileStatus = null;
    // The oracle-id-set signature ensureDeckProfiles last acted on — re-render for the same
    // deck (no card-set change) is a no-op; a changed set (or Retry, which clears this) redoes it.
    let daProfileSig = null;
    function daProfileLineHtml(folderId) {
      const st = daProfileStatus && daProfileStatus.folderId === folderId ? daProfileStatus : null;
      if (!st) return "";
      const n = (count) => `${count} card${count === 1 ? "" : "s"}`;
      if (st.phase === "profiling") return `<div class="da2-vsub" id="da2-profile-line">Profiling ${n(st.missing)}…</div>`;
      if (st.phase === "awaiting-confirm") {
        const price = st.estimate?.usd != null ? ` (≈ $${st.estimate.usd.toFixed(2)})` : "";
        return `<div class="da2-vsub" id="da2-profile-line">Profile ${n(st.missing)} for accurate roles${price} <button class="da2-chip muted cta" id="da2-profile-btn" type="button" style="margin-left:6px">Profile</button></div>`;
      }
      // The AI failed to profile these cards (omitted them twice) — never auto-retried;
      // only this manual Retry (a confirm prepare) tries them again.
      if (st.phase === "skipped") return `<div class="da2-vsub" id="da2-profile-line">${n(st.skipped)} couldn't be profiled <button class="da2-chip muted cta" id="da2-profile-skip-retry-btn" type="button" style="margin-left:6px">Retry</button></div>`;
      if (st.phase === "error") return `<div class="da2-vsub" id="da2-profile-line">${esc(st.error)} <button class="da2-chip muted cta" id="da2-profile-retry-btn" type="button" style="margin-left:6px">Retry</button></div>`;
      return "";
    }
    function wireDeckProfileLine(deck, cards, folderId) {
      $("#da2-profile-btn")?.addEventListener("click", () => {
        const missingCount = (daProfileStatus?.folderId === folderId && daProfileStatus.missing) || nonBasicCards(cards).length;
        runDeckProfilePrepare(folderId, cards, deckProfilesSig(folderId, cards), nonBasicCards(cards), { confirm: true, missingCount });
      });
      $("#da2-profile-skip-retry-btn")?.addEventListener("click", () => {
        const missingCount = (daProfileStatus?.folderId === folderId && daProfileStatus.skipped) || nonBasicCards(cards).length;
        runDeckProfilePrepare(folderId, cards, deckProfilesSig(folderId, cards), nonBasicCards(cards), { confirm: true, missingCount });
      });
      $("#da2-profile-retry-btn")?.addEventListener("click", () => {
        daProfileSig = null; // force ensureDeckProfiles to redo the lookup (and prepare, if still needed)
        ensureDeckProfiles(deck, cards, folderId);
      });
    }
    async function runDeckProfilePrepare(folderId, cards, sig, nonBasic, { confirm, missingCount }) {
      daProfileStatus = { folderId, phase: "profiling", missing: missingCount };
      rerenderDeckAnalysisIfActive(folderId);
      const res = await postJson("/api/deck-profiles/prepare", { cards: nonBasic, confirm }).catch((err) => ({ ok: false, data: { error: err.message } }));
      if (daProfileSig !== sig) return; // deck changed again while this was in flight
      if (res.ok) {
        cacheProfiles(res.data.profiles);
        daProfileStatus = res.data.skipped ? { folderId, phase: "skipped", skipped: res.data.skipped } : null;
      } else if (res.data?.needsConfirmation) {
        daProfileStatus = { folderId, phase: "awaiting-confirm", missing: res.data.missing, estimate: res.data.estimate };
      } else {
        daProfileStatus = { folderId, phase: "error", error: res.data?.error || "Profiling failed" };
      }
      rerenderDeckAnalysisIfActive(folderId);
    }
    // Looks up profiles for the deck's non-basic main-deck cards, caching them by oracle id
    // (skipped when the same set was already checked — a re-render alone never refetches).
    // Missing ≤ the auto limit and AI available: profiles automatically (the server enforces
    // the limit, so the client never needs to know its value) — cards the AI has already
    // failed to profile are excluded from that auto-profile, so they never get silently
    // retried on every deck edit; they surface as the "couldn't be profiled" status instead.
    // Missing over the limit: shows a "Profile N cards (≈ $X)" line with a manual Profile
    // button. No AI: no line, and detectRoleDetails/detectWinCons fall back to the
    // rule-based classifier per card.
    async function ensureDeckProfiles(deck, cards, folderId) {
      const nonBasic = nonBasicCards(cards);
      const sig = deckProfilesSig(folderId, cards);
      if (sig === daProfileSig) return;
      daProfileSig = sig;
      if (!nonBasic.length) { daProfileStatus = null; return; }
      const lookupRes = await postJson("/api/deck-profiles/lookup", { cards: nonBasic }).catch((err) => ({ ok: false, data: { error: err.message } }));
      if (daProfileSig !== sig) return;
      if (!lookupRes.ok) {
        daProfileStatus = { folderId, phase: "error", error: lookupRes.data?.error || "Couldn't check card profiles" };
        rerenderDeckAnalysisIfActive(folderId);
        return;
      }
      const { profiles, missing, aiAvailable } = lookupRes.data;
      const learnedNew = Object.keys(profiles || {}).length > 0; // some cards were already profiled server-side
      cacheProfiles(profiles);
      if (!missing.length || !aiAvailable) {
        daProfileStatus = null;
        if (learnedNew || !missing.length) rerenderDeckAnalysisIfActive(folderId);
        return;
      }
      await runDeckProfilePrepare(folderId, cards, sig, nonBasic, { confirm: false, missingCount: missing.length });
    }

    const deckBracket = {}; // folderId -> estimated minimum bracket (2–4)
    async function enhanceBracket(cards, folderId) {
      const gc = await loadGameChangers();
      const el = $("#da2-bracket");
      if (!el || state.activeFolder !== folderId) return; // deck switched while loading
      const hits = cards.filter((c) => gc.has(frontFaceName(c.name).toLowerCase())).map((c) => c.name);
      const mld = detectMassLandDenial(cards);
      const bracket = (hits.length >= 4 || mld) ? 4 : (hits.length >= 1 ? 3 : 2);
      deckBracket[folderId] = bracket; // sent with the AI review as power-level context
      el.innerHTML = bracketDialHtml(bracket);
      el.title = `${hits.length} Game Changer${hits.length === 1 ? "" : "s"}${mld ? ", mass land denial" : ""} → minimum Bracket ${bracket} (${BRACKET_NAMES[bracket]})` + (hits.length ? `\n${hits.join(", ")}` : "");
    }
    const comboCountCache = {}; // commander (lowercased front-face) -> { n, hasMore }
    async function enhanceCombos(commanderName, folderId) {
      const key = frontFaceName(commanderName).toLowerCase();
      const apply = (info) => {
        const el = $("#da2-combos");
        if (!el || state.activeFolder !== folderId || !info || !info.n) return;
        el.style.display = "flex";
        el.innerHTML = `<span class="dot" style="background:#FF9F1C"></span>${info.n}${info.hasMore ? "+" : ""} combo line${info.n === 1 ? "" : "s"} with ${esc(frontFaceName(commanderName))} — open the Combos button to see them`;
      };
      if (comboCountCache[key]) return apply(comboCountCache[key]);
      try {
        const res = await fetch(`/api/combos?commander=${encodeURIComponent(frontFaceName(commanderName))}&offset=0`);
        if (!res.ok) return;
        const d = await res.json();
        const info = { n: (d.combos || []).length, hasMore: Boolean(d.hasMore) };
        comboCountCache[key] = info;
        apply(info);
      } catch (e) { /* offline / no combos — leave hidden */ }
    }

    // Add/Trim card chip — clicking opens that card in the focus panel.
    function fixCardChip(raw, kind) {
      const name = String(raw).replace(/^[\s+\-–—]+/, "").trim();
      return `<span class="da2-chip ${kind} da2-card-chip" data-card="${esc(name)}" role="button" tabindex="0" title="Show ${esc(name)}">${esc(kind === "trim" ? "− " + name : name)}</span>`;
    }
    function fixRowsHtml(data) {
      // Reviews since the "full analysis" prompt carry paired swaps with reasons; older
      // cached reviews only have add/trim name lists.
      if (Array.isArray(data.swaps) && data.swaps.length) return swapRowsHtml(data.swaps) + fullAnalysisHtml(data);
      const add = Array.isArray(data.add) ? data.add : [];
      const trim = Array.isArray(data.trim) ? data.trim : [];
      const addChips = add.length ? add.map((n) => fixCardChip(n, "add")).join("") : `<span class="da2-chip muted">no clear adds</span>`;
      const trimChips = trim.length ? trim.map((n) => fixCardChip(n, "trim")).join("") : `<span class="da2-chip muted">no obvious cuts</span>`;
      return `<div class="da2-fix" id="da2-add-row"><span class="da2-fixlbl add">Add</span>${addChips}</div>
        <div class="da2-fix" id="da2-trim-row"><span class="da2-fixlbl trim">Trim</span>${trimChips}</div>
        <div class="da2-vsub" style="margin-top:8px">Re-analyze for the full analysis with reasons.</div>`;
    }
    // Normalized name -> owned, built lazily from the collection (for "Owned" on suggestions).
    function ownsCardNamed(name) {
      if (!collectionIndex) return false;
      const key = edhrecNameKey(name);
      return collectionIndex.list.some((it) => edhrecNameKey(it.card.name) === key);
    }
    function swapRowsHtml(swaps) {
      const rows = swaps.map((s) => `<div class="da2-swap">
          <div class="da2-swap-cards">${fixCardChip(s.cut, "trim")}<span class="da2-swap-arrow" aria-hidden="true">→</span>${fixCardChip(s.add, "add")}${ownsCardNamed(s.add) ? `<span class="owned-inline">Owned</span>` : ""}</div>
          <div class="da2-swap-why">${esc(s.reason)}</div>
        </div>`).join("");
      return `<div class="da2-swaps"><span class="da2-fixlbl add">Swaps</span><div class="da2-swap-list">${rows}</div></div>`;
    }
    let daFullOpen = false; // keeps the Full analysis section open across re-renders
    function fullAnalysisHtml(data) {
      if (!data.planRead) return "";
      const list = (items) => items.map((t) => `<li>${esc(t)}</li>`).join("");
      const notes = Object.entries(data.roleNotes || {}).filter(([, n]) => n)
        .map(([k, n]) => `<li><b>${esc(AI_LABEL[k] || k)}</b> — ${esc(n)}</li>`).join("");
      const keyCards = (data.keyCards || []).map((n) => fixCardChip(n, "key")).join("");
      return `<details class="da2-full" id="da2-full"${daFullOpen ? " open" : ""}>
        <summary>Full analysis</summary>
        <div class="da2-full-body">
          <div class="da2-full-sec"><div class="da-h">How it wins</div><p>${esc(data.planRead)}</p></div>
          <div class="da2-full-cols">
            ${(data.strengths || []).length ? `<div class="da2-full-sec"><div class="da-h">Strengths</div><ul class="da2-full-list good">${list(data.strengths)}</ul></div>` : ""}
            ${(data.weaknesses || []).length ? `<div class="da2-full-sec"><div class="da-h">Weaknesses</div><ul class="da2-full-list bad">${list(data.weaknesses)}</ul></div>` : ""}
          </div>
          ${keyCards ? `<div class="da2-full-sec"><div class="da-h">Key cards <span class="da2-approx">· good ones to pin</span></div><div class="da2-role-cards">${keyCards}</div></div>` : ""}
          ${notes ? `<div class="da2-full-sec"><div class="da-h">Role notes</div><ul class="da2-full-list">${notes}</ul></div>` : ""}
          ${data.mulligan ? `<div class="da2-full-sec"><div class="da-h">Keep or mulligan</div><p>${esc(data.mulligan)}</p></div>` : ""}
        </div>
      </details>`;
    }
    // Resolve a card by name (saved cards first, then Scryfall) and open its focus panel.
    async function openCardByName(name) {
      if (!name) return;
      const key = String(name).toLowerCase();
      let card = state.savedCards.find((c) => frontFaceName(c.name).toLowerCase() === key || (c.name || "").toLowerCase() === key);
      if (!card) {
        try {
          let res = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
          if (!res.ok) res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
          if (res.ok) card = await res.json();
        } catch (e) { /* not found / offline */ }
      }
      if (card) showDetail(card);
    }

    // The two chip rows (Needs attention / On target) built from computeGrade(...).items.
    // Role chips (ROLE_KEYS) are buttons that toggle the shared #da2-role-detail panel;
    // every other chip (lands, curve, the merged colors chip) is inert text.
    function chipsCardHtml(items) {
      const { attention, onTarget } = chipGroups(items);
      const chipHtml = (c) => {
        const cls = `da2-chip ${c.pass ? "ok" : "bad"}`;
        const title = c.note ? ` title="${escAttr(c.note)}"` : ""; // carries the AI role note (applyAiGradeContext), when there is one
        if (ROLE_KEYS.includes(c.key)) return `<button class="${cls}" type="button" data-role-key="${c.key}" aria-expanded="false" aria-controls="da2-role-detail"${title}>${esc(c.text)}</button>`;
        return `<span class="${cls}"${title}>${esc(c.text)}</span>`;
      };
      // A plain-language to-do per failing check ("Add 3 board wipes", "Cut ~8 ramp").
      const todo = (c) => {
        const num = typeof c.value === "number" && (c.lo != null || c.hi != null);
        const fmt = (n) => fmtScoreNum(Math.round(n * 10) / 10);
        const what = String(c.label || "").toLowerCase();
        const text = !num ? c.text
          : c.status === "low" ? `Add ${fmt(c.lo - c.value)} ${what}`
          : c.status === "high" ? (c.key === "avgMv" || /average/i.test(c.label || "") ? `Lower the ${what}` : `Cut ~${fmt(c.value - c.hi)} ${what}`) : c.text;
        const ctx = num ? `${c.valueLabel} / ${c.target}` : "";
        const tone = c.severity === "critical" ? "bad" : "warn";
        const title = c.note ? ` title="${escAttr(c.note)}"` : "";
        const inner = `<span class="ov-dot ${tone}"></span><span class="ov-text">${esc(text)}</span>${ctx ? `<span class="ov-ctx">${esc(ctx)}</span>` : ""}`;
        return ROLE_KEYS.includes(c.key)
          ? `<button class="da2-chip ov-item" type="button" data-role-key="${c.key}" aria-expanded="false" aria-controls="da2-role-detail"${title}>${inner}</button>`
          : `<div class="ov-item"${title}>${inner}</div>`;
      };
      const fine = (c) => ROLE_KEYS.includes(c.key)
        ? `<button class="da2-chip ov-fine" type="button" data-role-key="${c.key}" aria-expanded="false" aria-controls="da2-role-detail">${esc(c.text)}</button>`
        : `<span class="ov-fine">${esc(c.text)}</span>`;
      return `
        <div class="ov-todo">
          <div class="ov-col"><div class="da-h">To do</div>
            ${attention.length ? attention.map(todo).join("") : `<div class="da2-vsub">Nothing to fix. Every check is on target.</div>`}</div>
          <div class="ov-col"><div class="da-h">Looking good</div>
            <div class="ov-fines">${onTarget.length ? onTarget.map(fine).join("") : `<span class="da2-vsub">Nothing yet</span>`}</div></div>
        </div>`;
    }
    // Content of the shared role-detail panel opened by a role chip: its evidence cards
    // (heuristic or AI-refined — daCtx.roleDetails always carries the heuristic evidence),
    // the setup-dependent legend once, and — for Draw only — the card-flow split.
    function roleDetailHtml(key) {
      if (!daCtx) return "";
      const detail = daCtx.roleDetails[key] || { count: 0, cards: [] };
      const cards = detail.cards.slice(0, 24).map((card) => `<span class="da2-chip role${card.conditional ? " conditional" : ""} da2-card-chip" data-card="${esc(card.name)}" role="button" tabindex="0" title="Show ${esc(card.name)} in card focus">${esc(card.name)}${card.qty > 1 ? ` ×${card.qty}` : ""}</span>`).join("");
      const remaining = detail.cards.length - 24;
      const conditional = detail.cards.some((c) => c.conditional);
      const flowLine = (key === "draw" && daCtx.flow.total)
        ? `<div class="da2-role-detail-flow">${daCtx.flow.early} early · ${daCtx.flow.conditional} conditional · ${daCtx.flow.late} late</div>` : "";
      return `<div class="da2-role-detail-head"><b>${esc(AI_LABEL[key] || key)}</b><span>${detail.count} card${detail.count === 1 ? "" : "s"} found</span></div>
        ${flowLine}
        <div class="da2-role-cards">${cards || `<span class="da2-chip muted">No matches yet</span>`}${remaining > 0 ? `<span class="da2-chip muted">+${remaining} more</span>` : ""}</div>
        ${conditional ? `<div class="da2-role-key">Dashed cards are temporary, setup-dependent, or board-state dependent.</div>` : ""}`;
    }
    // Wires the chip-row role buttons to the shared detail panel: click toggles it open
    // for that role (closing it if it's already showing that role), and card chips inside
    // the panel open the card focus, same as the Add/Trim chips. Also re-opens the panel
    // (see daOpenRole) if an incidental re-render (profiles/EDHREC loading, grade
    // recompute) just replaced a panel that had it open.
    function wireDeckAnalysisChips() {
      const card = $("#da2-chips-card");
      const detail = $("#da2-role-detail");
      const openRole = (key, btn) => {
        if (!detail) return;
        daOpenRole = key;
        detail.innerHTML = roleDetailHtml(key);
        detail.hidden = false;
        detail.dataset.roleKey = key;
        if (btn) btn.setAttribute("aria-expanded", "true");
      };
      card?.querySelectorAll(".da2-chip[data-role-key]").forEach((btn) => btn.addEventListener("click", () => {
        const key = btn.dataset.roleKey;
        const wasOpen = Boolean(detail && !detail.hidden && detail.dataset.roleKey === key);
        card.querySelectorAll(".da2-chip[data-role-key]").forEach((b) => b.setAttribute("aria-expanded", "false"));
        if (!detail) return;
        if (wasOpen) { detail.hidden = true; detail.innerHTML = ""; delete detail.dataset.roleKey; daOpenRole = null; return; }
        openRole(key, btn);
      }));
      detail?.addEventListener("click", (e) => {
        const chip = e.target.closest(".da2-card-chip");
        if (chip) { e.stopPropagation(); openCardByName(chip.dataset.card); }
      });
      detail?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const chip = e.target.closest(".da2-card-chip");
        if (chip) { e.preventDefault(); openCardByName(chip.dataset.card); }
      });
      if (daOpenRole) {
        const btn = card?.querySelector(`.da2-chip[data-role-key="${daOpenRole}"]`);
        if (btn) openRole(daOpenRole, btn);
        else daOpenRole = null; // that role no longer has a chip — nothing to reopen
      }
    }
    // Per deck color: "W 1/5", shortfalls in the existing warning color.
    function colorsLineHtml(sources) {
      if (!sources.length) return `<div class="da2-vsub" style="margin-top:6px">Colorless — no colored sources needed.</div>`;
      const items = sources.map((s) => {
        const lc = s.c.toLowerCase();
        const style = s.status === "ok" ? "" : ` style="color:${STATUS_COLOR[s.status]}"`;
        return `<span class="da2-color-chip"${style}><span class="da2-srcpip da2-sb-${lc}">${MANA_SVG[lc]}</span>${s.c} ${fmtScoreNum(s.have)}/${s.need}</span>`;
      }).join("");
      return `<div class="da2-colors-line">${items}</div>`;
    }
    // Candidate cards for one trim category: main-deck cards in it, minus the commander and
    // pinned cards, weakest (lowest keep-score) first.
    function trimCandidates(key, ctx) {
      const { cards, folderId, commander, roleDetails, edhrecByName } = ctx;
      let inCat;
      if (key === "__all") inCat = cards.filter((c) => !isLandCard(c) || (ctx.landsOver && !isBasicLand(c)));
      else if (key === "lands") inCat = cards.filter((c) => isLandCard(c) && !isBasicLand(c));
      else if (ROLE_KEYS.includes(key)) {
        const names = new Set((roleDetails[key]?.cards || []).map((c) => c.name));
        inCat = cards.filter((c) => names.has(c.name));
      } else if (key === "spells") inCat = cards.filter((c) => { const t = cardTypes(c); return t.has("instant") || t.has("sorcery"); });
      else inCat = cards.filter((c) => cardTypes(c).has(key) && !isLandCard(c));
      const roleCount = new Map();
      ROLE_KEYS.forEach((k) => (roleDetails[k]?.cards || []).forEach((c) => roleCount.set(c.name, (roleCount.get(c.name) || 0) + 1)));
      return inCat
        .filter((c) => c.id !== commander?.id && !isPinned(folderId, c.id))
        .map((c) => {
          const e = edhrecByName ? edhrecByName.get(edhrecNameKey(c.name)) : null;
          const roles = roleCount.get(c.name) || 0;
          const cmc = Number(c.cmc || 0);
          const why = [
            e ? `in ${Math.round(e.inclusion * 100)}% of decks` : (edhrecByName ? "not on EDHREC's list" : null),
            e && e.synergy ? `${e.synergy > 0 ? "+" : ""}${Math.round(e.synergy * 100)}% synergy` : null,
            `${roles} role${roles === 1 ? "" : "s"}`,
            `MV ${cmc}`,
          ].filter(Boolean).join(" · ");
          return { card: c, score: cutKeepScore({ inclusion: e ? e.inclusion : (edhrecByName ? 0 : null), synergy: e ? e.synergy : 0, roles, cmc }), why };
        })
        .sort((a, b) => a.score - b.score);
    }
    function trimInRow(key, c, ctx) {
      if (key === "lands") return isLandCard(c) && !isBasicLand(c);
      if (ROLE_KEYS.includes(key)) return (ctx.roleDetails[key]?.cards || []).some((x) => x.name === c.name);
      const t = cardTypes(c);
      if (key === "spells") return t.has("instant") || t.has("sorcery");
      return t.has(key) && !isLandCard(c);
    }
    function trimSuggested(budget, ctx) {
      const short = budget.rows.filter((r) => r.action === "add");
      const over = budget.rows.filter((r) => r.action === "cut");
      const all = trimCandidates("__all", { ...ctx, landsOver: over.some((r) => r.key === "lands") });
      return all.map((x) => {
        const s = short.filter((r) => trimInRow(r.key, x.card, ctx));
        const o = over.filter((r) => trimInRow(r.key, x.card, ctx));
        const why = [o.length ? `${o.map((r) => r.label.toLowerCase()).join(", ")} over target` : null, x.why, s.length ? `you're short on ${s.map((r) => r.label.toLowerCase()).join(", ")}` : null].filter(Boolean).join(" · ");
        return { ...x, score: x.score + s.length * 14 - o.length * 8, why };
      }).sort((a, b) => a.score - b.score);
    }
    function trimPanelHtml(budget, ctx) {
      const pinnedCount = ctx.cards.filter((c) => isPinned(ctx.folderId, c.id)).length;
      const rows = budget.rows.map((r) => {
        const range = r.hi != null ? `${r.lo}–${r.hi}` : `${r.lo}+`;
        const act = r.action === "cut" ? `cut ~${r.n}` : r.action === "add" ? `add ${r.n}` : "on target";
        const open = trimOpenKey === r.key;
        return `<button type="button" class="da2-trim-row ${r.action}${open ? " open" : ""}" data-trim-key="${r.key}" aria-expanded="${open}">
          <span class="da2-trim-label">${esc(r.label)}</span><span class="da2-trim-have">${r.have}</span><span class="da2-trim-range">${range}</span><span class="da2-trim-act">${act}</span></button>`;
      }).join("");
      let list = "";
      let suggested = "";
      if (!trimOpenKey && budget.toCut > 0) {
        const sug = trimSuggested(budget, ctx);
        const shown = sug.slice(0, trimShowAll ? Math.max(budget.toCut, 30) : budget.toCut);
        trimSuggestedIds = sug.slice(0, budget.toCut).map((x) => x.card.id);
        suggested = `<div class="da2-trim-list da2-trim-suggest">
          <div class="da2-trim-list-head"><b>Suggested cuts</b> · the ${budget.toCut} weakest, protecting roles you're short on${ctx.edhrecByName ? "" : " (EDHREC data not loaded yet)"}
            <button type="button" class="da2-cut-all" id="da2-cut-all">Cut these ${Math.min(budget.toCut, sug.length)}</button></div>
          ${shown.map((x) => `<div class="da2-trim-cand">
            <button type="button" class="da2-edhrec-thumb" data-open-card="${esc(x.card.id)}" title="Show ${escAttr(x.card.name)}"><img src="${getCardImage(x.card)}" alt="" loading="lazy" style="width:100%;border-radius:5px;display:block"></button>
            <div class="da2-trim-meta"><div class="da2-edhrec-name">${esc(x.card.name)}</div><div class="da2-edhrec-stats">${esc(x.why)}</div></div>
            <button type="button" class="da2-hand-btn" data-pin-card="${esc(x.card.id)}" title="Keep this card — never suggest it">Pin</button>
            <button type="button" class="da2-hand-btn da2-cut-btn" data-cut-card="${esc(x.card.id)}" title="Move to the Maybeboard">Cut</button>
          </div>`).join("")}
          ${!trimShowAll && sug.length > shown.length ? `<button type="button" class="da2-hand-btn" id="da2-trim-more">Show more options</button>` : ""}
        </div>
        <div class="da2-vsub" style="margin-top:10px">Or pick a category to see its weakest cards:</div>`;
      }
      if (trimOpenKey) {
        const cands = trimCandidates(trimOpenKey, ctx);
        const shown = trimShowAll ? cands : cands.slice(0, 12);
        const label = budget.rows.find((r) => r.key === trimOpenKey)?.label || "";
        list = `<div class="da2-trim-list">
          <div class="da2-trim-list-head"><b>${esc(label)}</b> — weakest first${ctx.edhrecByName ? "" : " (EDHREC data not loaded yet)"}</div>
          ${shown.length ? shown.map((x) => `<div class="da2-trim-cand">
            <button type="button" class="da2-edhrec-thumb" data-open-card="${esc(x.card.id)}" title="Show ${escAttr(x.card.name)}"><img src="${getCardImage(x.card)}" alt="" loading="lazy" style="width:100%;border-radius:5px;display:block"></button>
            <div class="da2-trim-meta"><div class="da2-edhrec-name">${esc(x.card.name)}</div><div class="da2-edhrec-stats">${esc(x.why)}</div></div>
            <button type="button" class="da2-hand-btn" data-pin-card="${esc(x.card.id)}" title="Keep this card — never suggest it">Pin</button>
            <button type="button" class="da2-hand-btn da2-cut-btn" data-cut-card="${esc(x.card.id)}" title="Move to the Maybeboard">Cut</button>
          </div>`).join("") : `<div class="da2-edhrec-stats">Nothing to cut here${pinnedCount ? " (pinned cards are hidden)" : ""}.</div>`}
          ${!trimShowAll && cands.length > shown.length ? `<button type="button" class="da2-hand-btn" id="da2-trim-more">Show all ${cands.length}</button>` : ""}
        </div>`;
      }
      return `<div class="da-h">Trimming to 100 · <span class="da2-trim-total">${budget.toCut} to cut</span></div>
        <div class="da2-vsub">Targets are for the final deck. Categories overlap, so one cut can count twice. Cuts go to the Maybeboard${pinnedCount ? ` · ${pinnedCount} pinned` : ""}.</div>
        ${suggested}<div class="da2-trim-grid">${rows}</div>${list}`;
    }
    let trimSuggestedIds = [];
    function renderTrimPanel() {
      const el = $("#da2-trim");
      if (!el || !trimCtx) return;
      el.innerHTML = trimPanelHtml(trimCtx.budget, trimCtx);
      el.querySelectorAll("[data-trim-key]").forEach((b) => b.addEventListener("click", () => {
        trimOpenKey = trimOpenKey === b.dataset.trimKey ? null : b.dataset.trimKey;
        trimShowAll = false;
        renderTrimPanel();
      }));
      $("#da2-trim-more")?.addEventListener("click", () => { trimShowAll = true; renderTrimPanel(); });
      const byId = (id) => trimCtx.cards.find((c) => c.id === id);
      el.querySelectorAll("[data-open-card]").forEach((b) => b.addEventListener("click", () => { const c = byId(b.dataset.openCard); if (c) showDetail(c); }));
      el.querySelectorAll("[data-cut-card]").forEach((b) => b.addEventListener("click", () => { setMaybe(trimCtx.folderId, b.dataset.cutCard, true); renderSavedCards(); }));
      el.querySelectorAll("[data-pin-card]").forEach((b) => b.addEventListener("click", () => { setPinned(trimCtx.folderId, b.dataset.pinCard, true); renderSavedCards(); }));
      $("#da2-cut-all")?.addEventListener("click", () => {
        const folderId = trimCtx.folderId, ids = trimSuggestedIds.slice();
        ids.forEach((id) => setMaybe(folderId, id, true));
        renderSavedCards();
        showToast(`Moved ${ids.length} card${ids.length === 1 ? "" : "s"} to the maybeboard`, { actionLabel: "Undo", ms: 7000, onAction: () => { ids.forEach((id) => setMaybe(folderId, id, false)); renderSavedCards(); } });
      });
    }
    const TYPE_GUIDE_ROWS = [
      ["creature", "Creatures"], ["spells", "Instants + sorceries"], ["artifact", "Artifacts"],
      ["enchantment", "Enchantments"], ["planeswalker", "Planeswalkers"],
    ];
    function typeGuideHtml(typeCounts, targets) {
      const chips = TYPE_GUIDE_ROWS.map(([key, label]) => {
        const n = key === "spells" ? (typeCounts.instant || 0) + (typeCounts.sorcery || 0) : (typeCounts[key] || 0);
        const [lo, hi] = targets[key];
        const tone = n < lo ? "low" : n > hi ? "high" : "ok";
        const hint = tone === "ok" ? "In the typical range" : tone === "low" ? `${lo - n} below the typical range` : `${n - hi} above the typical range`;
        return `<span class="da2-chip da2-type-chip ${tone === "ok" ? "ok" : "bad"}" title="${hint}">${label} ${n}<small>${lo}–${hi}</small></span>`;
      }).join("");
      return `<div class="da2-chip-row da2-types-row"><div class="da2-chip-row-label">Card types</div><div class="da2-chips">${chips}</div></div>`;
    }
    const BASIC_NAMES = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
    // Suggested basics: split the deck's current basics (or, with none, the lands it's short
    // of its target) by colored-symbol share. Shows the current count where it differs.
    function basicsSuggestionHtml(cards, folderId, sources, landTargetLo, landCount) {
      if (!sources.length) return "";
      const have = { W: 0, U: 0, B: 0, R: 0, G: 0 };
      let basics = 0;
      cards.forEach((c) => {
        const tl = c.type_line || "";
        if (!/Basic/.test(tl) || !/Land/.test(tl)) return;
        const q = cardQty(folderId, c.id);
        basics += q;
        WUBRG.forEach((col) => { if (tl.includes(BASIC_NAMES[col])) have[col] += q; });
      });
      const n = basics || Math.max(0, landTargetLo - landCount);
      if (!n) return "";
      const pips = {};
      sources.forEach((s) => { pips[s.c] = s.pips; });
      const split = suggestBasicSplit(pips, n);
      const parts = sources.filter((s) => split[s.c] || have[s.c]).map((s) => {
        const want = split[s.c] || 0;
        const diff = basics && have[s.c] !== want ? ` <span class="da2-basic-have">(now ${have[s.c]})</span>` : "";
        return `<span class="da2-basic"><span class="da2-srcpip da2-sb-${s.c.toLowerCase()}">${MANA_SVG[s.c.toLowerCase()]}</span>${want} ${BASIC_NAMES[s.c]}${diff}</span>`;
      }).join("");
      const lead = basics ? `Suggested split of your ${basics} basics` : `Suggested basics to reach ${landTargetLo} lands`;
      return `<div class="da2-basics"><div class="da2-basics-lead" title="Split by how many mana symbols of each color your spells need.">${lead}</div><div class="da2-basics-line">${parts}</div></div>`;
    }
    function winConditionsLineHtml(wincons) {
      return wincons.length ? `Win conditions: ${wincons.slice(0, 8).map((w) => esc(w)).join(", ")}` : "Win conditions: none detected";
    }

    // Fill the AI-only parts: verdict, Add/Trim, and AI role-note annotations layered onto
    // the canonical (profile/rule-based) grade. `data.counts` is never used here — role chip
    // counts and the role-detail panel's cards always come from countsFromRoleDetails(daCtx's
    // roleDetails), so what the chips say and what the detail panel lists never diverge.
    function renderAiExtras(data) {
      const v = $("#da2-verdict"); if (v && data.verdict) v.textContent = data.verdict;
      if (daCtx) {
        const grade = applyAiGradeContext(computeGrade(daCtx.counts, daCtx.sources, daCtx.stats, daCtx.profile), data);
        updateGradeUi(grade);
        const chipsCard = $("#da2-chips-card"); if (chipsCard) chipsCard.innerHTML = chipsCardHtml(grade.items);
        const detail = $("#da2-role-detail"); if (detail) { detail.hidden = true; detail.innerHTML = ""; delete detail.dataset.roleKey; }
      }
      const wrap = $("#da2-fix-wrap");
      if (wrap) wrap.innerHTML = fixRowsHtml(data);
    }

    // ═══ Opening hand ═══════════════════════════════════════════════
    // The library: main deck minus the commander, basic lands expanded to their real
    // quantity (cardQty), matching what you'd actually shuffle up and draw from. Reads
    // state via cardQty, so — unlike hypergeomAtLeast/openingHandOdds/drawRandom — it isn't
    // in the pure @testable block.
    function openingHandLibrary(cards, folderId, commanderId) {
      return cards.filter((c) => c.id !== commanderId).flatMap((c) => Array(cardQty(folderId, c.id)).fill(c));
    }
    // Ramp count for the odds model: the analysis' own ramp role count (AI-profile or
    // rule-based, whichever detectRoleDetails used), minus any land or the commander that
    // slipped in under that role — the library excludes both.
    function rampCountForLibrary(roleDetails, cards, commander) {
      const exclude = new Set(cards.filter(isLandCard).map((c) => c.name));
      if (commander) exclude.add(commander.name);
      return (roleDetails.ramp?.cards || []).reduce((n, rc) => n + (exclude.has(rc.name) ? 0 : rc.qty), 0);
    }

    // Per-panel opening-hand demo state — reset whenever the underlying deck sig changes
    // (see renderDeckAnalysis), preserved across incidental re-renders (AI profile loads,
    // grade recompute) so a drawn hand doesn't vanish out from under the user.
    let handState = null; // { hand: Card[], mulligans: number }
    let handStateSig = null;

    function openingHandSectionHtml(odds, commander, { projected = false } = {}) {
      const pct = (p) => Math.round(p * 100);
      const toneLabel = { good: "Good odds", ok: "Borderline", bad: "Poor odds" };
      const stat = (key, label, title = "") => {
        const tone = oddsTone(key, odds[key]);
        return `<div class="da2-hand-line"${title ? ` title="${escAttr(title)}"` : ""}><span>${label}</span><b class="da2-odds da2-odds-${tone}" title="${toneLabel[tone]}">${pct(odds[key])}%</b></div>`;
      };
      const commanderLine = (odds.commanderOnCurve != null && commander)
        ? stat("commanderOnCurve", `${esc(frontFaceName(commander.name))} on curve (turn ${Math.round(commander.cmc || 0)})`, "Approximation — counts lands and ramp together; assumes each ramp piece gives one extra mana.")
        : "";
      const hand = handState?.hand || [];
      const handHtml = hand.length ? `
        ${handState.mulligans > 0 ? `<div class="da2-hand-mull">Mulligan ${handState.mulligans}: put ${handState.mulligans} card${handState.mulligans > 1 ? "s" : ""} on the bottom</div>` : ""}
        <div class="da2-hand-cards">${hand.map((c) => `<button class="da2-hand-card" type="button" data-id="${esc(c.id)}" title="${esc(c.name)}"><img src="${getCardImage(c)}" alt="${esc(c.name)}" loading="lazy"></button>`).join("")}</div>
        <div class="da2-hand-lands">${hand.filter(isLandCard).length} lands</div>` : "";
      return `
        <div class="da-h">Opening hand${projected ? ` <span class="da2-approx">· odds projected to a 99-card deck</span>` : ""}</div>
        <div class="da2-hand-odds">
          ${stat("landsIn7", "3+ lands in opening 7")}
          ${stat("keepableLands", "2–5 lands (keepable)")}
          ${stat("rampByT2", "Ramp by turn 2")}
          ${commanderLine}
        </div>
        <div class="da2-hand-actions">
          <button class="da2-hand-btn" type="button" id="da2-hand-sample">${hand.length ? "New hand" : "Sample hand"}</button>
          <button class="da2-hand-btn" type="button" id="da2-hand-mulligan" ${hand.length ? "" : "disabled"}>Mulligan</button>
        </div>
        ${handHtml}`;
    }

    function renderOpeningHandSection(library, odds, commander, opts = {}) {
      const section = $("#da2-opening-hand");
      if (!section) return;
      if (!library.length) { section.hidden = true; section.innerHTML = ""; return; }
      section.hidden = false;
      section.innerHTML = openingHandSectionHtml(odds, commander, opts);
      const redraw = () => renderOpeningHandSection(library, odds, commander, opts);
      $("#da2-hand-sample").addEventListener("click", () => {
        handState = { hand: drawRandom(library, 7), mulligans: 0 };
        redraw();
      });
      $("#da2-hand-mulligan").addEventListener("click", () => {
        if (!handState) return;
        handState = { hand: drawRandom(library, 7), mulligans: handState.mulligans + 1 };
        redraw();
      });
      section.querySelectorAll(".da2-hand-card").forEach((btn) => {
        btn.addEventListener("click", () => {
          const card = handState?.hand.find((c) => c.id === btn.dataset.id);
          if (card) showDetail(card);
        });
      });
    }

    // ── EDHREC × collection ("From your collection") ────────────────────
    // Session-only cache keyed by commander slug — fetched once no matter how many
    // decks/renders share a commander; picks recompute from this cache on every render
    // (deck/collection changes never trigger a refetch).
    // slug -> { status: "loading" | "ready" | "error", data, error, waiters }. `waiters` (only
    // populated while loading) holds the folderId of every deck currently rendering this
    // commander, so every one of them repaints once the shared fetch resolves — not just
    // whichever deck happened to start it.
    const edhrecCache = new Map();
    let edhrecShowAll = false; // reset alongside handState when the deck signature changes

    function ensureEdhrecLoaded(commanderName, folderId) {
      const slug = commanderSlug(commanderName);
      const existing = edhrecCache.get(slug);
      if (existing) {
        // Another deck sharing this commander may be rendering while the first deck's
        // fetch is still in flight — register it so it also repaints on resolve, instead
        // of only the deck that happened to trigger the fetch.
        if (existing.status === "loading") existing.waiters.add(folderId);
        return existing;
      }
      const entry = { status: "loading", waiters: new Set([folderId]) };
      edhrecCache.set(slug, entry);
      fetch(`/api/edhrec/commander?name=${encodeURIComponent(commanderName)}`)
        .then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || "Couldn't reach EDHREC.");
          entry.status = "ready";
          entry.data = data;
        })
        .catch((err) => {
          entry.status = "error";
          entry.error = err.message || "Couldn't reach EDHREC.";
        })
        .then(() => {
          const waiters = entry.waiters;
          entry.waiters = new Set();
          waiters.forEach((waitFolderId) => rerenderDeckAnalysisIfActive(waitFolderId));
        });
      return entry;
    }

    function edhrecRowHtml(pick) {
      const card = pick.card;
      const isSaved = isCardSaved(card.id);
      const synergyPct = Math.round((pick.synergy || 0) * 100);
      const synergyLabel = synergyPct >= 0 ? `+${synergyPct}%` : `${synergyPct}%`; // a card can carry negative synergy on EDHREC
      const inclusionPct = Math.round((pick.inclusion || 0) * 100);
      return `
        <div class="da2-edhrec-row" data-id="${card.id}">
          <img class="da2-edhrec-thumb" src="${getCardImage(card)}" alt="${esc(card.name)}" loading="lazy">
          <div class="da2-edhrec-meta">
            <div class="da2-edhrec-name">${esc(card.name)}</div>
            <div class="da2-edhrec-stats">${synergyLabel} synergy · in ${inclusionPct}% of decks · ${esc(pick.category)}</div>
          </div>
          <button class="icon-btn save-btn ${isSaved ? "saved" : ""}" data-id="${card.id}" title="${isSaved ? "Saved" : "Save"}" aria-label="${isSaved ? "Remove from saved" : "Save"}">${bookmarkIcon(isSaved)}</button>
        </div>`;
    }

    function edhrecSectionHtml(picks, commander) {
      const shown = edhrecShowAll ? picks : picks.slice(0, 12);
      const hasMore = picks.length > 12;
      const slug = commanderSlug(commander.name);
      const body = picks.length
        ? `<div class="da2-edhrec-list">${shown.map(edhrecRowHtml).join("")}</div>
           ${hasMore ? `<button class="da2-hand-btn da2-edhrec-more" type="button" id="da2-edhrec-more">${edhrecShowAll ? "Show less" : `Show all ${picks.length}`}</button>` : ""}`
        : `<div class="da2-vsub">None of EDHREC's picks for this commander are in your collection yet.</div>`;
      return `
        <div class="da-h">From your collection</div>
        <div class="da2-vsub">EDHREC picks for ${esc(frontFaceName(commander.name))} you already own</div>
        ${body}
        <div class="da2-edhrec-foot">Data from <a href="https://edhrec.com/commanders/${esc(slug)}" target="_blank" rel="noopener">EDHREC</a></div>`;
    }

    function renderEdhrecSection(deck, commander, folderId) {
      const section = $("#da2-edhrec");
      if (!section) return;
      if (!deck || !commander || !hasCollection()) { section.hidden = true; section.innerHTML = ""; return; }
      const entry = ensureEdhrecLoaded(commander.name, folderId);
      section.hidden = false;
      if (entry.status === "loading") {
        section.innerHTML = `<div class="da-h">From your collection</div><div class="da2-vsub">Loading EDHREC picks…</div>`;
        return;
      }
      if (entry.status === "error") {
        section.innerHTML = `<div class="da-h">From your collection</div><div class="da2-vsub">${esc(entry.error)} <button class="da2-chip muted cta" id="da2-edhrec-retry" type="button" style="margin-left:6px">Retry</button></div>`;
        $("#da2-edhrec-retry").addEventListener("click", () => {
          edhrecCache.delete(commanderSlug(commander.name));
          renderEdhrecSection(deck, commander, folderId);
        });
        return;
      }
      const ownedByName = new Map();
      (collectionIndex?.list || []).forEach((it) => {
        const key = frontFaceName(it.card.name).toLowerCase();
        if (!ownedByName.has(key)) ownedByName.set(key, it.card);
      });
      const deckNames = new Set(getFolderCards(folderId).map((c) => frontFaceName(c.name).toLowerCase()));
      const picks = edhrecPicks(entry.data.cards, ownedByName, deckNames);
      section.innerHTML = edhrecSectionHtml(picks, commander);
      section.querySelectorAll(".da2-edhrec-row").forEach((row) => {
        const pick = picks.find((p) => String(p.card.id) === row.dataset.id);
        if (!pick) return;
        const card = pick.card;
        row.querySelector(".da2-edhrec-thumb").addEventListener("click", () => showDetail(card));
        row.querySelector(".da2-edhrec-meta").addEventListener("click", () => showDetail(card));
        row.querySelector(".save-btn").addEventListener("click", (e) => { e.stopPropagation(); openSavePopover(card, e.currentTarget); });
        row.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); openCardContextMenu(card, e.clientX, e.clientY, { deckActions: false }); });
      });
      $("#da2-edhrec-more")?.addEventListener("click", () => {
        edhrecShowAll = !edhrecShowAll;
        renderEdhrecSection(deck, commander, folderId);
      });
    }

    // ═══ Colour balance + land swaps (Mana tab) ═══════════════════════
    const BASIC_OF = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
    // A card you can play as your land drop. Transforming cards (Growing Rites of Itlimoc)
    // only flip into a land later, so they count only when the front face is a land;
    // modal double-faced cards (Emeria's Call) can be played as their land side.
    function playableAsLand(c) {
      if (!isLandCard(c)) return false;
      if (c.layout !== "transform") return true;
      return /\bLand\b/.test(String(c.card_faces?.[0]?.type_line || c.type_line || "").split(" // ")[0]);
    }
    // The deck's lands with the colours they make and whether they enter tapped early.
    // Fetch lands count as every deck colour; basics are expanded to their quantity.
    function deckLandInfo(cards, folderId, colors) {
      return cards.filter(playableAsLand).flatMap((c) => {
        const oracle = getOracleText(c);
        const fetches = /search your library for (a|an).*land|search your library for.*basic land/i.test(oracle);
        const produces = fetches ? colors.slice() : [...new Set(cardProduces(c).filter((m) => WUBRG.includes(m)))];
        const info = { name: c.name, id: c.id, produces, tapped: landEntersTapped(oracle), eur: priceNum(c) || 0, card: c };
        return Array(isBasicLand(c) ? cardQty(folderId, c.id) : 1).fill(info);
      });
    }
    function colorBalanceFor(cards, folderId, colors, sources) {
      const lands = deckLandInfo(cards, folderId, colors);
      const landSources = {};
      colors.forEach((c) => { landSources[c] = 0; });
      lands.forEach((l) => l.produces.forEach((c) => { if (c in landSources) landSources[c]++; }));
      const pips = {};
      sources.forEach((s) => { pips[s.c] = s.pips; });
      return { lands, balance: colorBalance({ pips, landSources }) };
    }
    function colorsTableHtml(sources, balance) {
      if (!sources.length) return `<div class="da2-vsub">Colourless: no coloured sources needed.</div>`;
      const byC = Object.fromEntries(balance.map((b) => [b.c, b]));
      const rows = sources.map((s) => {
        const b = byC[s.c];
        const st = s.status === "ok" ? "good" : s.status === "low" ? "warn" : "bad";
        const label = st === "good" ? "OK" : st === "warn" ? "Low" : "Short";
        return `<tr>
          <td><span class="da2-srcpip da2-sb-${s.c.toLowerCase()}">${MANA_SVG[s.c.toLowerCase()]}</span></td>
          <td class="ct-n">${fmtScoreNum(s.have)}</td>
          <td class="ct-need">${s.need}</td>
          <td>${b ? `<div class="ct-share" title="${Math.round(b.pipShare * 100)}% of your mana symbols · ${Math.round(b.srcShare * 100)}% of your land colour sources"><i class="need" style="width:${(b.pipShare * 100).toFixed(1)}%"></i><i class="have ${b.status}" style="width:${(b.srcShare * 100).toFixed(1)}%"></i></div>` : ""}</td>
          <td><span class="da2-odds da2-odds-${st === "good" ? "good" : st === "warn" ? "ok" : "bad"}">${label}</span></td>
        </tr>`;
      }).join("");
      const worst = balance.filter((b) => b.status === "short").sort((a, b) => a.delta - b.delta)[0];
      const name = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
      const note = worst ? `<div class="cb-msg warn">${name[worst.c]} is ${Math.round(worst.pipShare * 100)}% of your mana symbols but only ${Math.round(worst.srcShare * 100)}% of your land colour sources.</div>` : "";
      return `<table class="ct"><thead><tr><th></th><th>Sources</th><th>Need</th><th>Symbols / lands</th><th></th></tr></thead><tbody>${rows}</tbody></table>${note}`;
    }
    function colorBalanceHtml(balance) {
      if (balance.length < 2) return "";
      const rows = balance.map((b) => `
        <div class="cb-row">
          <span class="da2-srcpip da2-sb-${b.c.toLowerCase()}">${MANA_SVG[b.c.toLowerCase()]}</span>
          <div class="cb-bars">
            <div class="cb-bar"><i class="need" style="width:${(b.pipShare * 100).toFixed(1)}%"></i></div>
            <div class="cb-bar"><i class="have ${b.status}" style="width:${(b.srcShare * 100).toFixed(1)}%"></i></div>
          </div>
          <span class="cb-nums">${Math.round(b.pipShare * 100)}% <span>/</span> ${Math.round(b.srcShare * 100)}%</span>
        </div>`).join("");
      const worst = balance.filter((b) => b.status === "short").sort((a, b) => a.delta - b.delta)[0];
      const over = balance.filter((b) => b.status === "over").sort((a, b) => b.delta - a.delta)[0];
      const name = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };
      const msg = worst
        ? `${name[worst.c]} is ${Math.round(worst.pipShare * 100)}% of your mana symbols but only ${Math.round(worst.srcShare * 100)}% of your land colour sources${over ? `, while ${name[over.c].toLowerCase()} gets ${Math.round(over.srcShare * 100)}% for ${Math.round(over.pipShare * 100)}% of the symbols` : ""}.`
        : "Your lands' colours match what your spells ask for.";
      return `<div class="cb">
        <div class="da-h" style="margin:0 0 6px">Colour balance</div>
        <div class="cb-legend"><span><i class="need"></i>share of mana symbols</span><span><i class="have ok"></i>share of land colour sources</span></div>
        ${rows}
        <div class="cb-msg ${worst ? "warn" : ""}">${esc(msg)}</div>
        <div id="da2-land-swaps"></div>
      </div>`;
    }

    // Replacement candidates for the short colours: dual/tri land cycles from Scryfall
    // (one search, cached per identity + short colours) plus the basics of those colours.
    const landSwapCache = new Map();
    async function landSwapCandidates(colors, shortColors, inDeck) {
      const ci = colors.join("").toLowerCase();
      const key = `${ci}|${shortColors.join("")}`;
      if (!landSwapCache.has(key)) {
        const cycles = ["shockland", "checkland", "fastland", "painland", "slowland", "tricycleland", "pathway", "bondland", "gainland", "scryland"];
        const q = `t:land -t:basic id<=${ci} (${shortColors.map((c) => `produces:${c.toLowerCase()}`).join(" or ")}) (${cycles.map((c) => `is:${c}`).join(" or ")}) game:paper`;
        const p = fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=eur&dir=asc`)
          .then((r) => (r.ok ? r.json() : { data: [] }))
          .then((d) => (d.data || []).map((c) => ({
            name: c.name, card: c, basic: false,
            produces: [...new Set((c.produced_mana || []).filter((m) => WUBRG.includes(m)))],
            tapped: landEntersTapped(c.oracle_text || (c.card_faces || []).map((f) => f.oracle_text).join("\n")),
            eur: Number(c.prices?.eur || c.prices?.eur_foil || 0) || 0,
          })))
          .catch(() => []);
        landSwapCache.set(key, p);
      }
      const fetched = (await landSwapCache.get(key)).filter((c) => !inDeck.has(c.name.toLowerCase()));
      const basics = shortColors.map((c) => ({ name: BASIC_OF[c], basic: true, produces: [c], tapped: false, eur: 0 }));
      return [...fetched, ...basics].map((c) => ({ ...c, owned: c.basic || ownsCardNamed(c.name) }));
    }
    async function renderLandSwaps(folderId, cards, colors, lands, balance) {
      const el = $("#da2-land-swaps");
      if (!el) return;
      const shortColors = balance.filter((b) => b.status === "short").map((b) => b.c);
      if (!shortColors.length) { el.innerHTML = ""; return; }
      const cuts = suggestLandCuts([...new Map(lands.map((l) => [l.name, l])).values()], balance);
      if (!cuts.length) { el.innerHTML = ""; return; }
      el.innerHTML = `<div class="da2-vsub" style="margin-top:10px">Finding better lands…</div>`;
      const inDeck = new Set(cards.map((c) => c.name.toLowerCase()));
      const candidates = await landSwapCandidates(colors, shortColors, inDeck);
      const target = $("#da2-land-swaps");
      if (!target || state.activeFolder !== folderId) return;
      const pairs = pairLandSwaps(cuts, candidates, balance).filter((p) => p.add);
      const eur = (v) => `€${(v || 0).toFixed(2)}`;
      const price = (c) => (c.basic ? "basic" : c.owned ? "owned" : eur(c.eur));
      target.innerHTML = pairs.length ? `
        <div class="da-h" style="margin:14px 0 8px">Land swaps · similar budget</div>
        <div class="ls-list">${pairs.map(({ cut, add, overBudget }) => `
          <div class="ls-row">
            <span class="da2-chip trim da2-card-chip" data-card="${esc(cut.name)}" role="button" tabindex="0">− ${esc(cut.name)}</span>
            <span class="ls-price">${eur(cut.eur)}${cut.tapped ? " · tapped" : ""}</span>
            <span class="da2-swap-arrow" aria-hidden="true">→</span>
            <span class="da2-chip add da2-card-chip" data-card="${esc(add.name)}" role="button" tabindex="0">${esc(add.name)}</span>
            <span class="ls-price${add.owned ? " own" : ""}">${price(add)}${add.tapped ? " · tapped" : ""}${overBudget ? " · over budget" : ""}</span>
          </div>`).join("")}</div>
        <div class="sim-note">Cuts are lands whose colours lean toward what you have too much of; each replacement makes your short colours and costs at most about 1.5× the land it replaces. Lands you own and basics count as free.</div>` : "";
      target.querySelectorAll(".da2-card-chip").forEach((chip) => {
        chip.addEventListener("click", () => openCardByName(chip.dataset.card));
        chip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCardByName(chip.dataset.card); } });
      });
    }

    // ═══ New deck dialog: choose a commander ════════════════════════════
    // Opened by "+ New deck" (creates a deck) or the empty-deck screen (sets the commander of
    // that deck). Commanders you own come first; the search covers every legal commander on
    // Scryfall, most popular first.
    let ndCtx = null; // { deck, query, ownedOnly, results, picked, themes, numDecks, name, seq }
    const isCommanderCard = (c) => c && c.legalities?.commander === "legal"
      && (/Legendary/.test(c.type_line || "") && /Creature/.test((c.type_line || "").split(" // ")[0]) || /can be your commander/i.test(getOracleText(c)));
    function ownedCommanders(query) {
      if (!collectionIndex) return [];
      const q = query.trim().toLowerCase();
      return collectionIndex.list.map((it) => it.card)
        .filter((c) => isCommanderCard(c) && (!q || c.name.toLowerCase().includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 12);
    }
    async function searchCommanders(query) {
      const q = `is:commander f:commander game:paper${query.trim() ? ` ${query.trim()}` : ""}`;
      const r = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=edhrec&unique=cards`);
      if (r.status === 404) return [];
      if (!r.ok) throw new Error("Couldn't reach Scryfall.");
      return ((await r.json()).data || []).slice(0, 24);
    }
    function ndTile(c) {
      const owned = ownedQty(collectionIndex, c) > 0;
      const sel = ndCtx.picked && ndCtx.picked.id === c.id;
      return `<button type="button" class="nd-cmd${sel ? " sel" : ""}" data-nd-pick="${esc(c.id)}">
        <span class="nd-art"><img src="${getCardImage(c)}" alt="" loading="lazy">${owned ? `<span class="owned-inline nd-own">Owned</span>` : ""}</span>
        <span class="nd-meta"><b>${esc(frontFaceName(c.name))}</b>${(c.color_identity || []).join("") || "C"}</span>
      </button>`;
    }
    function renderNewDeck() {
      const body = $("#nd-body");
      if (!body || !ndCtx) return;
      $("#nd-title").textContent = ndCtx.deck ? `Choose a commander for ${ndCtx.deck.name}` : "New deck · choose a commander";
      const owned = ownedCommanders(ndCtx.query);
      const results = ndCtx.ownedOnly ? [] : ndCtx.results;
      const p = ndCtx.picked;
      const side = p ? `
          <span class="nd-art nd-side-art"><img src="${getCardImage(p)}" alt="${esc(p.name)}"></span>
          <h3>${esc(p.name)}</h3>
          <div class="da2-vsub">${(p.color_identity || []).join("") || "Colourless"}${ndCtx.numDecks ? ` · ${ndCtx.numDecks.toLocaleString()} decks on EDHREC` : ""}${ownedQty(collectionIndex, p) > 0 ? " · you own it" : ""}</div>
          ${ndCtx.themes.length ? `<div class="nd-themes">${ndCtx.themes.slice(0, 6).map((t) => `<span>${esc(t.name)} <em>${t.count}</em></span>`).join("")}</div>` : ""}
          ${ndCtx.deck ? "" : `<label class="nd-name">Deck name<input id="nd-name" value="${esc(ndCtx.name)}" maxlength="80"></label>`}`
        : `<div class="nd-side-empty"><div class="deck-start-crown" aria-hidden="true">♛</div><b>Pick a commander</b><span>Click a card on the left to see it here.</span></div>`;
      body.innerHTML = `
        <div class="nd-layout">
          <div class="nd-main">
            <div class="nd-search"><span aria-hidden="true">⌕</span><input id="nd-q" type="search" placeholder="Search commanders… e.g. Codie, Atraxa, t:dragon" value="${esc(ndCtx.query)}" autocomplete="off"></div>
            <div class="nd-filters"><div class="nd-seg" role="group" aria-label="Which commanders">
              <button type="button" data-nd-owned="0" class="${ndCtx.ownedOnly ? "" : "on"}">All commanders</button>
              <button type="button" data-nd-owned="1" class="${ndCtx.ownedOnly ? "on" : ""}">I own</button></div></div>
            ${owned.length ? `<div class="da-h nd-h">From your collection</div><div class="nd-results">${owned.map(ndTile).join("")}</div>` : (ndCtx.ownedOnly ? `<div class="da2-vsub">No owned commanders match.${hasCollection() ? "" : " Upload your collection on the Collection tab."}</div>` : "")}
            ${ndCtx.ownedOnly ? "" : `<div class="da-h nd-h">${ndCtx.searching ? "Searching…" : "Most popular first"}</div>
              ${ndCtx.error ? `<div class="da2-vsub">${esc(ndCtx.error)}</div>` : `<div class="nd-results">${results.map(ndTile).join("") || `<span class="da2-vsub">No commanders match.</span>`}</div>`}`}
          </div>
          <aside class="nd-side" aria-live="polite">
            <div class="nd-side-card">${side}</div>
            <div class="nd-side-actions">
              <button class="af-primary" type="button" data-nd-create="fill" ${p ? "" : "disabled"}>${ndCtx.deck ? "Set & Autofill" : "Create & Autofill"}</button>
              <button class="btn-plain" type="button" data-nd-create="plain" ${p ? "" : "disabled"}>${ndCtx.deck ? "Set commander" : "Create deck"}</button>
              <button class="btn-plain" type="button" data-nd-close>Cancel</button>
              <span class="da2-vsub">You can change the commander later with the crown.</span>
            </div>
          </aside>
        </div>`;
    }
    let ndSearchTimer = null;
    function ndRunSearch() {
      const seq = ++ndCtx.seq;
      ndCtx.searching = true; ndCtx.error = "";
      renderNewDeck();
      refocusNdSearch();
      searchCommanders(ndCtx.query)
        .then((list) => { if (ndCtx && seq === ndCtx.seq) { ndCtx.results = list; ndCtx.searching = false; renderNewDeck(); refocusNdSearch(); } })
        .catch((err) => { if (ndCtx && seq === ndCtx.seq) { ndCtx.error = err.message; ndCtx.searching = false; renderNewDeck(); refocusNdSearch(); } });
    }
    function refocusNdSearch() {
      const input = $("#nd-q");
      if (input && ndCtx?.typing) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
    function openNewDeck({ deck = null } = {}) {
      ndCtx = { deck, query: "", ownedOnly: false, results: [], picked: null, themes: [], numDecks: 0, name: "", seq: 0, searching: false, error: "", typing: false };
      $("#nd-dialog").hidden = false;
      ndRunSearch();
      setTimeout(() => $("#nd-q")?.focus(), 0);
    }
    function closeNewDeck() { $("#nd-dialog").hidden = true; ndCtx = null; }
    async function pickCommander(card) {
      const scroller = $(".nd-main");
      const keep = scroller ? scroller.scrollTop : 0;
      ndCtx.picked = card;
      ndCtx.name = frontFaceName(card.name).split(",")[0];
      ndCtx.themes = []; ndCtx.numDecks = 0; ndCtx.typing = false;
      renderNewDeck();
      if ($(".nd-main")) $(".nd-main").scrollTop = keep;
      try {
        const d = await edhrecPage(card.name);
        if (ndCtx && ndCtx.picked?.id === card.id) {
          ndCtx.themes = (d.themes || []).filter((t) => !/companion/i.test(t.slug));
          ndCtx.numDecks = d.numDecks || 0;
          const s = $(".nd-main"), top = s ? s.scrollTop : 0;
          renderNewDeck();
          if ($(".nd-main")) $(".nd-main").scrollTop = top;
        }
      } catch { /* themes are a nice-to-have */ }
    }
    function createFromNewDeck(mode) {
      const card = ndCtx.picked;
      if (!card) return;
      let deck = ndCtx.deck;
      if (!deck) {
        deck = createFolder(($("#nd-name")?.value || ndCtx.name || frontFaceName(card.name)).trim());
        if (!deck) return;
      }
      setCardFolder(card, deck.id, true);
      if (deck.commanderId !== card.id) setDeckCommander(deck.id, card.id);
      state.activeFolder = deck.id;
      closeNewDeck();
      if (state.activeTab !== "saved") setActiveTab("saved");
      renderFolderRail();
      renderSavedCards();
      if (mode === "fill") openAutofill(deck, card);
    }
    document.addEventListener("click", (e) => {
      const dlg = $("#nd-dialog");
      if (!dlg || dlg.hidden || !ndCtx) return;
      const t = e.target;
      if (t === dlg || t.closest("[data-nd-close]")) { closeNewDeck(); return; }
      const own = t.closest("[data-nd-owned]");
      if (own) { ndCtx.ownedOnly = own.dataset.ndOwned === "1"; renderNewDeck(); return; }
      const pick = t.closest("[data-nd-pick]");
      if (pick) {
        const id = pick.dataset.ndPick;
        const card = [...ndCtx.results, ...ownedCommanders(ndCtx.query)].find((c) => c.id === id);
        if (card) pickCommander(card);
        return;
      }
      const create = t.closest("[data-nd-create]");
      if (create && !create.disabled) createFromNewDeck(create.dataset.ndCreate);
    });
    document.addEventListener("input", (e) => {
      if (!ndCtx) return;
      if (e.target.id === "nd-name") { ndCtx.name = e.target.value; return; }
      if (e.target.id !== "nd-q") return;
      ndCtx.query = e.target.value;
      ndCtx.typing = true;
      clearTimeout(ndSearchTimer);
      ndSearchTimer = setTimeout(ndRunSearch, 350);
    });
    document.addEventListener("keydown", (e) => {
      const dlg = $("#nd-dialog");
      if (dlg && !dlg.hidden && e.key === "Escape") closeNewDeck();
    });

    // ═══ Autofill (dialog: setup → preview → add) ═══════════════════════
    // Candidates come from EDHREC (the commander page, chosen theme pages, and the budget
    // page), checked against Scryfall for colour identity, legality, price, Game Changer
    // status and role. Free: no AI.
    const AF_OPTS_KEY = "autofill_opts";
    const afOpts = (() => {
      const d = { themes: [], budget: 50, cap: "", ownedFirst: true, onlyOwned: false };
      try { return { ...d, ...JSON.parse(localStorage.getItem(AF_OPTS_KEY) || "{}"), themes: [] }; } catch { return d; }
    })();
    let afCtx = null; // { deck, commander, folderId, themes, plan, basics, stage }

    async function edhrecPage(commanderName, page = null) {
      const r = await fetch(`/api/edhrec/commander?name=${encodeURIComponent(commanderName)}${page ? `&page=${encodeURIComponent(page)}` : ""}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't reach EDHREC.");
      return d;
    }
    async function scryfallByNames(names) {
      const byName = new Map();
      const uniq = [...new Set(names)];
      for (let i = 0; i < uniq.length; i += 75) {
        const res = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifiers: uniq.slice(i, i + 75).map((n) => ({ name: n })) }),
        });
        if (res.ok) ((await res.json()).data || []).forEach((c) => {
          byName.set(c.name.toLowerCase(), c);
          byName.set(frontFaceName(c.name).toLowerCase(), c);
        });
        if (i + 75 < uniq.length) await new Promise((r) => setTimeout(r, 110));
      }
      return byName;
    }
    function cardRoles(card) {
      const prof = profileCache.get(cardOracleId(card));
      return prof ? rolesFromProfile(card, prof) : classifyRoleCard(card);
    }

    async function buildAutofillPlan() {
      const { deck, commander, folderId } = afCtx;
      const all = getFolderCards(folderId);
      const main = all.filter((c) => !isMaybe(folderId, c.id));
      const colors = deckColors(main, commander);
      const s = computeDeckStats(main, folderId);
      const review = deckReviewCache[folderId]?.data;
      const profile = effectiveDeckProfile(Array.isArray(review?.identityTags) ? review.identityTags : []);
      const counts = countsFromRoleDetails(detectRoleDetails(main, folderId, profilesFromCache(main)));
      const needs = autofillNeeds({ total: s.total, lands: s.lands, counts, profile, themeCount: afOpts.themes.length });

      // EDHREC lists: commander page, chosen themes, and the budget page when money is tight.
      const pages = [{ page: null }, ...afOpts.themes.map((t) => ({ page: t, theme: t }))];
      if (Number(afOpts.budget) > 0 && Number(afOpts.budget) <= 150) pages.push({ page: "budget" });
      const lists = await Promise.all(pages.map((p) => edhrecPage(commander.name, p.page).then((d) => ({ ...p, cards: d.cards || [] })).catch(() => ({ ...p, cards: [] }))));
      const names = lists.flatMap((l) => l.cards.map((c) => c.name));
      const byName = await scryfallByNames(names);
      const gcSet = await loadGameChangers();
      const inDeck = new Set(all.map((c) => frontFaceName(c.name).toLowerCase()));

      // One candidate per (list, card); `fit` drops off-colour, illegal and in-deck cards.
      // Price: EUR (or foil), else USD converted; null = unknown (only taken when owned).
      const afPrice = (card) => {
        const eur = priceNum(card);
        if (eur != null) return eur;
        const usd = parseFloat(card.prices?.usd ?? card.prices?.usd_foil);
        return Number.isFinite(usd) ? usd * 0.92 : null;
      };
      const cand = (e, card, themed = false) => ({
        name: card.name, card, eur: afPrice(card), owned: ownedQty(collectionIndex, card) > 0,
        // Theme steps rank by synergy (theme-specific), others by how often it's played.
        score: themed ? (e.synergy || 0) * 100 + (e.inclusion || 0) * 30 : (e.inclusion || 0) * 100 + (e.synergy || 0) * 40,
        gc: card.game_changer === true || gcSet.has(frontFaceName(card.name).toLowerCase()),
      });
      const fit = (card) => card && card.legalities?.commander === "legal"
        && (card.color_identity || []).every((c) => colors.includes(c))
        && !inDeck.has(frontFaceName(card.name).toLowerCase()) && card.id !== commander.id;
      const fromList = (l) => l.cards.map((e) => [e, byName.get(e.name.toLowerCase())]).filter(([, c]) => fit(c));
      const main_ = lists.filter((l) => !l.theme);
      const nonland = main_.flatMap(fromList).filter(([, c]) => !playableAsLand(c));
      const byRole = (role) => nonland.filter(([, c]) => cardRoles(c)[role]).map(([e, c]) => cand(e, c));

      const themeSteps = afOpts.themes.map((t, i) => {
        const l = lists.find((x) => x.theme === t);
        const per = Math.floor(needs.theme / afOpts.themes.length) + (i < needs.theme % afOpts.themes.length ? 1 : 0);
        const name = afCtx.themes.find((x) => x.slug === t)?.name || t;
        return { key: `theme:${t}`, label: `Theme · ${name}`, target: `${per}`, need: per, pool: l ? fromList(l).filter(([, c]) => !playableAsLand(c)).map(([e, c]) => cand(e, c, true)) : [] };
      });
      // Non-basic lands: the more colours, the more duals; basics fill the rest to 100.
      const nbShare = colors.length >= 3 ? 0.75 : colors.length === 2 ? 0.55 : 0.2;
      const landPool = lists.flatMap(fromList).filter(([, c]) => playableAsLand(c) && !isBasicLand(c))
        .map(([e, c]) => {
          const base = cand(e, c);
          const makesColour = landColors(c).size > 0; // fetches count as every colour
          return { ...base, score: base.score - (landEntersTapped(getOracleText(c)) ? 15 : 0) - (makesColour ? 0 : 40) };
        });
      const steps = [
        { key: "ramp", label: "Ramp", target: `+${needs.ramp}`, need: needs.ramp, pool: byRole("ramp") },
        { key: "draw", label: "Card draw", target: `+${needs.draw}`, need: needs.draw, pool: byRole("draw") },
        { key: "removal", label: "Removal", target: `+${needs.removal}`, need: needs.removal, pool: byRole("removal") },
        { key: "wipes", label: "Board wipes", target: `+${needs.wipes}`, need: needs.wipes, pool: byRole("wipes") },
        ...themeSteps,
        { key: "rest", label: "Rest · most played for this commander", target: `${needs.rest}`, need: needs.rest, pool: nonland.map(([e, c]) => cand(e, c)) },
        { key: "lands", label: "Non-basic lands", target: `${Math.round(needs.lands * nbShare)}`, need: Math.round(needs.lands * nbShare), pool: landPool, land: true },
      ].filter((st) => st.need > 0);
      const gcInDeck = main.filter((c) => gcSet.has(frontFaceName(c.name).toLowerCase())).length;
      const allowGc = (deckBracket[folderId] || 2) >= 3;
      const plan = planAutofill({
        steps,
        budget: Number(afOpts.budget) > 0 ? Number(afOpts.budget) : Infinity,
        cap: Number(afOpts.cap) > 0 ? Number(afOpts.cap) : Infinity,
        onlyOwned: afOpts.onlyOwned, ownedFirst: afOpts.ownedFirst,
        gcAllowance: allowGc ? Math.max(0, 3 - gcInDeck) : 0,
        backfill: { label: "Backfill · other good fits", pool: [...nonland.map(([e, c]) => cand(e, c)), ...lists.filter((l) => l.theme).flatMap(fromList).filter(([, c]) => !playableAsLand(c)).map(([e, c]) => cand(e, c, true))] },
      });

      // Basics to reach 100, split by the colour symbols of the finished deck.
      const after = s.total + plan.added;
      const basicsNeed = colors.length ? Math.max(0, 100 - after) : 0;
      const pips = {};
      colors.forEach((c) => { pips[c] = 0; });
      [...main, ...plan.steps.flatMap((st) => st.picks.map((p) => p.card))].forEach((c) => {
        if (!playableAsLand(c)) Object.entries(coloredPipCounts(c)).forEach(([col, n]) => { if (col in pips) pips[col] += n; });
      });
      const split = suggestBasicSplit(pips, basicsNeed);
      const basicCards = Object.keys(split).length ? await scryfallByNames(Object.keys(split).map((c) => BASIC_OF[c])) : new Map();
      const basics = Object.entries(split).filter(([, n]) => n > 0).map(([c, n]) => ({ color: c, qty: n, card: basicCards.get(BASIC_OF[c].toLowerCase()) })).filter((b) => b.card);
      return { plan, basics, allowGc, colors };
    }

    function afSetupHtml() {
      const tg = (key, label, help) => `<div class="af-tg${afOpts[key] ? " on" : ""}" role="switch" tabindex="0" aria-checked="${afOpts[key]}" data-af-tg="${key}"><span class="af-sw"></span><span>${label}<small>${help}</small></span></div>`;
      const strategy = afCtx.themes.filter((t) => !/companion/i.test(t.slug)).slice(0, 14);
      const restrict = afCtx.themes.filter((t) => /companion/i.test(t.slug));
      const allowGc = (deckBracket[afCtx.folderId] || 2) >= 3;
      return `<div class="af">
        <div class="af-sec"><div class="da-h">Themes · from EDHREC decks for ${esc(frontFaceName(afCtx.commander.name))}</div>
          <div class="af-themes">${strategy.length ? strategy.map((t) => `<button type="button" class="af-theme${afOpts.themes.includes(t.slug) ? " on" : ""}" data-af-theme="${esc(t.slug)}">${esc(t.name)}<span>${t.count}</span></button>`).join("") : `<span class="da2-vsub">EDHREC has no themes for this commander yet.</span>`}</div>
          <div class="da2-vsub">Pick up to 3; each adds about 8 cards.${restrict.length ? ` Companion builds (not themes): ${restrict.map((t) => esc(t.name)).join(", ")}.` : ""}</div></div>
        <div class="af-sec"><div class="da-h">Budget · for cards you don't own</div>
          <div class="af-row2">
            <label class="af-field">Total<span class="af-money"><span>€</span><input id="af-budget" type="number" min="0" step="5" value="${esc(String(afOpts.budget))}" placeholder="no limit"></span></label>
            <label class="af-field">Max per card (optional)<span class="af-money"><span>€</span><input id="af-cap" type="number" min="0" step="1" value="${esc(String(afOpts.cap))}" placeholder="no cap"></span></label>
          </div></div>
        <div class="af-sec"><div class="da-h">Options</div><div class="af-toggles">
          ${tg("ownedFirst", "Use my collection first", "Cards you own count as free and are picked before others.")}
          ${tg("onlyOwned", "Only cards I own", "Fill only from your collection; slots it can't fill stay open.")}
          <div class="da2-vsub">${allowGc ? "Bracket 3 deck: up to 3 Game Changers in total." : "No Game Changers, so the deck stays bracket 2."}</div>
        </div></div>
      </div>`;
    }
    function afPreviewHtml() {
      const { plan, basics } = afCtx;
      const basicCount = basics.reduce((n, b) => n + b.qty, 0);
      const added = plan.added + basicCount;
      const rows = plan.steps.map((st, i) => `
        <div class="af-step" data-af-step="${i}" role="button" tabindex="0" aria-expanded="false">
          <span class="nm">${esc(st.label)}${st.short ? ` <span class="short">${st.short} short</span>` : ""}</span>
          <span class="own">${st.picks.filter((p) => p.owned).length} owned</span>
          <span class="ct">+${st.picks.length}</span>
        </div>
        <div class="af-step-cards" hidden>${st.picks.map((p) => `<span class="af-cc${p.owned ? " owned" : ""}" data-card="${esc(p.name)}">${esc(p.name)}<em>${p.owned ? "owned" : `€${p.cost.toFixed(2)}`}</em></span>`).join("") || `<span class="da2-vsub">Nothing fit the budget and filters.</span>`}</div>`).join("");
      const basicsRow = basicCount ? `<div class="af-step static"><span class="nm">Basic lands · ${basics.map((b) => `${b.qty} ${BASIC_OF[b.color]}`).join(", ")}</span><span class="own">basic</span><span class="ct">+${basicCount}</span></div>` : "";
      const budgetTxt = Number(afOpts.budget) > 0 ? `€${Number(afOpts.budget).toFixed(0)}` : "no limit";
      // Spell slots nothing filled (after backfill) end up as extra basic lands — say so.
      const spellGap = plan.steps.filter((st) => st.key !== "lands" && st.key !== "backfill").reduce((n, st) => n + st.short, 0)
        - (plan.steps.find((st) => st.key === "backfill")?.picks.length || 0);
      const shortNote = spellGap > 0
        ? `<div class="af-warn">${spellGap} spell slot${spellGap === 1 ? "" : "s"} couldn't be filled ${afOpts.onlyOwned ? "from your collection" : `within ${budgetTxt}`}, so they'll be extra basic lands. Raise the budget${afOpts.onlyOwned ? ", turn off Only cards I own," : ""} or add a theme for more options.</div>`
        : "";
      return `<div class="af">
        <div class="af-total"><div><span>Adds</span><b>${added}</b></div><div><span>Owned</span><b class="good">${plan.owned}</b></div><div><span>To buy</span><b>€${plan.spent.toFixed(2)}</b></div><div><span>Budget</span><b>${budgetTxt}</b></div></div>
        <div class="af-steps">${rows}${basicsRow}</div>
        ${shortNote}
        <div class="da2-vsub">Click a step to see its cards. Over-budget picks were replaced by the next-best card.</div>
      </div>`;
    }
    function renderAutofill() {
      const body = $("#af-body");
      if (!body || !afCtx) return;
      $("#af-stage").innerHTML = afCtx.stage === "setup" ? "<b>1 Setup</b> · 2 Preview" : "1 Setup · <b>2 Preview</b>";
      if (afCtx.stage === "loading") { body.innerHTML = `<div class="da2-vsub">${esc(afCtx.loadingText || "Loading…")}</div>`; return; }
      if (afCtx.stage === "error") { body.innerHTML = `<div class="da2-vsub">${esc(afCtx.error)}</div><div class="af-foot"><button class="btn-plain" type="button" data-af-close>Close</button></div>`; return; }
      const preview = afCtx.stage === "preview";
      const n = preview ? afCtx.plan.added + afCtx.basics.reduce((a, b) => a + b.qty, 0) : 0;
      body.innerHTML = (preview ? afPreviewHtml() : afSetupHtml()) + (preview
        ? `<div class="af-foot"><button class="btn-plain" type="button" data-af-go="setup">Back</button><button class="af-primary" type="button" data-af-apply ${n ? "" : "disabled"}>Add ${n} cards</button></div>`
        : `<div class="af-foot"><button class="btn-plain" type="button" data-af-close>Cancel</button><button class="af-primary" type="button" data-af-go="preview">Preview fill</button></div>`);
    }
    async function openAutofill(deck, commander) {
      const dlg = $("#af-dialog");
      if (!commander) { showToast("Set a commander first: the crown on a legendary creature in the deck."); return; }
      afCtx = { deck, commander, folderId: deck.id, themes: [], stage: "loading", loadingText: "Loading themes from EDHREC…" };
      afOpts.themes = [];
      dlg.hidden = false;
      renderAutofill();
      try {
        afCtx.themes = (await edhrecPage(commander.name)).themes || [];
        afCtx.stage = "setup";
      } catch (err) {
        afCtx.stage = "error"; afCtx.error = err.message;
      }
      renderAutofill();
      dlg.querySelector("button, [tabindex]")?.focus();
    }
    function closeAutofill() { $("#af-dialog").hidden = true; afCtx = null; }
    async function previewAutofill() {
      try { lsSet(AF_OPTS_KEY, JSON.stringify({ ...afOpts, themes: [] })); } catch {}
      afCtx.stage = "loading"; afCtx.loadingText = "Picking cards… (EDHREC + Scryfall)";
      renderAutofill();
      try {
        Object.assign(afCtx, await buildAutofillPlan());
        afCtx.stage = "preview";
      } catch (err) {
        afCtx.stage = "error"; afCtx.error = `Autofill failed: ${err.message || "network error"}`;
      }
      renderAutofill();
    }
    function applyAutofill() {
      const { plan, basics, folderId } = afCtx;
      const added = plan.steps.flatMap((st) => st.picks.map((p) => p.card)).filter((c) => !cardFolders(c.id).includes(folderId));
      added.forEach((c) => setCardFolder(c, folderId, true));
      const basicPrev = [];
      basics.forEach(({ card, qty }) => {
        const had = cardFolders(card.id).includes(folderId);
        const prevQty = had ? cardQty(folderId, card.id) : 0;
        basicPrev.push({ card, had, prevQty });
        if (!had) setCardFolder(card, folderId, true);
        setCardQty(folderId, card.id, prevQty + qty);
      });
      const n = added.length + basics.reduce((a, b) => a + b.qty, 0);
      const spent = plan.spent;
      closeAutofill();
      renderFolderRail();
      renderSavedCards();
      showToast(`Added ${n} cards (${plan.owned} owned · €${spent.toFixed(2)} to buy)`, {
        actionLabel: "Undo",
        ms: 12000,
        onAction: () => {
          added.forEach((c) => setCardFolder(c, folderId, false));
          basicPrev.forEach(({ card, had, prevQty }) => { if (had) setCardQty(folderId, card.id, prevQty); else setCardFolder(card, folderId, false); });
          renderFolderRail();
          renderSavedCards();
        },
      });
    }
    // Delegated dialog wiring (the dialog markup lives at the end of <body>).
    document.addEventListener("click", (e) => {
      const dlg = $("#af-dialog");
      if (!dlg || dlg.hidden || !afCtx) return;
      const t = e.target;
      if (t === dlg || t.closest("[data-af-close]")) { closeAutofill(); return; }
      const theme = t.closest("[data-af-theme]");
      if (theme) {
        const slug = theme.dataset.afTheme;
        if (afOpts.themes.includes(slug)) afOpts.themes = afOpts.themes.filter((x) => x !== slug);
        else if (afOpts.themes.length < 3) afOpts.themes = [...afOpts.themes, slug];
        renderAutofill();
        return;
      }
      const tg = t.closest("[data-af-tg]");
      if (tg) { afOpts[tg.dataset.afTg] = !afOpts[tg.dataset.afTg]; renderAutofill(); return; }
      const go = t.closest("[data-af-go]");
      if (go) { if (go.dataset.afGo === "preview") previewAutofill(); else { afCtx.stage = "setup"; renderAutofill(); } return; }
      const step = t.closest("[data-af-step]");
      if (step) { const list = step.nextElementSibling; if (list) { list.hidden = !list.hidden; step.setAttribute("aria-expanded", String(!list.hidden)); } return; }
      const cc = t.closest(".af-cc[data-card]");
      if (cc) { openCardByName(cc.dataset.card); return; }
      if (t.closest("[data-af-apply]")) applyAutofill();
    });
    document.addEventListener("input", (e) => {
      if (e.target.id === "af-budget") afOpts.budget = e.target.value;
      if (e.target.id === "af-cap") afOpts.cap = e.target.value;
    });
    document.addEventListener("keydown", (e) => {
      const dlg = $("#af-dialog");
      if (!dlg || dlg.hidden) return;
      if (e.key === "Escape") { closeAutofill(); return; }
      if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-af-tg],[data-af-step]")) { e.preventDefault(); e.target.click(); }
    });

    // ═══ Deck analysis tabs, sticky progress bar, staples, simulator ═════
    const DA_TABS = [["overview", "Overview"], ["build", "Build"], ["mana", "Mana"], ["playtest", "Playtest"], ["ideas", "Ideas"]];
    let daTab = (() => { try { return localStorage.getItem("deck_analysis_tab") || "overview"; } catch { return "overview"; } })();
    // Tabs only show/hide panes that are all rendered, so every existing wiring (AI
    // review, EDHREC, trim planner, opening hand) keeps working regardless of the tab.
    function wireDeckTabs() {
      dA.querySelectorAll("[data-da-tab]").forEach((btn) => btn.addEventListener("click", () => {
        daTab = btn.dataset.daTab;
        try { lsSet("deck_analysis_tab", daTab); } catch {}
        dA.querySelectorAll("[data-da-tab]").forEach((b) => { const on = b === btn; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
        dA.querySelectorAll(".da2-pane").forEach((p) => { p.hidden = p.dataset.pane !== daTab; });
      }));
    }

    // Sticky bar above the deck: name, colors, stats, progress toward 100, grade.
