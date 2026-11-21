// ===== Modulo "Scrivi una voce" (le voci delle meridiane) =====
// Si apre dalla scheda di una meridiana con  voci.html?m=<slug del comune>/<id della meridiana>
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));

  let cfg = null, comuneKey = "", slug = "", idMer = "", item = null;
  let tsToken = "", tsCaricato = false, inviando = false;
  const MIN_CARATTERI = 10;

  // codice casuale di questa compilazione: un secondo tentativo (linea caduta, doppio tocco) non crea un doppione
  function nuovoCodice() {
    const a = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.from(a, x => x.toString(16).padStart(2, "0")).join("");
  }
  const codiceInvio = nuovoCodice();

  function errore(campo, msg) { const p = $("err-" + campo); if (!p) return; p.textContent = msg; p.hidden = false; }
  function pulisciErrori() { document.querySelectorAll(".err").forEach(p => { p.hidden = true; p.textContent = ""; }); }
  function valoreRadio(nome) { const el = document.querySelector(`input[name="${nome}"]:checked`); return el ? el.value : ""; }
  function stato(msg, errore_) {
    const p = $("stato");
    p.textContent = msg; p.hidden = !msg; p.classList.toggle("bad", !!errore_);
  }

  // ---------- avvio ----------
  async function avvia() {
    try {
      const r = await fetch("data/config-form.json");
      cfg = r.ok ? await r.json() : null;
    } catch (_) { cfg = null; }
    if (!cfg || !cfg.attivo || !cfg.voci_attive) { $("form-off").hidden = false; return; }

    const m = /^([a-z0-9-]+)\/(\d{1,9})$/.exec(new URLSearchParams(location.search).get("m") || "");
    if (!m) { $("mer-errore").hidden = false; return; }
    slug = m[1]; idMer = m[2];
    try {
      const idx = await (await fetch("data/index.json")).json();
      const c = (idx.comuni || []).find(x => x.slug === slug);
      if (!c) throw new Error("comune");
      comuneKey = c.key;
      const r = await fetch(`data/comuni/${slug}.json`);
      if (!r.ok) throw new Error("dati");
      item = (await r.json()).find(x => String(x.id) === idMer);
      if (!item) throw new Error("meridiana");
    } catch (_) { $("mer-errore").hidden = false; return; }

    $("indietro").href = `index.html#m=${slug}/${encodeURIComponent(idMer)}`;
    $("indietro").textContent = "← Torna alla scheda";
    mostraRiepilogo();
    const max = Number(cfg.max_voci) >= 1 ? Number(cfg.max_voci) : 10;
    if (Array.isArray(item.voci) && item.voci.length >= max) { $("mer-piena").hidden = false; return; }

    const massimo = Number(cfg.voci_max_caratteri) >= 100 ? Number(cfg.voci_max_caratteri) : 300;
    $("testo").maxLength = massimo; $("massimo").textContent = String(massimo);
    riempiCategorie();
    $("modulo").hidden = false;
    if (cfg.sitekey) $("ts-hint").hidden = false;

    $("testo").addEventListener("input", () => { $("conta").textContent = String($("testo").value.length); });
    document.querySelectorAll('input[name="credito"]').forEach(el =>
      el.addEventListener("change", () => { $("nome-box").hidden = (valoreRadio("credito") !== "mostra"); }));
    $("modulo").addEventListener("focusin", caricaTurnstile, { once: true });
    $("modulo").addEventListener("submit", invia);
  }

  function mostraRiepilogo() {
    const stem = String(item.foto || "").split("/").pop().replace(/\.[^.]+$/, "");
    const sotto = [item.localita, item.motto ? "“" + item.motto + "”" : ""].filter(Boolean).join(" · ");
    $("mer-riepilogo").innerHTML = (stem ? `<img src="catalogo/thumbs/${esc(stem)}.jpg" onerror="this.onerror=null;this.src='catalogo/medie/${esc(stem)}.jpg'" alt="" width="64" height="64">` : "") +
      `<span class="gia-testo"><strong>Meridiana a ${esc(comuneKey)}</strong>${sotto ? `<span>${esc(sotto)}</span>` : ""}</span>`;
    $("mer-riepilogo").hidden = false;
  }

  function riempiCategorie() {
    const lista = (Array.isArray(cfg.voci_categorie) ? cfg.voci_categorie : []).filter(c => c && c.attiva === true);
    $("categorie").innerHTML = lista.map(c =>
      `<label class="choice"><input type="radio" name="categoria" value="${esc(c.id)}"><span><strong>${esc(c.titolo)}</strong><br>${esc(c.sottotitolo || "")}</span></label>`).join("");
    if (!lista.length) $("blocco-categoria").hidden = true;
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
        sitekey: cfg.sitekey, language: "it", action: "voce",
        callback: (t) => { tsToken = t; },
        "expired-callback": () => { tsToken = ""; },
        "error-callback": () => { tsToken = ""; }
      });
    };
    document.head.appendChild(s);
  }
  function reimpostaTurnstile() {
    tsToken = "";
    try { if (window.turnstile) window.turnstile.reset(); } catch (_) { /* nessuna azione */ }
  }

  // ---------- controllo dei campi ----------
  function valida() {
    pulisciErrori();
    let primo = null;
    const segna = (campo, msg, elId) => { errore(campo, msg); if (!primo) primo = $(elId || campo); };
    if (!$("blocco-categoria").hidden && !valoreRadio("categoria")) segna("categoria", "Scegli di che cosa vuoi parlare.", "blocco-categoria");
    const testo = $("testo").value.trim();
    if (testo.length < MIN_CARATTERI) segna("testo", `Scrivi almeno ${MIN_CARATTERI} caratteri.`, "testo");
    const cred = valoreRadio("credito");
    if (!cred) segna("credito", "Indica se vuoi che compaia il tuo nome.", "modulo");
    else if (cred === "mostra" && !$("nome").value.trim()) segna("nome", "Scrivi il nome da mostrare.", "nome");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($("email").value.trim())) segna("email", "Scrivi un indirizzo email valido.", "email");
    if (!($("c-pubblicazione").checked && $("c-contenuto").checked && $("c-privacy").checked)) segna("consensi", "Per inviare devi spuntare tutte le conferme.", "c-pubblicazione");
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

    const payload = {
      azione: "voce",
      comune: comuneKey, id_meridiana: idMer,
      categoria: valoreRadio("categoria"), testo: $("testo").value.trim(),
      mostra_nome: valoreRadio("credito") === "mostra", nome: $("nome").value,
      email: $("email").value.trim(),
      codice_invio: codiceInvio,
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
        $("modulo").hidden = true; $("esito").hidden = false;
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        // un testo non ammesso (link, contatti, parole vietate): il messaggio compare sotto il campo, che riceve il cursore
        const campo = ["testo", "nome"].find(x => j && Array.isArray(j.campi) && j.campi.includes(x) && $("err-" + x));
        if (campo) { pulisciErrori(); errore(campo, j.errore); stato("Controlla il testo segnalato qui sopra e riprova.", true); $(campo).focus(); }
        else stato((j && j.errore) || "L'invio non è riuscito. Riprova.", true);
        reimpostaTurnstile();
      }
    } catch (_) {
      stato("Non sono riuscito a inviare la voce (connessione assente o troppo lenta). Controlla la connessione e riprova: se l'invio era già partito, non verrà duplicato.", true);
      reimpostaTurnstile();
    } finally {
      clearTimeout(timer); inviando = false; $("invia").disabled = false;
    }
  }

  avvia();
})();
