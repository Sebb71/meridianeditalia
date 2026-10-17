// ===== Atlante delle Meridiane — dati per comune, mappa con raggruppamento =====
const $ = (id) => document.getElementById(id);
const DEFAULT_TITLE = "Atlante delle Meridiane – Meridiane d'Italia";
const MAX_SUGGESTIONS = 8;

let comuni = [];          // dall'indice: { key, slug, nome, sigla, provincia, regione, lat, lon, n }
let bySlug = {}, byKey = {};
let itemsCache = {};      // slug -> meridiane del comune (caricate solo quando servono)
let map = null;
let markers = {};         // slug -> marker
let currentRandom = null;
let routeToken = 0;

// ---------- utilità ----------
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}
// confronto senza accenti né maiuscole
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

// Il sito pubblica solo thumbs (elenchi) e medie (home/scheda): gli originali restano sul PC.
function stemOf(v) { return String(v || "").replaceAll("\\", "/").split("/").pop().replace(/\.[^.]+$/, ""); }
const photoUrl = (v, folder) => (v ? `catalogo/${folder}/${stemOf(v)}.jpg` : "");
const thumbFallback = (v) => `onerror="this.onerror=null;this.src='${escapeHtml(photoUrl(v, "medie"))}'"`;

const placeLine = (c) =>
  c && c.provincia ? `Provincia di ${c.provincia}${c.regione ? " · " + c.regione : ""}` : "";

// Interpretazione prudente dei campi del foglio
const isYear = (v) => /^\d{4}$/.test(String(v).trim());
const isUrl = (v) => /^https?:\/\//i.test(String(v).trim());
const isCoord = (v) => /°/.test(String(v));

async function loadItems(slug) {
  if (itemsCache[slug]) return itemsCache[slug];
  const r = await fetch(`data/comuni/${slug}.json`);
  if (!r.ok) throw new Error("Dati del comune non disponibili: " + slug);
  itemsCache[slug] = await r.json();
  return itemsCache[slug];
}

// ---------- avvio ----------
async function init() {
  const res = await fetch("data/index.json");
  if (!res.ok) throw new Error("data/index.json non disponibile");
  const idx = await res.json();

  comuni = idx.comuni.slice().sort((a, b) => a.nome.localeCompare(b.nome, "it"));
  comuni.forEach(c => { bySlug[c.slug] = c; byKey[c.key] = c; });

  $("count").textContent = idx.totale;
  $("count-comuni").textContent = comuni.length;
  if (idx.copyright_sito) $("footer-copy").textContent = idx.copyright_sito;

  fillBrowse();
  fillAllComuni();
  fetch("data/config-form.json").then(r => (r.ok ? r.json() : null)).then(f => {
    if (f && f.attivo) { $("form-link-wrap").hidden = false; $("form-link-foot").hidden = false; }
  }).catch(() => { /* modulo non configurato */ });
  setupSearch();
  $("shuffle").addEventListener("click", pickRandom);
  pickRandom();

  initMapGate();

  window.addEventListener("hashchange", route);
  route();
}

// ---------- home: foto casuale ----------
// Si sceglie un comune con probabilità proporzionale al numero di meridiane, poi una sua foto.
async function pickRandom() {
  const total = comuni.reduce((s, c) => s + c.n, 0);
  if (!total) return;
  let r = Math.random() * total, chosen = comuni[0];
  for (const c of comuni) { r -= c.n; if (r < 0) { chosen = c; break; } }

  let items;
  try { items = await loadItems(chosen.slug); } catch (_) { return; }
  const withPhoto = items.filter(x => x.foto);
  if (!withPhoto.length) return;
  let pool = withPhoto.filter(x => `${chosen.slug}/${x.id}` !== currentRandom);
  if (!pool.length) pool = withPhoto;
  const item = pool[Math.floor(Math.random() * pool.length)];
  currentRandom = `${chosen.slug}/${item.id}`;

  $("featured-img").src = photoUrl(item.foto, "medie");
  $("featured-img").alt = `Meridiana di ${chosen.nome}`;
  $("featured-title").textContent = item.localita ? `${chosen.key} · ${item.localita}` : chosen.key;
  $("featured-link").href = `#m=${chosen.slug}/${encodeURIComponent(item.id)}`;
  $("featured").hidden = false;
}

// ---------- home: ricerca con suggerimenti ----------
// 0 = il nome inizia con il testo, 1 = una parola inizia con il testo, 2 = il nome contiene il testo,
// 3 = corrisponde provincia/sigla/regione, null = nessuna corrispondenza
function scoreComune(c, q) {
  const nome = norm(c.nome);
  if (nome.startsWith(q)) return 0;
  if (nome.split(/[\s'’-]+/).some(w => w.startsWith(q))) return 1;
  if (nome.includes(q)) return 2;
  if (q.length === 2 && norm(c.sigla) === q) return 3;
  if (q.length >= 3 && (norm(c.provincia).includes(q) || norm(c.regione).includes(q))) return 3;
  return null;
}

function renderSuggestions(query) {
  const q = norm(query);
  const ul = $("suggestions");
  if (!q) { ul.innerHTML = ""; $("no-results").hidden = true; return []; }

  const found = comuni
    .map(c => ({ c, s: scoreComune(c, q) }))
    .filter(x => x.s !== null)
    .sort((a, b) => a.s - b.s || a.c.nome.localeCompare(b.c.nome, "it"))
    .map(x => x.c);

  const shown = found.slice(0, MAX_SUGGESTIONS);
  ul.innerHTML = shown.map(c => `
    <li>
      <a class="comune-btn" href="#c=${c.slug}">
        <span class="comune-name">${escapeHtml(c.nome)}<small>${escapeHtml(c.provincia ? "Provincia di " + c.provincia : "")}</small></span>
        <span class="badge">${c.n}</span>
        <span class="chev">›</span>
      </a>
    </li>`).join("") +
    (found.length > shown.length
      ? `<li><p class="muted more">…e altri ${found.length - shown.length} comuni: continua a scrivere per restringere.</p></li>`
      : "");
  $("no-results").hidden = found.length > 0;
  return found;
}

function setupSearch() {
  const input = $("search");
  input.addEventListener("input", () => renderSuggestions(input.value));
  input.addEventListener("keydown", (e) => {
    const links = [...document.querySelectorAll("#suggestions a")];
    if (e.key === "Enter") {
      e.preventDefault();
      if (links[0]) { input.blur(); location.hash = links[0].getAttribute("href").slice(1); }
    } else if (e.key === "ArrowDown" && links[0]) {
      e.preventDefault(); links[0].focus();
    }
  });
  $("suggestions").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...document.querySelectorAll("#suggestions a")];
    const i = links.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === "ArrowDown") (links[i + 1] || links[i]).focus();
    else (links[i - 1] || input).focus();
  });
}

// ---------- home: elenco a tendina raggruppato per provincia ----------
function fillBrowse() {
  const sel = $("browse");
  const groups = {};
  comuni.forEach(c => {
    const g = c.provincia ? `${c.provincia} (${c.sigla})` : "Altri";
    (groups[g] ||= []).push(c);
  });
  Object.keys(groups).sort((a, b) => a.localeCompare(b, "it")).forEach(g => {
    const og = document.createElement("optgroup");
    og.label = g;
    groups[g].forEach(c => {
      const o = document.createElement("option");
      o.value = c.slug;
      o.textContent = `${c.nome} (${c.n})`;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  sel.addEventListener("change", () => { if (sel.value) location.hash = "c=" + sel.value; });
}

// Elenco completo con link alle pagine statiche dei comuni (aiuta anche l'indicizzazione)
function fillAllComuni() {
  $("all-comuni-count").textContent = comuni.length;
  $("all-comuni-list").innerHTML = comuni.map(c =>
    `<li><a href="comuni/${c.slug}.html">${escapeHtml(c.nome)} (${escapeHtml(c.sigla)})</a></li>`).join("");
}

// ---------- viste ----------
function showView(name) {
  ["home", "comune", "detail"].forEach(v => { $("view-" + v).hidden = (v !== name); });
  // la mappa sta in fondo alla home e all'elenco del comune, non nella scheda
  $("map-section").hidden = (name === "detail");
  if (name !== "detail" && map) setTimeout(() => map.invalidateSize(), 50);
}

// Conteggio delle visualizzazioni (GoatCounter, se configurato): senza cookie, una voce per ogni vista
function track(h) {
  const path = h.startsWith("m=") ? "/m/" + h.slice(2) : h.startsWith("c=") ? "/c/" + h.slice(2) : "/";
  const send = () => { try { window.goatcounter.count({ path }); } catch (_) { /* contatore assente */ } };
  if (window.goatcounter && typeof window.goatcounter.count === "function") send();
  else window.addEventListener("load", () => setTimeout(send, 300), { once: true });
}

async function route() {
  const token = ++routeToken;
  document.title = DEFAULT_TITLE;
  window.scrollTo(0, 0);
  const h = decodeURIComponent(location.hash.slice(1));
  track(h);
  try {
    if (h.startsWith("m=")) {
      const rest = h.slice(2), cut = rest.indexOf("/");
      await showDetail(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? "" : rest.slice(cut + 1), token);
    } else if (h.startsWith("c=")) {
      await showComune(h.slice(2), token);
    } else {
      showHome();
    }
  } catch (err) {
    console.error(err);
    if (token === routeToken && location.hash) location.hash = "";
  }
}

function showHome() {
  showView("home");
  $("browse").value = "";
  highlightMarker(null);
}

async function showComune(arg, token) {
  const c = bySlug[arg] || byKey[arg];     // accetta anche il vecchio formato con il nome
  if (!c) { location.hash = ""; return; }
  showView("comune");
  $("comune-title").textContent = c.nome;
  $("comune-sub").textContent =
    [placeLine(c), c.n === 1 ? "1 meridiana catalogata" : `${c.n} meridiane catalogate`].filter(Boolean).join(" — ");
  $("sundial-list").innerHTML = `<li><p class="muted">Caricamento…</p></li>`;
  highlightMarker(c.slug);

  const items = await loadItems(c.slug);
  if (token !== routeToken) return;          // nel frattempo l'utente è andato altrove

  $("sundial-list").innerHTML = items.map((item, i) => {
    const sub = [item.localita, isYear(item["anno fotografia"]) ? "foto " + item["anno fotografia"] : ""]
      .filter(Boolean).join(" · ");
    return `
    <li>
      <a class="sundial-btn" href="#m=${c.slug}/${encodeURIComponent(item.id)}">
        <img src="${escapeHtml(photoUrl(item.foto, "thumbs"))}" ${thumbFallback(item.foto)} alt="" loading="lazy" width="76" height="76">
        <span class="sundial-info">
          <strong>Meridiana ${i + 1}</strong>
          ${item.motto ? `<span>“${escapeHtml(item.motto)}”</span>` : ""}
          ${sub ? `<span>${escapeHtml(sub)}</span>` : ""}
        </span>
        <span class="chev">›</span>
      </a>
    </li>`;
  }).join("");
}

async function showDetail(slugArg, id, token) {
  const c = bySlug[slugArg] || byKey[slugArg];
  if (!c) { location.hash = ""; return; }
  showView("detail");
  $("view-detail").innerHTML = `<a class="back" href="#c=${c.slug}">← ${escapeHtml(c.nome)}</a><p class="muted">Caricamento…</p>`;

  const list = await loadItems(c.slug);
  if (token !== routeToken) return;
  const item = list.find(x => String(x.id) === String(id));
  if (!item) { location.hash = "c=" + c.slug; return; }

  const idx = list.indexOf(item);
  const prev = list[idx - 1], next = list[idx + 1];
  const etichetta = list.length > 1 ? `Meridiana ${idx + 1}` : "Meridiana";
  const foto = escapeHtml(photoUrl(item.foto, "medie"));
  const link = (it) => `#m=${c.slug}/${encodeURIComponent(it.id)}`;

  const anno = String(item["anno fotografia"] ?? "").trim();
  const gm = String(item["google maps"] ?? "").trim();
  const notes = [];
  if (item.note) notes.push(item.note);
  if (anno && !isYear(anno)) notes.push(anno);
  if (gm && !isUrl(gm) && !isCoord(gm)) notes.push(gm);

  const meta = [];
  if (isYear(anno)) meta.push(`<div><strong>Anno fotografia:</strong> ${escapeHtml(anno)}</div>`);
  if (item.proprieta === "Privata") {
    meta.push(`<div><strong>Proprietà:</strong> Privata — la posizione esatta non è pubblicata</div>`);
  } else if (item.proprieta === "Pubblica") {
    meta.push(`<div><strong>Proprietà:</strong> Pubblica</div>`);
  }
  if (gm && isUrl(gm)) {
    meta.push(`<div><strong>Posizione:</strong> <a href="${escapeHtml(gm)}" target="_blank" rel="noopener noreferrer">Apri in Google Maps ↗</a></div>`);
  } else if (gm && isCoord(gm)) {
    meta.push(`<div><strong>Google Maps:</strong> ${escapeHtml(gm)}</div>`);
  }
  notes.forEach(n => meta.push(`<div><strong>Note:</strong> ${escapeHtml(n)}</div>`));

  $("view-detail").innerHTML = `
    <a class="back" href="#c=${c.slug}">← ${escapeHtml(c.nome)}</a>
    ${foto ? `
      <a class="photo-wrap" href="${foto}" target="_blank" rel="noopener">
        <img src="${foto}" alt="Meridiana di ${escapeHtml(c.nome)}">
      </a>
      <p class="photo-credit">${escapeHtml(item.copyright || "")}</p>
      <p class="photo-hint">Tocca la foto per aprirla a schermo intero</p>` : ""}
    <div class="detail-body">
      <p class="eyebrow">${escapeHtml(etichetta.toUpperCase())}</p>
      <h2>${escapeHtml(c.nome)}</h2>
      ${placeLine(c) ? `<p class="muted">${escapeHtml(placeLine(c))}</p>` : ""}
      ${item.localita ? `<div class="detail-locality"><strong>Località:</strong> ${escapeHtml(item.localita)}</div>` : ""}
      ${item.motto ? `<div class="motto">“${escapeHtml(item.motto)}”</div>` : ""}
      ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
    </div>
    ${list.length > 1 ? `
      <nav class="pager" aria-label="Altre meridiane del comune">
        <a href="${prev ? link(prev) : "#"}" class="${prev ? "" : "disabled"}">‹ Precedente</a>
        <a href="${next ? link(next) : "#"}" class="${next ? "" : "disabled"}">Successiva ›</a>
      </nav>` : ""}`;
  document.title = `Meridiana a ${c.nome} – Atlante delle Meridiane`;
}

// ---------- mappa: si carica solo dopo il consenso dell'utente ----------
const CONSENT_KEY = "atlante-mappa-consenso";
const MAP_LIBS = {
  css: ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
        "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css",
        "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css"],
  js: ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
       "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"]
};
let mapConsent = false;
let libsPromise = null;

function readConsent() {
  try { return localStorage.getItem(CONSENT_KEY) === "si"; } catch (_) { return false; }
}
function storeConsent(on) {
  try { on ? localStorage.setItem(CONSENT_KEY, "si") : localStorage.removeItem(CONSENT_KEY); } catch (_) { /* solo per questa visita */ }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error("Impossibile caricare " + src));
    document.head.appendChild(el);
  });
}
function loadMapLibs() {
  if (typeof L !== "undefined" && typeof L.markerClusterGroup === "function") return Promise.resolve();
  if (!libsPromise) {
    MAP_LIBS.css.forEach(href => {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = href;
      document.head.appendChild(link);
    });
    libsPromise = loadScript(MAP_LIBS.js[0]).then(() => loadScript(MAP_LIBS.js[1])).catch(err => { libsPromise = null; throw err; });
  }
  return libsPromise;
}

function showMapUI() {
  $("map-gate").hidden = mapConsent;
  $("map-wrap").hidden = !mapConsent;
  $("map-reset").hidden = !mapConsent;
  $("map-reset-sep").hidden = !mapConsent;
}

async function enableMap() {
  mapConsent = true;
  storeConsent(true);
  $("map-gate-msg").hidden = true;
  showMapUI();
  try {
    await loadMapLibs();
    if (!mapConsent) return;               // revocata mentre si caricava
    if (!map) setupMap();
    setTimeout(() => map && map.invalidateSize(), 50);
  } catch (err) {
    console.warn("Mappa non disponibile:", err);
    mapConsent = false;
    showMapUI();
    $("map-gate-msg").textContent = "Non è stato possibile caricare la mappa. Controlla la connessione e riprova.";
    $("map-gate-msg").hidden = false;
  }
}

function disableMap() {
  mapConsent = false;
  storeConsent(false);
  if (map) { map.remove(); map = null; }
  markers = {};
  showMapUI();
}

function initMapGate() {
  $("map-enable").addEventListener("click", enableMap);
  $("map-reset").addEventListener("click", disableMap);
  mapConsent = readConsent();
  showMapUI();
  if (mapConsent) enableMap();             // l'utente aveva già accettato su questo dispositivo
}

// ---------- mappa (in fondo alla pagina) ----------
function setupMap() {
  map = L.map("map", { scrollWheelZoom: false }).setView([42.5, 12.5], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // Con molti comuni i marker vicini si raggruppano; se il plugin non si carica, marker semplici.
  const group = (typeof L.markerClusterGroup === "function")
    ? L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45 })
    : L.layerGroup();

  const bounds = [];
  comuni.forEach(c => {
    if (typeof c.lat !== "number" || typeof c.lon !== "number") return;   // senza coordinate: niente marker
    const icon = L.divIcon({ className: "sundial-marker", html: "☀️", iconSize: [34, 34], iconAnchor: [17, 17] });
    const m = L.marker([c.lat, c.lon], { icon, title: c.nome });
    m.bindTooltip(`<strong>${escapeHtml(c.nome)}</strong><br>${c.n} ${c.n === 1 ? "meridiana" : "meridiane"}`,
      { direction: "top", offset: [0, -12] });
    m.on("click", () => { location.hash = "c=" + c.slug; });
    group.addLayer(m);
    markers[c.slug] = m;
    bounds.push([c.lat, c.lon]);
  });
  map.addLayer(group);
  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
}

function highlightMarker(slug) {
  Object.entries(markers).forEach(([k, m]) => m.setZIndexOffset(k === slug ? 1000 : 0));
}

init().catch(err => {
  console.error(err);
  $("view-home").innerHTML = `<p class="muted">Errore nel caricamento dei dati. Se apri la pagina in locale, usa un piccolo server
    (es. <code>python -m http.server</code>) invece del doppio clic su index.html.</p>`;
});
