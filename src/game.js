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
