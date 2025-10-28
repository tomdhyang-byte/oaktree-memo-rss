
# Oaktree Howard Marks Memo RSS (Feedly-ready)

這個專案會自動抓取 **Oaktree Capital / Insights / Memo**（Howard Marks 文章），每天更新一次，並在 `docs/feed.xml` 產生一條標準 RSS 2.0。把 GitHub Pages 打開後，Feedly 就能直接訂閱。

## 一鍵使用步驟

1. **把整個專案上傳到自己的 GitHub**（例如 repo 名：`oaktree-memo-rss`）。
2. 在 GitHub 專案頁 > **Settings → Pages**：
   - Source 選 `Deploy from a branch`
   - Branch 選 `main`，資料夾選 `/(root)` 或 `docs`（這個專案輸出在 `docs/`，建議選 `docs`）。
3. 等第一次 GitHub Actions 跑完（通常幾十秒），你會看到 `docs/feed.xml`。
4. 你的 RSS 位置將會是：  
   `https://<你的GitHub帳號>.github.io/<你的repo>/feed.xml`
5. 把這條 URL 貼進 **Feedly** 訂閱。完成 ✅

## 這條 RSS 包含什麼？
- 只收錄網址符合 `/insights/memo/*` 的文章
- 每篇包含：標題、連結、發佈日期、前幾段內文摘要、PDF 下載連結（若有）

## 手動在本機測試
```bash
npm install
npm run build
# 產出在 docs/feed.xml
```

## 時程與頻率
- GitHub Actions 每天執行一次（UTC 21:00，可自行改 CRON）

## 注意
- Oaktree Insights 列表頁為前端動態渲染，這裡使用 Playwright 頁面渲染後擷取資料。
- 若未來網站結構變動，可在 `scripts/scrape.mjs` 中調整 selector 與萃取邏輯。
