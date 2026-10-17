import { DurableObject } from "cloudflare:workers";
import { newShoe, evaluate, rankValue } from "./game.js";

const SEATS = 6;
const MAX_HANDS_PER_SEAT = 4;
const CHIPS = [2, 5, 10, 15, 25, 50, 100, 200, 300, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
const MIN_BET = CHIPS[0];
const MAX_SEATS_PER_PLAYER = 3;
const BET_MS = 15000;
const INSURANCE_MS = 10000;
const TURN_MS = 20000;
const AWAY_TURN_MS = 3000;
const DEALER_STEP_MS = 800;
const RESULT_MS = 5000;
const SEAT_HOLD_MS = 60000;
const STALE_MS = 45000;
const HOUSEKEEPING_MS = 15000;
const AFK_TIMEOUTS = 2;
const CUT_CARD = 78;
const MAX_DEPOSIT = 10000000;
const LOG_SIZE = 60;
const ERRLOG_SIZE = 200;
const RECENT_SIZE = 40;
const ROUND_PHASES = ["insurance", "playing", "dealer"];

function freshTable() {
  return {
    phase: "idle",
    // idle | betting | insurance | playing | dealer | result
    deadline: 0,
    seats: Array(SEATS).fill(null),
    dealer: [],
    hole: true,
    turn: null,
    included: [],
    shoe: newShoe(),
    roundNo: 0,
    house: 0,
    message: "Stół otwarty – usiądź i postaw zakład."
  };
}

function newSeat(pid) {
  return {
    pid,
    bet: 0,
    lastBet: 0,
    ready: false,
    sitOut: false,
    hands: [],
    ins: null,
    leaving: false,
    timeouts: 0,
    awayAt: null
  };
}

function newHand(cards, bet) {
  return { cards, bet, done: false, doubled: false, splitAces: false, result: null, label: "" };
}

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function signed(n) {
  return (n > 0 ? "+" : n < 0 ? "−" : "±") + fmt(Math.abs(n));
}

export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.t = (await ctx.storage.get("table")) || freshTable();
      this.log = (await ctx.storage.get("log")) || [];
      this.errlog = (await ctx.storage.get("errlog")) || [];
      this.players = new Map();
      this.byToken = new Map();
      const list = await ctx.storage.list({ prefix: "p:" });
      for (const p of list.values()) {
        this.players.set(p.id, p);
        this.byToken.set(p.token, p.id);
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/logs") return this.logsPage(url);
    if (url.pathname === "/admin") return this.adminPage(request, url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null, since: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 8000) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    const att = ws.deserializeAttachment() || {};
    try {
      this.handle(ws, att.pid || null, msg);
    } catch (e) {
      this.logError("serwer", e, { wiadomosc: msg.type, gracz: this.nameOf(att.pid), faza: this.t.phase });
      this.send(ws, { type: "error", msg: "Błąd serwera – spróbuj ponownie." });
    }
  }

  // -------------------------------------------------------------------------
  // Dziennik błędów (serwer + telefony graczy) – podgląd pod /logs
  // -------------------------------------------------------------------------

  logError(source, err, extra) {
    const entry = {
      ts: Date.now(),
      src: source,
      msg: String((err && err.message) || err).slice(0, 500),
      stack: err && err.stack ? String(err.stack).slice(0, 2000) : "",
      extra: extra || null
    };
    console.error("[" + source + "]", entry.msg, extra || "", entry.stack);
    this.errlog.unshift(entry);
    if (this.errlog.length > ERRLOG_SIZE) this.errlog.length = ERRLOG_SIZE;
    this.ctx.storage.put("errlog", this.errlog);
  }

  nameOf(pid) {
    const p = pid ? this.players.get(pid) : null;
    return p ? p.name : null;
  }

  // -------------------------------------------------------------------------
  // /admin – zerowanie statystyk albo wszystkich graczy (wymaga hasła ADMIN_KEY)
  // -------------------------------------------------------------------------

  async adminPage(request, url) {
    const key = this.env.ADMIN_KEY;
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!key && !local) return new Response("Ustaw sekret ADMIN_KEY, żeby używać /admin.", { status: 403 });
    if (key && url.searchParams.get("key") !== key) return new Response("Brak dostępu", { status: 403 });

    let done = "";
    if (request.method === "POST") {
      const form = await request.formData();
      const action = form.get("action");
      if (action === "stats") {
        this.resetStats();
        done = "Statystyki wyzerowane. Nicki i salda zostały.";
      } else if (action === "all") {
        this.resetAll();
        done = "Wszyscy gracze usunięci – stół jest pusty.";
      }
    }

    const players = [...this.players.values()];
    const rounds = players.reduce((a, p) => a + p.rounds, 0);
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const q = key ? "?key=" + encodeURIComponent(key) : "";
    const html =
      "<!doctype html><html lang=pl><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<title>Blackjack – admin</title><style>" +
      "body{font:15px system-ui,sans-serif;margin:16px;background:#14120c;color:#f3ecd9;max-width:560px}a{color:#e9cd83}" +
      ".box{border:1px solid #423a27;border-radius:12px;padding:12px 14px;margin:12px 0}" +
      "button{font:inherit;font-weight:700;border:0;border-radius:10px;padding:10px 14px;cursor:pointer}" +
      ".warn{background:#cda449;color:#241d12}.danger{background:#a3241d;color:#fff}.ok{color:#8fe0ac;font-weight:700}" +
      "p{margin:6px 0}small{color:#b8ac8e}</style></head><body><h2>Blackjack – administracja</h2>" +
      (done ? "<p class=ok>✓ " + esc(done) + "</p>" : "") +
      "<p>Graczy: <b>" + players.length + "</b> · rozegranych rund (suma): <b>" + rounds + "</b> · runda stołu: <b>" + this.t.roundNo + "</b></p>" +
      "<div class=box><p><b>Wyzeruj statystyki</b></p><p><small>Zostają nicki i salda. Od zera: rundy, na plus / zero / minus, bilans, historia rund, bilans krupiera.</small></p>" +
      "<form method=post action='/admin" + esc(q) + "' onsubmit=\"return confirm('Wyzerować statystyki wszystkich graczy?')\">" +
      "<input type=hidden name=action value=stats><button class=warn>Wyzeruj statystyki</button></form></div>" +
      "<div class=box><p><b>Usuń wszystkich graczy</b></p><p><small>Pełny reset: nicki, salda, statystyki i historia znikają, stół jest pusty. Każdy zakłada nick od nowa. Tego nie da się cofnąć.</small></p>" +
      "<form method=post action='/admin" + esc(q) + "' onsubmit=\"return confirm('Na pewno usunąć WSZYSTKICH graczy, salda i statystyki?')\">" +
      "<input type=hidden name=action value=all><button class=danger>Usuń wszystkich graczy</button></form></div>" +
      "<p><a href='/logs" + esc(q) + "'>Dziennik błędów</a> · <a href='/'>Stół</a></p></body></html>";
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  resetStats() {
    for (const p of this.players.values()) {
      p.rounds = 0;
      p.plus = 0;
      p.even = 0;
      p.minus = 0;
      p.net = 0;
      p.best = 0;
      p.worst = 0;
      p.recent = [];
      p.deposited = p.bankroll;
      this.savePlayer(p);
    }
    this.log = [];
    this.ctx.storage.put("log", this.log);
    this.t.house = 0;
    this.commit();
  }

  resetAll() {
    const keys = [...this.players.keys()].map((id) => "p:" + id);
    for (let i = 0; i < keys.length; i += 100) this.ctx.storage.delete(keys.slice(i, i + 100));
    this.players.clear();
    this.byToken.clear();
    this.log = [];
    this.ctx.storage.put("log", this.log);
    this.t = freshTable();
    this.ctx.storage.put("table", this.t);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4001, "reset");
      } catch {}
    }
  }

  logsPage(url) {
    const key = this.env.ADMIN_KEY;
    if (key && url.searchParams.get("key") !== key) return new Response("Brak dostępu", { status: 403 });
    if (url.searchParams.get("clear") === "1") {
      this.errlog = [];
      this.ctx.storage.put("errlog", this.errlog);
      const back = new URL(url);
      back.searchParams.delete("clear");
      return Response.redirect(back.toString(), 303);
    }
    if (url.searchParams.get("format") === "json") {
      return new Response(JSON.stringify(this.errlog, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const clearUrl = new URL(url);
    clearUrl.searchParams.set("clear", "1");
    const rows = this.errlog
      .map(
        (e) =>
          "<tr><td>" + esc(new Date(e.ts).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" })) + "</td><td>" + esc(e.src) +
          "</td><td><b>" + esc(e.msg) + "</b>" +
          (e.extra ? "<div class=x>" + esc(JSON.stringify(e.extra)) + "</div>" : "") +
          (e.stack ? "<details><summary>szczegóły</summary><pre>" + esc(e.stack) + "</pre></details>" : "") +
          "</td></tr>"
      )
      .join("");
    const html =
      "<!doctype html><html lang=pl><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<title>Blackjack – błędy</title><style>" +
      "body{font:14px system-ui,sans-serif;margin:16px;background:#14120c;color:#f3ecd9}a{color:#e9cd83}" +
      "table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #423a27;padding:6px;vertical-align:top}" +
      "td:first-child{white-space:nowrap;color:#b8ac8e}.x{color:#b8ac8e;font-size:12px;margin-top:3px;word-break:break-all}" +
      "pre{white-space:pre-wrap;font-size:11px;color:#b8ac8e}</style></head><body><h2>Błędy (" + this.errlog.length + ")</h2>" +
      "<p><a href=''>Odśwież</a> · <a href='" + esc(clearUrl.pathname + clearUrl.search) + "'>Wyczyść</a> · " +
      "<a href='?format=json" + (key ? "&key=" + esc(key) : "") + "'>JSON</a> · " +
      "<a href='/admin" + (key ? "?key=" + esc(encodeURIComponent(key)) : "") + "'>Administracja</a></p>" +
      (rows ? "<table>" + rows + "</table>" : "<p>Brak błędów 👍</p>") +
      "</body></html>";
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  async webSocketClose(ws) {
    try {
      ws.close(1000, "bye");
    } catch {}
    this.onDisconnect(ws);
  }

  async webSocketError(ws) {
    this.onDisconnect(ws);
  }

  onDisconnect(ws) {
    const pid = (ws.deserializeAttachment() || {}).pid;
    if (!pid || this.isConnected(pid, ws)) return;
    const mine = this.seatsOf(pid);
    if (mine.length === 0) return;
    const t = this.t;
    for (const si of mine) {
      t.seats[si].awayAt = Date.now();
      t.seats[si].ready = false;
    }
    if (t.phase === "playing" && t.turn && mine.includes(t.turn.seat)) {
      t.deadline = Math.min(t.deadline, Date.now() + AWAY_TURN_MS);
      this.schedule(t.deadline);
    } else if (t.phase === "betting" && this.allReady()) {
      this.dealRound();
    } else if (t.phase === "idle") {
      this.schedule(Date.now() + SEAT_HOLD_MS + 1000);
    }
    this.commit();
  }

  handle(ws, pid, msg) {
    const t = this.t;

    if (msg.type === "hello") {
      const known = this.byToken.get(String(msg.token || ""));
      if (known) {
        ws.serializeAttachment({ pid: known, since: Date.now() });
        for (const si of this.seatsOf(known)) t.seats[si].awayAt = null;
        this.send(ws, { type: "welcome", id: known, name: this.players.get(known).name });
        this.commit();
      } else {
        this.send(ws, { type: "needName" });
        this.sendState(ws);
      }
      return;
    }

    if (msg.type === "register") {
      if (pid) return;
      const name = String(msg.name || "").trim().replace(/\s+/g, " ");
      if (name.length < 2 || name.length > 16) return this.error(ws, "Nick musi mieć od 2 do 16 znaków.");
      const lower = name.toLowerCase();
      for (const p of this.players.values()) {
        if (p.name.toLowerCase() === lower) return this.error(ws, "Ten nick jest już zajęty – wybierz inny.");
      }
      const p = {
        id: crypto.randomUUID().slice(0, 8),
        token: crypto.randomUUID(),
        name,
        bankroll: 0,
        deposited: 0,
        rounds: 0,
        plus: 0,
        even: 0,
        minus: 0,
        net: 0,
        best: 0,
        worst: 0,
        recent: [],
        created: Date.now()
      };
      this.players.set(p.id, p);
      this.byToken.set(p.token, p.id);
      this.savePlayer(p);
      ws.serializeAttachment({ pid: p.id, since: Date.now() });
      this.send(ws, { type: "welcome", id: p.id, name: p.name, token: p.token });
      this.commit();
      return;
    }

    if (msg.type === "clientError") {
      const str = (v, n) => String(v || "").slice(0, n);
      this.logError("telefon", { message: str(msg.msg, 500), stack: str(msg.stack, 2000) }, {
        gracz: this.nameOf(pid),
        plik: str(msg.src, 200),
        ekran: str(msg.screen, 40),
        przegladarka: str(msg.ua, 200)
      });
      return;
    }

    if (msg.type === "stats") {
      this.send(ws, this.statsPayload());
      return;
    }

    if (!pid) return this.error(ws, "Najpierw podaj swój nick.");
    const p = this.players.get(pid);
    const mine = this.seatsOf(pid);
    const si = Number.isInteger(msg.seat) && mine.includes(msg.seat) ? msg.seat : -1;
    const seat = si === -1 ? null : t.seats[si];

    switch (msg.type) {
      case "sit": {
        const idx = Number(msg.seat);
        if (!Number.isInteger(idx) || idx < 0 || idx >= SEATS) return;
        if (t.seats[idx]) return this.error(ws, "To miejsce jest zajęte.");
        if (mine.length >= MAX_SEATS_PER_PLAYER) return this.error(ws, "Możesz zająć najwyżej " + MAX_SEATS_PER_PLAYER + " miejsca.");
        t.seats[idx] = newSeat(pid);
        break;
      }
      case "leave": {
        if (!seat) return;
        if (this.inRound(si)) {
          seat.leaving = true;
          this.send(ws, { type: "toast", msg: "Wstaniesz od stołu po tej rundzie." });
        } else {
          t.seats[si] = null;
          if (t.phase === "betting" && this.allReady()) this.dealRound();
        }
        break;
      }
      case "deposit": {
        const amount = Math.floor(Number(msg.amount));
        if (!(amount >= 1 && amount <= MAX_DEPOSIT)) return this.error(ws, "Kwota wpłaty: od 1 do " + fmt(MAX_DEPOSIT) + ".");
        p.bankroll += amount;
        p.deposited += amount;
        // Wpłata w trakcie rundy nie może się liczyć jako wygrana.
        if (t.roundStart && pid in t.roundStart && ROUND_PHASES.includes(t.phase)) t.roundStart[pid] += amount;
        this.savePlayer(p);
        this.send(ws, { type: "toast", msg: "Wpłacono " + fmt(amount) + " żetonów." });
        break;
      }
      case "bet": {
        if (!seat || (t.phase !== "idle" && t.phase !== "betting")) return;
        const amount = Number(msg.amount);
        if (!CHIPS.includes(amount)) return;
        if (this.betsOf(pid) + amount > p.bankroll) return this.error(ws, "Za mało żetonów na taki zakład.");
        seat.bet += amount;
        seat.ready = false;
        seat.sitOut = false;
        seat.timeouts = 0;
        if (t.phase === "idle") this.startBetting();
        break;
      }
      case "clearBet": {
        if (!seat || (t.phase !== "idle" && t.phase !== "betting")) return;
        seat.bet = 0;
        seat.ready = false;
        break;
      }
      case "sitOut": {
        if (!seat) return;
        seat.sitOut = !seat.sitOut;
        seat.timeouts = 0;
        if (seat.sitOut && (t.phase === "idle" || t.phase === "betting")) {
          seat.bet = 0;
          seat.ready = false;
        }
        if (t.phase === "betting" && this.allReady()) this.dealRound();
        break;
      }
      case "ready": {
        if (t.phase !== "betting") return;
        const withBet = mine.filter((i) => t.seats[i].bet > 0 && !t.seats[i].sitOut);
        if (withBet.length === 0) return;
        for (const i of withBet) t.seats[i].ready = true;
        if (this.allReady()) this.dealRound();
        break;
      }
      case "insurance": {
        if (!seat || t.phase !== "insurance" || !t.included.includes(si) || seat.ins !== null) return;
        const amt = Math.floor(seat.hands[0].bet / 2);
        if (msg.accept && amt > 0 && p.bankroll >= amt) {
          p.bankroll -= amt;
          seat.ins = amt;
          this.savePlayer(p);
        } else {
          seat.ins = 0;
        }
        seat.timeouts = 0;
        if (t.included.every((i) => t.seats[i].ins !== null)) this.finishInsurance();
        break;
      }
      case "action": {
        if (t.phase !== "playing" || !t.turn || !mine.includes(t.turn.seat)) return;
        this.doAction(String(msg.kind));
        break;
      }
      default:
        return;
    }
    this.commit();
  }

  // -------------------------------------------------------------------------
  // Alarm – jedyny zegar stołu (odliczanie, ruchy krupiera, koniec rundy)
  // -------------------------------------------------------------------------

  async alarm() {
    try {
      this.tick();
    } catch (e) {
      this.logError("serwer", e, { gdzie: "alarm", faza: this.t.phase });
    }
  }

  tick() {
    const t = this.t;
    const now = Date.now();
    if (["betting", "insurance", "playing", "result"].includes(t.phase) && t.deadline && now < t.deadline - 50) {
      this.schedule(t.deadline);
      return;
    }
    switch (t.phase) {
      case "betting":
        this.dealRound();
        break;
      case "insurance":
        this.finishInsurance();
        break;
      case "playing": {
        const seat = t.seats[t.turn.seat];
        seat.timeouts++;
        seat.hands[t.turn.hand].done = true;
        t.message = this.players.get(seat.pid).name + " – czas minął, zostaje.";
        this.advance();
        break;
      }
      case "dealer":
        this.dealerStep();
        break;
      case "result":
        this.afterResult();
        break;
      case "idle":
        this.cleanupAway();
        break;
    }
    this.commit();
  }

  // -------------------------------------------------------------------------
  // Przebieg rundy
  // -------------------------------------------------------------------------

  startBetting() {
    const t = this.t;
    t.phase = "betting";
    t.deadline = Date.now() + BET_MS;
    for (const s of t.seats) if (s) s.ready = false;
    t.message = "Obstawianie – runda startuje za chwilę.";
    this.schedule(t.deadline);
  }

  activeSeats() {
    return this.t.seats.filter((s) => {
      if (!s || s.sitOut || s.leaving || !this.isConnected(s.pid)) return false;
      return this.players.get(s.pid).bankroll >= MIN_BET || s.bet > 0;
    });
  }

  allReady() {
    const active = this.activeSeats();
    const readyPids = new Set(active.filter((s) => s.ready).map((s) => s.pid));
    return active.some((s) => s.bet > 0) && active.every((s) => (s.ready && s.bet > 0) || (s.bet === 0 && readyPids.has(s.pid)));
  }

  draw() {
    if (this.t.shoe.length === 0) this.t.shoe = newShoe();
    return this.t.shoe.pop();
  }

  dealRound() {
    const t = this.t;
    this.cleanupAway();
    const included = [];
    const left = {};
    t.seats.forEach((s, i) => {
      if (!s) return;
      const p = this.players.get(s.pid);
      if (!(s.pid in left)) left[s.pid] = p.bankroll;
      s.hands = [];
      s.ins = null;
      s.ready = false;
      if (s.bet > 0 && !s.sitOut && !s.leaving && s.bet <= left[s.pid] && this.isConnected(s.pid)) {
        included.push(i);
        left[s.pid] -= s.bet;
      } else {
        s.bet = 0;
      }
    });
    t.dealer = [];
    t.hole = true;
    t.turn = null;
    if (included.length === 0) {
      t.phase = "idle";
      t.deadline = 0;
      t.included = [];
      t.message = "Nikt nie postawił – czekamy na zakłady.";
      return;
    }
    if (t.shoe.length < CUT_CARD) {
      t.shoe = newShoe();
      t.message = "Nowy but – 6 talii potasowanych.";
    } else {
      t.message = "";
    }
    t.roundStart = {};
    for (const si of included) {
      const s = t.seats[si];
      const p = this.players.get(s.pid);
      if (!(s.pid in t.roundStart)) t.roundStart[s.pid] = p.bankroll;
      p.bankroll -= s.bet;
      s.lastBet = s.bet;
      this.savePlayer(p);
    }
    const first = {}, second = {};
    for (const si of included) first[si] = this.draw();
    const up = this.draw();
    for (const si of included) second[si] = this.draw();
    const hole = this.draw();
    for (const si of included) {
      const s = t.seats[si];
      s.hands = [newHand([first[si], second[si]], s.bet)];
      s.bet = 0;
    }
    t.dealer = [up, hole];
    t.included = included;
    t.roundNo++;
    this.resolvePreplay();
  }

  resolvePreplay() {
    const t = this.t;
    const up = t.dealer[0];
    if (up.r === "A") {
      t.phase = "insurance";
      for (const si of t.included) {
        const s = t.seats[si];
        const amt = Math.floor(s.hands[0].bet / 2);
        s.ins = amt > 0 && this.players.get(s.pid).bankroll >= amt ? null : 0;
      }
      if (t.included.every((i) => t.seats[i].ins !== null)) {
        this.finishInsurance();
        return;
      }
      t.message = "Krupier pokazuje asa – ubezpieczenie?";
      t.deadline = Date.now() + INSURANCE_MS;
      this.schedule(t.deadline);
      return;
    }
    if (rankValue(up.r) === 10 && evaluate(t.dealer).bj) {
      this.revealDealerBJ();
      return;
    }
    this.autoBlackjacks();
    this.beginPlaying();
  }

  finishInsurance() {
    const t = this.t;
    for (const si of t.included) if (t.seats[si].ins === null) t.seats[si].ins = 0;
    if (evaluate(t.dealer).bj) {
      this.revealDealerBJ();
      return;
    }
    if (t.included.some((si) => t.seats[si].ins > 0)) {
      t.message = "Krupier nie ma blackjacka – ubezpieczenia przepadają.";
    } else {
      t.message = "Krupier nie ma blackjacka.";
    }
    this.autoBlackjacks();
    this.beginPlaying();
  }

  revealDealerBJ() {
    const t = this.t;
    t.hole = false;
    for (const si of t.included) {
      const s = t.seats[si];
      const p = this.players.get(s.pid);
      const hand = s.hands[0];
      if (s.ins > 0) p.bankroll += s.ins * 3;
      if (evaluate(hand.cards).bj) {
        hand.result = "push";
        hand.label = "REMIS";
        p.bankroll += hand.bet;
      } else {
        hand.result = "lose";
        hand.label = "PRZEGRANA";
      }
      hand.done = true;
      this.savePlayer(p);
    }
    t.message = "Krupier ma blackjacka.";
    this.settle(false);
  }

  autoBlackjacks() {
    const t = this.t;
    for (const si of t.included) {
      const s = t.seats[si];
      const hand = s.hands[0];
      if (evaluate(hand.cards).bj) {
        const p = this.players.get(s.pid);
        hand.result = "win";
        hand.label = "BLACKJACK 3:2";
        p.bankroll += hand.bet + Math.floor(hand.bet * 1.5);
        hand.done = true;
        this.savePlayer(p);
      }
    }
  }

  // Następna ręka do zagrania. Ręka z 21 (np. po rozdzieleniu) kończy się sama.
  nextTurn(fromSeat, fromHand) {
    const t = this.t;
    for (let si = fromSeat; si < SEATS; si++) {
      if (!t.included.includes(si)) continue;
      const hands = t.seats[si].hands;
      for (let hi = si === fromSeat ? fromHand : 0; hi < hands.length; hi++) {
        const h = hands[hi];
        if (h.done) continue;
        if (evaluate(h.cards).total === 21) {
          h.done = true;
          continue;
        }
        return { seat: si, hand: hi };
      }
    }
    return null;
  }

  beginPlaying() {
    const t = this.t;
    const next = this.nextTurn(0, 0);
    if (!next) {
      this.toDealer();
      return;
    }
    t.phase = "playing";
    t.turn = next;
    this.setTurnDeadline();
  }

  setTurnDeadline() {
    const t = this.t;
    const seat = t.seats[t.turn.seat];
    t.deadline = Date.now() + (this.isConnected(seat.pid) ? TURN_MS : AWAY_TURN_MS);
    this.schedule(t.deadline);
  }

  canSplit(seat, hand, p) {
    return (
      hand.cards.length === 2 &&
      rankValue(hand.cards[0].r) === rankValue(hand.cards[1].r) &&
      !hand.splitAces &&
      p.bankroll >= hand.bet &&
      seat.hands.length < MAX_HANDS_PER_SEAT
    );
  }

  canDouble(hand, p) {
    return hand.cards.length === 2 && p.bankroll >= hand.bet;
  }

  canSurrender(seat, hand) {
    return hand.cards.length === 2 && seat.hands.length === 1 && !hand.splitAces;
  }

  doAction(kind) {
    const t = this.t;
    const seat = t.seats[t.turn.seat];
    const p = this.players.get(seat.pid);
    const hand = seat.hands[t.turn.hand];
    if (!hand || hand.done) return;
    t.message = "";
    switch (kind) {
      case "hit": {
        hand.cards.push(this.draw());
        if (evaluate(hand.cards).bust) {
          hand.done = true;
          hand.result = "lose";
          hand.label = "PRZEGIĘCIE";
        }
        break;
      }
      case "stand":
        hand.done = true;
        break;
      case "double": {
        if (!this.canDouble(hand, p)) return;
        p.bankroll -= hand.bet;
        hand.bet *= 2;
        hand.doubled = true;
        hand.cards.push(this.draw());
        hand.done = true;
        if (evaluate(hand.cards).bust) {
          hand.result = "lose";
          hand.label = "PRZEGIĘCIE";
        }
        break;
      }
      case "split": {
        if (!this.canSplit(seat, hand, p)) return;
        p.bankroll -= hand.bet;
        const isAces = hand.cards[0].r === "A";
        const second = hand.cards.pop();
        const c1 = this.draw();
        const c2 = this.draw();
        const other = newHand([second, c1], hand.bet);
        other.splitAces = isAces;
        hand.cards.push(c2);
        hand.splitAces = isAces;
        seat.hands.splice(t.turn.hand + 1, 0, other);
        // Rozdzielone asy dostają po jednej karcie i koniec.
        if (isAces) {
          hand.done = true;
          other.done = true;
        }
        break;
      }
      case "surrender": {
        if (!this.canSurrender(seat, hand)) return;
        p.bankroll += Math.floor(hand.bet / 2);
        hand.done = true;
        hand.result = "lose";
        hand.label = "PODDANE (−50%)";
        break;
      }
      default:
        return;
    }
    seat.timeouts = 0;
    this.savePlayer(p);
    this.advance();
  }

  advance() {
    const t = this.t;
    const next = this.nextTurn(t.turn.seat, t.turn.hand);
    if (next) {
      t.turn = next;
      this.setTurnDeadline();
      return;
    }
    this.toDealer();
  }

  toDealer() {
    const t = this.t;
    t.turn = null;
    t.phase = "dealer";
    t.hole = false;
    t.deadline = 0;
    const needsDealer = t.included.some((si) => t.seats[si].hands.some((h) => h.done && !h.label));
    if (needsDealer) this.schedule(Date.now() + DEALER_STEP_MS);
    else this.settle(false);
  }

  // Krupier dobiera do 16, stoi na każdej 17 (także miękkiej).
  dealerStep() {
    const t = this.t;
    if (evaluate(t.dealer).total < 17) {
      t.dealer.push(this.draw());
      this.schedule(Date.now() + DEALER_STEP_MS);
    } else {
      this.settle(true);
    }
  }

  settle(dealerPlayed) {
    const t = this.t;
    const d = evaluate(t.dealer);
    const results = [];
    let totalDelta = 0;
    for (const si of t.included) {
      const s = t.seats[si];
      const p = this.players.get(s.pid);
      for (const hand of s.hands) {
        if (hand.label) continue;
        const ev = evaluate(hand.cards);
        if (d.bust || ev.total > d.total) {
          hand.result = "win";
          hand.label = "WYGRANA";
          p.bankroll += hand.bet * 2;
        } else if (ev.total < d.total) {
          hand.result = "lose";
          hand.label = "PRZEGRANA";
        } else {
          hand.result = "push";
          hand.label = "REMIS";
          p.bankroll += hand.bet;
        }
      }
    }
    const pids = [...new Set(t.included.map((si) => t.seats[si].pid))];
    for (const pid of pids) {
      const p = this.players.get(pid);
      const delta = p.bankroll - t.roundStart[pid];
      totalDelta += delta;
      p.rounds++;
      if (delta > 0) p.plus++;
      else if (delta < 0) p.minus++;
      else p.even++;
      p.net += delta;
      p.best = Math.max(p.best, delta);
      p.worst = Math.min(p.worst, delta);
      p.recent.push(Math.sign(delta));
      if (p.recent.length > RECENT_SIZE) p.recent = p.recent.slice(-RECENT_SIZE);
      this.savePlayer(p);
      results.push({ name: p.name, delta });
    }
    t.house -= totalDelta;
    const dealerText = d.bj ? "BJ" : d.bust ? "fura " + d.total : String(d.total);
    this.log.unshift({ n: t.roundNo, ts: Date.now(), dealer: dealerText, res: results });
    if (this.log.length > LOG_SIZE) this.log.length = LOG_SIZE;
    this.ctx.storage.put("log", this.log);
    const summary = results.map((r) => r.name + " " + signed(r.delta)).join(" · ");
    if (dealerPlayed) {
      t.message = (d.bust ? "Krupier przegina (" + d.total + "). " : "Krupier ma " + d.total + ". ") + summary;
    } else if (!t.message) {
      t.message = summary;
    } else {
      t.message += " " + summary;
    }
    t.phase = "result";
    t.turn = null;
    t.deadline = Date.now() + RESULT_MS;
    this.schedule(t.deadline);
  }

  afterResult() {
    const t = this.t;
    const left = {};
    t.seats.forEach((s, i) => {
      if (!s) return;
      if (s.leaving) {
        t.seats[i] = null;
        return;
      }
      const p = this.players.get(s.pid);
      if (!(s.pid in left)) left[s.pid] = p.bankroll;
      if (s.timeouts >= AFK_TIMEOUTS) s.sitOut = true;
      const played = t.included.includes(i);
      s.hands = [];
      s.ins = null;
      s.ready = false;
      // Ten sam zakład co w poprzedniej rundzie, o ile starczy żetonów.
      s.bet = played && !s.sitOut ? Math.min(s.lastBet, left[s.pid]) : 0;
      if (s.bet < MIN_BET) s.bet = 0;
      left[s.pid] -= s.bet;
    });
    t.dealer = [];
    t.hole = true;
    t.included = [];
    t.turn = null;
    this.cleanupAway();
    if (this.activeSeats().some((s) => s.bet > 0)) {
      this.startBetting();
    } else {
      t.phase = "idle";
      t.deadline = 0;
      t.message = "Postaw zakład, aby zacząć rundę.";
      if (t.seats.some((s) => s && s.awayAt)) this.schedule(Date.now() + SEAT_HOLD_MS + 1000);
    }
  }

  // Zamyka połączenia, z których od dawna nie przyszedł ping (telefon zablokowany,
  // brak zasięgu – taki telefon często nie zamyka połączenia) i oznacza graczy jako offline.
  // Minuta do zwolnienia miejsca liczy się od chwili pokazania statusu „offline”.
  sweepStale() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      if (this.lastSeen(ws) > now - STALE_MS) continue;
      try {
        ws.close(4000, "brak odpowiedzi");
      } catch {}
    }
    for (const s of this.t.seats) {
      if (!s || s.awayAt || this.isConnected(s.pid)) continue;
      s.awayAt = now;
      s.ready = false;
    }
  }

  cleanupAway() {
    const t = this.t;
    this.sweepStale();
    const now = Date.now();
    t.seats.forEach((s, i) => {
      if (s && s.awayAt && now - s.awayAt > SEAT_HOLD_MS && !this.inRound(i)) t.seats[i] = null;
    });
  }

  // -------------------------------------------------------------------------
  // Pomocnicze
  // -------------------------------------------------------------------------

  inRound(si) {
    return ROUND_PHASES.includes(this.t.phase) && this.t.included.includes(si);
  }

  seatsOf(pid) {
    const list = [];
    this.t.seats.forEach((s, i) => {
      if (s && s.pid === pid) list.push(i);
    });
    return list;
  }

  betsOf(pid) {
    return this.t.seats.reduce((sum, s) => sum + (s && s.pid === pid ? s.bet : 0), 0);
  }

  // Ostatni sygnał z telefonu: ping (co 20 s) albo moment połączenia.
  lastSeen(ws) {
    const att = ws.deserializeAttachment() || {};
    let last = att.since || 0;
    try {
      const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (pong) last = Math.max(last, pong.getTime());
    } catch {}
    return last;
  }

  isConnected(pid, except) {
    const cutoff = Date.now() - STALE_MS;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const att = ws.deserializeAttachment();
      if (att && att.pid === pid && this.lastSeen(ws) > cutoff) return true;
    }
    return false;
  }

  schedule(at) {
    this.ctx.storage.setAlarm(at);
  }

  savePlayer(p) {
    this.ctx.storage.put("p:" + p.id, p);
  }

  commit() {
    if (this.t.phase === "idle" && this.t.seats.some((s) => s)) {
      let at = Date.now() + HOUSEKEEPING_MS;
      for (const s of this.t.seats) if (s && s.awayAt) at = Math.min(at, s.awayAt + SEAT_HOLD_MS + 500);
      this.schedule(Math.max(at, Date.now() + 1000));
    }
    this.ctx.storage.put("table", this.t);
    const state = this.publicState();
    for (const ws of this.ctx.getWebSockets()) this.sendState(ws, state);
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  error(ws, msg) {
    this.send(ws, { type: "error", msg });
  }

  sendState(ws, state) {
    const att = ws.deserializeAttachment() || {};
    const p = att.pid ? this.players.get(att.pid) : null;
    const me = p
      ? { id: p.id, name: p.name, bankroll: p.bankroll, rounds: p.rounds, plus: p.plus, even: p.even, minus: p.minus, net: p.net }
      : null;
    this.send(ws, { type: "state", state: state || this.publicState(), me });
  }

  publicState() {
    const t = this.t;
    const hideHole = t.hole && t.dealer.length > 1;
    const dealerCards = t.dealer.map((c, i) => (i === 1 && hideHole ? null : c));
    let dealer;
    if (t.dealer.length === 0) dealer = { cards: [], total: null };
    else if (hideHole) dealer = { cards: dealerCards, total: rankValue(t.dealer[0].r) };
    else {
      const ev = evaluate(t.dealer);
      dealer = { cards: dealerCards, total: ev.total, soft: ev.soft, bj: ev.bj, bust: ev.bust };
    }
    let actions = null;
    if (t.phase === "playing" && t.turn) {
      const seat = t.seats[t.turn.seat];
      const hand = seat.hands[t.turn.hand];
      const p = this.players.get(seat.pid);
      actions = {
        double: this.canDouble(hand, p),
        split: this.canSplit(seat, hand, p),
        surrender: this.canSurrender(seat, hand)
      };
    }
    return {
      phase: t.phase,
      deadline: t.deadline,
      now: Date.now(),
      roundNo: t.roundNo,
      message: t.message,
      house: t.house,
      turn: t.turn,
      actions,
      dealer,
      seats: t.seats.map((s, i) => {
        if (!s) return null;
        const p = this.players.get(s.pid);
        return {
          pid: s.pid,
          name: p.name,
          bankroll: p.bankroll,
          bet: s.bet,
          ready: s.ready,
          sitOut: s.sitOut,
          leaving: s.leaving,
          away: !!s.awayAt,
          ins: s.ins,
          inRound: t.included.includes(i),
          hands: s.hands.map((h) => {
            const ev = evaluate(h.cards);
            return {
              cards: h.cards,
              bet: h.bet,
              done: h.done,
              doubled: h.doubled,
              result: h.result,
              label: h.label,
              total: ev.total,
              soft: ev.soft,
              bj: ev.bj && s.hands.length === 1,
              bust: ev.bust
            };
          })
        };
      })
    };
  }

  statsPayload() {
    const players = [...this.players.values()]
      .filter((p) => p.rounds > 0 || p.deposited > 0)
      .map((p) => ({
        name: p.name,
        rounds: p.rounds,
        plus: p.plus,
        even: p.even,
        minus: p.minus,
        net: p.net,
        bankroll: p.bankroll,
        deposited: p.deposited,
        best: p.best,
        worst: p.worst,
        recent: p.recent
      }));
    return { type: "stats", players, log: this.log, house: this.t.house, roundNo: this.t.roundNo };
  }
}
