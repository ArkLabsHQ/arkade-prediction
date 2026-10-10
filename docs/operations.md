# Operations runbook

Test funds only. Mutinynet steps below were checked read-only (preflight); no transaction has been sent there.

## Components

| Process | Image command | Volume | Port | Secrets |
|---|---|---|---|---|
| `app`: UI, API, SSE, single-writer keeper/importer/resolver | `node dist/server/main.js` | `apm-data:/data` (`/data/apm.sqlite`, `/data/backups/`) | 37400 | operator + LP mnemonics, admin token |
| `oracle`: attestor | `node dist/oracle/main.js` | `apm-oracle:/data` (`attestations.jsonl`) | 37410 (internal) | attestor key |

Both run from one image. The attestor should run on separate infrastructure in production so that the app
operator cannot sign outcomes; compose co-locates them for convenience.

## Local regtest (one command)

Requires Docker, Node >= 22.12 and pnpm 10.

```sh
git submodule update --init regtest
pnpm install
node scripts/regtest.mjs up      # isolated arkade-regtest stack (project apm-regtest, ports 37xxx) + app + attestor
node scripts/regtest.mjs demo    # deterministic demo against the running app; prints DEMO OK
node scripts/regtest.mjs test    # typecheck, unit tests, fill-planner check, regtest e2e suite
node scripts/regtest.mjs down    # stops containers; volumes are kept
```

`up` generates `.env.regtest` with fresh regtest-only secrets on first run. UI: http://localhost:37400.
Opt-in suites: `LIVE_POLYMARKET=1` (live Polymarket + Polygon reads) and `DOCKER_E2E=1` (image recreate,
backup and restore), both run through `pnpm exec vitest run --config vitest.e2e.config.ts <file>`.
Never run the stack's `clean --prune` on a shared Docker host.

The stack mines blocks only on demand. Until blocks advance the median time past a batch's expiry, arkd's sweeper
cannot reclaim the batch and its liquidity stays locked; after enough batches, new ones (renewals, note
redemptions) stall with `not enough liquidity` in the arkd log. The e2e suite mines 12 blocks before it starts;
on a long-lived stack run `node regtest/regtest.mjs mine 12 --env infra/regtest/stack.env` now and then.

## Build

```sh
docker build -t arkade-prediction:local .
ARKADEC=<path to arkadec @ e9703e7> node contracts/build.mjs --check   # committed artifacts match sources
```

The build copies only `package.json`, the lockfile, `tsconfig.json`, Vite config, `index.html`,
`contracts/artifacts` and `src`; `.dockerignore` keeps `.env*`, data and test material out of the context.
Secrets are runtime-only (environment or `*_FILE`); there are no build arguments.

## Mutinynet preflight (read-only)

```sh
node --env-file=.env.mutinynet.example --import tsx scripts/preflight.ts
```

Checks the live operator and emulator keys (against pins if you set any, else the emulator against the SDK's
network pin), the exit delay, fees and tx limits, template sizes,
Esplora, two Polygon `finalized` providers and the Polymarket Gamma API. Exit code 0 only when every check passes.
Last run: `docs/evidence/mutinynet-preflight.txt` (18/18 PASS, 2026-10-08). Re-run before every deployment:
a changed operator or emulator key means new contract scripts.

## Deploy on Dokploy

On Mutinynet no endpoint or key settings are needed: the Ark server and emulator URLs default to Arkade's published
hosts, Esplora to the SDK's, the operator key is read from the Ark server and the emulator key is the SDK's network
pin. Set `ARK_SERVER_URL`/`EMULATOR_URL`/`ESPLORA_URL` or `ARK_SIGNER_PUBKEY`/`EMULATOR_PUBKEY` only to override
or pin them. The first start records the keys in the volume and refuses to start if they later change.

### Simplest: one Dokploy Application (Dockerfile build)

One container runs the UI/API, the keeper and a local 1-of-1 attestor (started by the app when
`ORACLE_SECRET_KEY` is set; it listens on 127.0.0.1 only).

1. **Generate secrets** on your machine:
   ```sh
   node --input-type=module -e "import {generateMnemonic} from '@scure/bip39'; import {wordlist} from '@scure/bip39/wordlists/english.js'; console.log(generateMnemonic(wordlist))"   # run twice: OPERATOR_MNEMONIC, LP_MNEMONIC
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"   # ORACLE_SECRET_KEY
   ```
2. **Create an Application** from the repository, build type Dockerfile, default command.
3. **Environment:** `APM_NETWORK=mutinynet`, the three secrets above, and the rest of `.env.mutinynet.example`
   (plain values; endpoints, keys, attestor URL and key all default).
4. **Volume:** Advanced → Mounts, a named volume at `/data` (database, backups, attestor log).
5. **Domains:** public domain on container port `37400`. The operator console and `/api/admin` are on port
   `37401` with no authentication: give it a separate domain behind your edge access control, or none.
6. **Deploy** and check `GET /api/health/ready`.
7. **Fund** the operator and LP addresses shown in the admin console (`/api/admin/overview` on 37401) with
   Mutinynet test sats: per imported market the operator locks `MARKET_BASE_SATS` + one seed set + carriers;
   the LP locks `LP_BOOTSTRAP_SETS x MARKET_UNIT_SATS` + carriers, and with `LP_BID_SETS` set,
   `LP_BID_SETS x bid price` + a 330-sat reserve per outcome. With `LP_MAX_SETS_PER_MARKET` above
   `LP_BOOTSTRAP_SETS`, a sold-out ask is refilled until the LP has minted that many sets on the market;
   the worst-case loss per market is about `LP_MAX_SETS_PER_MARKET x MARKET_UNIT_SATS`.

Not yet executed on Mutinynet: steps 6 to 8 (no hosted deployment has been made).

### Separate attestors (Dokploy Applications)

For attestors outside the app container (needed for k-of-n), one Application per process, all built from the same repository and `Dockerfile`:

- **app**: default command. Environment tab takes plain values (no `${VAR}` indirection). Advanced → Mounts:
  a named volume at `/data`, and file mounts at `/run/secrets/<name>` for the `*_FILE` secrets. Domain on
  container port `37400`. One replica: a second one only waits for the writer lease.
- **attestor** (one Application per attestor key): command override `node dist/oracle/main.js`, its own volume
  at `/data`, `ORACLE_SECRET_KEY_FILE`, `ORACLE_PORT=37410`, `APM_NETWORK`,
  `POLYGON_RPC_URLS`, `POLYMARKET_RESOLVERS` (and `POLYMARKET_CREATORS` / `POLYMARKET_NEGRISK_ORACLES` only to
  override their built-in defaults). No public domain needed; set the app's `ORACLE_URLS` to the
  attestors' internal addresses, `ORACLE_PUBKEYS` to their keys and `ORACLE_THRESHOLD` (2 with three attestors).

Dokploy applies an Application's command field as the container command (split on spaces) and attaches
Applications to `dokploy-network` unless "detach" is set; services are named by their App Name, so the attestor
is reachable as `http://<attestor App Name>:37410` (Swarm service DNS; not yet exercised on a live Dokploy host).

## Health and monitoring

- `GET /api/health/live`: process up (container healthcheck; never restarts the writer for a slow dependency).
- `GET /api/health/ready`: database, arkd, emulator, attestor and writer lease.
- `GET /api/admin/overview`: process metrics, import lag, markets waiting for the oracle, failed / in-flight /
  pending workflows, open liquidity, nearest VTXO expiries, wallet balances.
- Logs are JSON lines on stdout; configuration is logged with secrets redacted.

Act on: failed workflows, expiries closer than `RENEW_THRESHOLD_SECONDS`, and markets past close without a
certificate. A workflow fails after 8 attempts or a permanent error. Workflows the keeper plans from current state
(resolve, timeout, activate, renew, settle, match, cancel, auto-claim) are re-armed automatically after a cooldown that grows
from 2 minutes to an hour, keeping their recorded progress. LP liquidity workflows are not re-planned:
retry them with `POST /api/admin/workflows/<id>/retry`.

A market whose source resolves before its close shows `halted`: the app stops trading it, the keeper cancels the
LP's offers, and other makers see a notice to cancel theirs. LP offers always expire at the market's close.

## Backup and restore

```sh
curl -X POST https://<admin host>/api/admin/backup   # -> {"path":"/data/backups/apm-<time>.sqlite"}
```

`VACUUM INTO` writes a consistent snapshot while the server runs. Copy it off the host (`docker cp`) or use
Dokploy volume backups (named volumes only). Restore:

```sh
docker compose stop app
docker run --rm -v <project>_apm-data:/data --entrypoint sh arkade-prediction:local \
  -c "cp /data/backups/<file>.sqlite /data/apm.sqlite && rm -f /data/apm.sqlite-wal /data/apm.sqlite-shm"
docker compose start app
```

After restart the keeper re-reads offers and vaults from the indexer, so fills and vault balances that happened
after the backup are reconciled (tested: `docker-redeploy.test.ts`). Anything first recorded after the backup is
not rediscovered:

- Custom markets, offers and claim boxes registered after the backup: their creators or makers must register them
  again through the API (`POST /api/markets`, `/api/offers`, `/api/boxes`).
- Imported markets activated after the backup cannot be re-registered. The importer may mirror the same source
  market again under new asset ids, and the orphaned vault is not renewed, so after its batch expires it is
  recoverable only through the operator.

Restore is therefore for database corruption, not a routine rollback. Take a backup after activations and before
upgrades, and restore the newest one.

## Upgrades

Deploy a new image on the same volume. Migrations run forward at startup; downgrades are not supported
(restore a backup instead). `stop_grace_period: 30s` lets the keeper finish its tick and release the writer
lease; a second instance on the same volume waits for the lease instead of writing. The holder renews the lease
every 5 s on its own timer, so a long keeper tick does not let a second instance take over.

## Changing network, operator, emulator or attestor

Covenant scripts commit to the operator key, the emulator key and the attestor key, so these are not settings
that can be edited in place. The server refuses to start when the volume's recorded identity differs.

1. Set `POLYMARKET_ENABLED=false` and stop admitting custom markets.
2. Let open markets resolve or time out, and let holders redeem; makers cancel offers.
3. Start a new deployment (`APM_DEPLOYMENT_ID`, new volume) against the new endpoints.

Attestors: `ORACLE_PUBKEYS` (1 to 3 keys) and `ORACLE_THRESHOLD` are committed into each imported market at
activation; `ORACLE_URLS` (plus `ORACLE_URL`) lists where the resolver asks for certificates. Run each attestor on
separate infrastructure; `compose.attestors.yaml` adds two local ones for testing. Key rotation for live markets is
not implemented: each market keeps the set current at its activation, so keep those attestors reachable until it
resolves.

## Limits

| Limit | Value | Where |
|---|---|---|
| Writers | one process per volume (lease) | `src/server/lease.ts` |
| Store | SQLite on a local volume | `src/server/db.ts` |
| Per-market write rate | ~1.7 tx/s on the test host | `docs/performance.md` |
| Covenant VTXOs per renewal workflow | 32 | `src/server/keeper.ts` |
| Imported markets | `IMPORT_MAX_ACTIVE` | `src/server/importer.ts` |
| Collateral per market | `MARKET_CAP_SETS` complete sets (enforced on-contract) | `contracts/src/market_vault.ark` |

Migration path beyond one host: Postgres store with leader election for the writer; API-only replicas
(`WORKERS=none`); per-market sharding of the keeper.
