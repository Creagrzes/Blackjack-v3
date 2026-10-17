// Talia, tasowanie i liczenie punktów ręki.

export const SUITS = ["♠", "♣", "♥", "♦"];
export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const NUM_DECKS = 6;

export function rankValue(rank) {
  if (rank === "A") return 11;
  if (rank === "J" || rank === "Q" || rank === "K") return 10;
  return parseInt(rank, 10);
}

// Losowa liczba 0..n-1 bez przekłamania modulo.
function randInt(n) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(4294967296 / n) * n;
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % n;
}

export function newShoe() {
  const cards = [];
  for (let d = 0; d < NUM_DECKS; d++) {
    for (const s of SUITS) {
      for (const r of RANKS) cards.push({ r, s });
    }
  }
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function evaluate(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    total += rankValue(c.r);
    if (c.r === "A") aces++;
  }
  let softAces = aces;
  while (total > 21 && softAces > 0) {
    total -= 10;
    softAces--;
  }
  return {
    total,
    soft: softAces > 0 && total <= 21,
    bj: cards.length === 2 && total === 21,
    bust: total > 21
  };
}

// ---------------------------------------------------------------------------
// Zakłady poboczne – rozliczane od razu po rozdaniu
// ---------------------------------------------------------------------------

const isRed = (s) => s === "♥" || s === "♦";

// Perfect Pairs: dwie pierwsze karty gracza tej samej rangi.
export function perfectPairs(a, b) {
  if (a.r !== b.r) return null;
  if (a.s === b.s) return { mult: 25, label: "Idealna para" };
  if (isRed(a.s) === isRed(b.s)) return { mult: 12, label: "Para w kolorze" };
  return { mult: 6, label: "Mieszana para" };
}

// 21+3: dwie karty gracza i odkryta karta krupiera jako układ pokerowy.
export function twentyOnePlusThree(cards) {
  const idx = cards.map((c) => RANKS.indexOf(c.r)).sort((x, y) => x - y);
  const flush = cards.every((c) => c.s === cards[0].s);
  const trips = cards.every((c) => c.r === cards[0].r);
  // As może być na górze (Q-K-A) albo na dole (A-2-3).
  const straight = (idx[0] + 1 === idx[1] && idx[1] + 1 === idx[2]) || (idx[0] === 0 && idx[1] === 1 && idx[2] === 12);
  if (trips && flush) return { mult: 100, label: "Trójka w kolorze" };
  if (straight && flush) return { mult: 40, label: "Poker" };
  if (trips) return { mult: 30, label: "Trójka" };
  if (straight) return { mult: 10, label: "Strit" };
  if (flush) return { mult: 5, label: "Kolor" };
  return null;
}
