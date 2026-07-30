# apollo-auto-punch

> [English](README.md) ・ **繁體中文**

一個透過 GPS `/locate` 端點（以「位置」而非「IP」驗證）替你打卡進／出 Apollo XE
（MayoHR）的工具。它的核心會登入、讀取當天的 Mayo 班表並打卡。**你用 CLI
（`npm run punch in|out`）手動操作它 — 這才是本專案的主體。** 而那個選用、輕薄的
**Cloudflare Worker** 才是負責「自動化」的部分：它依你的班表在對的時間自動打卡進／出、
完全不用你動手（進／出的方向由當下時間決定，時機則取自班表的開始／結束時間）。
CLI 以 exit code 回報結果；Worker 則以「失敗的 cron 執行」在 Cloudflare 上標記錯誤。

## 運作方式

核心流程是 **登入 → 讀取當天班表 → 打卡**。手動執行時，CLI 就是照這個流程即時打卡。
自動執行時，選用的 Worker 會在同一套核心外面包上 cron 的時間控制：

```
登入 → 讀取當天班表 → 上班日？ ──否─→ 略過（週末／假日）
                          │是
                          ▼
                 請整天假？ ──(RESPECT_LEAVE=true)─→ 略過
                          │ 預設：否
                          ▼
         上班打卡 = 班表開始 − (緩衝 + 隨機提早)   → 一律「提早」
         下班打卡 = 班表結束 + 隨機延後             → 一律「延後」
         每次打卡：辦公室 GPS 座標 + 小幅隨機抖動，並以伺服器回應
         （AttendanceHistoryId）驗證是否成功。
```

- **無狀態（Stateless）— 不用 KV。** Worker 不保留任何狀態。以 MayoHR 為唯一真實來源：
  重複打卡會回 `already_done`（今天已打過）或 `cooldown`（10 分鐘內剛打過），兩者
  Worker 都視為「已完成」而保持安靜。因此 cron 每 5 分鐘觸發一次也很安全。
- **反應緩衝（Reaction buffer）：** 上班打卡會在班表開始前至少 `REACTION_BUFFER_MIN`
  分鐘嘗試，這樣萬一真的失敗，你會在還有時間手動打卡時就發現（一次失敗的執行／
  exit code）。
- 班表時間來自 Mayo 的行事曆，所以彈性／變動班表也能自動適用。

> **注意。** 貴公司對*網頁版*打卡有 IP 限制（僅限辦公室／VPN）。本工具改用 *GPS*
> 打卡，從雲端伺服器送出你的辦公室座標，刻意繞過「僅限辦公室」的管控。執行前請先
> 確認這在你雇主的政策範圍內、你能接受再使用。

## 安裝設定

```bash
npm install
```

1. **憑證** — 用環境變數（`export`）或 config CLI（會寫入被 gitignore 的 `.dev.vars`）：
   ```bash
   export MAYO_USERNAME=you@company.com MAYO_PASSWORD=…    # 或：
   npm run config set username you@company.com
   npm run config set password            # 會提示輸入、不回顯 — 不會進 argv／shell 歷史
   ```
   優先順序為 **環境變數 > `.dev.vars` > 程式預設值**，所以 `export` 會覆蓋檔案。
   密碼絕不透過命令列參數傳入（那會外洩到 shell 歷史／`ps`）。

2. **選擇打卡地點**（要回報哪個辦公室）：
   ```bash
   npm run config set location            # 不帶 id → 列出你的辦公室，再帶 id 重跑：
   npm run config set location 0e7d3f49-1fe5-49ef-aeb7-e54d4c434ab1
   ```
   **地點 id 與 GPS 座標必須是同一個辦公室** — 打卡會同時送出兩者，不一致可能觸發
   辦公室的地理圍欄（geofence）而被拒。所以要一併設定對應的 `pos`：
   ```bash
   npm run config set pos 25.0781415 121.5703676   # 該辦公室的真實座標
   ```
   預設已把 L001 台北辦公室（`0e7d3f49…`）與上面的台北座標配好，所以若你在台北打卡
   可略過此步。執行 `npm run config` 可查看目前生效的設定（密碼會遮蔽）。

3. **（選用）設定部署用的 secrets** — 只有在你要跑 Worker 時才需要（與 `.dev.vars` 分開；切勿 commit）：
   ```bash
   npx wrangler secret put MAYO_USERNAME     # 你的登入 email
   npx wrangler secret put MAYO_PASSWORD
   ```

4. **本機驗證：**
   ```bash
   npm test          # 單元測試
   npm run typecheck # tsc
   npm run punch in  # 選用：一次真實的上班打卡（或用 DRY_RUN=true 做空跑）
   ```

   `npm run punch` 會從本機 `calendar-cache.json` 讀取班表，而不是每次都打行事曆 API。
   當檔案不存在、超過 7 天、或未涵蓋今天時會自動更新（快取當月＋次月）。此檔被
   gitignore（是你的個人班表）且可讀 — 打開它即可核對你接下來的班。

### 快取與開關

`punch` 執行的是共用核心 `src/flow.runPunch`（Agent 也能直接呼叫）。有兩個各自獨立、
預設都**開啟**的開關，可用 `config`（或環境變數 `CALENDAR_CHECK` / `SESSION_CACHE`）設定：

- `npm run config set calendar on|off` — 打卡前是否先檢查當天班表（上班日守門）。
- `npm run config set session on|off` — 是否重用約 10 天效期的登入 cookie（使用前會先驗證），
  或每次重新登入。
- `npm run punch in -- --force`（`-f`）— 這一次略過班表檢查。（`--` 是必要的，讓 npm 把
  旗標轉交給腳本）
- `npm run config` 會顯示生效設定、兩個開關狀態，密碼遮蔽。

登入 cookie 存放在被 gitignore 的 `session-cache.json`（權限 600）；跨次重用、並以一個
輕量請求先驗證，因此一個被撤銷的 cookie 不會弄壞打卡。

**回報訊號（Signals）。** `npm run punch` 的 exit code：`0`（成功／already_done／cooldown／
略過）、`1`（打卡被拒 — 會印出原因）、`2`（用法錯誤）、`3`（無法執行 — 登入／行事曆／
網路）。加上 `-- --json` 可額外印一行機器可讀的摘要。Worker 不寄 email；打卡失敗會
**throw**，把該次 cron 執行標記為失敗（顯示在 Cloudflare 主控台 / `wrangler tail`）—
若想收到通知，可自行設定 Cloudflare Notification。

## 安全上線

`wrangler.toml` 預設 `DRY_RUN = "true"` — Worker 會跑完整流程（登入、行事曆、規劃）但
**不會真的打卡**。

```bash
npx wrangler deploy
npx wrangler tail          # 觀察真實的早上／傍晚時段
```
確認規劃正確（DRY_RUN 執行會把打卡記錄印在 `wrangler tail`）。接著切成正式：

```toml
# wrangler.toml
DRY_RUN = "false"
```
```bash
npx wrangler deploy
```
透過 `wrangler tail` 觀察第一個真實上班日，確認 `wrangler tail` 顯示 Mayo 記錄的時間，
並到 Apollo 檢查剛好一進一出。

> 因為無狀態，每次 cron 觸發都會重新登入＋讀行事曆（兩個時段合計約每天最多 ~48 次登入）。
> 這是「不用 KV」的代價。若想減少，可把 `wrangler.toml` 的 `crons` 時窗縮到你班表附近。

**選用 — 用 KV 跨次快取。** 綁定一個 KV namespace，Worker 就會重用登入 cookie（約每 9 天
才登入 1 次，而非每天 ~48 次）與行事曆，用的是與 CLI 相同的 `runPunch` 元件：
```bash
npx wrangler kv namespace create APOLLO_KV
# 把印出的 id 貼進 wrangler.toml 的 [[kv_namespaces]] 區塊（取消註解）
npx wrangler deploy
```
不綁定時，Worker 維持無狀態（現行行為）— 無論如何，伺服器端的冪等性都能防止重複打卡。

## 設定項（除 secrets 外皆為選用）

| 變數 | 預設 | 意義 |
|-----|---------|---------|
| `TIMEZONE` | `Asia/Taipei` | 班表時間的時區 |
| `PUNCH_LATITUDE` / `PUNCH_LONGITUDE` | 台北辦公室 | 回報的座標 |
| `PUNCHES_LOCATION_ID` | `0e7d3f49…`（台北辦公室） | 辦公室地點 id |
| `GPS_JITTER_METERS` | `12` | 每次打卡的隨機位移半徑 |
| `PUNCH_EARLY_IN_MIN` / `_MAX` | `1` / `15` | 提早分鐘數（在緩衝之上） |
| `PUNCH_LATE_OUT_MIN` / `_MAX` | `1` / `15` | 下班延後分鐘數 |
| `REACTION_BUFFER_MIN` | `10` | 至少在班表前這麼多分鐘打卡（讓失敗的執行有時間手動補打） |
| `RESPECT_LEAVE` | `false` | `true` = 略過整天請假的日子 |
| `DRY_RUN` | `true` | 跑完整流程但絕不真的打卡 |

## 專案結構

- `src/` — `config`、`auth`、`calendar`、`punch`、`locations`、`time`、
  `calendar-cache`、`session-cache`（使用前先驗證的 cookie 快取）、
  `cache-store`（共用的 `CacheStore`）、`flow`（`runPunch`/`acquireSession`/`getDay` —
  可重用核心）、`kv-store`（給 Worker 的 KV `CacheStore`）、`scheduler` + `index`（Worker）。
- `scripts/` — 本機 CLI 工具，建構在與 Worker **相同的 `src/` 模組**上（所以不會與部署
  行為分歧）：`punch-now.ts`（手動打卡進／出）、`config-cli.ts`（`npm run config` /
  `config set` — 寫入 `.dev.vars`，`set location` 可列出地點）、`dev-vars.ts`（純粹的
  `.dev.vars` 編輯）+ `cache-fs.ts`（檔案式快取儲存）、`_env.ts`（共用的 `.dev.vars` +
  設定啟動；`APOLLO_DEV_VARS` 可覆蓋檔案路徑）。
- `docs/` — 設計規格、實作計畫，以及已驗證的 API 事實。
