// ===== Pagina "Modifica la tua meridiana" =====
// Le parti dell'editor di ritaglio e dell'antispam sono le stesse del modulo di invio (inserisci.js): se cambi quelle, cambia anche qui.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  const MAX_LATO = 2400, MAX_BYTE = 3 * 1024 * 1024;   // lato massimo inviato, peso massimo

  let cfg = null;
  let elenco = [], elencoNorm = [];
  let foto = null;               // ritaglio confermato: { base64, byte, larghezza, altezza, imp, impIntera }
  let tsToken = "", tsCaricato = false, inviando = false;
  let indiceSito = null, merToken = 0, merDisponibili = false;

  function errore(campo, msg) { const p = $("err-" + campo); p.textContent = msg; p.hidden = false; }
  function pulisciErrori() { document.querySelectorAll(".err").forEach(p => { p.hidden = true; p.textContent = ""; }); }
  function valoreRadio(nome) { const el = document.querySelector(`input[name="${nome}"]:checked`); return el ? el.value : ""; }
  function stato(msg, errore_) {
    const p = $("stato");
    p.textContent = msg; p.hidden = !msg; p.classList.toggle("bad", !!errore_);
  }

  // Elenco guidato degli anni (dal corrente al 1950); l'ultima voce vale "nessun anno"
  function riempiAnni(sel, voceVuota, primaVoceVuota) {
    const fine = new Date().getFullYear();
    sel.innerHTML = "";
    const aggiungi = (v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); };
    if (primaVoceVuota) aggiungi("", voceVuota);
    for (let a = fine; a >= 1950; a--) aggiungi(String(a), String(a));
    if (!primaVoceVuota) aggiungi("", voceVuota);
    sel.value = primaVoceVuota ? "" : String(fine);
  }

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
    const estOk = /\.(jpe?g|png|webp)$/i.test(file.name || "");
    const tipoOk = ["image/jpeg", "image/png", "image/webp"].includes(file.type);
    if (!(file.type ? tipoOk : estOk)) { errore("foto", "Formato non ammesso: scegli un file jpg, jpeg, png o webp."); return; }
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
    ul.innerHTML = lista.map(l => `<li><button type="button" class="comune-btn sug-btn" data-v="${esc(l)}"><span class="comune-name">${esc(l)}</span></button></li>`).join("");
    ul.querySelectorAll(".sug-btn").forEach(b => b.addEventListener("click", () => {
      $("comune").value = b.dataset.v; ul.innerHTML = ""; $("err-comune").hidden = true;
      aggiornaMeridiane(b.dataset.v);
    }));
  }

  // ---------- meridiane pubblicate nel comune scelto ----------
  async function caricaIndiceSito() {
    if (indiceSito !== null) return indiceSito;
    try {
      const j = await (await fetch("data/index.json")).json();
      indiceSito = {};
      (j.comuni || []).forEach(c => { indiceSito[c.key] = c; });
    } catch (_) { indiceSito = {}; }
    return indiceSito;
  }
  async function aggiornaMeridiane(label) {
    const token = ++merToken;
    merDisponibili = false;
    $("mer-box").hidden = true; $("err-mer").hidden = true; $("mer-lista").innerHTML = "";
    if (!label) return;
    const c = (await caricaIndiceSito())[label];
    let items = [];
    if (c && c.n) {
      try {
        const r = await fetch(`data/comuni/${c.slug}.json`);
        if (r.ok) items = await r.json();
      } catch (_) { items = []; }
    }
    if (token !== merToken) return;
    $("mer-box").hidden = false;
    if (!items.length) {
      $("mer-intro").textContent = `Nel catalogo non ci sono ancora meridiane pubblicate in ${label}. Qui si possono modificare solo quelle già pubblicate.`;
      return;
    }
    $("mer-intro").textContent = items.length === 1 ? `Nel catalogo c'è 1 meridiana in ${label}:` : `Nel catalogo ci sono ${items.length} meridiane in ${label}. Scegli la tua:`;
    $("mer-lista").innerHTML = items.map((it, i) => {
      const stem = String(it.foto || "").split("/").pop().replace(/\.[^.]+$/, "");
      const sotto = [it.localita, /^\d{4}$/.test(String(it["anno fotografia"]).trim()) ? "foto " + it["anno fotografia"] : ""].filter(Boolean).join(" · ");
      return `<li class="gia-voce"><label class="choice" style="margin:0;align-items:flex-start">
        <input type="radio" name="mer" value="${esc(it.id)}">
        <img src="catalogo/thumbs/${esc(stem)}.jpg" onerror="this.onerror=null;this.src='catalogo/medie/${esc(stem)}.jpg'" alt="" loading="lazy" width="64" height="64" style="flex:none;width:64px;height:64px;object-fit:cover;border-radius:8px">
        <span class="gia-testo"><strong>${items.length > 1 ? "Meridiana " + (i + 1) : "Meridiana"}</strong>
          ${it.motto ? `<span>“${esc(it.motto)}”</span>` : ""}${sotto ? `<span>${esc(sotto)}</span>` : ""}
          <a href="index.html#m=${esc(c.slug)}/${encodeURIComponent(it.id)}" target="_blank" rel="noopener">Vedi la scheda ↗</a></span></label></li>`;
    }).join("");
    merDisponibili = true;
  }

  // ---------- sezioni secondo l'azione scelta ----------
  function aggiornaSezioni() {
    const a = valoreRadio("azione");
    $("sez-dati").hidden = a !== "dati";
    $("sez-foto").hidden = a !== "foto";
    $("avviso-rimozione").hidden = !(a === "rimuovi" || a === "rimuovi_tutte");
    $("err-azione").hidden = true;
    $("invia").textContent = "Invia la richiesta";
  }

  // ---------- controllo dei campi ----------
  function datiCambiati() {
    const d = {};
    if ($("anno").value) d.anno = $("anno").value;
    if ($("proprieta").value) d.proprieta = $("proprieta").value;
    ["motto", "localita", "note"].forEach(k => { const v = $(k).value.trim(); if (v) d[k] = v; });
    return d;
  }
  function valida() {
    pulisciErrori();
    let primo = null;
    const segna = (campo, msg, elId) => { errore(campo, msg); if (!primo) primo = $(elId || campo); };
    if (!trovaEsatto($("comune").value)) segna("comune", "Scegli il comune dall'elenco dei suggerimenti.", "comune");
    else if (!merDisponibili) segna("mer", "In questo comune non ci sono meridiane pubblicate da modificare.", "mer-box");
    else if (!valoreRadio("mer")) segna("mer", "Scegli la tua meridiana dall'elenco.", "mer-box");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($("email").value.trim())) segna("email", "Scrivi un indirizzo email valido.", "email");
    const a = valoreRadio("azione");
    if (!a) segna("azione", "Scegli che cosa vuoi fare.", "modulo");
    if (a === "dati" && !Object.keys(datiCambiati()).length) segna("dati", "Indica almeno un dato da cambiare.", "anno");
    if (a === "foto") {
      if (!foto) { if (imgOrig) segna("foto", "Conferma il ritaglio con il pulsante «Conferma ritaglio».", "crop-ok"); else segna("foto", "Scegli la nuova fotografia.", "foto"); }
      if (!($("c-pubblicazione").checked && $("c-contenuto").checked)) segna("consensi", "Per inviare devi spuntare entrambe le conferme.", "c-pubblicazione");
    }
    if (cfg.sitekey && !tsToken) { stato("Completa la verifica anti-spam qui sopra, poi invia di nuovo.", true); if (!primo) primo = $("ts-box"); }
    if (primo) { primo.scrollIntoView({ behavior: "smooth", block: "center" }); if (primo.focus) primo.focus({ preventScroll: true }); return false; }
    return true;
  }

  // ---------- invio ----------
  async function invia(ev) {
    ev.preventDefault();
    if (inviando) return;
    stato("");
    if (!valida()) return;
    inviando = true; $("invia").disabled = true;
    stato("Invio in corso… non chiudere la pagina.");
    const a = valoreRadio("azione");
    const payload = {
      azione: "modifica", tipo: a,
      comune: trovaEsatto($("comune").value), id_meridiana: valoreRadio("mer"),
      email: $("email").value.trim(), codice: $("codice").value.trim(),
      sito_web: $("sito_web").value, turnstile: tsToken
    };
    if (a === "dati") payload.dati = datiCambiati();
    if (a === "foto") {
      Object.assign(payload, { foto: foto.base64, impronta: foto.imp || "", impronta_intera: foto.impIntera || "",
        larghezza_ritaglio: foto.larghezza, altezza_ritaglio: foto.altezza,
        consenso_pubblicazione: $("c-pubblicazione").checked, consenso_contenuto: $("c-contenuto").checked });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000);
    try {
      // corpo "text/plain": evita la richiesta preliminare che gli script Google non gestiscono
      const r = await fetch(cfg.endpoint, { method: "POST", body: JSON.stringify(payload), signal: ctrl.signal });
      const j = await r.json();
      if (j && j.ok) {
        $("modulo").hidden = true; $("esito").hidden = false;
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        stato((j && j.errore) || "L'invio non è riuscito. Riprova.", true);
        reimpostaTurnstile();
      }
    } catch (_) {
      stato("Non sono riuscito a inviare la richiesta (connessione assente o troppo lenta). Controlla la connessione e riprova.", true);
      reimpostaTurnstile();
    } finally {
      clearTimeout(timer); inviando = false; $("invia").disabled = false;
    }
  }
  function reimpostaTurnstile() {
    tsToken = "";
    try { if (window.turnstile) window.turnstile.reset(); } catch (_) { /* nessuna azione */ }
  }

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
    } catch (_) { /* senza elenco il comune non si può scegliere */ }

    riempiAnni($("anno"), "Non cambiare", true);
    $("comune").addEventListener("input", suggerisci);
    $("comune").addEventListener("change", () => { const e = trovaEsatto($("comune").value); aggiornaMeridiane(e); });
    document.querySelectorAll('input[name="azione"]').forEach(el => el.addEventListener("change", aggiornaSezioni));
    $("foto").addEventListener("change", sceltaFoto);
    $("crop-ok").addEventListener("click", confermaRitaglio);
    $("crop-reset").addEventListener("click", () => { r = { x: 0, y: 0, w: 1, h: 1 }; aggiornaRitaglio(); });
    $("crop-modifica").addEventListener("click", modificaRitaglio);
    eventiRitaglio();
    $("modulo").addEventListener("focusin", caricaTurnstile, { once: true });
    $("modulo").addEventListener("submit", invia);
  }

  avvia();
})();
