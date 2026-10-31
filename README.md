# exposure-manager｜曝險管理

- 網站：https://exposure-manager.vercel.app/
- 原始碼：https://github.com/wiclhim/exposure-manager

## 網址更名與舊資料轉移

網站已更名為 exposure-manager。舊網址暫時保留，供原本的瀏覽器讀取本機資料；不會自動重新導向，避免讓舊資料無法讀取。請在原本有資料的裝置／瀏覽器，按網站上方「轉移資料並前往新網站」，再於新網站確認匯入。持倉、現金、設定、歷史與指數策略設定只會在兩個網站的瀏覽器視窗之間複製，不經伺服器，不會放進網址，也不會刪除舊資料。新網站原有資料會先在本機保留一份轉移前備份。

也可以使用原有的 JSON 匯出／匯入功能。WebSocket Key 不參與跨網址轉移，請在新網站重新輸入；Vercel 伺服器端行情金鑰及 Redis 連結維持不變。每個裝置／瀏覽器都需分別轉移；此功能不是跨裝置雲端同步。程式僅為相容既有本機資料及共用行情額度而保留舊儲存識別碼，不作為網站或專案名稱。

這是一個可部署到 Vercel 的台股投資組合 Beta／資產配置／再平衡工具。依公開首頁可觀察到的模組重建，並額外加入可正常操作的「標的互換」流程。它不是原網站的原始碼，也無法保證與未公開頁面逐像素相同。

## 功能

- 整體 Beta、目標 Beta、容許偏離區間與曝險儀表
- 槓桿／原形／現金＋類現金的市值與配置比例
- 持倉新增、編輯、刪除、搜尋、CSV 匯出
- 現金餘額管理
- 再平衡建議：目標分類市值、差額、買賣方向與估算股數
- 標的互換：可選擇保留原持倉市值或保留原 Beta 曝險金額；可把換入標的報價自動帶入
- 以 0050（或自訂基準）最近 364 日還原日 K 估算個別 Beta
- 市場水位：目前報價相對 52 週最高收盤價的距離
- 每日手動快照、歷史紀錄、JSON 備份／還原
- 行情來源與最後更新狀態顯示
- Upstash Redis 全域滑動視窗請求計數器：全專案 Fugle REST 硬上限 40 次／60 秒；超額或計數器不可用時採 fail-closed

## 行情來源與計算

### 台股即時報價

本專案接入 Fugle Market Data API：

- `GET /marketdata/v1.0/stock/intraday/quote/{symbol}`：盤中最後成交價、漲跌、成交時間等。
- `GET /marketdata/v1.0/stock/historical/candles/{symbol}`：取得歷史日 K；用於 52 週最高收盤價與 Beta 計算。
- 報價由 `api/quote.js` 在伺服器端轉接，API Key 不會放在瀏覽器端。
- 依使用者需求採混合模式：最多 5 檔以 Fugle WebSocket `trades` 推播（優先 0050、00631L、00685L、009816，再選市值較大的持倉）；其餘標的以 REST 每 60 秒輪詢。WebSocket 斷線時，REST 暫時接手全部標的，每 60 秒一輪，並採退避重連。
- 所有本專案的 Fugle REST 上游呼叫（盤中報價、歷史日 K、Beta）都先向 Upstash Redis 原子預留額度。共用同一個 Redis Sorted Set 做 60 秒滑動視窗計數，硬上限 40 次；Beta 估算一次預留 2 次，因為要下載標的與基準兩份日 K。每當用量達 40 次，新的 REST 請求會收到 HTTP 429，且不會呼叫 Fugle。
- 若 Upstash 環境變數未設定或 Redis 不可用，後端採 fail-closed，回傳 HTTP 503 並停止 Fugle REST 查詢。這是「不超過本系統 40 次」的必要保護，不會退回無保護模式。
- 設定頁顯示最近 60 秒用量與剩餘次數；計數器共用於此 Vercel 專案的所有瀏覽器與 Serverless 執行個體。

> Fugle 個人基本方案以 REST 60 次／分鐘及 WebSocket 5 個訂閱為規劃基準。本專案把自己產生的 REST 請求上限壓在 40 次／60 秒，預留至少 20 次額度給同一 Fugle Key 的其他用途。**若同一把 Fugle Key 還被其他網站、程式或裝置直接使用，那些外部請求不會計入本專案的 Redis 計數器**，請勿把其餘 20 次當成絕對保證。
> 
> REST Key 放在 Vercel 環境變數；因 Vercel Serverless 不適合長時間維持 WebSocket 代理連線，這版 WebSocket 由瀏覽器直連 Fugle，因此需在設定頁輸入相同 API Key，僅儲存在該瀏覽器 Local Storage。**瀏覽器端 Key 可被該裝置使用者透過開發者工具讀取**，不適合多人公開使用。免費方案的 WebSocket 連線上限為 1 條、最多 5 個訂閱；程式使用瀏覽器 Web Locks API 避免同一瀏覽器多分頁重複連線。請勿在其他裝置同時開啟本儀表板，因不同裝置之間無法由本機分頁鎖統一限制連線數。實際額度與授權依 Fugle 當期方案為準。

### 需要注意的即時性

- API 的 `lastPrice` 是 API 回傳的最後一筆成交價（或試撮價），不是保證每秒更新，也不是保證一定有成交。
- 休市時會顯示最後一筆報價；畫面會顯示報價時間與盤後狀態。
- 52 週最高價是歷史日 K 的最高「收盤價」，不是盤中最高價；歷史資料依行情商的盤後更新時間為準。
- 美股、海外 ETF 與期貨未接入 Fugle 台股行情服務，請用手動價格，或另外接入有相應市場授權的 API。
- Beta 使用兩組還原日收盤價的日報酬率，計算 `Cov(標的日報酬, 基準日報酬) / Var(基準日報酬)`。預設基準標的是 0050，可自行更改。此估算結果會受樣本期間、標的流動性及基準選擇影響。

## 部署到 Vercel

1. 將整個資料夾放進 GitHub repository。
2. 在 Vercel 選擇 Import Project，Framework Preset 選 Other，Root Directory 指向專案根目錄。
3. 部署前或部署後，至 Vercel 專案的 **Settings → Environment Variables** 新增：
   - Name: `FUGLE_API_KEY`
   - Value: 你的 Fugle API Key
   - Environment: Production（建議 Preview 也一併設定）
4. 在 Vercel Storage／Marketplace 安裝或連結 **Upstash Redis**，並確認專案環境變數有：
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   可以從 [Vercel Marketplace 的 Upstash Redis](https://vercel.com/marketplace/upstash) 安裝，連結此專案後同步環境變數；Upstash REST API 使用 `/pipeline` 傳送 Redis 指令，程式以單一 Lua `EVAL` 命令原子預留額度，詳見 [Upstash REST API 文件](https://upstash.com/docs/redis/features/restapi) 與 [Vercel 整合步驟](https://upstash.com/docs/redis/howto/vercelintegration)。
5. 對 Production（以及需要的 Preview）環境設定 `FUGLE_API_KEY`、`UPSTASH_REDIS_REST_URL`、`UPSTASH_REDIS_REST_TOKEN`，然後重新部署。**若 Upstash 未設定，系統會停止 REST 報價，而不是繞過計數器。**
6. 開啟網站後，進入「設定」頁確認 REST 用量顯示 `0 / 40` 或目前用量。
7. 在「WebSocket API Key」欄位貼上 Fugle Key，按「儲存 WebSocket Key」。這個 Key 只保存在目前瀏覽器，不會寫入網站程式或 JSON 備份。免費方案請避免在多分頁或多裝置同時連線。

`FUGLE_API_KEY` 不要貼到公開聊天、GitHub、`app.js` 或 HTML。REST Key 只放在 Vercel Environment Variables。WebSocket Key 僅在私人瀏覽器端使用，因直連模式可被本機檢視。

## 本機測試

需要 Node.js 20+ 與 Vercel CLI：

```bash
npm install -g vercel
vercel dev
```

在本機 `.env.local`（不要提交到 Git）加入：

```env
FUGLE_API_KEY=你的_API_KEY
UPSTASH_REDIS_REST_URL=你的_Upstash_REST_URL
UPSTASH_REDIS_REST_TOKEN=你的_Upstash_REST_TOKEN
```

## 資料保存

持倉、現金、目標配置與歷史快照存在目前瀏覽器的 Local Storage。此版本沒有雲端資料庫或帳號同步。建議定期按「下載資料備份 JSON」。

## Beta 與再平衡公式

- 投組 Beta：`Σ(各持倉市值 × 個別 Beta) ÷ 總資產`；現金的 Beta 預設 0。
- 各分類目標市值：`總資產 × 分類目標比例`。
- 同分類多檔標的：依目前市值比例分配該分類的目標市值。
- 建議調整金額：`目標市值 − 目前市值`。
- 參考股數：`調整金額 ÷ 最新報價`。
- 標的互換「保留原 Beta 曝險」：`新標的目標市值 = 原持倉市值 × 原 Beta ÷ 新標的 Beta`。
- 標的互換視窗開啟時，新標的代號會加入每 60 秒的 REST 輪詢清單（若它已在 WebSocket 5 檔訂閱內，則使用 trades 推播）。原持倉或新標的價格更新時，互換預覽會即時重算股數與現金差額。

所有交易數字均為估算，不包括手續費、交易稅、滑價、流動性、整股／零股限制與券商規則。本工具不會下單。
