// ===== Modulo "Inserisci la tua meridiana" =====
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const MAX_LATO = 2400, MAX_BYTE = 3 * 1024 * 1024;   // lato massimo inviato, peso massimo

  let cfg = null;
  let elenco = [], elencoNorm = [], centri = [];
  let foto = null;               // ritaglio confermato, pronto da inviare: { base64, byte, larghezza, altezza }
  let tsToken = "", tsCaricato = false, inviando = false;
  let pos = null, gpsTemp = null, gpsInAttesa = false, map = null, marcatore = null, cerchioGps = null, cerchioArea = null;
  let mapConsent = false, leafletPromise = null, comuneCorrente = null;

  // ---------- avvio ----------
  async function avvia() {
    try {
      const r = await fetch("data/config-form.json");
      cfg = r.ok ? await r.json() : null;
    } catch (_) { cfg = null; }
    if (!cfg || !cfg.attivo) { $("form-off").hidden = false; return; }
    if (cfg.ritaglio) {
      const lungo = cfg.ritaglio.lungo || soglia.lungo, corto = cfg.ritaglio.corto || soglia.corto;
      soglia = { lungo, corto,
                 consLungo: Math.max(lungo, cfg.ritaglio.consigliato_lungo || soglia.consLungo),
                 consCorto: Math.max(corto, cfg.ritaglio.consigliato_corto || soglia.consCorto) };
    }

    $("modulo").hidden = false;
    if (cfg.sitekey) $("ts-hint").hidden = false;
    try {
      const r = await fetch("data/comuni_elenco.json");
      const lista = await r.json();                       // [nome, latitudine, longitudine]
      elenco = lista.map(x => x[0]);
      elencoNorm = elenco.map(norm);
      centri = lista.map(x => (x[1] == null ? null : [x[1], x[2]]));
    } catch (_) { /* senza elenco il comune non si può scegliere: l'errore comparirà all'invio */ }

    $("comune").addEventListener("input", suggerisci);
    $("foto").addEventListener("change", sceltaFoto);
    $("crop-ok").addEventListener("click", confermaRitaglio);
    $("crop-reset").addEventListener("click", () => { r = { x: 0, y: 0, w: 1, h: 1 }; aggiornaRitaglio(); });
    $("crop-modifica").addEventListener("click", modificaRitaglio);
    eventiRitaglio();
    document.querySelectorAll('input[name="gia"]').forEach(el => el.addEventListener("change", () => {
      $("gia-avviso").hidden = (valoreRadio("gia") !== "presente");
      $("err-gia").hidden = true;
    }));
    document.querySelectorAll('input[name="credito"]').forEach(el =>
      el.addEventListener("change", () => { $("nome-box").hidden = (valoreRadio("credito") !== "mostra"); }));
    $("modulo").addEventListener("focusin", caricaTurnstile, { once: true });
    mapConsent = leggiConsenso();
    $("btn-gps").addEventListener("click", usaGps);
    $("gps-si").addEventListener("click", confermaGps);
    $("gps-no").addEventListener("click", annullaGps);
    $("btn-mappa").addEventListener("click", () => apriMappa(pos, 16));
    $("map-enable-form").addEventListener("click", attivaMappa);
    $("map-reset-form").addEventListener("click", disattivaMappa);
    $("pos-rimuovi").addEventListener("click", rimuoviPos);
    $("comune").addEventListener("input", aggiornaStatoPosizione);
    $("comune").addEventListener("change", aggiornaStatoPosizione);
    aggiornaStatoPosizione();
    $("modulo").addEventListener("submit", invia);
  }


  // ---------- posizione: GPS, mappa, riepilogo ----------
  const CHIAVE_CONSENSO = "atlante-mappa-consenso";          // la stessa della mappa della home
  const LEAFLET = { css: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", js: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" };
  const ZOOM_PUNTO = 16;                                     // abbastanza vicino da riconoscere l'edificio, non il massimo (19)
  const MARGINE_M = 500;                                     // tolleranza sul confine (GPS, contorni semplificati lungo coste e laguna)
  const arrotonda = (n) => Math.round(n * 1e5) / 1e5;

  function leggiConsenso() { try { return localStorage.getItem(CHIAVE_CONSENSO) === "si"; } catch (_) { return false; } }
  function salvaConsenso(on) { try { on ? localStorage.setItem(CHIAVE_CONSENSO, "si") : localStorage.removeItem(CHIAVE_CONSENSO); } catch (_) { /* solo per questa visita */ } }

  function indiceComune() {
    const label = trovaEsatto($("comune").value);
    return label ? elenco.indexOf(label) : -1;
  }
  function centroComune() { const i = indiceComune(); return i >= 0 ? centri[i] : null; }

  // ---------- confini del comune (ISTAT, un file per provincia, caricato quando serve) ----------
  const cacheProvince = {};           // sigla -> promessa con i confini di tutta la provincia
  let confineComune = null;           // { b: riquadro, poligoni: [[anello, ...], ...] } oppure null se non disponibile
  let confiniPromessa = Promise.resolve(null);
  let confiniToken = 0;

  function decodificaAnello(a) {      // [lat0, lon0, dlat, dlon, ...] in unità di 1e-4 gradi
    const out = [[a[0] / 1e4, a[1] / 1e4]];
    let la = a[0], lo = a[1];
    for (let i = 2; i < a.length; i += 2) { la += a[i]; lo += a[i + 1]; out.push([la / 1e4, lo / 1e4]); }
    return out;
  }
  function caricaProvincia(sigla) {
    if (!cacheProvince[sigla]) {
      cacheProvince[sigla] = fetch(`data/confini/${sigla}.json`).then(r => (r.ok ? r.json() : null)).catch(() => null);
    }
    return cacheProvince[sigla];
  }
  function caricaConfiniComune(label) {
    const token = ++confiniToken;
    confineComune = null;
    const m = /\(([A-Z]{2})\)$/.exec(label || "");
    if (!m) return Promise.resolve(null);
    confiniPromessa = caricaProvincia(m[1]).then(dati => {
      if (token !== confiniToken) return null;
      const e = dati && dati[label];
      confineComune = e ? { b: e.b, poligoni: e.g.map(p => p.map(decodificaAnello)) } : null;
      return confineComune;
    });
    return confiniPromessa;
  }

  function dentroPoligono(lat, lon, anelli) {                // regola pari/dispari su tutti gli anelli (buchi compresi)
    let dentro = false;
    for (const a of anelli) {
      for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
        const yi = a[i][0], xi = a[i][1], yj = a[j][0], xj = a[j][1];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) dentro = !dentro;
      }
    }
    return dentro;
  }
  function distanzaDalBordoM(lat, lon, poligoni) {
    const ky = 110570, kx = 111320 * Math.cos(lat * Math.PI / 180);
    let min = Infinity;
    for (const p of poligoni) for (const a of p) {
      for (let i = 0; i < a.length - 1; i++) {
        const ax = (a[i][1] - lon) * kx, ay = (a[i][0] - lat) * ky, bx = (a[i + 1][1] - lon) * kx, by = (a[i + 1][0] - lat) * ky;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < min) min = d;
      }
    }
    return min;
  }

  // Controllo con i confini del comune: ok (dentro) / bordo (entro il margine) / fuori / nd (confini non disponibili)
  function verificaPunto(lat, lon, precisione) {
    const cf = confineComune;
    if (!cf) return { stato: "nd" };
    const [minLa, minLo, maxLa, maxLo] = cf.b;
    if (lat >= minLa && lat <= maxLa && lon >= minLo && lon <= maxLo) {
      for (const p of cf.poligoni) if (dentroPoligono(lat, lon, p)) return { stato: "ok", m: 0 };
    }
    const d = distanzaDalBordoM(lat, lon, cf.poligoni);
    if (d <= MARGINE_M + Math.min(precisione || 0, 500)) return { stato: "bordo", m: d };
    return { stato: "fuori", m: d };
  }
  function testoDistanza(m) { return m < 1000 ? `${Math.max(50, Math.round(m / 50) * 50)} m` : `${Math.round(m / 1000)} km`; }
  function erroreFuori(m) {
    const p = $("err-posizione");
    p.textContent = `Coordinata non valida: il punto è esterno al comune selezionato (a circa ${testoDistanza(m)} dal suo confine). ` +
                    "Scegli un punto dentro il comune, oppure descrivi il posto a parole.";
    p.hidden = false;
  }

  // Si può indicare la posizione solo dopo aver scelto il comune
  function aggiornaStatoPosizione() {
    const label = trovaEsatto($("comune").value);
    $("btn-gps").disabled = !label;
    $("btn-mappa").disabled = !label;
    $("pos-prima").hidden = !!label;
    if (label !== comuneCorrente) {
      const cambiato = comuneCorrente !== null && label !== null;
      comuneCorrente = label;
      giaPromessa = aggiornaGiaPresenti(label);
      if (label) {
        if (cambiato) annullaGps();
        caricaConfiniComune(label).then(() => {
          if (comuneCorrente !== label) return;
          if (pos) {
            const v = verificaPunto(pos.lat, pos.lon, pos.precisione);
            if (v.stato === "fuori") { rimuoviPos(); erroreFuori(v.m); }
            else aggiornaRiepilogo();
          }
          if (map) { disegnaArea(); if (!pos && !gpsInAttesa) centraSulComune(); }
        });
      }
    }
  }

  function messaggioGps(testo, errore_) {
    const p = $("gps-msg");
    p.textContent = testo; p.hidden = !testo; p.classList.toggle("bad", !!errore_);
  }

  function usaGps() {
    $("gps-conferma").hidden = true; gpsInAttesa = false;
    $("err-posizione").hidden = true;
    if (!navigator.geolocation) {
      messaggioGps("Questo dispositivo non permette di rilevare la posizione. Scegli il punto sulla mappa o scrivi dove si trova.", true);
      return;
    }
    messaggioGps("Sto cercando la posizione… il browser ti chiederà il permesso.");
    navigator.geolocation.getCurrentPosition(async (p) => {
      messaggioGps("");
      gpsTemp = { lat: p.coords.latitude, lon: p.coords.longitude, precisione: p.coords.accuracy };
      await confiniPromessa;                               // i confini del comune devono essere pronti
      const v = verificaPunto(gpsTemp.lat, gpsTemp.lon, gpsTemp.precisione);
      if (v.stato === "fuori") {
        gpsTemp = null;
        messaggioGps(`Il GPS indica una posizione esterna al comune selezionato (a circa ${testoDistanza(v.m)} dal suo confine): ` +
                     "non la posso usare. Controlla di aver scelto il comune giusto, oppure scegli il punto sulla mappa.", true);
        apriMappa(null, 13);
        return;
      }
      gpsInAttesa = true;
      let t = `Posizione rilevata: ${gpsTemp.lat.toFixed(5)}, ${gpsTemp.lon.toFixed(5)} (precisione circa ±${Math.round(gpsTemp.precisione)} m). ` +
              "Controlla sulla mappa: la meridiana si trova qui, dove sei adesso?";
      if (gpsTemp.precisione > 150) t += " Attenzione: la precisione è bassa, conviene correggere il punto sulla mappa.";
      if (v.stato === "bordo") t += " Il punto è molto vicino al confine del comune.";
      $("gps-testo").textContent = t;
      $("gps-conferma").hidden = false;
      apriMappa(gpsTemp, ZOOM_PUNTO);                      // mostra subito la mappa con il punto rilevato
    }, (e) => {
      const m = e.code === 1 ? "Non hai dato il permesso di usare la posizione. Puoi scegliere il punto sulla mappa o scrivere dove si trova."
              : e.code === 3 ? "La rilevazione della posizione ha impiegato troppo tempo. Riprova all'aperto, oppure usa la mappa."
              : "Non riesco a rilevare la posizione. Usa la mappa o scrivi dove si trova.";
      messaggioGps(m, true);
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }
  function confermaGps() {
    if (!gpsTemp) return;
    impostaPos(gpsTemp.lat, gpsTemp.lon, "gps", gpsTemp.precisione);
  }
  function annullaGps() {
    gpsInAttesa = false;
    $("gps-conferma").hidden = true;
    if (map) { togliCerchioGps(); if (!pos && marcatore) { map.removeLayer(marcatore); marcatore = null; } }
  }

  // Registra la posizione se è valida; restituisce false se il punto è fuori dal comune
  function impostaPos(lat, lon, origine, precisione) {
    const v = verificaPunto(lat, lon, precisione);
    if (v.stato === "fuori") { erroreFuori(v.m); return false; }
    pos = { lat: arrotonda(lat), lon: arrotonda(lon), origine };
    if (origine === "gps" && typeof precisione === "number") pos.precisione = Math.round(precisione);
    gpsInAttesa = false;
    $("gps-conferma").hidden = true;
    if (map) {
      if (!marcatore) creaMarcatore([pos.lat, pos.lon]); else marcatore.setLatLng([pos.lat, pos.lon]);
      if (origine !== "gps") togliCerchioGps();
    }
    aggiornaRiepilogo();
    return true;
  }
  function rimuoviPos() {
    pos = null;
    if (map) { togliCerchioGps(); if (marcatore) map.removeLayer(marcatore); }
    marcatore = null;
    aggiornaRiepilogo();
  }
  function ripristinaMarcatore() {
    if (!marcatore) return;
    if (pos) marcatore.setLatLng([pos.lat, pos.lon]);
    else if (gpsInAttesa && gpsTemp) marcatore.setLatLng([gpsTemp.lat, gpsTemp.lon]);
    else { map.removeLayer(marcatore); marcatore = null; }
  }
  function aggiornaRiepilogo() {
    $("pos-riepilogo").hidden = !pos;
    if (pos) $("err-posizione").hidden = true;
    if (!pos) return;
    const da = pos.origine === "gps" ? "rilevata con il GPS" + (pos.precisione != null ? ` (±${pos.precisione} m)` : "") : "scelta sulla mappa";
    $("pos-testo").textContent = `Posizione ${da}: ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`;
    const v = verificaPunto(pos.lat, pos.lon, pos.precisione), avviso = $("pos-avviso");
    if (v.stato === "bordo") {
      avviso.textContent = "Il punto è molto vicino al confine del comune: controlla di aver scelto il comune giusto.";
      avviso.hidden = false;
    } else { avviso.hidden = true; }
  }

  // ---------- mappa (si carica solo dopo il consenso) ----------
  function caricaLeaflet() {
    if (typeof L !== "undefined") return Promise.resolve();
    if (!leafletPromise) {
      const link = document.createElement("link"); link.rel = "stylesheet"; link.href = LEAFLET.css; document.head.appendChild(link);
      leafletPromise = new Promise((ok, ko) => {
        const sc = document.createElement("script"); sc.src = LEAFLET.js;
        sc.onload = ok; sc.onerror = () => { leafletPromise = null; ko(new Error("Leaflet non caricato")); };
        document.head.appendChild(sc);
      });
    }
    return leafletPromise;
  }
  let mappaRichiesta = false, vistaIniziale = null;

  function mostraMappaOGate() {
    $("map-gate-form").hidden = mapConsent || !mappaRichiesta;
    $("map-wrap-form").hidden = !(mapConsent && mappaRichiesta);
  }

  // punto: dove centrare (se c'è); zoom: livello di ingrandimento
  function apriMappa(punto, zoom) {
    mappaRichiesta = true;
    vistaIniziale = punto ? { c: [punto.lat, punto.lon], z: zoom || ZOOM_PUNTO } : null;
    mostraMappaOGate();
    if (!mapConsent) return;
    if (map) {
      if (vistaIniziale) map.setView(vistaIniziale.c, vistaIniziale.z); else centraSulComune();
      disegnaArea();
      if (gpsInAttesa) mostraMarcatoreGps();
      setTimeout(() => map && map.invalidateSize(), 50);
    } else {
      avviaMappa();
    }
  }

  async function attivaMappa() {
    mapConsent = true; salvaConsenso(true);
    $("map-gate-msg-form").hidden = true;
    mostraMappaOGate();
    await avviaMappa();
  }
  async function avviaMappa() {
    try {
      await caricaLeaflet();
      if (!mapConsent) return;
      if (!map) creaMappa();
      setTimeout(() => map && map.invalidateSize(), 50);
      $("map-wrap-form").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (_) {
      mapConsent = false; mostraMappaOGate();
      $("map-gate-msg-form").textContent = "Non è stato possibile caricare la mappa. Controlla la connessione e riprova.";
      $("map-gate-msg-form").hidden = false;
    }
  }
  function disattivaMappa() {
    mapConsent = false; salvaConsenso(false);
    if (map) { map.remove(); map = null; marcatore = null; cerchioGps = null; cerchioArea = null; }
    mappaRichiesta = false;
    mostraMappaOGate();
  }
  function creaMarcatore(ll) {
    const icona = L.divIcon({ className: "sundial-marker", html: "☀️", iconSize: [34, 34], iconAnchor: [17, 17] });
    marcatore = L.marker(ll, { icon: icona, draggable: true }).addTo(map);
    marcatore.on("dragend", () => {
      const p = marcatore.getLatLng();
      if (!impostaPos(p.lat, p.lng, "mappa")) ripristinaMarcatore();   // fuori dal comune: il segnaposto torna indietro
    });
  }
  function mostraMarcatoreGps() {
    if (!map || !gpsTemp) return;
    const ll = [gpsTemp.lat, gpsTemp.lon];
    if (!marcatore) creaMarcatore(ll); else marcatore.setLatLng(ll);
    togliCerchioGps();
    cerchioGps = L.circle(ll, { radius: Math.min(gpsTemp.precisione || 0, 1000), color: "#b46b31", weight: 1, fillOpacity: 0.15, interactive: false }).addTo(map);
  }
  function togliCerchioGps() {
    if (cerchioGps && map) map.removeLayer(cerchioGps);
    cerchioGps = null;
  }
  function disegnaArea() {                                  // contorno tratteggiato del comune
    if (!map) return;
    if (cerchioArea) { map.removeLayer(cerchioArea); cerchioArea = null; }
    if (confineComune) {
      cerchioArea = L.polygon(confineComune.poligoni, { color: "#b46b31", weight: 1.5, dashArray: "6 6", fill: false, interactive: false }).addTo(map);
    }
  }
  function creaMappa() {
    let centro = [42.5, 12.5], zoom = 6;
    if (pos) { centro = [pos.lat, pos.lon]; zoom = ZOOM_PUNTO; }
    else if (vistaIniziale) { centro = vistaIniziale.c; zoom = vistaIniziale.z; }
    else { const c = centroComune(); if (c) { centro = c; zoom = 13; } }
    const adattaAlComune = !pos && !vistaIniziale && !gpsInAttesa && confineComune;
    map = L.map("mappa-form", { scrollWheelZoom: false }).setView(centro, zoom);
    if (adattaAlComune) centraSulComune();
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    disegnaArea();
    if (pos) creaMarcatore([pos.lat, pos.lon]);
    else if (gpsInAttesa) mostraMarcatoreGps();
    map.on("click", (e) => impostaPos(e.latlng.lat, e.latlng.lng, "mappa"));
  }
  function centraSulComune() {
    if (!map) return;
    if (confineComune) {
      const [a, b, c, d] = confineComune.b;
      map.fitBounds([[a, b], [c, d]], { padding: [20, 20], maxZoom: 15 });
    } else {
      const c = centroComune();
      if (c) map.setView(c, 13);
    }
  }

  // ---------- errori ----------
  function errore(campo, msg) { const p = $("err-" + campo); p.textContent = msg; p.hidden = false; }
  function pulisciErrori() { document.querySelectorAll(".err").forEach(p => { p.hidden = true; p.textContent = ""; }); }
  function valoreRadio(nome) { const el = document.querySelector(`input[name="${nome}"]:checked`); return el ? el.value : ""; }

  // ---------- comune con suggerimenti ----------
  function trovaEsatto(testo) {
    const n = norm(testo);
    const i = elencoNorm.indexOf(n);
    return i >= 0 ? elenco[i] : null;
  }
  function suggerisci() {
    const q = norm($("comune").value);
    const ul = $("comune-sug");
    if (q.length < 2) { ul.innerHTML = ""; return; }
    const inizio = [], dentro = [];
    for (let i = 0; i < elencoNorm.length && inizio.length < 8; i++) {
      if (elencoNorm[i].startsWith(q)) inizio.push(elenco[i]);
      else if (dentro.length < 8 && elencoNorm[i].includes(q)) dentro.push(elenco[i]);
    }
    const lista = inizio.concat(dentro).slice(0, 8);
    ul.innerHTML = lista.map(l => `<li><button type="button" class="comune-btn sug-btn" data-v="${l.replace(/"/g, "&quot;")}"><span class="comune-name">${l.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</span></button></li>`).join("");
    ul.querySelectorAll(".sug-btn").forEach(b => b.addEventListener("click", () => {
      $("comune").value = b.dataset.v; ul.innerHTML = ""; $("err-comune").hidden = true;
      aggiornaStatoPosizione();
    }));
  }

  // ---------- meridiane già pubblicate nel comune scelto ("È una di queste?") ----------
  let indiceSito = null;              // etichetta del comune -> { slug, n }, da data/index.json
  let giaToken = 0, giaAttive = false, giaPromessa = Promise.resolve();
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));

  async function caricaIndiceSito() {
    if (indiceSito !== null) return indiceSito;
    try {
      const j = await (await fetch("data/index.json")).json();
      indiceSito = {};
      (j.comuni || []).forEach(c => { indiceSito[c.key] = c; });
    } catch (_) { indiceSito = {}; }
    return indiceSito;
  }
  async function aggiornaGiaPresenti(label) {
    const token = ++giaToken;
    giaAttive = false;
    $("gia-box").hidden = true; $("gia-avviso").hidden = true; $("err-gia").hidden = true;
    document.querySelectorAll('input[name="gia"]').forEach(el => { el.checked = false; });
    if (!label) return;
    const c = (await caricaIndiceSito())[label];
    if (!c || !c.n) return;                                   // nessuna meridiana pubblicata: niente da controllare
    let items;
    try {
      const r = await fetch(`data/comuni/${c.slug}.json`);
      if (!r.ok) return;
      items = await r.json();
    } catch (_) { return; }                                   // senza elenco il modulo funziona comunque
    if (token !== giaToken || !items.length) return;
    $("gia-intro").textContent = items.length === 1
      ? `Nel catalogo c'è già 1 meridiana in ${label}. Controlla se la tua è questa:`
      : `Nel catalogo ci sono già ${items.length} meridiane in ${label}. Controlla se la tua è tra queste:`;
    $("gia-lista").innerHTML = items.map((it, i) => {
      const stem = String(it.foto || "").split("/").pop().replace(/\.[^.]+$/, "");
      const sotto = [it.localita, /^\d{4}$/.test(String(it["anno fotografia"]).trim()) ? "foto " + it["anno fotografia"] : ""].filter(Boolean).join(" · ");
      return `<li class="gia-voce">
        <img src="catalogo/thumbs/${esc(stem)}.jpg" onerror="this.onerror=null;this.src='catalogo/medie/${esc(stem)}.jpg'" alt="" loading="lazy" width="64" height="64">
        <span class="gia-testo"><strong>${items.length > 1 ? "Meridiana " + (i + 1) : "Meridiana"}</strong>
          ${it.motto ? `<span>“${esc(it.motto)}”</span>` : ""}${sotto ? `<span>${esc(sotto)}</span>` : ""}
          <a href="index.html#m=${esc(c.slug)}/${encodeURIComponent(it.id)}" target="_blank" rel="noopener">Vedi la scheda ↗</a></span></li>`;
    }).join("");
    giaAttive = true;
    $("gia-box").hidden = false;
  }

  // ---------- anti-duplicati: codice di invio e impronta della foto (calcolati nel browser) ----------
  function nuovoCodice() {
    const a = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.from(a, x => x.toString(16).padStart(2, "0")).join("");
  }
  const codiceInvio = nuovoCodice();      // identifica questa compilazione: un secondo tentativo non crea un doppione

  // Impronta a 64 bit ("dHash"): resta quasi uguale se la foto viene ricompressa o ridimensionata, e non permette di ricostruirla
  function impronta64(sorgente, sx, sy, sw, sh) {
    try {
      const c1 = document.createElement("canvas"); c1.width = 72; c1.height = 64;          // due passaggi: risultato stabile anche con foto molto grandi
      const x1 = c1.getContext("2d"); x1.imageSmoothingQuality = "high";
      x1.drawImage(sorgente, sx, sy, sw, sh, 0, 0, 72, 64);
      const c2 = document.createElement("canvas"); c2.width = 9; c2.height = 8;
      const x2 = c2.getContext("2d", { willReadFrequently: true }); x2.imageSmoothingQuality = "high";
      x2.drawImage(c1, 0, 0, 72, 64, 0, 0, 9, 8);
      const px = x2.getImageData(0, 0, 9, 8).data;
      const g = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      let bit = "";
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bit += g((y * 9 + x) * 4) > g((y * 9 + x + 1) * 4) ? "1" : "0";
      let hex = "";
      for (let i = 0; i < 64; i += 4) hex += parseInt(bit.slice(i, i + 4), 2).toString(16);
      return hex;
    } catch (_) { return ""; }         // senza impronta il controllo sulla foto non viene fatto
  }

  // ---------- foto: ritaglio, ridimensionamento e pulizia dei dati nascosti (tutto nel browser) ----------
  // minimo = sotto questo il ritaglio e' bloccato; consigliato = sotto questo e' accettato con un avviso gentile
  let soglia = { lungo: 800, corto: 600, consLungo: 1200, consCorto: 800 };
  let imgOrig = null, origL = 0, origA = 0;         // foto intera: resta solo nel browser, non viene inviata
  let r = { x: 0, y: 0, w: 1, h: 1 };               // rettangolo di ritaglio, in frazioni (0-1) dell'immagine
  let ritaglioValido = true, ritaglioPiccolo = false, trascina = null;
  const MIN_FRAZ = 0.04;
  const limita = (v, a, b) => Math.max(a, Math.min(b, v));

  async function decodifica(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file); } catch (_) { /* si prova con <img> */ }
    }
    return await new Promise((ok, ko) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("formato non supportato")); };
      img.src = url;
    });
  }
  function toBlob(canvas, qualita) {
    return new Promise(res => canvas.toBlob(res, "image/jpeg", qualita));
  }
  function inBase64(blob) {
    return new Promise((ok, ko) => {
      const rd = new FileReader();
      rd.onload = () => ok(String(rd.result).split(",")[1]);
      rd.onerror = () => ko(new Error("lettura non riuscita"));
      rd.readAsDataURL(blob);
    });
  }

  function azzeraFoto() {
    foto = null;
    if (imgOrig && imgOrig.close) { try { imgOrig.close(); } catch (_) { /* nessuna azione */ } }
    imgOrig = null;
    $("crop-area").hidden = true; $("foto-pronta").hidden = true; $("err-foto").hidden = true;
  }

  async function sceltaFoto() {
    const file = $("foto").files[0];
    azzeraFoto();
    if (!file) return;
    if (file.type && !file.type.startsWith("image/")) { errore("foto", "Il file scelto non è un'immagine."); return; }
    try {
      const img = await decodifica(file);
      const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
      if (Math.max(w, h) < soglia.lungo) {
        errore("foto", `La foto è troppo piccola (${w}×${h} px): serve almeno ${soglia.lungo} px sul lato lungo.`);
        return;
      }
      imgOrig = img; origL = w; origA = h;
      r = { x: 0, y: 0, w: 1, h: 1 };
      const canvas = $("crop-canvas"), sc = Math.min(1, 1400 / Math.max(w, h));      // anteprima leggera per il ritaglio
      canvas.width = Math.round(w * sc); canvas.height = Math.round(h * sc);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      $("crop-area").hidden = false;
      aggiornaRitaglio();
    } catch (_) {
      errore("foto", "Non riesco a leggere questa immagine. Prova con una foto JPG o PNG.");
    }
  }

  // Aggiorna rettangolo, misure e avviso: sotto la soglia la foto viene coperta da un velo con la scritta
  function aggiornaRitaglio() {
    const box = $("crop-box");
    box.style.left = (r.x * 100) + "%"; box.style.top = (r.y * 100) + "%";
    box.style.width = (r.w * 100) + "%"; box.style.height = (r.h * 100) + "%";
    box.classList.toggle("pieno", r.w > 0.999 && r.h > 0.999);

    const sw = r.w * origL, sh = r.h * origA;
    const sL = Math.min(soglia.lungo, Math.max(origL, origA)), sC = Math.min(soglia.corto, Math.min(origL, origA));
    ritaglioValido = Math.max(sw, sh) >= sL * 0.995 && Math.min(sw, sh) >= sC * 0.995;
    $("crop-stage").classList.toggle("troppo-piccolo", !ritaglioValido);
    $("crop-warning").hidden = ritaglioValido;
    $("crop-ok").disabled = !ritaglioValido;
    const cL = soglia.consLungo, cC = soglia.consCorto;
    ritaglioPiccolo = ritaglioValido && !(Math.max(sw, sh) >= cL * 0.995 && Math.min(sw, sh) >= cC * 0.995);
    const info = $("crop-info");
    info.textContent = `Ritaglio: ${Math.round(sw)}×${Math.round(sh)} px. Minimo: ${sL} px sul lato lungo e ${sC} px sul lato corto.`;
    info.classList.toggle("bad", !ritaglioValido);
    const lieve = $("crop-soft");
    if (lieve) lieve.hidden = !ritaglioPiccolo;
  }

  function iniziaTrascinamento(ev, modo) {
    ev.preventDefault();
    const b = $("crop-stage").getBoundingClientRect();
    trascina = { modo, px: (ev.clientX - b.left) / b.width, py: (ev.clientY - b.top) / b.height, r0: { ...r }, id: ev.pointerId };
    ev.currentTarget.setPointerCapture(ev.pointerId);
  }
  function muovi(ev) {
    if (!trascina || ev.pointerId !== trascina.id) return;
    const b = $("crop-stage").getBoundingClientRect();
    const dx = (ev.clientX - b.left) / b.width - trascina.px, dy = (ev.clientY - b.top) / b.height - trascina.py;
    const r0 = trascina.r0, m = trascina.modo;
    let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
    if (m === "move") {
      x1 = limita(r0.x + dx, 0, 1 - r0.w); x2 = x1 + r0.w;
      y1 = limita(r0.y + dy, 0, 1 - r0.h); y2 = y1 + r0.h;
    } else {
      if (m.includes("w")) x1 = limita(r0.x + dx, 0, x2 - MIN_FRAZ);
      if (m.includes("e")) x2 = limita(r0.x + r0.w + dx, x1 + MIN_FRAZ, 1);
      if (m.includes("n")) y1 = limita(r0.y + dy, 0, y2 - MIN_FRAZ);
      if (m.includes("s")) y2 = limita(r0.y + r0.h + dy, y1 + MIN_FRAZ, 1);
    }
    r = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    aggiornaRitaglio();
  }
  function fineTrascinamento(ev) { if (trascina && ev.pointerId === trascina.id) trascina = null; }
  function eventiRitaglio() {
    [$("crop-corpo"), ...document.querySelectorAll("#crop-box .h")].forEach(el => {
      el.addEventListener("pointerdown", (ev) => iniziaTrascinamento(ev, el.dataset.h || "move"));
      el.addEventListener("pointermove", muovi);
      el.addEventListener("pointerup", fineTrascinamento);
      el.addEventListener("pointercancel", fineTrascinamento);
    });
  }

  // Ricava il ritaglio dalla foto ORIGINALE (non dall'anteprima), lo porta a MAX_LATO al massimo e lo comprime
  async function confermaRitaglio() {
    if (!imgOrig || !ritaglioValido) return;
    $("crop-ok").disabled = true; $("err-foto").hidden = true;
    try {
      const sx = Math.round(r.x * origL), sy = Math.round(r.y * origA);
      const sw = Math.max(1, Math.min(origL - sx, Math.round(r.w * origL)));
      const sh = Math.max(1, Math.min(origA - sy, Math.round(r.h * origA)));
      let lato = MAX_LATO, blob = null, dim = null;
      for (const q of [0.85, 0.72, 0.6, 0.5]) {
        const s = Math.min(1, lato / Math.max(sw, sh));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(sw * s)); canvas.height = Math.max(1, Math.round(sh * s));
        canvas.getContext("2d").drawImage(imgOrig, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);  // ridisegnando si perdono i metadati (GPS compreso)
        blob = await toBlob(canvas, q);
        if (blob && blob.size <= MAX_BYTE) { dim = [canvas.width, canvas.height]; break; }
        lato = 1800;
      }
      if (!dim) { errore("foto", "La foto è troppo pesante anche dopo il ritaglio: scegli una foto più leggera."); return; }
      foto = { larghezza: dim[0], altezza: dim[1], byte: blob.size, base64: await inBase64(blob),
               imp: impronta64(imgOrig, sx, sy, sw, sh), impIntera: impronta64(imgOrig, 0, 0, origL, origA) };
      $("anteprima").src = URL.createObjectURL(blob);
      $("foto-info").textContent = `Foto pronta: verrà inviata a ${dim[0]}×${dim[1]} px (${Math.round(blob.size / 1024)} KB). Solo questa parte lascia il tuo dispositivo.`;
      $("crop-area").hidden = true; $("foto-pronta").hidden = false;
    } catch (_) {
      errore("foto", "Non sono riuscito a preparare il ritaglio. Riprova, oppure scegli un'altra foto.");
    } finally {
      $("crop-ok").disabled = !ritaglioValido;
    }
  }
  function modificaRitaglio() {
    if (!imgOrig) { $("foto").click(); return; }       // pagina ricaricata: serve scegliere di nuovo la foto
    foto = null; $("foto-pronta").hidden = true; $("crop-area").hidden = false;
    aggiornaRitaglio();
  }

  // ---------- antispam (Cloudflare Turnstile), caricato quando si inizia a compilare ----------
  function caricaTurnstile() {
    if (tsCaricato || !cfg || !cfg.sitekey) return;
    tsCaricato = true;
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => {
      $("ts-hint").hidden = true;
      window.turnstile.render("#ts-box", {
        sitekey: cfg.sitekey, language: "it",
        callback: (t) => { tsToken = t; },
        "expired-callback": () => { tsToken = ""; },
        "error-callback": () => { tsToken = ""; }
      });
    };
    document.head.appendChild(s);
  }

  // ---------- controllo dei campi ----------
  function valida() {
    pulisciErrori();
    let primo = null;
    const segna = (campo, msg, elId) => { errore(campo, msg); if (!primo) primo = $(elId || campo); };

    if (!trovaEsatto($("comune").value)) segna("comune", "Scegli il comune dall'elenco dei suggerimenti.", "comune");
    if (giaAttive) {
      const g = valoreRadio("gia");
      if (!g) segna("gia", "Indica se la tua meridiana è una di quelle già presenti.", "gia-box");
      else if (g === "presente") segna("gia", "Se la meridiana è già nel catalogo non serve inviarla di nuovo (vedi il messaggio qui sopra).", "gia-box");
    }
    const anno = $("anno").value.trim();
    if (anno && !(/^\d{4}$/.test(anno) && +anno >= 1800 && +anno <= new Date().getFullYear())) segna("anno", "Scrivi un anno di quattro cifre, oppure lascia vuoto.", "anno");
    if (!valoreRadio("proprieta")) segna("proprieta", "Indica se la proprietà è privata o pubblica.", "modulo");
    if (!foto) { if (imgOrig) segna("foto", "Conferma il ritaglio con il pulsante «Conferma ritaglio».", "crop-ok"); else segna("foto", "Scegli la fotografia.", "foto"); }
    const cred = valoreRadio("credito");
    if (!cred) segna("credito", "Indica se vuoi che compaia il tuo nome.", "modulo");
    else if (cred === "mostra" && !$("nome").value.trim()) segna("credito", "Scrivi il nome da mostrare.", "nome");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($("email").value.trim())) segna("email", "Scrivi un indirizzo email valido.", "email");
    if (!($("c-pubblicazione").checked && $("c-contenuto").checked && $("c-privacy").checked)) segna("consensi", "Per inviare devi spuntare tutte le conferme.", "c-pubblicazione");
    if (cfg.sitekey && !tsToken) { stato("Completa la verifica anti-spam qui sopra, poi invia di nuovo.", true); if (!primo) primo = $("ts-box"); }

    if (primo) { primo.scrollIntoView({ behavior: "smooth", block: "center" }); if (primo.focus) primo.focus({ preventScroll: true }); return false; }
    return true;
  }

  function stato(msg, errore_) {
    const p = $("stato");
    p.textContent = msg; p.hidden = !msg; p.classList.toggle("bad", !!errore_);
  }

  // ---------- invio ----------
  async function invia(ev) {
    ev.preventDefault();
    if (inviando) return;
    stato("");
    await giaPromessa;                                        // l'elenco delle meridiane già presenti deve essere pronto
    if (!valida()) return;
    inviando = true; $("invia").disabled = true;
    stato("Invio in corso… non chiudere la pagina.");

    const payload = {
      comune: trovaEsatto($("comune").value),
      localita: $("localita").value, motto: $("motto").value, anno: $("anno").value.trim(),
      proprieta: valoreRadio("proprieta"), note: $("note").value,
      mostra_nome: valoreRadio("credito") === "mostra", nome: $("nome").value,
      email: $("email").value.trim(),
      foto: foto.base64,
      codice_invio: codiceInvio,
      larghezza_ritaglio: foto.larghezza, altezza_ritaglio: foto.altezza,
      impronta: foto.imp || "",
      impronta_intera: foto.impIntera || "",
      consenso_pubblicazione: $("c-pubblicazione").checked,
      consenso_contenuto: $("c-contenuto").checked,
      consenso_privacy: $("c-privacy").checked,
      posizione: pos ? { lat: pos.lat, lon: pos.lon, origine: pos.origine, precisione: pos.precisione } : null,
      indicazioni: $("indicazioni").value,
      verifica_catalogo: giaAttive ? valoreRadio("gia") : "nessuna",   // risposta a "È una di queste?"
      sito_web: $("sito_web").value,
      turnstile: tsToken
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      // corpo "text/plain": evita la richiesta preliminare che gli script Google non gestiscono
      const r = await fetch(cfg.endpoint, { method: "POST", body: JSON.stringify(payload), signal: ctrl.signal });
      const j = await r.json();
      if (j && j.ok) {
        $("modulo").hidden = true;
        $("esito-id").textContent = j.id || "";
        $("esito").hidden = false;
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        stato((j && j.errore) || "L'invio non è riuscito. Riprova.", true);
        reimpostaTurnstile();
      }
    } catch (_) {
      stato("Non sono riuscito a inviare la proposta (connessione assente o troppo lenta). Controlla la connessione e riprova.", true);
      reimpostaTurnstile();
    } finally {
      clearTimeout(timer); inviando = false; $("invia").disabled = false;
    }
  }
  function reimpostaTurnstile() {
    tsToken = "";
    try { if (window.turnstile) window.turnstile.reset(); } catch (_) { /* nessuna azione */ }
  }

  avvia();
})();
