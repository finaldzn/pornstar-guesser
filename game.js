/* Devine la pornstar — game logic */

const STORAGE_KEY  = "dlpx.state.v1";
const SESSION_KEY  = "dlpx.session.v1";
const POOL_CACHE   = "dlpx.pool.v7";   // v7: country + onlyfans tags
const AGE_KEY      = "dlpx.age.v1";

const CACHE_TTL_MS     = 7 * 24 * 60 * 60 * 1000;
const ADVANCE_DELAY_MS = 2400;
const RECENT_KEEP      = 40;
const CHOICES_PER_ROUND = 4;
const MIN_POOL          = CHOICES_PER_ROUND;
const PRELOAD_AHEAD     = 4;            // portraits warmed in the browser cache
const TOP_N             = 200;          // Top 200 category size
const RUN_MAX           = 200;          // max round count for any single run
const RECENT_YEARS      = 5;
const RECENT_AGE_FALLBACK = 28;

const COUNTRY_FRANCE    = "Q142";

// Curated allow-list of well-known OnlyFans performers, used in addition
// to the `onlyfans: true` flag the build script attaches via Wikidata
// P10934. Matched case-insensitively against the candidate's name. Edit
// freely — entries only land in the OnlyFans filter if their name shows
// up here OR Wikidata flagged them.
const ONLYFANS_NAMES = new Set([
  "Mia Khalifa", "Riley Reid", "Lana Rhoades", "Belle Delphine",
  "Adriana Chechik", "Mia Malkova", "Angela White", "Eva Elfie",
  "Sweetie Fox", "Lena Paul", "Autumn Falls", "Jia Lissa",
  "Emily Willis", "Gabbie Carter", "Whitney Wright", "Kira Noir",
  "Skylar Vox", "Karma RX", "Olivia Austin", "Ava Addams",
  "Brandi Love", "Phoenix Marie", "Cherie DeVille", "Cory Chase",
  "Stormy Daniels", "Asa Akira", "Abella Danger", "Veronica Leal",
  "Lacy Lennon", "Adira Allure", "Aletta Ocean", "Lela Star",
  "Kendra Lust", "Madison Ivy", "Nicole Aniston", "Romi Rain",
].map((s) => s.toLowerCase()));

// "Top 3 sites" allow-list — performers commonly featured on the top three
// most-visited adult websites. Matched case-insensitively against the
// Wikidata label, so an entry only counts if Wikidata also has them
// (with an image). Edit freely.
const TOP_SITES_NAMES = new Set([
  "Mia Khalifa", "Sasha Grey", "Riley Reid", "Lana Rhoades", "Lisa Ann",
  "Asa Akira", "Adriana Chechik", "Jenna Jameson", "Tori Black", "Abella Danger",
  "Angela White", "Brandi Love", "Stoya", "Kendra Lust", "Madison Ivy",
  "Phoenix Marie", "Nicole Aniston", "Romi Rain", "Kayden Kross", "Bonnie Rotten",
  "Eva Lovia", "Dani Daniels", "Aletta Ocean", "Nina Hartley", "Belle Knox",
  "Bree Olson", "Christy Mack", "Janice Griffith", "Jenna Haze", "Lexi Belle",
  "Nikki Benz", "Stormy Daniels", "Sunny Leone", "Tasha Reign", "Veronica Avluv",
  "Aaliyah Hadid", "Mia Malkova", "Cherie DeVille", "Alexis Texas", "Remy LaCroix",
  "August Ames", "Tera Patrick", "Esperanza Gomez", "Eva Angelina", "Gianna Michaels",
  "Jesse Jane", "Faye Reagan", "Elsa Jean", "Karla Lane", "Jessie Volt",
].map((s) => s.toLowerCase()));

const SPARQL = `SELECT ?item ?itemLabel ?image ?workStart ?birth WHERE {
  ?item wdt:P31 wd:Q5 .
  ?item wdt:P106 wd:Q488111 .
  ?item wdt:P21 wd:Q6581072 .
  ?item wdt:P18 ?image .
  ?item wikibase:sitelinks ?sl .
  OPTIONAL { ?item wdt:P2031 ?workStart . }
  OPTIONAL { ?item wdt:P569 ?birth . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr" . }
} ORDER BY DESC(?sl) LIMIT 1500`;

const SPARQL_URL =
  "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(SPARQL);

const SESSION_ID = (() => {
  let s = null;
  try { s = localStorage.getItem(SESSION_KEY); } catch (_) {}
  if (s) return s;
  s = (crypto.randomUUID && crypto.randomUUID()) ||
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
      });
  try { localStorage.setItem(SESSION_KEY, s); } catch (_) {}
  return s;
})();

const $ = (id) => document.getElementById(id);
const ui = {
  ageGate:    $("age-gate"),
  ageYes:     $("age-yes"),
  topbar:     document.querySelector(".topbar"),
  pageEl:     document.querySelector(".page"),
  filters:    $("filters"),
  challenge:  $("challenge"),
  card:       $("card"),
  imgA:       $("img-front"),
  imgB:       $("img-back"),
  cap:        $("caption"),
  who:        $("who"),
  meta:       $("meta"),
  choices:    $("choices"),
  bar:        $("bar"),
  hint:       $("hint"),
  recent:     $("recent"),
  list:       $("recent-list"),
  board:      $("board"),
  boardList:  $("board-list"),
  toast:      $("toast"),
  round:      $("m-round"),
  score:      $("m-score"),
  streak:     $("m-streak"),
  best:       $("m-best"),
  share:      $("m-share"),
  reset:      $("m-reset"),
  shareMenu:  $("share-menu"),
  summary:    $("summary"),
  summaryNum: $("summary-num"),
  summaryDen: $("summary-den"),
  summaryMeta:$("summary-meta"),
  summaryShare:   $("summary-share"),
  summaryRestart: $("summary-restart"),
};

let allCandidates = [];                // raw, unfiltered list from Wikidata / cache
let pool = [];                         // category-filtered list (drives distractors)
let currentCategory = "all";
let current = null;
let answered = false;
let timer = null;
let frontEl = ui.imgA;
let backEl  = ui.imgB;
const preloadCache = new Map();        // src -> Image, keeps browser cache warm

// Run state — a finite, gamified pass over the pool.
let run = blankRun();

const state = restore();

// ----- persistence ------------------------------------------------------

function blank() {
  return { score: 0, attempts: 0, streak: 0, best: 0, recent: [], runs: [] };
}

function blankRun() {
  return {
    items: [],          // ordered list of correct answers, each appears once
    index: 0,           // 0-based index of current question
    correct: 0,         // count of correct answers in this run
    streak: 0,          // current streak in this run
    best: 0,            // best streak in this run
    finished: false,
  };
}

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw && typeof raw.score === "number") return Object.assign(blank(), raw);
  } catch (_) {}
  return blank();
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

// ----- rendering --------------------------------------------------------

function pop(el) {
  if (!el) return;
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
}

function paintScore(animate) {
  const total = run.items.length;
  const done  = run.index + (answered ? 1 : 0);
  if (ui.round) ui.round.textContent = total ? `${done} / ${total}` : `0 / 0`;
  ui.score.textContent  = `${run.correct} / ${done}`;
  ui.streak.textContent = run.streak;
  ui.best.textContent   = state.best;
  if (animate) {
    pop(ui.score);
    pop(ui.round);
    pop(ui.streak);
    if (run.streak > 0 && state.streak === state.best) pop(ui.best);
  }
}

function paintBoard() {
  const runs = (state.runs || []).slice(0, 3);
  if (runs.length === 0) { ui.board.hidden = true; return; }
  ui.board.hidden = false;
  ui.boardList.innerHTML = "";
  for (const r of runs) {
    const li = document.createElement("li");
    li.className = "run";
    const date = new Date(r.ts).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    li.innerHTML = `
      <span class="run-len"></span>
      <span class="run-label">d'affilée</span>
      <span class="run-when"></span>`;
    li.querySelector(".run-len").textContent  = r.length;
    li.querySelector(".run-when").textContent = date;
    ui.boardList.appendChild(li);
  }
}

function recordStreak() {
  if (state.streak > 0) {
    state.runs = state.runs || [];
    state.runs.push({ length: state.streak, ts: Date.now() });
    state.runs.sort((a, b) => b.length - a.length || b.ts - a.ts);
    if (state.runs.length > 50) state.runs.length = 50;
  }
}

function flashToast(msg) {
  ui.toast.textContent = msg;
  ui.toast.classList.add("show");
  clearTimeout(flashToast._t);
  flashToast._t = setTimeout(() => ui.toast.classList.remove("show"), 2200);
}

function categoryLabel(cat) {
  return ({
    all:      "Toutes",
    top200:   "Top 200",
    recent:   "5 dernières années",
    topsites: "Top 3 sites",
    france:   "France",
    onlyfans: "OnlyFans",
  })[cat] || "Toutes";
}

function buildShareUrl() {
  const base = location.origin + location.pathname;
  const p = new URLSearchParams();
  if (currentCategory && currentCategory !== "all") p.set("cat", currentCategory);
  if (run.items.length > 0) {
    p.set("score", `${run.correct}-${run.finished ? run.items.length : run.index + (answered ? 1 : 0)}`);
  }
  if (run.best > 0) p.set("streak", String(run.best));
  const q = p.toString();
  return q ? `${base}?${q}` : base;
}

function buildShareText() {
  const cat = categoryLabel(currentCategory);
  if (run.finished && run.items.length > 0) {
    return `🎯 Devine la pornstar (${cat}) — j'ai fait ${run.correct}/${run.items.length}` +
           (run.best > 1 ? ` (meilleure série : ${run.best})` : "") +
           `. Sauras-tu faire mieux ?`;
  }
  if (run.items.length > 0 && run.index > 0) {
    return `🎯 Devine la pornstar (${cat}) — en cours : ${run.correct}/${run.index + (answered ? 1 : 0)}/${run.items.length}.`;
  }
  return `🎯 Devine la pornstar — sauras-tu reconnaître les stars du X parmi 4 noms ?`;
}

function openShareMenu() {
  if (!ui.shareMenu) return shareNative();
  ui.shareMenu.hidden = false;
  setTimeout(() => {
    document.addEventListener("click", closeShareMenuOnce, { once: true, capture: true });
  }, 0);
}

function closeShareMenu() {
  if (ui.shareMenu) ui.shareMenu.hidden = true;
}

function closeShareMenuOnce(e) {
  if (!ui.shareMenu.contains(e.target) && e.target !== ui.share) closeShareMenu();
}

async function shareNative() {
  const url  = buildShareUrl();
  const text = buildShareText();
  if (navigator.share) {
    try { await navigator.share({ title: "Devine la pornstar", text, url }); return true; }
    catch (_) {}
  }
  return shareCopy();
}

async function shareCopy() {
  const url  = buildShareUrl();
  const text = buildShareText();
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    flashToast("Lien copié dans le presse-papier");
    return true;
  } catch (_) {
    flashToast("Copie impossible — partagez l'URL manuellement");
    return false;
  }
}

function shareTo(target) {
  const url  = buildShareUrl();
  const text = buildShareText();
  let go;
  if (target === "twitter") {
    go = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  } else if (target === "whatsapp") {
    go = `https://wa.me/?text=${encodeURIComponent(text + "\n" + url)}`;
  } else if (target === "telegram") {
    go = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  }
  if (go) window.open(go, "_blank", "noopener,noreferrer");
}

function paintRecent() {
  if (state.recent.length === 0) { ui.recent.hidden = true; return; }
  ui.recent.hidden = false;
  ui.list.innerHTML = "";
  for (const e of state.recent) {
    const li = document.createElement("li");
    li.className = "entry " + (e.correct ? "ok" : "no");
    li.innerHTML = `
      <img class="thumb" src="" alt="" referrerpolicy="no-referrer">
      <div class="lines">
        <div class="nm"></div>
        <div class="sub"></div>
      </div>
      <div class="badge"></div>`;
    li.querySelector(".thumb").src = e.image;
    li.querySelector(".nm").textContent = e.name;
    li.querySelector(".sub").textContent = e.correct
      ? "Bonne réponse"
      : `vous avez dit ${e.guess}`;
    ui.list.appendChild(li);
  }
}

// ----- candidate pool ---------------------------------------------------

function dedupeByName(items) {
  // Wikidata occasionally has two QIDs sharing the same English label
  // (different people, same stage name). Deduplicate so a round can't
  // ever show the same name twice — neither across consecutive questions
  // nor inside a single 4-button choice list.
  const seen = new Set();
  const out = [];
  for (const c of items || []) {
    const key = (c.name || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function thumbify(commonsUrl, width) {
  let u = String(commonsUrl).replace(/^http:\/\//, "https://");
  if (u.includes("Special:FilePath")) {
    const sep = u.includes("?") ? "&" : "?";
    u += `${sep}width=${width || 480}`;
  }
  return u;
}

function readPoolCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(POOL_CACHE));
    if (!raw || !Array.isArray(raw.items)) return null;
    if (Date.now() - (raw.ts || 0) > CACHE_TTL_MS)  return null;
    if (raw.items.length < MIN_POOL)                return null;
    return raw.items;
  } catch (_) { return null; }
}

function writePoolCache(items) {
  try { localStorage.setItem(POOL_CACHE, JSON.stringify({ ts: Date.now(), items })); }
  catch (_) {}
}

function yearOf(iso) {
  if (!iso) return null;
  const m = String(iso).match(/-?(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

async function fetchWikidata() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(SPARQL_URL, {
      headers: { "Accept": "application/sparql-results+json" },
      signal:  ctrl.signal,
    });
    if (!r.ok) throw new Error(`SPARQL HTTP ${r.status}`);
    const data = await r.json();
    const seen = new Map();
    for (const b of (data.results && data.results.bindings) || []) {
      const qid    = b.item && b.item.value && b.item.value.split("/").pop();
      const name   = b.itemLabel && b.itemLabel.value;
      const img    = b.image && b.image.value;
      const ws     = yearOf(b.workStart && b.workStart.value);
      const bd     = yearOf(b.birth && b.birth.value);
      if (!qid || !name || !img) continue;
      if (/^Q\d+$/.test(name)) continue;
      if (seen.has(qid)) {
        const prev = seen.get(qid);
        if (ws && (!prev.workStart || ws < prev.workStart)) prev.workStart = ws;
        if (bd && !prev.birth) prev.birth = bd;
        continue;
      }
      seen.set(qid, {
        id: qid, name, gender: "f",
        workStart: ws || null,
        birth:     bd || null,
        image_url: thumbify(img, 480),
      });
    }
    return [...seen.values()];
  } finally {
    clearTimeout(t);
  }
}

async function loadPool() {
  // 1) static file shipped alongside the site (preferred)
  try {
    const r = await fetch("candidates.json", { cache: "no-store" });
    if (r.ok) {
      const items = await r.json();
      if (Array.isArray(items) && items.length >= MIN_POOL) {
        // legacy candidates.json may include men — filter on read.
        allCandidates = dedupeByName(
          items.filter((c) => !c.gender || c.gender === "f")
        );
        applyCategory(currentCategory);
        ui.hint.textContent = `${allCandidates.length} stars chargées.`;
        return true;
      }
    }
  } catch (_) {}

  // 2) fresh-enough cache from a previous Wikidata fetch
  const cached = readPoolCache();
  if (cached) {
    allCandidates = dedupeByName(cached);
    applyCategory(currentCategory);
    ui.hint.textContent = `${allCandidates.length} stars chargées (cache local).`;
    refreshPoolInBackground();
    return true;
  }

  // 3) fetch from Wikidata
  try {
    const items = await fetchWikidata();
    if (items.length >= MIN_POOL) {
      allCandidates = dedupeByName(items);
      writePoolCache(allCandidates);
      applyCategory(currentCategory);
      ui.hint.textContent = `${allCandidates.length} stars chargées depuis Wikidata.`;
      return true;
    }
    ui.hint.classList.add("error");
    ui.hint.textContent = "Wikidata n'a pas renvoyé assez de résultats. Réessayez plus tard.";
    return false;
  } catch (e) {
    ui.hint.classList.add("error");
    ui.hint.textContent = "Impossible de joindre Wikidata. Vérifiez votre connexion et réessayez.";
    return false;
  }
}

function refreshPoolInBackground() {
  fetchWikidata()
    .then((items) => {
      if (items.length >= MIN_POOL) {
        const fresh = dedupeByName(items);
        writePoolCache(fresh);
        allCandidates = fresh;
        // don't restart a run mid-session just because the cache refreshed
      }
    })
    .catch(() => {});
}

function isRecent(c) {
  const now = new Date().getFullYear();
  if (c.workStart && c.workStart >= now - RECENT_YEARS) return true;
  if (!c.workStart && c.birth && c.birth >= now - RECENT_AGE_FALLBACK) return true;
  return false;
}

function isTopSites(c) {
  return TOP_SITES_NAMES.has((c.name || "").toLowerCase());
}

function isFrench(c) {
  return c.country === COUNTRY_FRANCE;
}

function isOnlyFans(c) {
  return c.onlyfans === true ||
         ONLYFANS_NAMES.has((c.name || "").toLowerCase());
}

function applyCategory(cat) {
  currentCategory = cat;
  if (cat === "top200") {
    pool = allCandidates.slice(0, TOP_N);
  } else if (cat === "recent") {
    pool = allCandidates.filter(isRecent);
  } else if (cat === "topsites") {
    pool = allCandidates.filter(isTopSites);
  } else if (cat === "france") {
    pool = allCandidates.filter(isFrench);
  } else if (cat === "onlyfans") {
    pool = allCandidates.filter(isOnlyFans);
  } else {
    pool = allCandidates.slice();
  }
  if (ui.filters) {
    for (const b of ui.filters.querySelectorAll(".cat")) {
      b.classList.toggle("is-active", b.dataset.cat === currentCategory);
    }
  }
  if (pool.length >= MIN_POOL) {
    startRun();
  } else if (allCandidates.length) {
    ui.hint.classList.remove("error");
    ui.hint.textContent = "Pas assez de stars dans cette catégorie — essayez-en une autre.";
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startRun() {
  clearTimeout(timer);
  preloadCache.clear();
  const items = shuffle(pool.slice()).slice(0, Math.min(pool.length, RUN_MAX));
  run = blankRun();
  run.items = items;
  hideSummary();
  paintScore(false);
  if (run.items.length === 0) return;
  nextRound();
}

function pickChoices(correct) {
  // distractors: any other candidate, but never the same display name
  // as the correct answer (defensive — pool is already name-deduped)
  const correctName = (correct.name || "").trim().toLowerCase();
  let bucket = pool.filter((c) =>
    c.id !== correct.id && (c.name || "").trim().toLowerCase() !== correctName);
  shuffle(bucket);
  const distractors = bucket.slice(0, CHOICES_PER_ROUND - 1);
  return shuffle([correct, ...distractors]);
}

function preload(src) {
  if (!src || preloadCache.has(src)) return;
  const img = new Image();
  img.referrerPolicy = "no-referrer";
  img.decoding = "async";
  img.src = src;
  preloadCache.set(src, img);
  if (preloadCache.size > 64) {
    const firstKey = preloadCache.keys().next().value;
    preloadCache.delete(firstKey);
  }
}

function preloadAhead() {
  for (let i = run.index + 1;
       i < Math.min(run.index + PRELOAD_AHEAD + 1, run.items.length);
       i++) {
    preload(run.items[i].image_url);
  }
}

// ----- round flow -------------------------------------------------------

function renderChoices(choices) {
  ui.choices.innerHTML = "";
  for (const c of choices) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice";
    b.dataset.name = c.name;
    b.textContent = c.name;
    ui.choices.appendChild(b);
  }
}

function swapPortrait(src) {
  backEl.onload = () => {
    backEl.classList.add("shown");
    frontEl.classList.remove("shown");
    [frontEl, backEl] = [backEl, frontEl];
    if (current) current.shownAt = performance.now();
  };
  backEl.onerror = () => { advanceRound(); };
  backEl.src = src;
}

function nextRound() {
  clearTimeout(timer);
  if (run.index >= run.items.length) { finishRun(); return; }

  current  = run.items[run.index];
  answered = false;

  ui.cap.classList.remove("visible");
  ui.bar.classList.remove("run");

  renderChoices(pickChoices(current));
  swapPortrait(current.image_url);
  paintScore(false);
  preloadAhead();
}

function answer(name) {
  if (answered || !current) return;
  answered = true;

  const isCorrect = name === current.name;

  // run-scoped stats
  if (isCorrect) {
    run.correct += 1;
    run.streak  += 1;
    if (run.streak > run.best) run.best = run.streak;
  } else {
    run.streak = 0;
  }

  // lifetime stats (kept for top-runs board across runs)
  state.attempts += 1;
  if (isCorrect) {
    state.score  += 1;
    state.streak += 1;
    if (state.streak > state.best) state.best = state.streak;
  } else {
    recordStreak();
    state.streak = 0;
  }

  for (const b of ui.choices.children) {
    b.disabled = true;
    if (b.dataset.name === current.name)               b.classList.add("was-correct");
    else if (b.dataset.name === name && !isCorrect)    b.classList.add("was-wrong");
  }

  ui.who.textContent  = current.name;
  ui.meta.textContent = isCorrect
    ? "Bonne réponse"
    : `Mauvaise réponse — c'était ${current.name}`;
  ui.cap.classList.add("visible");

  state.recent.unshift({
    name:    current.name,
    image:   current.image_url,
    guess:   name,
    correct: isCorrect,
  });
  if (state.recent.length > RECENT_KEEP) state.recent.length = RECENT_KEEP;

  paintScore(true);
  paintRecent();
  paintBoard();
  persist();

  ui.bar.style.setProperty("--ms", ADVANCE_DELAY_MS + "ms");
  void ui.bar.offsetWidth;
  ui.bar.classList.add("run");
  timer = setTimeout(advanceRound, ADVANCE_DELAY_MS);
}

function advanceRound() {
  clearTimeout(timer);
  run.index += 1;
  if (run.index >= run.items.length) finishRun();
  else nextRound();
}

// ----- end-of-run summary -----------------------------------------------

function finishRun() {
  run.finished = true;
  // Bank the run's best streak into the top-runs board
  if (run.best > 0) {
    state.runs = state.runs || [];
    state.runs.push({ length: run.best, ts: Date.now() });
    state.runs.sort((a, b) => b.length - a.length || b.ts - a.ts);
    if (state.runs.length > 50) state.runs.length = 50;
    persist();
  }
  showSummary();
}

function showSummary() {
  if (!ui.summary) return;
  if (ui.summaryNum) ui.summaryNum.textContent = String(run.correct);
  if (ui.summaryDen) ui.summaryDen.textContent = `/ ${run.items.length}`;
  if (ui.summaryMeta) {
    const cat = categoryLabel(currentCategory);
    const pct = run.items.length ? Math.round((run.correct / run.items.length) * 100) : 0;
    const bits = [`<b>${cat}</b>`, `${pct}%`];
    if (run.best > 1) bits.push(`meilleure série : <b>${run.best}</b>`);
    ui.summaryMeta.innerHTML = bits.join(" · ");
  }
  ui.summary.hidden = false;
  ui.card.hidden    = true;
  paintBoard();
  paintRecent();
  // drop the stale challenge banner — the run we were challenged on is over
  if (ui.challenge) ui.challenge.hidden = true;
}

function hideSummary() {
  if (ui.summary) ui.summary.hidden = true;
  if (ui.card)    ui.card.hidden    = false;
}

// ----- input handling ---------------------------------------------------

ui.choices.addEventListener("click", (e) => {
  const b = e.target.closest(".choice");
  if (b && !b.disabled) answer(b.dataset.name);
});

ui.card.addEventListener("click", (e) => {
  if (answered && !e.target.closest(".choice")) advanceRound();
});

document.addEventListener("keydown", (e) => {
  if (run.finished) return;
  if (!answered && e.key >= "1" && e.key <= "4") {
    const i = parseInt(e.key, 10) - 1;
    const btn = ui.choices.children[i];
    if (btn) answer(btn.dataset.name);
    return;
  }
  if (answered && (e.key === " " || e.key === "Enter" || e.key === "ArrowRight")) {
    e.preventDefault();
    advanceRound();
  }
});

if (ui.reset) {
  ui.reset.addEventListener("click", () => {
    if (!confirm("Tout remettre à zéro (score, série et historique) ?")) return;
    Object.assign(state, blank());
    persist();
    paintRecent();
    paintBoard();
    if (allCandidates.length) startRun();
  });
}

ui.share.addEventListener("click", (e) => {
  e.stopPropagation();
  if (ui.shareMenu && ui.shareMenu.hidden) openShareMenu();
  else if (ui.shareMenu) closeShareMenu();
  else shareNative();
});

if (ui.shareMenu) {
  ui.shareMenu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-share]");
    if (!b) return;
    const t = b.dataset.share;
    if      (t === "copy")   shareCopy();
    else if (t === "native") shareNative();
    else                     shareTo(t);
    closeShareMenu();
  });
}

if (ui.summaryShare) {
  ui.summaryShare.addEventListener("click", () => shareNative());
}
if (ui.summaryRestart) {
  ui.summaryRestart.addEventListener("click", () => startRun());
}

if (ui.filters) {
  ui.filters.addEventListener("click", (e) => {
    const b = e.target.closest(".cat");
    if (!b) return;
    const cat = b.dataset.cat;
    if (cat && cat !== currentCategory && allCandidates.length) {
      const p = new URLSearchParams(location.search);
      if (cat === "all") p.delete("cat");
      else               p.set("cat", cat);
      const qs = p.toString();
      history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
      applyCategory(cat);
    }
  });
}

// ----- age gate + boot --------------------------------------------------

function dismissAgeGate() {
  if (ui.ageGate) ui.ageGate.remove();
  if (ui.topbar)  ui.topbar.hidden = false;
  if (ui.pageEl)  ui.pageEl.hidden = false;
  if (ui.filters) ui.filters.hidden = false;
}

function readIncomingParams() {
  const p = new URLSearchParams(location.search);
  const cat = p.get("cat");
  if (cat === "top200" || cat === "recent" || cat === "topsites" ||
      cat === "france" || cat === "onlyfans" || cat === "all") {
    currentCategory = cat;
  }

  const incomingScore  = p.get("score");
  const incomingStreak = p.get("streak");
  if (!incomingScore && !incomingStreak) return;

  if (!ui.challenge) return;
  const bits = [];
  if (incomingScore)  bits.push(`<b>${incomingScore.replace("-", "/")}</b>`);
  if (incomingStreak) bits.push(`série <b>${incomingStreak}</b>`);
  ui.challenge.innerHTML =
    `🎯 Un·e ami·e a fait ${bits.join(" · ")}. Sauras-tu faire mieux ?` +
    ` <button class="challenge-close" type="button" aria-label="Fermer">×</button>`;
  ui.challenge.hidden = false;
  ui.challenge.querySelector(".challenge-close").addEventListener("click", () => {
    ui.challenge.hidden = true;
  });
}

async function boot() {
  readIncomingParams();
  paintScore(false);
  paintRecent();
  paintBoard();
  await loadPool();
}

ui.ageYes.addEventListener("click", () => {
  try { localStorage.setItem(AGE_KEY, "1"); } catch (_) {}
  dismissAgeGate();
  boot();
});

let alreadyConsented = false;
try { alreadyConsented = localStorage.getItem(AGE_KEY) === "1"; } catch (_) {}
if (alreadyConsented) {
  dismissAgeGate();
  boot();
}
