"use strict";

// Klient stołu: łączy się z /ws, wysyła akcje gracza i rysuje stan, który przysyła serwer.

const CHIPS = [2, 5, 10, 15, 25, 50, 100, 200, 300, 500, 1000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 250000, 500000];
const BAR_CHIPS = [2, 5, 10, 15, 100, 200, 300, 500, 1000, 2500];
const BAR_MORE = [10000, 20000, 50000, 100000];
const CHIP_COLORS = {
  2: "#7a7a7a", 5: "#c0392b", 10: "#1e7b48", 15: "#7d3fa6", 25: "#3b8f3b", 50: "#d35400",
  100: "#262626", 200: "#b8901f", 300: "#9e9e9e", 500: "#12806b", 1000: "#5b2a86", 2500: "#1565c0",
  5000: "#a0144f", 10000: "#00838f", 20000: "#c2185b", 25000: "#6d4c41", 50000: "#ad1457", 100000: "#111111",
  250000: "#4527a0", 500000: "#b8860b"
};
const PHASE_MS = { betting: 15000, insurance: 10000, playing: 20000, result: 5000 };
const PING_MS = 20000;
const MAX_SEATS = 3;
const TOKEN_KEY = "bj_token";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + fmt(Math.abs(n));
const chipLabel = (v) => (v >= 1000 ? v / 1000 + "k" : String(v));

let ws = null;
let pingTimer = null;
let retry = 0;
let meId = null;
let S = null;          // stan stołu
let me = null;         // mój profil
let clockOffset = 0;   // serwer − telefon
let sel = null;        // wybrane moje miejsce
let drawerOpen = false;
let barMore = false;
let holeState = "";       // czy zakryta karta krupiera była jeszcze zakryta
let seenCards = null;       // karty już pokazane (null = pierwszy stan po wejściu, bez animacji)
let newCards = [];          // karty, które pojawiły się w tym rysowaniu: [klucz, kolejność]
const dealing = new Map();  // klucz karty -> czas, w którym ma wylecieć z buta
const lastStake = [];       // ostatnia stawka na miejscu – żeby żetony „spadały” tylko przy zmianie
const DEAL_STEP_MS = 190;
const DEAL_MS = 600;
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
  $("center").classList.toggle("hidden", myTurn);

  $("seats").innerHTML = S.seats.map((s, i) => seatHtml(s, i, mine)).join("");

  registerDeal();
  // Przyciski ruchu i ubezpieczenia pokazujemy dopiero, gdy karty dolecą na stół.
  const busy = dealBusyUntil - Date.now();
  if (busy > 0) {
    clearTimeout(dealTimer);
    dealTimer = setTimeout(render, busy + 30);
  }
  renderActionPanel(myTurn && busy <= 0);
  renderBar(mine, myTurn, busy > 0);
  renderDrawer(mine);
  animateDeal();
  updateTimers();
}

// Karty wylatują po kolei z buta krupiera i odwracają się w locie.
// Stan przychodzi często, więc karta w trakcie lotu po przerysowaniu dostaje ujemne opóźnienie
// i leci dalej od miejsca, w którym była.
function registerDeal() {
  const now = Date.now();
  if (!seenCards) {
    seenCards = new Set([...document.querySelectorAll(".card[data-k]")].map((el) => el.dataset.k));
    return;
  }
  newCards.sort((a, b) => a[1] - b[1]);
  newCards.forEach(([key], n) => {
    seenCards.add(key);
    dealing.set(key, now + n * DEAL_STEP_MS);
    dealBusyUntil = Math.max(dealBusyUntil, now + n * DEAL_STEP_MS + DEAL_MS);
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
  const staked = s.hands.length ? s.hands.reduce((a, h) => a + h.bet, 0) : s.bet;
  const drop = staked > (lastStake[i] || 0);
  lastStake[i] = staked;
  const spot = staked > 0
    ? '<div class="spot has"><div class="stack' + (drop ? " drop" : "") + '">' + chipFace(stackChip(staked)).repeat(3) + '</div><span class="amount">' + fmt(staked) + "</span></div>"
    : '<div class="spot num">' + (i + 1) + "</div>";

  const tags = [];
  if (s.away) tags.push('<span class="off">offline</span>');
  if (s.sitOut) tags.push("pauza");
  if (s.leaving) tags.push("wstaje");
  if (s.ready && S.phase === "betting") tags.push('<span class="ok">gotowy</span>');
  if (s.ins > 0) tags.push("ubezp. " + fmt(s.ins));

  const plateCls = "plate" + (isMine ? " mine" : "") + (isMine && i === sel ? " sel" : "") + (s.away ? " away" : "");
  return '<div class="seat' + (isTurn ? " turn" : "") + '" style="' + pos + '">' +
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
    '<div class="ring" id="turnRing"><svg viewBox="0 0 36 36"><circle class="bg" cx="18" cy="18" r="15"/>' +
    '<circle class="fg" cx="18" cy="18" r="15" stroke-dasharray="94.25" stroke-dashoffset="0"/></svg><span id="turnSec"></span></div>' +
    '<span class="ap-seat">' + label + "</span>" +
    '<button class="act hit" data-act="hit">Dobierz</button>' +
    '<button class="act stand" data-act="stand">Zostań</button>' +
    '<button class="act double" data-act="double"' + (a.double ? "" : " disabled") + ">Podwój</button>" +
    '<button class="act split" data-act="split"' + (a.split ? "" : " disabled") + ">Rozdziel</button>" +
    '<button class="act surrender" data-act="surrender"' + (a.surrender ? "" : " disabled") + ">Poddaj</button>";
}

function renderBar(mine, myTurn, dealingNow) {
  const el = $("bar");
  const oldRow = el.querySelector(".chips-row");
  const scroll = oldRow ? oldRow.scrollLeft : 0;
  if (dealingNow && !isBetting()) el.innerHTML = '<div class="bar-text">Krupier rozdaje karty…</div>';
  else renderBarInner(el, mine, myTurn);
  const row = el.querySelector(".chips-row");
  if (row) row.scrollLeft = scroll;
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
    const betsMine = mine.reduce((sum, i) => sum + S.seats[i].bet, 0);
    const withBet = mine.filter((i) => S.seats[i].bet > 0 && !S.seats[i].sitOut);
    const allReady = withBet.length > 0 && withBet.every((i) => S.seats[i].ready);
    const chips = BAR_CHIPS.concat(barMore ? BAR_MORE : []).map((v) => chipBtn(v, betsMine + v > me.bankroll, "data-bet")).join("") +
      '<button class="chip more' + (barMore ? " on" : "") + '" data-more aria-label="Więcej żetonów">' + (barMore ? "−" : "+") + "</button>";
    let readyLabel = "Postaw", readyOn = false;
    if (withBet.length && allReady) readyLabel = "Czekam…";
    else if (withBet.length) { readyLabel = "Gotowe"; readyOn = S.phase === "betting"; }
    el.innerHTML =
      '<div class="bet-box"><small>' + (mine.length > 1 ? "Miejsce " + (sel + 1) : "Zakład") + "</small><b>" + fmt(seat.bet) + "</b></div>" +
      '<div class="chips-row">' + chips + "</div>" +
      '<button class="btn outline" data-clear="' + sel + '"' + (seat.bet > 0 ? "" : " disabled") + ">Wyczyść</button>" +
      '<button class="btn outline" data-sitout="' + sel + '">' + (seat.sitOut ? "Wracam" : "Pauza") + "</button>" +
      '<button class="btn gold" data-ready' + (readyOn ? "" : " disabled") + ">" + readyLabel + "</button>";
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

function renderDrawer(mine) {
  const show = mine.length > 0 && isBetting() && me;
  $("drawerTab").classList.toggle("hidden", !show || drawerOpen);
  $("drawer").classList.toggle("hidden", !show || !drawerOpen);
  if (!show) return;
  const betsMine = mine.reduce((sum, i) => sum + S.seats[i].bet, 0);
  $("drawer").innerHTML = '<button class="drawer-close" data-drawer="0">◂ Zwiń</button>' +
    CHIPS.slice().reverse().map((v) => chipBtn(v, betsMine + v > me.bankroll, "data-bet")).join("");
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
  const ring = $("turnRing");
  if (!ring || !S || !S.deadline) return;
  const left = Math.max(0, S.deadline - (Date.now() + clockOffset));
  const frac = Math.min(1, left / PHASE_MS.playing);
  ring.querySelector(".fg").setAttribute("stroke-dashoffset", (94.25 * (1 - frac)).toFixed(1));
  ring.classList.toggle("low", left < 5000);
  $("turnSec").textContent = Math.ceil(left / 1000);
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
  else if (d.bet != null) send({ type: "bet", seat: sel, amount: +d.bet });
  else if (d.clear != null) send({ type: "clearBet", seat: +d.clear });
  else if (d.ready != null) send({ type: "ready" });
  else if (d.sitout != null) send({ type: "sitOut", seat: +d.sitout });
  else if (d.act != null) send({ type: "action", kind: d.act });
  else if (d.ins != null) send({ type: "insurance", seat: +d.ins, accept: d.accept === "1" });
  else if (d.dep != null) { send({ type: "deposit", amount: +d.dep }); closeModal("mDeposit"); }
  else if (d.drawer != null) { drawerOpen = d.drawer === "1"; render(); }
  else if (d.more != null) {
    barMore = !barMore;
    render();
    const row = document.querySelector(".chips-row");
    if (row && barMore) row.scrollTo({ left: row.scrollWidth, behavior: "smooth" });
  }
  else if (d.close != null) b.closest(".modal").classList.add("hidden");
  else if (d.select != null) { sel = +d.select; render(); }
});

$("drawerTab").dataset.drawer = "1";

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
