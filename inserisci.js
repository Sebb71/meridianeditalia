// ===== Modulo "Inserisci la tua meridiana" =====
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const MAX_LATO = 1600, MAX_BYTE = 3 * 1024 * 1024;

  let cfg = null;
  let elenco = [], elencoNorm = [], centri = [], raggi = [];
  let foto = null;               // { base64, byte, larghezza, altezza }
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

    $("modulo").hidden = false;
    if (cfg.sitekey) $("ts-hint").hidden = false;
    try {
      const r = await fetch("data/comuni_elenco.json");
      const lista = await r.json();                       // [nome, latitudine, longitudine]
      elenco = lista.map(x => x[0]);
      elencoNorm = elenco.map(norm);
      centri = lista.map(x => (x[1] == null ? null : [x[1], x[2]]));
      raggi = lista.map(x => (x[3] == null ? null : x[3]));        // raggio indicativo del comune, in km
    } catch (_) { /* senza elenco il comune non si può scegliere: l'errore comparirà all'invio */ }

    $("comune").addEventListener("input", suggerisci);
    $("foto").addEventListener("change", sceltaFoto);
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
  const FATTORE_LIMITE = 2.2;                                // oltre 2,2 volte il raggio indicativo: coordinata non valida
  const arrotonda = (n) => Math.round(n * 1e5) / 1e5;

  function leggiConsenso() { try { return localStorage.getItem(CHIAVE_CONSENSO) === "si"; } catch (_) { return false; } }
  function salvaConsenso(on) { try { on ? localStorage.setItem(CHIAVE_CONSENSO, "si") : localStorage.removeItem(CHIAVE_CONSENSO); } catch (_) { /* solo per questa visita */ } }

  function distanzaKm(a, b) {
    const R = 6371, rad = (x) => x * Math.PI / 180;
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function indiceComune() {
    const label = trovaEsatto($("comune").value);
    return label ? elenco.indexOf(label) : -1;
  }
  function centroComune() { const i = indiceComune(); return i >= 0 ? centri[i] : null; }
  function raggioComune() { const i = indiceComune(); return i >= 0 ? raggi[i] : null; }

  // Controllo di massima (non abbiamo i confini reali): ok / al limite / fuori dal comune / non verificabile
  function verificaPunto(lat, lon) {
    const c = centroComune(), r = raggioComune();
    if (!c || !r) return { stato: "nd" };
    const km = distanzaKm(c, [lat, lon]);
    if (km <= r) return { stato: "ok", km };
    if (km <= FATTORE_LIMITE * r) return { stato: "limite", km };
    return { stato: "fuori", km };
  }
  function erroreFuori(km) {
    const p = $("err-posizione");
    p.textContent = `Coordinata non valida: il punto è esterno al comune selezionato (a circa ${Math.round(km)} km dal suo centro). ` +
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
      if (label) {
        if (cambiato) annullaGps();
        if (pos) {
          const v = verificaPunto(pos.lat, pos.lon);
          if (v.stato === "fuori") { rimuoviPos(); erroreFuori(v.km); }
          else aggiornaRiepilogo();
        }
        if (map) { disegnaArea(); if (!pos) centraSulComune(); }
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
    navigator.geolocation.getCurrentPosition((p) => {
      messaggioGps("");
      gpsTemp = { lat: p.coords.latitude, lon: p.coords.longitude, precisione: p.coords.accuracy };
      const v = verificaPunto(gpsTemp.lat, gpsTemp.lon);
      if (v.stato === "fuori") {
        gpsTemp = null;
        messaggioGps(`Il GPS indica una posizione esterna al comune selezionato (a circa ${Math.round(v.km)} km dal suo centro): ` +
                     "non la posso usare. Controlla di aver scelto il comune giusto, oppure scegli il punto sulla mappa.", true);
        apriMappa(null, 13);
        return;
      }
      gpsInAttesa = true;
      let t = `Posizione rilevata: ${gpsTemp.lat.toFixed(5)}, ${gpsTemp.lon.toFixed(5)} (precisione circa ±${Math.round(gpsTemp.precisione)} m). ` +
              "Controlla sulla mappa: la meridiana si trova qui, dove sei adesso?";
      if (gpsTemp.precisione > 150) t += " Attenzione: la precisione è bassa, conviene correggere il punto sulla mappa.";
      if (v.stato === "limite") t += " Il punto è vicino al limite del comune.";
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
    const v = verificaPunto(lat, lon);
    if (v.stato === "fuori") { erroreFuori(v.km); return false; }
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
    const v = verificaPunto(pos.lat, pos.lon), avviso = $("pos-avviso");
    if (v.stato === "limite") {
      avviso.textContent = `Il punto è a circa ${Math.round(v.km)} km dal centro del comune, vicino al suo limite: controlla di aver scelto il comune giusto.`;
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
  function disegnaArea() {                                  // cerchio tratteggiato: area indicativa del comune
    if (!map) return;
    if (cerchioArea) { map.removeLayer(cerchioArea); cerchioArea = null; }
    const c = centroComune(), r = raggioComune();
    if (c && r) cerchioArea = L.circle(c, { radius: r * 1000, color: "#b46b31", weight: 1.5, dashArray: "6 6", fill: false, interactive: false }).addTo(map);
  }
  function creaMappa() {
    let centro = [42.5, 12.5], zoom = 6;
    if (pos) { centro = [pos.lat, pos.lon]; zoom = ZOOM_PUNTO; }
    else if (vistaIniziale) { centro = vistaIniziale.c; zoom = vistaIniziale.z; }
    else { const c = centroComune(); if (c) { centro = c; zoom = 13; } }
    map = L.map("mappa-form", { scrollWheelZoom: false }).setView(centro, zoom);
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
    const c = centroComune();
    if (c && map) map.setView(c, 13);
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

  // ---------- foto: ridimensionamento e pulizia dei dati nascosti ----------
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
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1]);
      r.onerror = () => ko(new Error("lettura non riuscita"));
      r.readAsDataURL(blob);
    });
  }
  async function sceltaFoto() {
    const file = $("foto").files[0];
    foto = null; $("anteprima").hidden = true; $("foto-info").hidden = true; $("err-foto").hidden = true;
    if (!file) return;
    if (file.type && !file.type.startsWith("image/")) { errore("foto", "Il file scelto non è un'immagine."); return; }
    try {
      const img = await decodifica(file);
      let lato = MAX_LATO, blob = null;
      for (const q of [0.85, 0.72, 0.6, 0.5]) {
        const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
        const s = Math.min(1, lato / Math.max(w0, h0));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w0 * s)); canvas.height = Math.max(1, Math.round(h0 * s));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);   // ridisegnando si perdono i metadati (GPS compreso)
        blob = await toBlob(canvas, q);
        if (blob && blob.size <= MAX_BYTE) { foto = { larghezza: canvas.width, altezza: canvas.height }; break; }
        lato = 1200;
      }
      if (!foto || !blob || blob.size > MAX_BYTE) { foto = null; errore("foto", "La foto è troppo pesante anche dopo il ridimensionamento."); return; }
      foto.byte = blob.size;
      foto.base64 = await inBase64(blob);
      $("anteprima").src = URL.createObjectURL(blob); $("anteprima").hidden = false;
      $("foto-info").textContent = `Verrà inviata a ${foto.larghezza}×${foto.altezza} px (${Math.round(blob.size / 1024)} KB).`;
      $("foto-info").hidden = false;
    } catch (_) {
      foto = null;
      errore("foto", "Non riesco a leggere questa immagine. Prova con una foto JPG o PNG.");
    }
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
    const anno = $("anno").value.trim();
    if (anno && !(/^\d{4}$/.test(anno) && +anno >= 1800 && +anno <= new Date().getFullYear())) segna("anno", "Scrivi un anno di quattro cifre, oppure lascia vuoto.", "anno");
    if (!valoreRadio("proprieta")) segna("proprieta", "Indica se la proprietà è privata o pubblica.", "modulo");
    if (!foto) segna("foto", "Scegli la fotografia.", "foto");
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
      consenso_pubblicazione: $("c-pubblicazione").checked,
      consenso_contenuto: $("c-contenuto").checked,
      consenso_privacy: $("c-privacy").checked,
      posizione: pos ? { lat: pos.lat, lon: pos.lon, origine: pos.origine, precisione: pos.precisione } : null,
      indicazioni: $("indicazioni").value,
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
