# Raddartest

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/yuyun56/Raddartest/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/yuyun56/Raddartest/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar built from the sealed DefiLlama snapshot (as of 2026-11-14). It finds the protocols that record no token yet — excluding wrapped, staked and restaked products of tokens that already trade — and ranks them by implied launch value.

The board carries 178 protocols: the full 40-protocol watchlist (TVL at or above $50M) plus 138 early candidates below that floor that pass the same product screens. Together they imply about $3.01B of launch value; the watchlist alone implies about $2.53B.

How a value is derived (model `radar-ember-2`, in `lib/model.ts`): implied value = TVL × a category multiple × a 7-day growth factor × a maturity factor × a chain-reach factor. The category multiple is the median market-cap/TVL ratio of live, already-traded protocols in the same category inside the same snapshot, shrunk toward the global median with a prior of 3 peers so thin categories stay honest, and clamped to [0.05, 3.0]. Every board row shows its full derivation, its rank inside its own category, and the live peers its multiple came from.

Every row also carries a 7-step farm plan written for that protocol: the cheapest chain it runs on (picked from a real per-chain cost table, not a guess), a position size tiered to its TVL, the points or season mechanics to join, and one step generated from the protocol's own record — momentum, caution, patience or multi-chain concentration, whichever its numbers call for.

The dashboard in `dashboard/` is fully static and renders offline: a sortable, filterable board (search, category, chain, TVL band, watchlist/early segment), a detail page per protocol with its value waterfall and category standing, a view of the largest already-traded protocols that were set aside, and a method page that shows the formula and every category multiple, raw and after shrinkage.

## Run it

```sh
# Node 22+ (standard library only). Expects the competition snapshot at
# /input/snapshot.json; writes board.json, data.js, dashboard/, screenshots/
# and dossier.json to /output. Two runs produce byte-identical output.
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=sz67g615&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
