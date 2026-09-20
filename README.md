# RGB APP（公開下載版）

此儲存庫包含 Google Apps Script（GAS）原始碼，供下載、檢視與自行部署。

## 專案檔案

GAS 專案原始碼包含管理後台、學生頁面、活動與資料庫管理、IRS/ITC、AI 評分等 `.js` 與 `.html` 檔案；`appsscript.json` 為 Apps Script 專案設定。

## 部署前注意

- 此專案的 `appsscript.json` 設定網頁應用程式可匿名存取（`ANYONE_ANONYMOUS`），並以部署者身分執行。任何知道部署網址的人都可開啟網頁；管理功能仍應使用強密碼保護。部署時若不想匿名開放，可在 Apps Script「部署」設定中改為只允許登入 Google 帳戶的使用者或組織成員，並選擇適當的執行身分。
- `appsscript.json` 列出程式要求的 OAuth 權限（Drive、試算表、外部連線、使用者電子郵件與 Gmail）。首次部署或程式新增服務時，Google 會要求部署者授權。請先逐項檢視程式用途；若不使用寄信功能，可檢查並移除 Gmail scopes；若不需要讀取登入者信箱，檢查是否可移除 `userinfo.email`。Drive、試算表與外部連線 scopes 是否可縮減，需依實際使用功能確認。
- `executeAs: USER_DEPLOYING` 表示網頁程式以部署者授權執行。匿名訪客透過網頁操作時，可能觸發部署者有權使用的 Drive／試算表功能；請只部署到專用資料與資料夾，並避免授予不必要的帳戶權限。
- 此專案是獨立 Apps Script 專案，不需容器綁定試算表；資料庫以 `SPREADSHEET_ID` 指令碼屬性連接。每位使用者應建立自己的 Apps Script 專案副本與資料庫試算表副本，不要共用同一份含有學生資料的資料庫。
- API 金鑰、上傳資料夾 ID 等設定由管理介面或 Apps Script 設定提供，請勿提交憑證或真實使用者資料。
- 初次設定必須由部署者在 Apps Script 編輯器執行 `initializeRgbPublic`。請先建立資料庫試算表副本，將副本 ID 設為指令碼屬性 `SPREADSHEET_ID`，並設定符合密碼規則的 `RGB_INITIAL_ADMIN_PASSWORD`。初始化會建立資料表標題、預設系統設定與 `admin` 管理員，完成後自動刪除明文初始密碼屬性。首次登入後系統會要求再更換密碼；密碼不會寫入執行記錄。
- `.clasp.json` 含 Apps Script 專案識別碼，已排除於版本控制。

## 語音／相機輔助服務

IRS 語音輸入與即時相機會開啟外部輔助網站。預設網址為 `https://rgb-production.web.app`。若自行部署了相容的輔助服務，可在 Apps Script「專案設定」的「指令碼屬性」新增 `RGB_HOSTED_TOOL_ORIGIN`，值設為服務的來源網址（例如 `https://tools.example.com`，不要在結尾加路徑斜線）。程式會以此值取代預設網址。設為空字串可停用外部輔助服務；語音輸入或即時相機功能將無法使用。

## 使用 clasp

1. 安裝 Node.js 與 clasp：`npm install -g @google/clasp`
2. 登入 Google：`clasp login`
3. 在自己的 Apps Script 專案中建立或選定專案，將本專案檔案推送至該專案。
4. 依需求設定網頁應用程式部署、資料來源與金鑰。

請勿直接將本公開下載版推送回原始 Apps Script 專案。

## 第一次安裝與初始化

1. 在 Apps Script 建立本專案的個人副本。
2. 建立「RGBPublic 資料庫空白模板」的個人副本，從網址複製試算表 ID。
3. 在 Apps Script「專案設定 > 指令碼屬性」新增 `SPREADSHEET_ID`，值為資料庫副本 ID。
4. 新增 `RGB_INITIAL_ADMIN_PASSWORD`，設定至少 8 碼且包含大寫、小寫、數字及特殊字元的密碼。此值只作首次初始化使用。
5. 在編輯器選取 `initializeRgbPublic` 並按「執行」，授權 Apps Script 要求的服務。成功後會初始化資料表、建立 `admin` 管理員，並刪除 `RGB_INITIAL_ADMIN_PASSWORD` 屬性。重複執行不會覆寫現有資料或密碼。
6. 建立 Web App 部署後，開啟部署網址的 `?page=admin`，以 `admin` 和剛設定的密碼登入；依畫面提示更換密碼。
7. 在管理介面設定 AI API 金鑰、上傳資料夾 ID 等個人服務設定。
