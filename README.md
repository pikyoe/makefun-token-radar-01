# Token Radar

A token launch radar: it reads a sealed DefiLlama protocol snapshot, ranks the
protocols that record no token by an implied value, and shows a reader how to
farm each one. Built for the make.fun token-radar-01 competition.

## What it does

`main.ts` (Node 22, standard library only) reads the snapshot at
`/input/snapshot.json` (or `--input <snapshot.json|directory>`), scores every
pre-token protocol with the radar-2 model in `lib/model.ts`, and writes:

- `/output/board.json` — the ranked board (200 rows: the 40-protocol watchlist
  plus 160 early pre-token protocols below the $50M floor, ranked 1..200)
- `/output/data.js` — the same board, compact, for the dashboard
- `/output/dashboard/` — the static dashboard (board, per-protocol detail,
  filters, live-token view, model explainer)
- `/output/screenshots/` — three screenshots of the dashboard
- `/output/dossier.json` — the dossier the judge reads, built by
  `vendor/makefun-board.ts`

## The model (radar-2)

```
implied = round( tvl_usd x 0.30
  x (1 + clamp(change_7d, -50, 150) / 100 x 1.0)
  x (0.5 + min(age_days, 1460) / 1460 x 0.5)
  x (1 + 0.02 x min(chains, 5)) )
```

TVL, seven-day growth, age since first listing with no token recorded, and
chain breadth — all from the snapshot's own figures. No protocol name is
special-cased. Live-token protocols are kept out of the board and shown
separately with their market caps.

## How to run it

```sh
mkdir -p out out2
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
MAKEFUN_OUTPUT_DIR=out2 node main.ts --input /path/to/snapshot.json
cmp out/board.json out2/board.json && cmp out/dossier.json out2/dossier.json
```

Both runs must write identical bytes. Open `out/dashboard/index.html` in a
browser to see the dashboard (it reads `out/data.js`, no network).
