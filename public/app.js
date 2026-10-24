"use strict";

// Klient stołu: łączy się z /ws, wysyła akcje gracza i rysuje stan, który przysyła serwer.

const CHIPS = [2, 5, 10, 15, 25, 50, 100, 200, 300, 500, 1000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 250000, 500000];
const CHIP_COLORS = {
  2: "#7a7a7a", 5: "#c0392b", 10: "#1e7b48", 15: "#7d3fa6", 25: "#3b8f3b", 50: "#d35400",
  100: "#262626", 200: "#b8901f", 300: "#9e9e9e", 500: "#12806b", 1000: "#5b2a86", 2500: "#1565c0",
  5000: "#a0144f", 10000: "#00838f", 20000: "#c2185b", 25000: "#6d4c41", 50000: "#ad1457", 100000: "#111111",
  250000: "#4527a0", 500000: "#b8860b"
};
const PHASE_MS = { betting: 60000, insurance: 10000, playing: 20000, result: 5000 };
const PING_MS = 20000;
const MAX_SEATS = 3;
const TOKEN_KEY = "bj_token";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + fmt(Math.abs(n));
const chipLabel = (v) => (v >= 1000 ? v / 1000 + "k" : String(v));
// Krótka kwota na wąskie miejsca: 2 500, 25k, 1,5M.
const short = (n) => {
  const trim = (x) => String(Math.round(x * 100) / 100).replace(".", ",");
  if (n >= 1000000) return trim(n / 1000000) + "M";
  if (n >= 10000) return trim(n / 1000) + "k";
  return fmt(n);
};

let ws = null;
let pingTimer = null;
let retry = 0;
let meId = null;
let S = null;          // stan stołu
let me = null;         // mój profil
let clockOffset = 0;   // serwer − telefon
let sel = null;        // wybrane moje miejsce
let pickerOpen = false;     // rozwinięta kolumna żetonów nad paskiem
let pickerAnim = false;     // animacja tylko przy rozwinięciu, nie przy każdym odświeżeniu
let activeChip = 100;       // ostatnio wybrany żeton – pod przyciskiem na pasku
let betTarget = "bet";      // na co idą żetony: zakład główny, Pary (pp) albo 21+3 (t3)
let fxResultRound = null;   // runda, dla której już pokazano zgarnianie/wypłatę żetonów
let fxSideRound = null;
const shownNets = new Set(); // wyniki boksów, które już się pojawiły (animacja tylko raz)     // runda, dla której już pokazano rozliczenie zakładów pobocznych
let holeState = "";       // czy zakryta karta krupiera była jeszcze zakryta
let seenCards = null;       // karty już pokazane (null = pierwszy stan po wejściu, bez animacji)
let newCards = [];          // karty, które pojawiły się w tym rysowaniu: [klucz, kolejność]
const dealing = new Map();  // klucz karty -> czas, w którym ma wylecieć z buta
const lastStake = [];       // ostatnia stawka na miejscu – żeby żetony „spadały” tylko przy zmianie
const DEAL_STEP_MS = 190;
const DEAL_MS = 600;
const SHUFFLE_MS = 1400;
let shuffleUntil = 0;       // przy nowym bucie karty lecą dopiero po tasowaniu
let lastShoeLeft = null;    // ile kart było w bucie przy poprzednim stanie
let pageVer = null;         // wersja serwera, z którą otwarto stronę
let dealBusyUntil = 0;
let dealTimer = null;

function storage(fn) {
  try { return fn(localStorage); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Zawsze poziomo: na pionowym ekranie obracamy całą grę o 90°
// ---------------------------------------------------------------------------

function fit() {
  const app = $("app");
  const w = window.innerWidth, h = window.innerHeight;
  const portrait = h > w;
  const W = portrait ? h : w, H = portrait ? w : h;
  app.style.width = W + "px";
  app.style.height = H + "px";
  app.style.transform = portrait ? "translate(" + w + "px,0) rotate(90deg)" : "none";
  app.classList.toggle("rotated", portrait);
  // Projekt jest liczony dla ok. 54 × 25 em (telefon poziomo).
  const size = Math.max(10, Math.min(H / 25, W / 54, 24));
  app.style.fontSize = size + "px";
}
window.addEventListener("resize", fit);
window.addEventListener("orientationchange", () => setTimeout(fit, 150));
fit();

// ---------------------------------------------------------------------------
// Połączenie
// ---------------------------------------------------------------------------

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/ws");
  showConn("Łączenie…");

  ws.onopen = () => {
    retry = 0;
    showConn(null);
    send({ type: "hello", token: storage((s) => s.getItem(TOKEN_KEY)) || "" });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send("ping"); }, PING_MS);
  };

  ws.onmessage = (ev) => {
    if (ev.data === "pong") return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  };

  ws.onclose = (ev) => {
    clearInterval(pingTimer);
    if (ev.code === 4001) {
      // Administrator usunął wszystkich graczy.
      storage((s) => s.removeItem(TOKEN_KEY));
      meId = null;
      me = null;
    }
    showConn("Brak połączenia – łączę ponownie…");
    const delay = Math.min(1000 * 2 ** retry, 10000);
    retry++;
    setTimeout(connect, delay);
  };
}

function showConn(text) {
  $("conn").textContent = text || "";
  $("conn").classList.toggle("hidden", !text);
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Po odblokowaniu telefonu połączenie bywa martwe – sprawdzamy od razu.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ws && ws.readyState === 1) ws.send("ping");
});

function onMessage(msg) {
  switch (msg.type) {
    case "version":
      // Po wdrożeniu serwer ma nową wersję, a ta strona jest jeszcze stara.
      if (pageVer === null) pageVer = msg.ver;
      else if (msg.ver !== pageVer) $("update").classList.remove("hidden");
      break;
    case "needName":
      meId = null;
      openModal("mName");
      $("nameErr").textContent = "";
      break;
    case "welcome":
      meId = msg.id;
      if (msg.token) storage((s) => s.setItem(TOKEN_KEY, msg.token));
      closeModal("mName");
      break;
    case "state":
      S = msg.state;
      me = msg.me;
      clockOffset = S.now - Date.now();
      render();
      break;
    case "error":
      if (!$("mName").classList.contains("hidden")) $("nameErr").textContent = msg.msg;
      else toast(msg.msg, true);
      break;
    case "toast":
      toast(msg.msg);
      break;
    case "stats":
      renderStats(msg);
      break;
  }
}

// ---------------------------------------------------------------------------
// Rysowanie
// ---------------------------------------------------------------------------

// order: kolejność rozdawania (najpierw pierwsze karty graczy od miejsca 1, potem krupier itd.)
function cardHtml(c, key, order) {
  if (seenCards && !seenCards.has(key)) newCards.push([key, order]);
  const k = ' data-k="' + key + '"';
  if (!c) return '<div class="card back"' + k + "></div>";
  const red = c.s === "♥" || c.s === "♦";
  return '<div class="card' + (red ? " red" : "") + '"' + k + ">" +
    '<span class="tl">' + esc(c.r) + "<i>" + esc(c.s) + "</i></span>" +
    '<span class="mid">' + esc(c.s) + "</span></div>";
}

function totalText(h) {
  if (h.total == null) return "–";
  if (h.bj) return "BJ";
  return String(h.total);
}

function chipFace(v) {
  return '<span class="chip-face" style="--c:' + (CHIP_COLORS[v] || "#555") + '"></span>';
}

function chipBtn(v, disabled, attr) {
  return '<button class="chip" ' + attr + '="' + v + '"' + (disabled ? " disabled" : "") + ">" +
    chipFace(v) + "<b>" + chipLabel(v) + "</b></button>";
}

// Kolor stosu: największy żeton, który mieści się w kwocie.
function stackChip(amount) {
  let v = CHIPS[0];
  for (const c of CHIPS) if (c <= amount) v = c;
  return v;
}

function mySeats() {
  if (!S || !meId) return [];
  const list = [];
  S.seats.forEach((s, i) => { if (s && s.pid === meId) list.push(i); });
  return list;
}

function isBetting() {
  return S && (S.phase === "idle" || S.phase === "betting");
}

function render() {
  if (!S) return;
  const mine = mySeats();
  if (!mine.includes(sel)) sel = mine.length ? mine[0] : null;
  newCards = [];

  $("meName").textContent = me ? me.name : "Gość";
  $("meBank").textContent = me ? fmt(me.bankroll) : "0";
  $("depBank").textContent = me ? fmt(me.bankroll) : "0";

  // Krupier
  const d = S.dealer;
  $("dealerCards").innerHTML = d.cards.map((c, i) => cardHtml(c, S.roundNo + "d" + i, i * 10 + 9)).join("");
  const hole = d.cards.length > 1 ? S.roundNo + ":" + (d.cards[1] ? "up" : "down") : "";
  if (hole.endsWith("up") && holeState === S.roundNo + ":down") $("dealerCards").children[1].classList.add("flip");
  holeState = hole;
  $("dealerTotal").textContent = d.cards.length ? totalText(d) : "–";
  $("dealerRes").innerHTML = d.bust ? '<span class="res lose">PRZEGIĘCIE</span>' : d.bj && !d.cards.includes(null) ? '<span class="res push">BLACKJACK</span>' : "";

  const myTurn = S.phase === "playing" && S.turn && mine.includes(S.turn.seat);
  $("message").textContent = S.message || "";
  $("center").classList.toggle("hidden", myTurn || S.phase === "betting");

  $("seats").innerHTML = S.seats.map((s, i) => seatHtml(s, i, mine)).join("");

  renderShoe();
  registerDeal();
  // Przyciski ruchu i ubezpieczenia pokazujemy dopiero, gdy karty dolecą na stół.
  const busy = dealBusyUntil - Date.now();
  if (busy > 0) {
    clearTimeout(dealTimer);
    dealTimer = setTimeout(render, busy + 30);
  }
  renderActionPanel(myTurn && busy <= 0);
  renderBetPanel(mine);
  renderBar(mine, myTurn, busy > 0);
  animateDeal();
  updateTimers();
  chipEffects();
}

// Karty wylatują po kolei z buta krupiera i odwracają się w locie.
// Stan przychodzi często, więc karta w trakcie lotu po przerysowaniu dostaje ujemne opóźnienie
// i leci dalej od miejsca, w którym była.
// Wskaźnik buta: ile kart zostało i gdzie leży karta cięcia. Nowy but = tasowanie.
function renderShoe() {
  const sh = S.shoe;
  if (!sh) return;
  const now = Date.now();
  if (lastShoeLeft !== null && sh.left > lastShoeLeft) {
    shuffleUntil = now + SHUFFLE_MS;
    const shoe = $("shoe");
    shoe.classList.remove("shuffling");
    void shoe.offsetWidth;
    shoe.classList.add("shuffling");
    setTimeout(() => { shoe.classList.remove("shuffling"); render(); }, SHUFFLE_MS);
  }
  lastShoeLeft = sh.left;
  const m = $("shoeMeter");
  m.classList.remove("hidden");
  m.querySelector(".sm-fill").style.width = (sh.left / sh.total * 100).toFixed(1) + "%";
  m.querySelector(".sm-cut").style.left = (sh.cut / sh.total * 100).toFixed(1) + "%";
  const label = m.querySelector(".sm-label");
  m.classList.toggle("low", sh.left < sh.cut);
  if (now < shuffleUntil) label.textContent = "Tasowanie…";
  else if (sh.left < sh.cut) label.textContent = "Nowy but w następnej rundzie";
  else label.textContent = Math.round(sh.left / sh.total * 100) + "% · " + sh.left + " kart";
}

function registerDeal() {
  const now = Date.now();
  if (!seenCards) {
    seenCards = new Set([...document.querySelectorAll(".card[data-k]")].map((el) => el.dataset.k));
    return;
  }
  const base = Math.max(now, shuffleUntil);
  newCards.sort((a, b) => a[1] - b[1]);
  newCards.forEach(([key], n) => {
    seenCards.add(key);
    dealing.set(key, base + n * DEAL_STEP_MS);
    dealBusyUntil = Math.max(dealBusyUntil, base + n * DEAL_STEP_MS + DEAL_MS);
  });
}

function animateDeal() {
  const now = Date.now();
  if (seenCards.size > 600) seenCards = new Set([...document.querySelectorAll(".card[data-k]")].map((el) => el.dataset.k));

  const shoe = $("shoe").getBoundingClientRect();
  const sx = shoe.left + shoe.width / 2, sy = shoe.top + shoe.height / 2;
  const rotated = $("app").classList.contains("rotated");
  let dealerDealing = false;
  for (const el of document.querySelectorAll(".card[data-k]")) {
    const start = dealing.get(el.dataset.k);
    if (start == null) continue;
    if (now > start + DEAL_MS) { dealing.delete(el.dataset.k); continue; }
    const r = el.getBoundingClientRect();
    let dx = sx - (r.left + r.width / 2), dy = sy - (r.top + r.height / 2);
    // Ekran obrócony o 90°: przesunięcie na ekranie zamieniamy na układ gry.
    if (rotated) [dx, dy] = [dy, -dx];
    el.style.setProperty("--dx", dx.toFixed(0) + "px");
    el.style.setProperty("--dy", dy.toFixed(0) + "px");
    el.style.setProperty("--delay", start - now + "ms");
    el.classList.add("deal");
    // Suma punktów pojawia się dopiero, gdy karta wyląduje.
    const hand = el.closest(".hand");
    if (hand) hand.classList.add("dealing");
    else dealerDealing = true;
  }
  $("dealerTotal").style.visibility = dealerDealing ? "hidden" : "";
}

// Miejsca ułożone w łuk: miejsce 1 po prawej, 6 po lewej, skrajne wyżej.
function seatPos(i) {
  const x = 87.5 - i * 15;
  const t = (x - 50) / 37.5;
  return "left:" + x + "%;bottom:" + (2.5 + 7 * t * t).toFixed(1) + "%";
}

function seatHtml(s, i, mine) {
  const pos = seatPos(i);
  if (!s) {
    const canSit = meId && mine.length < MAX_SEATS;
    return '<div class="seat" style="' + pos + '">' +
      (canSit
        ? '<button class="spot sit" data-sit="' + i + '" aria-label="Usiądź na miejscu ' + (i + 1) + '">+</button>'
        : '<div class="spot num">' + (i + 1) + "</div>") +
      '<div class="plate empty"><div class="nm">Miejsce ' + (i + 1) + '</div><div class="bk">wolne</div></div></div>';
  }

  const isMine = s.pid === meId;
  const isTurn = S.turn && S.turn.seat === i;
  const multi = s.hands.length > 1;

  const hands = s.hands.map((h, hi) => {
    const active = isTurn && S.turn.hand === hi;
    const cls = "hand" + (active ? " active" : "") + (h.result === "lose" ? " lose" : "");
    return '<div class="' + cls + '">' +
      '<div class="cards">' + h.cards.map((c, ci) => cardHtml(c, S.roundNo + "s" + i + "h" + hi + "c" + ci + c.r + c.s, ci * 10 + i)).join("") + "</div>" +
      '<div class="hand-info"><span class="tot">' + esc(totalText(h)) + "</span>" +
      (h.doubled ? '<span class="dbl">×2</span>' : "") +
      (h.label ? '<span class="res ' + esc(h.result || "") + '">' + esc(h.label) + "</span>" : "") +
      "</div></div>";
  }).join("");

  // Stawka: w trakcie rundy suma rąk, przy obstawianiu bieżący zakład.
  // Po rundzie żetony zgarnia/wypłaca animacja, więc pole jest już puste.
  const staked = S.phase === "result" && s.inRound ? 0 : s.hands.length ? s.hands.reduce((a, h) => a + h.bet, 0) : s.bet;
  const total = staked + s.pp + s.t3;
  const drop = total > (lastStake[i] || 0);
  lastStake[i] = total;
  const canBet = isMine && isBetting();
  const onCls = (k) => (canBet && i === sel && betTarget === k ? " on" : "");
  const spotTag = (k, cls, inner) => canBet
    ? '<button class="' + cls + onCls(k) + '" data-spot="' + k + '" data-target="' + k + '" data-seat="' + i + '">' + inner + "</button>"
    : '<div class="' + cls + '" data-spot="' + k + '">' + inner + "</div>";
  const main = staked > 0
    ? spotTag("bet", "spot has", '<div class="stack' + (drop ? " drop" : "") + '">' + chipFace(stackChip(staked)).repeat(3) + '</div><span class="amount">' + short(staked) + "</span>")
    : spotTag("bet", "spot num", String(i + 1));
  const side = (k, name) => {
    const res = s.side && s.side.find((x) => x.k === k);
    if (s[k] > 0) return spotTag(k, "sspot has", chipFace(stackChip(s[k])) + '<span class="amount">' + short(s[k]) + "</span>");
    if (res && res.mult) return spotTag(k, "sspot win", "<b>" + res.mult + ":1</b>");
    return spotTag(k, "sspot" + (res ? " lost" : ""), '<span class="sl">' + name + "</span>");
  };
  const spot = '<div class="spots">' + side("pp", "PARY") + main + side("t3", "21+3") + "</div>";

  const tags = [];
  if (s.away) tags.push('<span class="off">offline</span>');
  if (s.sitOut) tags.push("pauza");
  if (s.leaving) tags.push("wstaje");
  if (s.ready && S.phase === "betting") tags.push('<span class="ok">gotowy</span>');
  if (s.ins > 0) tags.push("ubezp. " + fmt(s.ins));

  const plateCls = "plate" + (isMine ? " mine" : "") + (isMine && i === sel ? " sel" : "") + (s.away ? " away" : "");
  // Po rundzie: ile wyszło na tym boksie (zakład, poboczne i ubezpieczenie razem).
  let boxNet = "";
  if (S.phase === "result" && s.net != null) {
    const key = S.roundNo + ":" + i;
    if (shownNets.size > 300) shownNets.clear();
    const fresh = !shownNets.has(key);
    shownNets.add(key);
    boxNet = '<div class="box-net ' + (s.net > 0 ? "pos" : s.net < 0 ? "neg" : "zero") + (fresh ? " fresh" : "") + '">' + signed(s.net) + "</div>";
  }
  return '<div class="seat' + (isTurn ? " turn" : "") + '" data-i="' + i + '" style="' + pos + '">' + boxNet +
    (hands ? '<div class="hands' + (multi ? " multi" : "") + '">' + hands + "</div>" : "") +
    spot +
    '<div class="' + plateCls + '"' + (isMine ? ' data-select="' + i + '"' : "") + ">" +
    (isMine ? '<button class="leave" data-leave="' + i + '">Wstań</button>' : "") +
    '<div class="nm">M' + (i + 1) + " · " + esc(s.name) + "</div>" +
    '<div class="bk">' + fmt(s.bankroll) + "</div>" +
    (tags.length ? '<div class="tags">' + tags.join(" · ") + "</div>" : "") +
    "</div></div>";
}

function renderActionPanel(myTurn) {
  const el = $("actionPanel");
  if (!myTurn) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const a = S.actions || {};
  const t = S.seats[S.turn.seat];
  const label = "M" + (S.turn.seat + 1) + (t.hands.length > 1 ? "·" + (S.turn.hand + 1) : "");
  el.classList.remove("hidden");
  el.innerHTML =
    ringHtml(PHASE_MS.playing, "") +
    '<span class="ap-seat">' + label + "</span>" +
    '<button class="act hit" data-act="hit">Dobierz</button>' +
    '<button class="act stand" data-act="stand">Zostań</button>' +
    '<button class="act double" data-act="double"' + (a.double ? "" : " disabled") + ">Podwój</button>" +
    '<button class="act split" data-act="split"' + (a.split ? "" : " disabled") + ">Rozdziel</button>" +
    '<button class="act surrender" data-act="surrender"' + (a.surrender ? "" : " disabled") + ">Poddaj</button>";
}

// Kółko z odliczaniem do S.deadline; total – pełny czas w ms (odświeża je updateTimers).
function ringHtml(total, cls) {
  return '<div class="ring ' + cls + '" data-total="' + total + '"><svg viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15"/>' +
    '<circle class="fg" cx="18" cy="18" r="15" stroke-dasharray="94.25" stroke-dashoffset="0"/></svg><span class="ring-sec"></span></div>';
}

// Minuta na zakłady: licznik i „Gotowy” na środku stołu. Gdy wszyscy z zakładami
// są gotowi, runda startuje od razu; po minucie rozdaje się sama.
function renderBetPanel(mine) {
  const el = $("betPanel");
  if (S.phase !== "betting") { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const playing = S.seats.filter((s) => s && s.bet > 0 && !s.sitOut && !s.away);
  const ready = playing.filter((s) => s.ready).length;
  const withBet = mine.filter((i) => S.seats[i].bet > 0 && !S.seats[i].sitOut);
  const meReady = withBet.length > 0 && withBet.every((i) => S.seats[i].ready);
  let btn = "";
  if (me && mine.length) {
    if (meReady) btn = '<button class="btn ready-btn done" disabled>✓ Gotowy</button>';
    else btn = '<button class="btn gold ready-btn" data-ready' + (withBet.length ? "" : " disabled") + ">" + (withBet.length ? "Gotowy" : "Postaw zakład") + "</button>";
  }
  const sub = meReady && ready < playing.length ? "Czekamy na pozostałych · gotowi " + ready + "/" + playing.length
    : playing.length ? "Gotowi: " + ready + "/" + playing.length : "Postaw zakład i kliknij Gotowy";
  el.classList.remove("hidden");
  el.innerHTML = ringHtml(PHASE_MS.betting, "big") +
    '<div class="bp-info"><div class="bp-title">Czas na zakłady</div><div class="bp-sub">' + sub + "</div></div>" + btn;
}

function renderBar(mine, myTurn, dealingNow) {
  const el = $("bar");
  const oldCol = el.querySelector(".chip-col");
  const scroll = oldCol ? oldCol.scrollTop : null;
  if (dealingNow && !isBetting()) el.innerHTML = '<div class="bar-text">Krupier rozdaje karty…</div>';
  else renderBarInner(el, mine, myTurn);
  const col = el.querySelector(".chip-col");
  if (!col) return;
  if (scroll != null) col.scrollTop = scroll;
  else {
    // Po rozwinięciu przewijamy do ostatnio używanego żetonu.
    const cur = col.querySelector('[data-bet="' + activeChip + '"]');
    if (cur) col.scrollTop = cur.offsetTop - col.clientHeight / 2 + cur.offsetHeight / 2;
  }
}

function renderBarInner(el, mine, myTurn) {
  if (!me) { el.innerHTML = '<div class="bar-text">Podaj nick, żeby dołączyć do gry.</div>'; return; }
  if (mine.length === 0) {
    el.innerHTML = '<div class="bar-text">' +
      (me.bankroll < CHIPS[0] ? "Wpłać żetony, potem dotknij <b>+</b> przy wolnym miejscu." : "Dotknij <b>+</b> przy wolnym miejscu, żeby usiąść. Możesz zająć do " + MAX_SEATS + " miejsc.") +
      "</div>";
    return;
  }

  if (isBetting()) {
    const seat = S.seats[sel];
    const stake = seat.bet + seat.pp + seat.t3;
    const betsMine = mine.reduce((sum, i) => sum + S.seats[i].bet + S.seats[i].pp + S.seats[i].t3, 0);
    const noMain = betTarget !== "bet" && seat.bet === 0;
    const off = (v) => noMain || betsMine + v > me.bankroll;
    // Kolumna rośnie do góry: najmniejsze żetony na dole, przy palcu.
    const col = pickerOpen
      ? '<div class="chip-col' + (pickerAnim ? " anim" : "") + '">' + CHIPS.slice().reverse().map((v) => chipBtn(v, off(v), "data-bet")).join("") + "</div>"
      : "";
    const picker = '<div class="picker">' + col +
      chipBtn(activeChip, off(activeChip), "data-bet") +
      '<button class="pick-toggle' + (pickerOpen ? " on" : "") + '" data-picker aria-label="Wybierz żeton">' + (pickerOpen ? "▼" : "▲") + "</button></div>";
    const tabs = [["bet", (mine.length > 1 ? "M" + (sel + 1) + " · " : "") + "Zakład"], ["pp", "Pary"], ["t3", "21+3"]].map(([k, label]) =>
      '<button class="tgt' + (betTarget === k ? " on" : "") + '" data-target="' + k + '" data-seat="' + sel + '"><small>' + label + "</small><b>" + short(seat[k]) + "</b></button>"
    ).join("");
    // Powtórz działa na wszystkich moich miejscach naraz.
    const toRepeat = mine.map((i) => S.seats[i]).filter((s) => s.last > 0);
    const extra = toRepeat.reduce((a, s) => a + s.last - (s.bet + s.pp + s.t3), 0);
    const canRebet = toRepeat.some((s) => s.bet + s.pp + s.t3 < s.last) && betsMine + extra <= me.bankroll;
    const canDouble = stake > 0 && betsMine + stake <= me.bankroll;
    el.innerHTML =
      '<div class="tgts">' + tabs + "</div>" +
      picker + '<div class="bar-gap"></div>' +
      '<button class="btn outline" data-clear="' + sel + '"' + (stake > 0 ? "" : " disabled") + ">Wyczyść</button>" +
      '<button class="btn outline" data-rebet' + (canRebet ? "" : " disabled") + ">↺ Powtórz" + (toRepeat.length > 1 ? " wszystkie" : "") + "</button>" +
      '<button class="btn outline" data-double="' + sel + '"' + (canDouble ? "" : " disabled") + ">×2</button>" +
      '<button class="btn outline" data-sitout="' + sel + '">' + (seat.sitOut ? "Wracam" : "Pauza") + "</button>";
    return;
  }

  if (S.phase === "insurance") {
    const pending = mine.filter((i) => S.seats[i].inRound && S.seats[i].ins === null);
    if (pending.length) {
      const i = pending[0];
      const amt = Math.floor(S.seats[i].hands[0].bet / 2);
      el.innerHTML = '<div class="bar-text">' + (mine.length > 1 ? "M" + (i + 1) + ": " : "") +
        "Krupier pokazuje asa. Ubezpieczenie za <b>" + fmt(amt) + "</b> (wypłata 2:1)?</div>" +
        '<button class="btn gold" data-ins="' + i + '" data-accept="1">Ubezpiecz</button>' +
        '<button class="btn outline" data-ins="' + i + '" data-accept="0">Nie</button>';
      return;
    }
  }

  let text;
  if (myTurn) text = "<b>Twój ruch</b> – wybierz na środku stołu.";
  else if (S.phase === "insurance") text = "Czekamy na decyzje o ubezpieczeniu…";
  else if (S.phase === "playing" && S.turn) text = "Ruch gracza <b>" + esc(S.seats[S.turn.seat].name) + "</b> – czekaj na swoją kolej.";
  else if (S.phase === "dealer") text = "Krupier odsłania i dobiera karty…";
  else text = "Koniec rundy – za chwilę kolejne zakłady.";
  el.innerHTML = '<div class="bar-text">' + text + "</div>";
}

function statusText() {
  if (!S) return "";
  const left = S.deadline ? Math.max(0, Math.ceil((S.deadline - (Date.now() + clockOffset)) / 1000)) : null;
  const sec = left != null && PHASE_MS[S.phase] ? " · <b>" + left + " s</b>" : "";
  const round = " · runda #" + Math.max(1, S.roundNo + (S.phase === "idle" || S.phase === "betting" ? 1 : 0));
  switch (S.phase) {
    case "idle": return "Czekamy na zakłady" + round;
    case "betting": return "Obstawianie" + sec + round;
    case "insurance": return "Ubezpieczenie" + sec + round;
    case "playing": return "Ruch: <b>" + esc(S.turn ? S.seats[S.turn.seat].name : "") + "</b>" + sec + round;
    case "dealer": return "Krupier dobiera" + round;
    case "result": return "Koniec rundy" + round;
  }
  return "";
}

function updateTimers() {
  $("status").innerHTML = statusText();
  if (!S || !S.deadline) return;
  const left = Math.max(0, S.deadline - (Date.now() + clockOffset));
  for (const ring of document.querySelectorAll(".ring[data-total]")) {
    const frac = Math.min(1, left / +ring.dataset.total);
    ring.querySelector(".fg").setAttribute("stroke-dashoffset", (94.25 * (1 - frac)).toFixed(1));
    ring.classList.toggle("low", left < 10000);
    ring.querySelector(".ring-sec").textContent = Math.ceil(left / 1000);
  }
}
setInterval(updateTimers, 250);

// ---------------------------------------------------------------------------
// Kliknięcia
// ---------------------------------------------------------------------------

document.addEventListener("click", (e) => {
  const b = e.target.closest("button, [data-select]");
  if (!b || b.disabled) return;
  const d = b.dataset;
  if (d.sit != null) send({ type: "sit", seat: +d.sit });
  else if (d.leave != null) send({ type: "leave", seat: +d.leave });
  else if (d.bet != null) {
    const target = document.querySelector('.seat[data-i="' + sel + '"] [data-spot="' + betTarget + '"]');
    if (target) flyBetChip(+d.bet, b, target);
    send({ type: "bet", seat: sel, amount: +d.bet, kind: betTarget });
    if (activeChip !== +d.bet) { activeChip = +d.bet; render(); }
  }
  else if (d.picker != null) { pickerOpen = !pickerOpen; pickerAnim = pickerOpen; render(); pickerAnim = false; }
  else if (d.rebet != null) send({ type: "rebet" });
  else if (d.double != null) send({ type: "doubleBet", seat: +d.double });
  else if (d.target != null) { sel = +d.seat; betTarget = d.target; render(); }
  else if (d.clear != null) send({ type: "clearBet", seat: +d.clear });
  else if (d.ready != null) send({ type: "ready" });
  else if (d.sitout != null) send({ type: "sitOut", seat: +d.sitout });
  else if (d.act != null) send({ type: "action", kind: d.act });
  else if (d.ins != null) send({ type: "insurance", seat: +d.ins, accept: d.accept === "1" });
  else if (d.dep != null) { send({ type: "deposit", amount: +d.dep }); closeModal("mDeposit"); }
  else if (d.close != null) b.closest(".modal").classList.add("hidden");
  else if (d.select != null) { sel = +d.select; render(); }
});

// Dotknięcie gdzie indziej zwija kolumnę żetonów.
document.addEventListener("click", (e) => {
  // Przełączanie Zakład / Pary / 21+3 (na pasku albo na stole) zostawia kolumnę otwartą.
  if (pickerOpen && !e.target.closest(".picker, [data-target]")) { pickerOpen = false; render(); }
}, true);

$("btnReload").onclick = () => location.reload();

$("btnDeposit").onclick = () => {
  if (!me) return openModal("mName");
  $("inDeposit").value = "";
  openModal("mDeposit");
};
$("formDeposit").onsubmit = (e) => {
  e.preventDefault();
  const amount = Math.floor(Number($("inDeposit").value));
  if (!(amount >= 1)) return;
  send({ type: "deposit", amount });
  $("inDeposit").blur();
  closeModal("mDeposit");
};

$("btnStats").onclick = () => {
  $("statsBody").innerHTML = '<p class="muted">Wczytywanie…</p>';
  openModal("mStats");
  send({ type: "stats" });
};

$("formName").onsubmit = (e) => {
  e.preventDefault();
  const name = $("inName").value.trim();
  if (name.length < 2) { $("nameErr").textContent = "Nick musi mieć od 2 do 16 znaków."; return; }
  $("nameErr").textContent = "";
  $("inName").blur();
  send({ type: "register", name });
};

// Kliknięcie w tło zamyka okno (oprócz okna z nickiem – bez nicku nie da się grać).
document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => { if (e.target === m && m.id !== "mName") m.classList.add("hidden"); });
});

function openModal(id) {
  $(id).classList.remove("hidden");
  if (id === "mName") setTimeout(() => $("inName").focus(), 60);
}
function closeModal(id) {
  $(id).classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Animacje żetonów: obstawianie, zgarnianie przez krupiera i wypłaty
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const em = () => parseFloat($("app").style.fontSize) || 16;

// Środek elementu w układzie gry (na pionowym telefonie gra jest obrócona o 90°).
function localCenter(el) {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if ($("app").classList.contains("rotated")) return { x: cy, y: window.innerWidth - cx };
  return { x: cx, y: cy };
}

function fxChip(amount, at, label) {
  const el = document.createElement("div");
  el.className = "fx-chip";
  el.innerHTML = chipFace(stackChip(amount)).repeat(2) + (label ? '<span class="amount">' + label + "</span>" : "");
  el.style.left = at.x + "px";
  el.style.top = at.y + "px";
  el._at = at;
  $("fx").appendChild(el);
  return el;
}

// Przesuwa żeton z jego bieżącego miejsca do punktu „to”. fade – znika na końcu lotu.
function moveChip(el, to, ms, fade) {
  const from = el._at;
  const dx = to.x - from.x, dy = to.y - from.y;
  const anim = el.animate([
    { transform: "translate(-50%,-50%)", opacity: 1 },
    { transform: "translate(calc(-50% + " + dx * 0.55 + "px), calc(-50% + " + (dy * 0.55 - em() * 0.8) + "px)) scale(1.12)", opacity: 1, offset: 0.55 },
    { transform: "translate(calc(-50% + " + dx + "px), calc(-50% + " + dy + "px))", opacity: fade ? 0 : 1 }
  ], { duration: ms, easing: "cubic-bezier(.3,.7,.4,1)", fill: "forwards" });
  return anim.finished.then(() => {
    if (fade) el.remove();
    else {
      anim.cancel();
      el._at = to;
      el.style.left = to.x + "px";
      el.style.top = to.y + "px";
    }
  });
}

function fxLabel(text, at, cls) {
  const el = document.createElement("div");
  el.className = "fx-label " + (cls || "");
  el.textContent = text;
  el.style.left = at.x + "px";
  el.style.top = at.y + "px";
  $("fx").appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

function pulse(el) {
  if (!el) return;
  el.classList.remove("paid");
  void el.offsetWidth;
  el.classList.add("paid");
}

function flyBetChip(amount, fromEl, toEl) {
  const c = fxChip(amount, localCenter(fromEl));
  moveChip(c, localCenter(toEl), 380, true);
}

function dealerPoint() {
  const cards = $("dealerCards");
  return localCenter(cards.children.length ? cards : $("dealerTotal"));
}

const seatEl = (i, sel) => document.querySelector('.seat[data-i="' + i + '"] ' + sel);

// Wygrana: wypłata leci od krupiera obok zakładu, potem oba stosy jadą do salda gracza.
async function payout(i, spotEl, stake, profit) {
  const spot = localCenter(spotEl);
  const base = fxChip(stake, spot);
  let pay = null;
  if (profit > 0) {
    await sleep(200);
    const next = { x: spot.x + em() * 1.1, y: spot.y - em() * 0.2 };
    pay = fxChip(profit, dealerPoint());
    await moveChip(pay, next, 650, false);
    fxLabel("+" + fmt(profit), { x: spot.x, y: spot.y - em() * 1.6 }, "win");
  }
  await sleep(900);
  const plate = seatEl(i, ".plate");
  if (!plate) { base.remove(); if (pay) pay.remove(); return; }
  const dest = localCenter(plate);
  const moves = [moveChip(base, dest, 520, true)];
  if (pay) moves.push(moveChip(pay, dest, 560, true));
  await Promise.all(moves);
  pulse(plate);
}

// Przegrana: krupier zgarnia żetony.
function collect(spotEl, amount) {
  const c = fxChip(amount, localCenter(spotEl));
  return moveChip(c, dealerPoint(), 600, true);
}

async function resultFx() {
  const seats = S.seats.map((s, i) => [s, i]).filter(([s]) => s && s.inRound && s.hands.length);
  for (const [n, [s, i]] of seats.entries()) {
    let lost = 0, back = 0, profit = 0;
    for (const h of s.hands) {
      if (h.result === "win") { back += h.bet; profit += h.label.startsWith("BLACKJACK") ? Math.floor(h.bet * 1.5) : h.bet; }
      else if (h.result === "push") back += h.bet;
      else lost += h.bet;
    }
    setTimeout(() => {
      const spotEl = seatEl(i, '[data-spot="bet"]');
      if (!spotEl) return;
      if (lost) collect(spotEl, lost);
      if (back) payout(i, spotEl, back, profit);
    }, n * 280);
  }
}

async function sideFx() {
  await sleep(Math.max(0, dealBusyUntil - Date.now()) + 250);
  S.seats.forEach((s, i) => {
    if (!s || !s.side) return;
    for (const r of s.side) {
      const spotEl = seatEl(i, '[data-spot="' + r.k + '"]');
      if (!spotEl) continue;
      if (r.mult) {
        fxLabel(r.label + " " + r.mult + ":1", { x: localCenter(spotEl).x, y: localCenter(spotEl).y - em() * 2.4 }, "win big");
        payout(i, spotEl, r.bet, r.bet * r.mult);
      } else collect(spotEl, r.bet);
    }
  });
}

function chipEffects() {
  // Po wejściu do gry nie odtwarzamy tego, co już się wydarzyło.
  if (fxResultRound === null) {
    fxResultRound = S.phase === "result" ? S.roundNo : -1;
    fxSideRound = S.roundNo;
    return;
  }
  if (S.phase === "result" && fxResultRound !== S.roundNo) {
    fxResultRound = S.roundNo;
    resultFx();
  }
  if (fxSideRound !== S.roundNo && S.seats.some((s) => s && s.side)) {
    fxSideRound = S.roundNo;
    sideFx();
  }
}

function renderStats(st) {
  const rows = st.players
    .sort((a, b) => b.rounds - a.rounds)
    .map((p) => {
      const pct = p.rounds ? Math.round((p.plus / p.rounds) * 100) + "%" : "–";
      const dots = (p.recent || []).slice(-20).map((r) => "<i class='" + (r > 0 ? "w" : r < 0 ? "l" : "") + "'></i>").join("");
      return "<tr><td>" + esc(p.name) + "</td><td>" + p.rounds + '</td><td class="pos">' + p.plus + "</td><td>" + p.even +
        '</td><td class="neg">' + p.minus + "</td><td>" + pct + "</td>" +
        '<td class="' + (p.net > 0 ? "pos" : p.net < 0 ? "neg" : "") + '">' + signed(p.net) + "</td>" +
        "<td>" + fmt(p.bankroll) + '</td><td><span class="dots">' + dots + "</span></td></tr>";
    }).join("");
  const log = st.log.slice(0, 30).map((r) =>
    "<div>#" + r.n + " Krupier " + esc(r.dealer) + " — " +
    r.res.map((x) => esc(x.name) + ' <span class="' + (x.delta > 0 ? "pos" : x.delta < 0 ? "neg" : "") + '">' + signed(x.delta) + "</span>").join(", ") +
    "</div>"
  ).join("");
  $("statsBody").innerHTML =
    (rows
      ? '<table class="st"><tr><th>Gracz</th><th>Rundy</th><th>Na plus</th><th>Na zero</th><th>Na minus</th><th>% na plus</th><th>Bilans</th><th>Saldo</th><th>Ostatnie rundy</th></tr>' + rows + "</table>"
      : '<p class="muted">Nikt jeszcze nie grał.</p>') +
    '<p class="muted">Bilans krupiera: <b class="' + (st.house > 0 ? "pos" : st.house < 0 ? "neg" : "") + '">' + signed(st.house) + "</b> · rozegranych rund: " + st.roundNo + "</p>" +
    (log ? '<div class="log-title">Ostatnie rundy</div><div class="log">' + log + "</div>" : "");
}

let toastTimer = null;
function toast(text, isErr) {
  const t = $("toast");
  t.textContent = text;
  t.classList.toggle("err", !!isErr);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

// ---------------------------------------------------------------------------
// Błędy z telefonu trafiają do dziennika pod /logs
// ---------------------------------------------------------------------------

function reportError(message, stack, src) {
  send({
    type: "clientError",
    msg: message,
    stack: stack || "",
    src: src || "",
    screen: innerWidth + "x" + innerHeight,
    ua: navigator.userAgent
  });
}
window.addEventListener("error", (e) => reportError(e.message, e.error && e.error.stack, e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => reportError(String((e.reason && e.reason.message) || e.reason), e.reason && e.reason.stack, "promise"));

connect();
