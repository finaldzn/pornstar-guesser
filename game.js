/* Devine la pornstar — game logic */

const STORAGE_KEY  = "dlpx.state.v1";
const SESSION_KEY  = "dlpx.session.v1";
const POOL_CACHE   = "dlpx.pool.v3";   // v3: mixed pool, distractors drawn per-gender
const AGE_KEY      = "dlpx.age.v1";

const CACHE_TTL_MS     = 7 * 24 * 60 * 60 * 1000;
const ADVANCE_DELAY_MS = 2400;
const RECENT_KEEP      = 40;
const CHOICES_PER_ROUND = 4;
const MIN_POOL          = CHOICES_PER_ROUND;
const PRELOAD_AHEAD     = 4;           // portraits warmed in the browser cache

const GENDER_FEMALE = "Q6581072";
const GENDER_MALE   = "Q6581097";

const SPARQL = `SELECT ?item ?itemLabel ?image ?gender WHERE {
  ?item wdt:P31 wd:Q5 .
  ?item wdt:P106 wd:Q488111 .
  ?item wdt:P21 ?gender .
  ?item wdt:P18 ?image .
  ?item wikibase:sitelinks ?sl .
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
  ageGate:   $("age-gate"),
  ageYes:    $("age-yes"),
  topbar:    document.querySelector(".topbar"),
  pageEl:    document.querySelector(".page"),
  card:      $("card"),
  imgA:      $("img-front"),
  imgB:      $("img-back"),
  cap:       $("caption"),
  who:       $("who"),
  meta:      $("meta"),
  choices:   $("choices"),
  bar:       $("bar"),
  hint:      $("hint"),
  recent:    $("recent"),
  list:      $("recent-list"),
  board:     $("board"),
  boardList: $("board-list"),
  toast:     $("toast"),
  score:     $("m-score"),
  streak:    $("m-streak"),
  best:      $("m-best"),
  share:     $("m-share"),
  reset:     $("m-reset"),
};

let pool = [];
let current = null;
let answered = false;
let timer = null;
let frontEl = ui.imgA;
let backEl  = ui.imgB;
let upcoming = [];                     // queue of pre-built rounds
const preloadCache = new Map();        // src -> Image, keeps browser cache warm

const state = restore();

// ----- persistence ------------------------------------------------------

function blank() {
  return { score: 0, attempts: 0, streak: 0, best: 0, recent: [], runs: [] };
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
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
}

function paintScore(animate) {
  ui.score.textContent  = `${state.score} / ${state.attempts}`;
  ui.streak.textContent = state.streak;
  ui.best.textContent   = state.best;
  if (animate) {
    pop(ui.score);
    pop(ui.streak);
    if (state.streak > 0 && state.streak === state.best) pop(ui.best);
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

function recordRun() {
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

async function shareScore() {
  const url  = location.origin + location.pathname.replace(/[^/]+$/, "");
  const lead = state.attempts > 0
    ? `Devine la pornstar — ${state.score}/${state.attempts}, record ${state.best} d'affilée`
    : `Devine la pornstar — saurez-vous reconnaître les stars du X ?`;

  if (navigator.share) {
    try { await navigator.share({ title: "Devine la pornstar", text: lead, url }); return; }
    catch (_) {}
  }
  try {
    await navigator.clipboard.writeText(`${lead}\n${url}`);
    flashToast("Score copié dans le presse-papier");
  } catch (_) {
    flashToast("Copie impossible — partagez l'URL manuellement");
  }
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

function genderBucket(genderUrl) {
  const qid = String(genderUrl || "").split("/").pop();
  if (qid === GENDER_FEMALE) return "f";
  if (qid === GENDER_MALE)   return "m";
  return "x";
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
      const gender = genderBucket(b.gender && b.gender.value);
      if (!qid || !name || !img) continue;
      if (/^Q\d+$/.test(name)) continue;             // unlabeled
      if (seen.has(qid)) continue;                   // first image wins
      seen.set(qid, { id: qid, name, gender, image_url: thumbify(img, 480) });
    }
    return [...seen.values()];
  } finally {
    clearTimeout(t);
  }
}

async function loadPool() {
  // 1) static file shipped alongside the site (optional)
  try {
    const r = await fetch("candidates.json", { cache: "no-store" });
    if (r.ok) {
      const items = await r.json();
      if (Array.isArray(items) && items.length >= MIN_POOL) {
        pool = items;
        ui.hint.textContent = `${pool.length} stars chargées.`;
        return true;
      }
    }
  } catch (_) {}

  // 2) fresh-enough cache from a previous Wikidata fetch
  const cached = readPoolCache();
  if (cached) {
    pool = cached;
    ui.hint.textContent = `${pool.length} stars chargées (cache local).`;
    // refresh in the background
    refreshPoolInBackground();
    return true;
  }

  // 3) fetch from Wikidata
  try {
    const items = await fetchWikidata();
    if (items.length >= MIN_POOL) {
      pool = items;
      writePoolCache(items);
      ui.hint.textContent = `${pool.length} stars chargées depuis Wikidata.`;
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
        writePoolCache(items);
        pool = items;
      }
    })
    .catch(() => {});
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function drawNext() {
  const correct = pool[Math.floor(Math.random() * pool.length)];

  // distractors must share the same gender bucket so the answer can't
  // be inferred from "the photo is a man, so it's the only male name"
  let sameGender = pool.filter((c) => c.gender === correct.gender && c.name !== correct.name);
  if (sameGender.length < CHOICES_PER_ROUND - 1) {
    // unlikely with a 1500-row pool, but if a gender bucket is too small
    // (e.g. unspecified), fall back to the whole pool minus the correct one
    sameGender = pool.filter((c) => c.name !== correct.name);
  }
  shuffle(sameGender);
  const distractors = sameGender.slice(0, CHOICES_PER_ROUND - 1);
  const choices = shuffle([correct, ...distractors]);
  return { correct, choices };
}

function preload(src) {
  if (!src || preloadCache.has(src)) return;
  const img = new Image();
  img.referrerPolicy = "no-referrer";
  img.decoding = "async";
  img.src = src;
  preloadCache.set(src, img);
  // cap the cache so it can't grow unbounded across long sessions
  if (preloadCache.size > 64) {
    const firstKey = preloadCache.keys().next().value;
    preloadCache.delete(firstKey);
  }
}

function fillUpcoming() {
  while (upcoming.length < PRELOAD_AHEAD && pool.length >= MIN_POOL) {
    const round = drawNext();
    upcoming.push(round);
    preload(round.correct.image_url);
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
  backEl.onerror = () => {
    // photo gone stale — skip
    nextRound();
  };
  backEl.src = src;
}

function nextRound() {
  clearTimeout(timer);
  if (pool.length < MIN_POOL) return;

  fillUpcoming();
  const round = upcoming.shift() || drawNext();
  current  = round.correct;
  answered = false;

  ui.cap.classList.remove("visible");
  ui.bar.classList.remove("run");

  renderChoices(round.choices);
  swapPortrait(current.image_url);

  // top the queue back up and warm the browser cache for the rounds after this one
  fillUpcoming();
}

function answer(name) {
  if (answered || !current) return;
  answered = true;

  const correct = name === current.name;
  state.attempts += 1;
  if (correct) {
    state.score  += 1;
    state.streak += 1;
    if (state.streak > state.best) state.best = state.streak;
  } else {
    recordRun();
    state.streak = 0;
  }

  for (const b of ui.choices.children) {
    b.disabled = true;
    if (b.dataset.name === current.name)            b.classList.add("was-correct");
    else if (b.dataset.name === name && !correct)   b.classList.add("was-wrong");
  }

  ui.who.textContent  = current.name;
  ui.meta.textContent = correct ? "Bonne réponse" : `Mauvaise réponse — c'était ${current.name}`;
  ui.cap.classList.add("visible");

  state.recent.unshift({
    name:    current.name,
    image:   current.image_url,
    guess:   name,
    correct,
  });
  if (state.recent.length > RECENT_KEEP) state.recent.length = RECENT_KEEP;

  paintScore(true);
  paintRecent();
  paintBoard();
  persist();

  ui.bar.style.setProperty("--ms", ADVANCE_DELAY_MS + "ms");
  void ui.bar.offsetWidth;
  ui.bar.classList.add("run");
  timer = setTimeout(nextRound, ADVANCE_DELAY_MS);
}

// ----- input handling ---------------------------------------------------

ui.choices.addEventListener("click", (e) => {
  const b = e.target.closest(".choice");
  if (b && !b.disabled) answer(b.dataset.name);
});

ui.card.addEventListener("click", (e) => {
  if (answered && !e.target.closest(".choice")) {
    clearTimeout(timer);
    nextRound();
  }
});

document.addEventListener("keydown", (e) => {
  if (!answered && e.key >= "1" && e.key <= "4") {
    const i = parseInt(e.key, 10) - 1;
    const btn = ui.choices.children[i];
    if (btn) answer(btn.dataset.name);
    return;
  }
  if (answered && (e.key === " " || e.key === "Enter" || e.key === "ArrowRight")) {
    e.preventDefault();
    clearTimeout(timer);
    nextRound();
  }
});

ui.reset.addEventListener("click", () => {
  if (!confirm("Tout remettre à zéro (score, série et historique) ?")) return;
  Object.assign(state, blank());
  persist();
  paintScore(false);
  paintRecent();
  paintBoard();
});

ui.share.addEventListener("click", shareScore);

// ----- age gate + boot --------------------------------------------------

function dismissAgeGate() {
  if (ui.ageGate) ui.ageGate.remove();
  if (ui.topbar)  ui.topbar.hidden = false;
  if (ui.pageEl)  ui.pageEl.hidden = false;
}

async function boot() {
  paintScore(false);
  paintRecent();
  paintBoard();
  if (await loadPool()) nextRound();
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
