# apolloxe-mayohr-punch

> [English](README.en.md) ・ **繁體中文**

**懶人的福音，也是容易忘記打卡之人的福音。** 🕘

一個替你打卡進／出 Apollo XE（MayoHR）的小工具 — 讓你再也不用記得打卡。它的核心會
登入、讀取當天的 Mayo 班表，並透過 GPS `/locate` 端點打卡（以「位置」而非「IP」驗證）。
你用 CLI（`npm run punch in|out`）操作它。我們也附上一個選用、輕薄的 **Cloudflare Worker**
來做打卡進／出的自動化：依你的班表在對的時間自動打卡、完全不用你動手（方向由當下時間
決定，時機取自班表的開始／結束）。CLI 以 exit code 回報；Worker 則以「失敗的 cron 執行」
在 Cloudflare 上標記錯誤。

## 運作方式

手動執行時，CLI 就是「登入 → 讀班表 → 打卡」即時完成。自動執行時，Worker 是一個
**Durable Object**，用它的 `alarm()` 當精準計時器，只在幾個關鍵時刻醒來：

```
🌙 00:05  讀當天班表                    ← MayoHR 第 1 次
          擲出隨機打卡時間，例如 進 09:13:47、出 18:41:12
          （偏移「連秒」只擲一次，然後凍結）
          存起來、設定 alarm、睡覺…

⏰ 09:13:47  醒來 → 打卡進              ← MayoHR 第 2 次   → 設 alarm 給下班
⏰ 18:41:12  醒來 → 打卡出              ← MayoHR 第 3 次   → 設 alarm 給明天
```

- **一個 Durable Object，用 alarm 驅動。** 不輪詢、不用 KV、不用 Workflow。DO 自己的
  儲存存 cookie、行事曆與當日計畫；alarm 一天叫醒它 **約 3 次** — 剛好在每個打卡時間。
  時間取自*實際*行事曆，所以**任何班表都能運作**；而且 alarm 在精準時刻觸發，隨機打卡
  時間可精準到**秒**，看起來像真人、不會落在死板的整點格線上。
- **對 MayoHR 很溫和 — 一天約打 3 次**（行事曆、進、出）；登入沿用儲存的 cookie。每天一次的
  cron 只是備援，必要時重新替 DO 設定 alarm。
- **冪等（Idempotent）。** MayoHR 仍是唯一真實來源：重複打卡回 `already_done` 或
  `cooldown`，兩者都當「已完成」，所以不會重複打卡。
- **反應緩衝（Reaction buffer）：** 上班打卡目標在班表開始前至少 `REACTION_BUFFER_MIN`
  分鐘，這樣萬一真的失敗，你會在還有時間手動打卡時就發現（一次失敗的執行）。

> **注意。** 貴公司對*網頁版*打卡有 IP 限制（僅限辦公室／VPN）。本工具改用 *GPS*
> 打卡，從雲端伺服器送出你的辦公室座標，刻意繞過「僅限辦公室」的管控。執行前請先
> 確認這在你雇主的政策範圍內、你能接受再使用。

## 安裝設定

```bash
npm install
```

1. **憑證。** 所有非機密設定都放在 **`wrangler.toml [vars]`**（唯一來源，與 Worker 共用）；
   只有**密碼**放在被 gitignore 的 **`.dev.vars`**。用 config CLI 設定：
   ```bash
   npm run config set username you@company.com    # → wrangler.toml [vars]
   npm run config set password                    # → .dev.vars（提示輸入、不回顯）
   ```
   優先順序為 **環境變數 > `.dev.vars` > `wrangler.toml [vars]` > 程式預設值**，所以 `export`
   會覆蓋兩個檔案。密碼絕不透過命令列參數傳入（會外洩到 shell 歷史／`ps`），也絕不放進
   `wrangler.toml` — 因為 `wrangler deploy` 會把 `[vars]` 以明文上傳。

2. **選擇打卡地點**（要回報哪個辦公室）：
   ```bash
   npm run config set location                    # 不帶 id → 列出你的辦公室，再帶 id 重跑：
   npm run config set location <PunchesLocationId>
   ```
   **地點 id 與 GPS 座標必須是同一個辦公室** — 打卡會同時送出兩者，不一致可能觸發
   辦公室的地理圍欄（geofence）而被拒。所以要一併設定對應的 `pos`：
   ```bash
   npm run config set pos <lat> <lng>             # 該辦公室的真實座標
   ```
   執行 `npm run config` 可查看目前生效的設定（密碼會遮蔽）。

3. **本機驗證：**
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
- `npm run calendar [YYYY-MM-DD]` — 唯讀：查那天是不是上班日、班表為何？絕不打卡；exit code `0`（上班日）／`1`（非上班日），`-- --json` 可輸出摘要行。

登入 cookie 存放在被 gitignore 的 `session-cache.json`（權限 600）；跨次重用、並以一個
輕量請求先驗證，因此一個被撤銷的 cookie 不會弄壞打卡。

**回報訊號（Signals）。** `npm run punch` 的 exit code：`0`（成功／already_done／cooldown／
略過）、`1`（打卡被拒 — 會印出原因）、`2`（用法錯誤）、`3`（無法執行 — 登入／行事曆／
網路）。加上 `-- --json` 可額外印一行機器可讀的摘要。Worker 不寄 email；打卡失敗會
**throw**，把該次 cron 執行標記為失敗（顯示在 Cloudflare 主控台 / `wrangler tail`）—
若想收到通知，可自行設定 Cloudflare Notification。

## 設定項

除了**密碼**以外，全部都是一般設定，放在 **`wrangler.toml [vars]`** — 單一來源，
Worker 與 CLI 共用（`npm run config set …` 會寫入，或手動編輯）。只有密碼是分開的：
本機 `.dev.vars` ＋ 部署用 `wrangler secret put`。除了 `MAYO_USERNAME` ＋ `MAYO_PASSWORD`
之外皆為選用；只有密碼會是 `wrangler secret`。

> **從舊版升級**（設定原本在 `.dev.vars`）？執行一次 `npm run config migrate` —
> 它會把非機密的設定搬進 `wrangler.toml [vars]`，`.dev.vars` 只留下密碼。

| 變數 | 預設 | 意義 |
|-----|---------|---------|
| `MAYO_USERNAME` | — | 登入 email（是 var，不是 secret） |
| `PUNCHES_LOCATION_ID` | 佔位值 | 辦公室地點 id — `npm run config set location` 可列出 |
| `PUNCH_LATITUDE` / `PUNCH_LONGITUDE` | 佔位值 | 回報的座標（要與地點相符） |
| `TIMEZONE` | `Asia/Taipei` | 班表時間的時區 |
| `GPS_JITTER_METERS` | `12` | 每次打卡的隨機位移半徑 |
| `PUNCH_EARLY_IN_MIN` / `_MAX` | `1` / `15` | 提早分鐘數（在緩衝之上） |
| `PUNCH_LATE_OUT_MIN` / `_MAX` | `1` / `15` | 下班延後分鐘數 |
| `REACTION_BUFFER_MIN` | `10` | 至少在班表前這麼多分鐘打卡 |
| `RESPECT_LEAVE` | `false` | `true` = 略過整天請假的日子 |
| `DRY_RUN` | `true` | 跑完整流程但絕不真的打卡 |
| `MAYO_PASSWORD` | — | **secret** — `wrangler secret put`（部署）／`.dev.vars`（本機）；絕不是 var |

## 部署 Worker（選用）

Worker 是選用的。若你想要免動手的自動化，這是安全的做法。

**事前準備：** 一個免費的 [Cloudflare 帳號](https://dash.cloudflare.com/sign-up)
（這裡用到的 cron 觸發器在免費方案即可）與 **Node.js 18+**。請先在 repo 根目錄執行
`npm install` — 以下所有指令都透過 `npx` 使用 repo 內鎖定版本的 `wrangler`，不需全域安裝。

接著用範本建立你的設定檔 — `wrangler.toml` 已被 gitignore，所以你的辦公室 id／座標／
帳號不會進到 repo：
```bash
cp wrangler.toml.example wrangler.toml
# 接著編輯 MAYO_USERNAME、PUNCHES_LOCATION_ID、PUNCH_LATITUDE／PUNCH_LONGITUDE
```

1. **登入** wrangler（會開瀏覽器）：
   ```bash
   npx wrangler login
   ```
2. **設定密碼 secret**（唯一的 secret — `MAYO_USERNAME` 放在 `wrangler.toml`；
   密碼不會進檔案或 argv）：
   ```bash
   npx wrangler secret put MAYO_PASSWORD
   ```
   （不用建立 KV — Durable Object 與其儲存會在部署時，由 `[[migrations]]` 區塊自動建立。）
3. **先用 DRY-RUN 部署。** `wrangler.toml` 預設 `DRY_RUN = "true"`，會跑完整流程
   （行事曆 → 計畫 → 判斷）但**絕不真的打卡**：
   ```bash
   npx wrangler deploy
   ```
   > **第一次何時跑：** DO 由每天 **台北 00:05** 的 cron 備援規劃並設定 alarm。若你在那之後才
   > 部署，今天就不會動，要等今晚 00:05（那會規劃「明天」）— 所以今天仍手動（`npm run punch out`）。
   >
   > **不用等、現在就測** — 在本機用真實 MayoHR API 跑一次 scheduled handler（**只有在
   > `DRY_RUN="true"` 時才安全** — 正式跑會真的打卡）：
   > ```bash
   > npx wrangler dev --test-scheduled
   > # 然後在另一個 shell：
   > curl "http://localhost:8787/cdn-cgi/handler/scheduled"
   > ```
   > 白天跑會發現上班卡逾期，先嘗試**補打**（若你已上班打卡過，會回無害的 `already_done`），
   > 再規劃下班卡。
4. **觀察一個上班日。** DO 一天醒來約 3 次 — 規劃、進、出。在那些時間點 tail：
   ```bash
   npx wrangler tail
   ```
   日誌會清楚顯示它在做什麼（時間為台北，精準到秒）：
   ```
   apollo: 2026-07-31 — waiting (in 09:13:47, out 18:41:12)
   apollo: clock-in 2026-07-31 — recorded … (DRY_RUN)
   apollo: 2026-08-02 — skipped, not a workday
   ```
5. **切成正式** — 確認 DRY_RUN 的規劃無誤後，改旗標並重新部署：
   ```toml
   # wrangler.toml
   DRY_RUN = "false"
   ```
   ```bash
   npx wrangler deploy
   ```
   > ⚠️ 這就是玩真的了 — Worker 從此會無人看管地自動打卡。切換前，先讓 DRY_RUN 版本
   > 跑一天並看 `tail`。
6. **確認第一個真實上班日** — 透過 `wrangler tail` 觀察，確認顯示 Mayo 記錄的時間，
   並到 Apollo 檢查剛好一進一出。

> **資源用量。** DO 一天醒來約 3 次（規劃 + 兩次打卡），其餘時間在睡 — 長時間的等待不花錢。
> 只用到免費額度的極小一部分（Durable Objects 每天 10 萬次請求免費），對 MayoHR 也只碰約 3 次。

### Worker 常見陷阱

- **Worker 的名稱來自 `wrangler.toml` 的 `name` 欄位。** `npx wrangler tail`、`deploy`、
  `delete` 都以它為準。若指令回報 *「This Worker does not exist」*，代表你用的名稱跟已部署
  的不同 — 改用實際名稱：`npx wrangler tail <已部署的名稱>`（可在 Cloudflare 主控台查到）。
- **Secrets 是每個 Worker 各自獨立的。** 若你改了 Worker 名稱（改 `name`），下次 `deploy`
  會建立一個**全新、沒有任何 secret** 的 Worker — 要重跑 `npx wrangler secret put
  MAYO_PASSWORD`，再用 `npx wrangler delete --name <舊名稱>` 刪掉舊的，以免**兩個** cron
  同時打卡。
- **Cloudflare 主控台顯示的是 UTC 時間**（台北 = UTC+8）。主控台上「11:15」的事件其實是台北
  19:15。Worker 自己的日誌印的是台北時間，有疑問時以那個為準。

## 專案結構

- `src/` — `config`、`auth`、`calendar`、`punch`、`locations`、`time`、
  `calendar-cache`、`session-cache`（使用前先驗證的 cookie 快取）、
  `cache-store`（共用的 `CacheStore`）、`flow`（`runPunch`/`acquireSession`/`getDay` —
  可重用核心）、`day-machine`（純函式的當日計畫：`buildDayPlan`／`dueAction`／`nextAlarm`）、
  `do-store`（架在 Durable Object 儲存上的 `CacheStore`）、`punch-day`（`PunchDay` DO
  ＋可測試的 `runTick`）＋ `index`（Worker）。
- `scripts/` — 本機 CLI 工具，建構在與 Worker **相同的 `src/` 模組**上（所以不會與部署
  行為分歧）：`punch-now.ts`（手動打卡進／出）、`config-cli.ts`（`npm run config` /
  `config set` — 寫入 `.dev.vars`，`set location` 可列出地點）、`dev-vars.ts`（純粹的
  `.dev.vars` 編輯）+ `cache-fs.ts`（檔案式快取儲存）、`_env.ts`（共用的 `.dev.vars` +
  設定啟動；`APOLLO_DEV_VARS` 可覆蓋檔案路徑）。
