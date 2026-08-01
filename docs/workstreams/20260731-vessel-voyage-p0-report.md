# P0 Vessel/Voyage Parser Delivery Report

## Conflict Risk

Conflict risk: the pre-write snapshot says `/opt/sanlyn-api-test/api/auth.js` and `/opt/sanlyn-api-test/routes-core.js` were modified within 12h. The local canonical checkout also has existing unrelated dirty files, including `server.js`. This P0 patch only adds new files and does not touch `server.js`, `routes-core.js`, `api/auth.js`, or `api/db/booking-collab.js`.

## Round 1 - Implementation

Added `api/db/lib/vessel-voyage-parse.js` as an ESM parser with:

- `parseVesselVoyage(raw)`
- `isVesselLike(raw)`
- `normalizeVessel(name)`

Added an append-only migration SQL file and a read-only dry-run script. The parser only returns a vessel/voyage pair when both the vessel shape and voyage shape are present; otherwise it returns `vessel=null`, `voyage=null`, `confidence=no_vessel`.

## Round 2 - 19 Sample Verification

The first test run caught a bug in `MSC VIGOUR IIIHU624A`: the last-token rule parsed `IIIHU624A` as the voyage. I moved the roman-tail boundary rule ahead of the last-token rule. A second run caught `III` being matched as `II`; I reordered roman numerals longest-first.

Actual local code output:

| raw | vessel | voyage | confidence | reason |
|---|---|---|---|---|
| SITC GUANGDONG/2612S | SITC GUANGDONG | 2612S | high | slash_delimited |
| CUL XIAMEN/2619E | CUL XIAMEN | 2619E | high | slash_delimited |
| SEASPAN YINGKOU/0837N | SEASPAN YINGKOU | 0837N | high | slash_delimited |
| SITC BATANGAS/2612S | SITC BATANGAS | 2612S | high | slash_delimited |
| MSC TAMPA V HB624A | MSC TAMPA V | HB624A | high | last_token_voyage |
| QD-BKI-EMC |  |  | no_vessel | route_code_not_vessel |
| QD-BKI-MSK |  |  | no_vessel | route_code_not_vessel |
| ELBA III -V.HV611A | ELBA III | HV611A | high | dash_v_noise |
| TIAN CHANG HE 113S | TIAN CHANG HE | 113S | high | last_token_voyage |
| EVER VIVE/0289-020S | EVER VIVE | 0289-020S | high | slash_delimited |
| TIAN CHANG HE/113S | TIAN CHANG HE | 113S | high | slash_delimited |
| SYNERGY BUSAN/607S | SYNERGY BUSAN | 607S | high | slash_delimited |
| TJ-PKW-TSL |  |  | no_vessel | route_code_not_vessel |
| ESL DANA/02545/W | ESL DANA | 02545/W | high | slash_delimited |
| MSC VIGOUR IIIHU624A | MSC VIGOUR III | HU624A | high | roman_tail_boundary |
| CNXMN-MYPKG |  |  | no_vessel | route_code_not_vessel |
| MSC CALIDRIS III / HU603A | MSC CALIDRIS III | HU603A | high | slash_delimited |
| GFS GALAXY /02604W | GFS GALAXY | 02604W | high | slash_delimited |
| FENGXINDA27 076S | FENGXINDA27 | 076S | high | last_token_voyage |

## Round 3 - Attack Tests

Added rejection tests for blank input, SVC codes (`NS5`, `KCM3`, `CSS3`, `BENGAL`), port-route codes (`CNXMN-MYPKG`, `XMN-PKW`), numeric noise (`USD 1000`, `7+7`), vessel-without-voyage, and non-numeric voyage-like tails. These all return `no_vessel`.

## Round 4 - Safety Checks

- Parser file length: 129 lines.
- Dry-run script length: 47 lines.
- Migration SQL only adds columns with `IF NOT EXISTS`.
- Dry-run script only has `SELECT route_code`; no write statements.
- `node tests/vessel-voyage-parse.test.mjs` passed.
- `git apply --check --cached /tmp/vessel-voyage-p0.patch` passed for the generated patch.
- `node scripts/freight-rates-vessel-voyage-dry-run.mjs` could not run here because the sandbox blocked DB access: `connect EPERM 127.0.0.1:5432`.
- `POST https://api.sanlyn.cn/api/db/auth-login` could not complete here: `curl: (7) Couldn't connect to server`.
- `ssh mini 'ssh tencent ...'` could not complete here: `Could not resolve hostname mini`.

## shipping-rate-intake Replacement Snippet

Replace the current `route_code` row:

```md
| `route_code` | text | 兼容保留字段：原始船名/航次文本，不作为规范锚点；新录入优先同时落 `vessel_name` + `voyage_no` |
| `vessel_name` | text | 规范船名，来自解析器 `parseVesselVoyage(raw).vessel`；解析不出留 null，不猜 |
| `voyage_no` | text | 规范航次，来自解析器 `parseVesselVoyage(raw).voyage`；解析不出留 null，不猜 |
| `vessel_parse_confidence` | text | `high` / `low` / `no_vessel`；缺船名不阻断录入，标 `no_vessel` 并进入“待补锚点”清单 |
```
