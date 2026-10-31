// Pagina di conferma delle richieste di modifica o rimozione (il link arriva per email).
// Il codice nel link si legge qui e si toglie subito dall'indirizzo; l'azione parte solo con il clic sul pulsante.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const token = (new URLSearchParams(location.search).get("c") || "").trim().toLowerCase();
  try { history.replaceState(null, "", location.pathname); } catch (_) { /* nessuna azione */ }
  let endpoint = "";

  function testo(el, msg) { el.textContent = msg; }
  function paragrafo(msg, classe) { const p = document.createElement("p"); if (classe) p.className = classe; p.textContent = msg; return p; }
  function mostra(...nodi) { const c = $("contenuto"); c.innerHTML = ""; nodi.forEach(n => c.appendChild(n)); }
  function link(href, msg) { const a = document.createElement("a"); a.href = href; a.textContent = msg; return a; }

  async function chiama(azione) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      // corpo "text/plain": evita la richiesta preliminare che gli script Google non gestiscono
      const r = await fetch(endpoint, { method: "POST", body: JSON.stringify({ azione, token }), signal: ctrl.signal });
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  function descrivi(v) {
    if (v.tipo === "dati") return `${v.etichetta || v.campo}: ${v.attuale || "(vuoto)"}  →  ${v.nuovo}`;
    if (v.tipo === "foto") return "Sostituire la fotografia con quella nuova che hai inviato.";
    if (v.tipo === "rimuovi") return "Togliere dal sito questa meridiana.";
    return `Togliere dal sito TUTTE le tue meridiane (${v.attuale}) e cancellare i tuoi dati.`;
  }

  async function avvia() {
    if (!/^[0-9a-f]{40}$/.test(token)) { mostra(paragrafo("Il link non è valido."), paragrafo("Se serve, fai di nuovo la richiesta da “Modifica la tua meridiana”.")); return; }
    try {
      const r = await fetch("data/config-form.json");
      const cfg = r.ok ? await r.json() : null;
      if (!cfg || !cfg.attivo || !cfg.endpoint) { mostra(paragrafo("Il servizio non è disponibile in questo momento. Riprova più tardi.")); return; }
      endpoint = cfg.endpoint;
    } catch (_) { mostra(paragrafo("Non riesco a caricare la pagina. Riprova più tardi.")); return; }
    let j;
    try { j = await chiama("conferma_info"); }
    catch (_) { mostra(paragrafo("Non sono riuscito a contattare il servizio (connessione assente o lenta). Ricarica la pagina tra poco, aprendo di nuovo il link dell'email.")); return; }
    if (!j || !j.ok) { mostra(paragrafo((j && j.errore) || "Qualcosa non ha funzionato. Riprova più tardi.")); return; }
    if (j.stato === "scaduta") { mostra(paragrafo("Il link è scaduto."), link("modifica.html", "Fai di nuovo la richiesta")); return; }
    if (j.stato === "gia_confermata") { mostra(paragrafo("Questa richiesta è già stata confermata, oppure il link non è più valido.")); return; }
    if (j.stato !== "valida") { mostra(paragrafo("Il link non è valido."), link("modifica.html", "Fai di nuovo la richiesta")); return; }

    const ul = document.createElement("ul");
    (j.voci || []).forEach(v => { const li = document.createElement("li"); li.textContent = descrivi(v); ul.appendChild(li); });
    const rimozione = (j.voci || []).some(v => v.tipo === "rimuovi" || v.tipo === "rimuovi_tutte");
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "submit-btn"; btn.textContent = "Conferma";
    btn.addEventListener("click", async () => {
      btn.disabled = true; $("stato").hidden = true;
      try {
        const k = await chiama("conferma");
        if (k && k.ok) { mostra(paragrafo(k.messaggio || "Richiesta registrata."), link("index.html", "Vai alla home")); }
        else { btn.disabled = false; testo($("stato"), (k && k.errore) || "Non è stato possibile completare la richiesta. Riprova.");  $("stato").hidden = false; $("stato").classList.add("bad"); }
      } catch (_) {
        btn.disabled = false; testo($("stato"), "Non sono riuscito a completare la richiesta (connessione assente o lenta). Riprova.");
        $("stato").hidden = false; $("stato").classList.add("bad");
      }
    });
    mostra(paragrafo(`Stai confermando questa richiesta per la tua meridiana a ${j.comune}:`), ul,
           ...(rimozione ? [paragrafo("Dopo la conferma la meridiana non sarà più pubblicata dal prossimo aggiornamento del sito; il tuo nome, la tua email e la foto saranno cancellati entro 30 giorni.", "hint")] : []),
           btn);
  }

  avvia();
})();
