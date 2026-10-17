// ===== Modulo "Inserisci la tua meridiana" =====
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const MAX_LATO = 1600, MAX_BYTE = 3 * 1024 * 1024;

  let cfg = null;
  let elenco = [], elencoNorm = [];
  let foto = null;               // { base64, byte, larghezza, altezza }
  let tsToken = "", tsCaricato = false, inviando = false;

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
      elenco = await r.json();
      elencoNorm = elenco.map(norm);
    } catch (_) { /* senza elenco il comune non si può scegliere: l'errore comparirà all'invio */ }

    $("comune").addEventListener("input", suggerisci);
    $("foto").addEventListener("change", sceltaFoto);
    document.querySelectorAll('input[name="credito"]').forEach(el =>
      el.addEventListener("change", () => { $("nome-box").hidden = (valoreRadio("credito") !== "mostra"); }));
    $("modulo").addEventListener("focusin", caricaTurnstile, { once: true });
    $("modulo").addEventListener("submit", invia);
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
