/* Menu a tre lineette dell'Meridiane d'Italia.
   Per aggiungere una pagina al menu basta una riga nell'elenco VOCI qui sotto (percorso dalla cartella principale del sito).
   Nessun cookie, nessuna richiesta a siti esterni. */
(function () {
  "use strict";

  var VOCI = [
    ["Home", "index.html"],
    ["Il progetto", "il-progetto.html"],
    ["Inserisci la tua meridiana", "inserisci.html"],
    ["Istruzioni per fotografare una meridiana", "fotografare.html"],
    ["Link utili", "link-utili.html"]
  ];

  var script = document.currentScript;
  var base;
  try { base = new URL(".", script && script.src ? script.src : location.href); }
  catch (e) { return; }

  var ultimo = decodeURIComponent(location.pathname.split("/").pop() || "") || "index.html";
  var aperto = false, precedente = null;

  function el(tag, classe, testo) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (testo) e.textContent = testo;
    return e;
  }

  var bottone = el("button", "menu-btn");
  bottone.type = "button";
  bottone.setAttribute("aria-label", "Apri il menu");
  bottone.setAttribute("aria-haspopup", "true");
  bottone.setAttribute("aria-expanded", "false");
  bottone.setAttribute("aria-controls", "menu-pannello");
  for (var i = 0; i < 3; i++) bottone.appendChild(el("span"));

  var overlay = el("div", "menu-overlay");
  overlay.hidden = true;
  var pannello = el("nav", "menu-pannello");
  pannello.id = "menu-pannello";
  pannello.setAttribute("aria-label", "Menu principale");
  var testa = el("div", "menu-testa");
  testa.appendChild(el("strong", null, "Menu"));
  var chiudi = el("button", "menu-chiudi", "\u00d7");
  chiudi.type = "button";
  chiudi.setAttribute("aria-label", "Chiudi il menu");
  testa.appendChild(chiudi);
  pannello.appendChild(testa);
  var lista = el("ul", "menu-lista");
  VOCI.forEach(function (v) {
    var li = el("li");
    var a = el("a", null, v[0]);
    a.href = new URL(v[1], base).href;
    if (v[1] === ultimo) a.setAttribute("aria-current", "page");
    li.appendChild(a);
    lista.appendChild(li);
  });
  pannello.appendChild(lista);
  overlay.appendChild(pannello);

  function focalizzabili() { return pannello.querySelectorAll("a[href], button"); }

  function apri() {
    if (aperto) return;
    aperto = true;
    precedente = document.activeElement;
    overlay.hidden = false;
    document.body.classList.add("menu-aperto");
    bottone.setAttribute("aria-expanded", "true");
    window.requestAnimationFrame(function () { overlay.classList.add("aperto"); });
    var cur = pannello.querySelector("[aria-current]") || chiudi;
    cur.focus();
  }

  function chiudiMenu(ripristina) {
    if (!aperto) return;
    aperto = false;
    overlay.classList.remove("aperto");
    document.body.classList.remove("menu-aperto");
    bottone.setAttribute("aria-expanded", "false");
    window.setTimeout(function () { if (!aperto) overlay.hidden = true; }, 220);
    if (ripristina !== false) (precedente && precedente.focus ? precedente : bottone).focus();
  }

  bottone.addEventListener("click", function () { aperto ? chiudiMenu() : apri(); });
  chiudi.addEventListener("click", function () { chiudiMenu(); });
  overlay.addEventListener("click", function (ev) { if (ev.target === overlay) chiudiMenu(); });
  pannello.addEventListener("click", function (ev) {
    if (ev.target.closest && ev.target.closest("a")) chiudiMenu(false);
  });
  document.addEventListener("keydown", function (ev) {
    if (!aperto) return;
    if (ev.key === "Escape") { ev.preventDefault(); chiudiMenu(); return; }
    if (ev.key !== "Tab") return;
    var f = focalizzabili();
    if (!f.length) return;
    var primo = f[0], ultimoEl = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === primo) { ev.preventDefault(); ultimoEl.focus(); }
    else if (!ev.shiftKey && document.activeElement === ultimoEl) { ev.preventDefault(); primo.focus(); }
  });

  function monta() {
    var intestazione = document.querySelector("header.topbar") || document.querySelector("header");
    if (intestazione) intestazione.appendChild(bottone);
    else { bottone.classList.add("flottante"); document.body.appendChild(bottone); }
    document.body.appendChild(overlay);
  }
  if (document.body) monta();
  else document.addEventListener("DOMContentLoaded", monta);
})();
