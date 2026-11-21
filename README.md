# Japan Port Container Volumes — Weekly (MLIT)

Weekly **foreign-trade container volumes (TEU)** at Japan's six major ports — **Tokyo, Kawasaki, Yokohama, Nagoya, Osaka, Kobe** — from the Ministry of Land, Infrastructure, Transport and Tourism (国土交通省「外貿コンテナ数（週次）」), as clean JSON: total, export and import TEU with week-on-week, month-on-month (same week) and year-on-year ratios.

MLIT publishes these figures weekly, much earlier than the monthly port statistics — a timely indicator of Japan's trade and logistics activity.

## Use cases

- **Shippers, forwarders and carriers:** track export/import demand per port week by week
- **Market & macro research:** an early, high-frequency proxy for Japan's foreign trade
- **Logistics dashboards and AI agents:** "how did container imports at Tokyo change last week?"

## Input examples

All ports, latest week plus the recent archive (default):

```json
{}
```

Exports at Yokohama and Kobe only:

```json
{ "ports": ["Yokohama", "Kobe"], "flows": ["export"] }
```

Weekly monitoring (schedule after MLIT's weekly update):

```json
{ "onlyNew": true, "stateKey": "weekly" }
```

## Output example

```json
{
  "weekStart": "2026-11-02",
  "weekEnd": "2026-11-08",
  "aggregatedOn": "2026-11-20",
  "port": "Tokyo",
  "portJa": "東京港",
  "flow": "total",
  "teu": 90304.25,
  "vsPreviousWeekPct": 93.57,
  "vsSameWeekLastMonthPct": 100.83,
  "vsSameWeekLastYearPct": 100.42,
  "unit": "TEU",
  "sourceUrl": "https://www.mlit.go.jp/kowan/content/002047258.xlsx",
  "source": "Ministry of Land, Infrastructure, Transport and Tourism (MLIT), Japan — weekly foreign-trade container statistics"
}
```

- `teu` is twenty-foot equivalent units as published (fractions occur in MLIT's figures). The ratio fields are percentages where 100 = unchanged (e.g. 93.57 = 6.43% lower).
- `port: "Total (6 ports)"` is MLIT's total of the six ports.
- MLIT's page keeps the latest week and roughly the previous two months; older weeks are not available from this source.
- These are MLIT's preliminary weekly figures (empty containers included, as published). If MLIT changes the spreadsheet layout (headers, ports, cell types), the run fails with a clear message instead of returning wrong numbers.
- Monitoring mode: the first run returns everything in range as `new`. Do not run two schedules with the same `stateKey` at the same time; if a run fails after saving rows but before saving its state, the next run may return those rows again. Rows not saved because your pay-per-event spending limit was reached are returned by the next run.

## Data source & terms

Source: MLIT, 外貿コンテナ数（週次） ([page](https://www.mlit.go.jp/kowan/kowan_fr3_000045.html)). Content available under the Public Data License 1.0 ([MLIT terms](https://www.mlit.go.jp/link.html)). When you publish the data, credit the source and state that it was processed and by whom, e.g. 出典：国土交通省「外貿コンテナ数（週次）」（https://www.mlit.go.jp/kowan/kowan_fr3_000045.html）を〇〇が加工して作成. This Actor is not affiliated with or endorsed by MLIT.

---

## 日本語の概要

国土交通省が週次で公表する主要6港（東京・川崎・横浜・名古屋・大阪・神戸）の外貿コンテナ個数（TEU、合計・輸出・輸入、前週比・前月同週比・前年同週比）を JSON で取得します。監視モードでは新しい週と改訂だけを出力します。出典の明記など公共データ利用規約（第1.0版）に従ってご利用ください。
