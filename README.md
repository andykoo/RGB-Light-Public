# RGB APP（公開下載版）

此儲存庫包含 Google Apps Script（GAS）原始碼，供下載、檢視與自行部署。

## 專案檔案

GAS 專案原始碼包含管理後台、學生頁面、活動與資料庫管理、IRS/ITC、AI 評分等 `.js` 與 `.html` 檔案；`appsscript.json` 為 Apps Script 專案設定。

## 部署前注意

- 此專案的 `appsscript.json` 設定網頁應用程式可匿名存取（`ANYONE_ANONYMOUS`），並以部署者身分執行。任何知道部署網址的人都可開啟網頁；管理功能仍應使用強密碼保護。部署時若不想匿名開放，可在 Apps Script「部署」設定中改為只允許登入 Google 帳戶的使用者或組織成員，並選擇適當的執行身分。
- `appsscript.json` 列出程式要求的 OAuth 權限（Drive、試算表、外部連線、使用者電子郵件與 Gmail）。首次部署或程式新增服務時，Google 會要求部署者授權。請先逐項檢視程式用途；若不使用寄信功能，可檢查並移除 Gmail scopes；若不需要讀取登入者信箱，檢查是否可移除 `userinfo.email`。Drive、試算表與外部連線 scopes 是否可縮減，需依實際使用功能確認。
- `executeAs: USER_DEPLOYING` 表示網頁程式以部署者授權執行。匿名訪客透過網頁操作時，可能觸發部署者有權使用的 Drive／試算表功能；請只部署到專用資料與資料夾，並避免授予不必要的帳戶權限。
- API 金鑰、上傳資料夾 ID 等設定由管理介面或 Apps Script 設定提供，請勿提交憑證或真實使用者資料。
- 第一次開啟管理頁面時，系統會建立 `admin` 管理員並產生隨機初始密碼。初始密碼只會在 Apps Script 執行記錄中顯示一次；請部署者立即查看並登入，系統會要求設定新密碼。不要公開或分享該執行記錄。
- `.clasp.json` 含 Apps Script 專案識別碼，已排除於版本控制。

## 語音／相機輔助服務

IRS 語音輸入與即時相機會開啟外部輔助網站。預設網址為 `https://rgb-production.web.app`。若自行部署了相容的輔助服務，可在 Apps Script「專案設定」的「指令碼屬性」新增 `RGB_HOSTED_TOOL_ORIGIN`，值設為服務的來源網址（例如 `https://tools.example.com`，不要在結尾加路徑斜線）。程式會以此值取代預設網址。設為空字串可停用外部輔助服務；語音輸入或即時相機功能將無法使用。

## 使用 clasp

1. 安裝 Node.js 與 clasp：`npm install -g @google/clasp`
2. 登入 Google：`clasp login`
3. 在自己的 Apps Script 專案中建立或選定專案，將本專案檔案推送至該專案。
4. 依需求設定網頁應用程式部署、資料來源與金鑰。

請勿直接將本公開下載版推送回原始 Apps Script 專案。
