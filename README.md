# Blackjack v3

Wieloosobowy blackjack na telefon: jeden wspólny stół (6 miejsc, but z 6 talii),
działający na Cloudflare Workers + Durable Objects.

- `src/worker.js` – punkt wejścia: `/ws` (gra), `/admin`, `/logs`, reszta to pliki z `public/`
- `src/table.js` – stół (Durable Object): rundy, zakłady, ubezpieczenie, split, double, surrender, statystyki
- `src/game.js` – talia, tasowanie, liczenie punktów
- `public/` – strona gry (HTML/CSS/JS)

## Uruchomienie lokalnie

```
npm install
npm run dev
```

Gra będzie pod http://localhost:8787.

## Wdrożenie na Cloudflare

**Automatycznie z GitHuba (zalecane):** w panelu Cloudflare → Workers & Pages → Create →
Import a repository → wybierz to repo → Deploy. Każdy push na `main` wdraża się sam.
Adres: `https://blackjack-v3.<twoja-subdomena>.workers.dev`.

**Ręcznie:** `npx wrangler login`, potem `npm run deploy`.

## Panel administracyjny

Ustaw sekret `ADMIN_KEY` (Cloudflare → Worker → Settings → Variables and Secrets,
albo `npx wrangler secret put ADMIN_KEY`). Potem:

- `/admin?key=TWOJ_KLUCZ` – zerowanie statystyk lub wszystkich graczy
- `/logs?key=TWOJ_KLUCZ` – dziennik błędów serwera i telefonów graczy
