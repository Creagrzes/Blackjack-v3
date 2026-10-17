"use strict";

// Klient stołu: łączy się z /ws, wysyła akcje gracza i rysuje stan, który przysyła serwer.

const CHIPS = [2, 5, 10, 15, 100, 200, 300, 500, 1000, 2500];
const PHASE_MS = { betting: 15000, insurance: 10000, playing: 20000, result: 5000 };
const PING_MS = 20000;
const TOKEN_KEY = "bj_token";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "±") + fmt(Math.abs(n));

let ws = null;
let pingTimer = null;
let retry = 0;
let meId = null;
let S = null;         // stan stołu
let me = null;        // mój profil
let clockOffset = 0;  // serwer − telefon
let sel = null;       // wybrane moje miejsce

function storage(fn) {
  try { return fn(localStorage); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Połączenie
// ---------------------------------------------------------------------------

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/ws");
  $("conn").textContent = "Łączenie…";
  $("conn").classList.remove("hidden");

  ws.onopen = () => {
    retry = 0;
    $("conn").classList.add("hidden");
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
    $("conn").textContent = "Brak połączenia – łączę ponownie…";
    $("conn").classList.remove("hidden");
    const delay = Math.min(1000 * 2 ** retry, 10000);
    retry++;
    setTimeout(connect, delay);
  };
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
      openName();
      break;
    case "welcome":
      meId = msg.id;
      if (msg.token) storage((s) => s.setItem(TOKEN_KEY, msg.token));
      if ($("dlgName").open) $("dlgName").close();
      break;
    case "state":
      S = msg.state;
      me = msg.me;
      clockOffset = S.now - Date.now();
      render();
      break;
    case "error":
      if ($("dlgName").open) $("nameErr").textContent = msg.msg;
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

function cardHtml(c) {
  if (!c) return '<div class="card back"></div>';
  const red = c.s === "♥" || c.s === "♦";
  return '<div class="card' + (red ? " red" : "") + '"><span class="r">' + esc(c.r) + '</span><span class="s">' + esc(c.s) + "</span></div>";
}

function totalText(h) {
  if (h.total == null) return "";
  if (h.bj) return "BJ";
  return (h.soft ? "miękkie " : "") + h.total;
}

function mySeats() {
  if (!S || !meId) return [];
  const list = [];
  S.seats.forEach((s, i) => { if (s && s.pid === meId) list.push(i); });
  return list;
}

function render() {
  if (!S) return;
  const mine = mySeats();
  if (!mine.includes(sel)) sel = mine.length ? mine[0] : null;

  $("meName").textContent = me ? me.name : "Gość";
  $("meBank").textContent = me ? fmt(me.bankroll) : "0";

  // Krupier
  $("dealerCards").innerHTML = S.dealer.cards.map(cardHtml).join("");
  $("dealerTotal").textContent = S.dealer.total == null ? "" : totalText(S.dealer);
  $("message").textContent = S.message || "";

  // Miejsca
  $("seats").innerHTML = S.seats.map((s, i) => seatHtml(s, i)).join("");

  renderControls(mine);
  updateTimer();
}

function seatHtml(s, i) {
  if (!s) {
    const canSit = meId && mySeats().length < 3;
    return '<div class="seat empty">' +
      (canSit ? '<button class="btn small" data-sit="' + i + '">Usiądź · ' + (i + 1) + "</button>" : '<span class="muted">Wolne · ' + (i + 1) + "</span>") +
      "</div>";
  }
  const isMine = s.pid === meId;
  const isTurn = S.turn && S.turn.seat === i;
  const cls = ["seat", isMine && "mine", isMine && i === sel && "selected", isTurn && "turn"].filter(Boolean).join(" ");

  const badges = [];
  if (s.away) badges.push('<span class="badge bad">offline</span>');
  if (s.sitOut) badges.push('<span class="badge warn">pauza</span>');
  if (s.leaving) badges.push('<span class="badge warn">wstaje</span>');
  if (s.ready && S.phase === "betting") badges.push('<span class="badge ok">gotowy</span>');
  if (s.ins > 0) badges.push('<span class="badge warn">ubezp. ' + fmt(s.ins) + "</span>");

  const hands = s.hands.map((h, hi) => {
    const active = isTurn && S.turn.hand === hi;
    return '<div class="hand' + (active ? " active" : "") + '">' +
      '<div class="cards">' + h.cards.map(cardHtml).join("") + "</div>" +
      '<div class="hand-info"><span class="total">' + esc(totalText(h)) + "</span>" +
      "<span>" + fmt(h.bet) + (h.doubled ? " ×2" : "") + "</span>" +
      (h.label ? '<span class="result ' + esc(h.result || "") + '">' + esc(h.label) + "</span>" : "") +
      "</div></div>";
  }).join("");

  return '<div class="' + cls + '"' + (isMine ? ' data-select="' + i + '"' : "") + ">" +
    '<div class="seat-head"><span class="seat-name">' + esc(s.name) + '</span><span class="seat-no">#' + (i + 1) + "</span></div>" +
    '<div class="seat-bank">💰 ' + fmt(s.bankroll) + "</div>" +
    (badges.length ? '<div class="badges">' + badges.join("") + "</div>" : "") +
    (s.bet > 0 ? '<span class="bet-chip">zakład ' + fmt(s.bet) + "</span>" : "") +
    hands +
    "</div>";
}

function renderControls(mine) {
  const el = $("controls");
  if (!me) { el.innerHTML = ""; return; }
  if (mine.length === 0) {
    el.innerHTML = '<div class="ctl-title">Wybierz wolne miejsce przy stole' +
      (me.bankroll < CHIPS[0] ? " i wpłać żetony" : "") + ".</div>";
    return;
  }
  const seat = S.seats[sel];
  const phase = S.phase;

  // Mój ruch
  if (phase === "playing" && S.turn && mine.includes(S.turn.seat)) {
    const a = S.actions || {};
    const t = S.seats[S.turn.seat];
    const multi = t.hands.length > 1 ? " · ręka " + (S.turn.hand + 1) : "";
    el.innerHTML = '<div class="ctl-title">Twój ruch – miejsce ' + (S.turn.seat + 1) + multi + "</div>" +
      '<div class="actions">' +
      '<button class="btn green" data-act="hit">Dobierz</button>' +
      '<button class="btn red" data-act="stand">Stój</button>' +
      '<button class="btn gold" data-act="double"' + (a.double ? "" : " disabled") + ">Podwój</button>" +
      '<button class="btn" data-act="split"' + (a.split ? "" : " disabled") + ">Rozdziel</button>" +
      '<button class="btn ghost" data-act="surrender"' + (a.surrender ? "" : " disabled") + ' style="grid-column:1/-1">Poddaj (−50%)</button>' +
      "</div>";
    return;
  }

  // Ubezpieczenie
  if (phase === "insurance") {
    const pending = mine.filter((i) => S.seats[i].inRound && S.seats[i].ins === null);
    if (pending.length) {
      el.innerHTML = '<div class="ctl-title">Krupier ma asa – ubezpieczenie płaci 2:1</div>' +
        pending.map((i) => {
          const amt = Math.floor(S.seats[i].hands[0].bet / 2);
          return '<div class="row" style="margin-bottom:6px">' +
            '<button class="btn gold" data-ins="' + i + '" data-accept="1">Miejsce ' + (i + 1) + ": ubezpiecz (" + fmt(amt) + ")</button>" +
            '<button class="btn ghost" data-ins="' + i + '" data-accept="0">Nie</button></div>';
        }).join("");
      return;
    }
  }

  const tabs = mine.length > 1
    ? '<div class="seat-tabs">' + mine.map((i) => '<button class="btn small' + (i === sel ? " on" : "") + '" data-select="' + i + '">Miejsce ' + (i + 1) + "</button>").join("") + "</div>"
    : "";
  const seatRow = '<div class="row">' +
    '<button class="btn ghost" data-sitout="' + sel + '">' + (seat.sitOut ? "Wracam do gry" : "Pauza") + "</button>" +
    '<button class="btn ghost" data-leave="' + sel + '">Wstań</button></div>';

  // Obstawianie
  if (phase === "idle" || phase === "betting") {
    const betsMine = mine.reduce((sum, i) => sum + S.seats[i].bet, 0);
    const anyBet = mine.some((i) => S.seats[i].bet > 0 && !S.seats[i].sitOut);
    const allReady = mine.filter((i) => S.seats[i].bet > 0).every((i) => S.seats[i].ready);
    const chips = CHIPS.map((v) =>
      '<button class="chip" data-v="' + v + '" data-bet="' + v + '"' + (betsMine + v > me.bankroll ? " disabled" : "") + ">" + (v >= 1000 ? v / 1000 + "k" : v) + "</button>"
    ).join("");
    const hint = me.bankroll < CHIPS[0] && betsMine === 0 ? '<div class="ctl-title">Brak żetonów – kliknij „+ Wpłać”.</div>' : "";
    el.innerHTML = tabs + hint +
      '<div class="ctl-title">Zakład na miejscu ' + (sel + 1) + ": <b>" + fmt(seat.bet) + "</b></div>" +
      '<div class="chips">' + chips + "</div>" +
      '<div class="row" style="margin-bottom:6px">' +
      '<button class="btn ghost" data-clear="' + sel + '"' + (seat.bet > 0 ? "" : " disabled") + ">Wyczyść</button>" +
      '<button class="btn gold" data-ready' + (phase === "betting" && anyBet && !allReady ? "" : " disabled") + ">" + (anyBet && allReady && phase === "betting" ? "Czekam na innych…" : "Rozdaj") + "</button></div>" +
      seatRow;
    return;
  }

  // Krupier gra / wyniki / czekanie na innych
  const title = phase === "dealer" ? "Krupier dobiera…" : phase === "result" ? "Koniec rundy" : "Czekaj na swoją kolej…";
  el.innerHTML = tabs + '<div class="ctl-title">' + title + "</div>" + seatRow;
}

function updateTimer() {
  const bar = $("timerBar");
  if (!S || !S.deadline || !PHASE_MS[S.phase]) { bar.style.width = "0"; return; }
  const left = S.deadline - (Date.now() + clockOffset);
  const frac = Math.max(0, Math.min(1, left / PHASE_MS[S.phase]));
  bar.style.width = (frac * 100).toFixed(1) + "%";
  bar.classList.toggle("low", left < 5000);
}
setInterval(updateTimer, 250);

// ---------------------------------------------------------------------------
// Kliknięcia
// ---------------------------------------------------------------------------

document.addEventListener("click", (e) => {
  const b = e.target.closest("button, [data-select]");
  if (!b || b.disabled) return;
  const d = b.dataset;
  if (d.sit != null) send({ type: "sit", seat: +d.sit });
  else if (d.bet != null) send({ type: "bet", seat: sel, amount: +d.bet });
  else if (d.clear != null) send({ type: "clearBet", seat: +d.clear });
  else if (d.ready != null) send({ type: "ready" });
  else if (d.sitout != null) send({ type: "sitOut", seat: +d.sitout });
  else if (d.leave != null) send({ type: "leave", seat: +d.leave });
  else if (d.act != null) send({ type: "action", kind: d.act });
  else if (d.ins != null) send({ type: "insurance", seat: +d.ins, accept: d.accept === "1" });
  else if (d.amt != null) $("inDeposit").value = d.amt;
  else if (d.close != null) b.closest("dialog").close();
  else if (d.select != null) { sel = +d.select; render(); }
});

$("btnDeposit").onclick = () => {
  if (!me) return openName();
  $("inDeposit").value = "";
  $("dlgDeposit").showModal();
};
$("formDeposit").onsubmit = (e) => {
  const amount = Math.floor(Number($("inDeposit").value));
  if (!(amount >= 1)) { e.preventDefault(); return; }
  send({ type: "deposit", amount });
};

$("btnStats").onclick = () => {
  $("statsBody").innerHTML = '<p class="muted">Wczytywanie…</p>';
  $("dlgStats").showModal();
  send({ type: "stats" });
};

function openName() {
  $("nameErr").textContent = "";
  if (!$("dlgName").open) $("dlgName").showModal();
  setTimeout(() => $("inName").focus(), 50);
}
$("formName").onsubmit = (e) => {
  e.preventDefault();
  const name = $("inName").value.trim();
  if (name.length < 2) { $("nameErr").textContent = "Nick musi mieć od 2 do 16 znaków."; return; }
  $("nameErr").textContent = "";
  send({ type: "register", name });
};
// Bez nicku nie da się grać – okna nie można zamknąć klawiszem Esc.
$("dlgName").addEventListener("cancel", (e) => e.preventDefault());

function renderStats(st) {
  const rows = st.players
    .sort((a, b) => b.net - a.net)
    .map((p) => {
      const streak = (p.recent || []).slice(-12).map((r) => "<i class='" + (r > 0 ? "w" : r < 0 ? "l" : "") + "'></i>").join("");
      return "<tr><td>" + esc(p.name) + '<span class="streak">' + streak + "</span></td>" +
        "<td>" + p.rounds + "</td><td>" + p.plus + "/" + p.even + "/" + p.minus + "</td>" +
        '<td class="' + (p.net > 0 ? "pos" : p.net < 0 ? "neg" : "") + '">' + signed(p.net) + "</td>" +
        "<td>" + fmt(p.bankroll) + "</td></tr>";
    }).join("");
  const log = st.log.slice(0, 20).map((r) =>
    "<div><b>#" + r.n + "</b> krupier " + esc(r.dealer) + " · " +
    r.res.map((x) => esc(x.name) + ' <span class="' + (x.delta > 0 ? "pos" : x.delta < 0 ? "neg" : "") + '">' + signed(x.delta) + "</span>").join(", ") +
    "</div>"
  ).join("");
  $("statsBody").innerHTML =
    '<p class="muted">Rund: <b>' + st.roundNo + "</b> · bilans krupiera: <b class='" + (st.house > 0 ? "pos" : st.house < 0 ? "neg" : "") + "'>" + signed(st.house) + "</b></p>" +
    (rows
      ? '<table class="stats-table"><tr><th>Gracz</th><th>Rundy</th><th>+/=/−</th><th>Bilans</th><th>Saldo</th></tr>' + rows + "</table>"
      : '<p class="muted">Nikt jeszcze nie grał.</p>') +
    (log ? '<div class="log"><div class="label">Ostatnie rundy</div>' + log + "</div>" : "");
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
window.addEventListener("unhandledrejection", (e) => reportError(String(e.reason && e.reason.message || e.reason), e.reason && e.reason.stack, "promise"));

connect();
