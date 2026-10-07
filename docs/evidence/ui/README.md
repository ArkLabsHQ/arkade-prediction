# Browser run against regtest (2026-10-07, 19:46–19:58 UTC)

Built UI served by the real server (`node --env-file=.tmp/app.env --import tsx src/server/main.ts`) on the
isolated `apm-regtest` stack, driven through Playwright. Every money movement below is a real Arkade tx.

| Step | Who signs | Tx |
|---|---|---|
| Create wallet (12 words, confirm 3, encrypt), dev faucet 100,000 sats | operator wallet (server) | `1fd325ee…6f03f2` |
| Create custom market: issue CTRL/YES/NO | browser | `44c714fd…b7b3ca` |
| Open vault (2,000 sats, 1 seed set); server audits genesis and lists it | browser | `cf396f88…523e2c` |
| LP liquidity via `POST /api/admin/markets/:id/liquidity` (5 sets, asks YES 650 / NO 450) | LP wallet via keeper workflow | — |
| Buy 2 YES @650 into an auto-claim box | browser | `52afd497…ebf87e` |
| Post ask 1 NO @480, then cancel (maker + operator leaf) | browser | `712214e0…c44e1b`, `aed56877…a316da` |
| Resolve YES with the creator's oracle key after close | browser | `6936823d…c64073` |
| Keeper auto-claims the box (browser idle) | nobody (covenant) | `ee355c39…` |
| Redeem remaining 1 YES + 1 NO for 1,000 sats | browser | `844c743d…5be54e` |

Balance check: 100,000 − 2,000 − 1,300 − 330 + 2,330 + 1,000 = 99,700 sats, as displayed. Console errors: 0.
Screenshots: `market-after-trade.png`, `portfolio-after-resolution.png`.
