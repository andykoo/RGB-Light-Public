# RGB APP（公開下載版）

此儲存庫包含 Google Apps Script（GAS）原始碼，供下載、檢視與自行部署。

## 專案檔案

GAS 專案原始碼包含管理後台、學生頁面、活動與資料庫管理、IRS/ITC、AI 評分等 `.js` 與 `.html` 檔案；`appsscript.json` 為 Apps Script 專案設定。

## 部署前注意

- 此專案的 `appsscript.json` 設定網頁應用程式可匿名存取（`ANYONE_ANONYMOUS`），並以部署者身分執行。部署前請檢視存取控制與資料處理方式。
- 專案要求 Drive、試算表、外部連線及 Gmail 相關 OAuth 權限。請先檢視並確認用途，再授權。
- API 金鑰、上傳資料夾 ID 等設定由管理介面或 Apps Script 設定提供，請勿提交憑證或真實使用者資料。
- `.clasp.json` 含 Apps Script 專案識別碼，已排除於版本控制。

## 使用 clasp

1. 安裝 Node.js 與 clasp：`npm install -g @google/clasp`
2. 登入 Google：`clasp login`
3. 在自己的 Apps Script 專案中建立或選定專案，將本專案檔案推送至該專案。
4. 依需求設定網頁應用程式部署、資料來源與金鑰。

請勿直接將本公開下載版推送回原始 Apps Script 專案。
