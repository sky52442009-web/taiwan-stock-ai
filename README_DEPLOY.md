# 免費永久部署：GitHub Pages

這個版本可以放到 GitHub Pages，網址會是：

```text
https://你的帳號.github.io/你的repo名稱/
```

## 第一次上線

1. 到 GitHub 建立一個新的 public repository。
2. 在這個資料夾執行：

```powershell
git init
git add .
git commit -m "Initial stock AI website"
git branch -M main
git remote add origin https://github.com/你的帳號/你的repo名稱.git
git push -u origin main
```

3. 打開 GitHub repo 的 `Settings > Pages`。
4. Source 選 `Deploy from a branch`。
5. Branch 選 `main`，資料夾選 `/public`，按 Save。

## 每天自動更新與學習

`.github/workflows/update-analysis.yml` 會在台北時間每個平日 16:30 自動執行：

- 抓 TWSE/TPEx 官方資料。
- 更新 `public/api/analysis.json`。
- 用新的交易日收盤結果驗證舊預測。
- 更新 `data/learning-state.json` 裡的模型權重。
- 自動 commit 回 GitHub。

也可以在 GitHub 的 `Actions > Update stock analysis > Run workflow` 手動更新。

## 限制

GitHub Pages 是免費固定網址，不需要你的電腦開著。資料更新依賴 GitHub Actions；如果 GitHub 帳號或 repo 被停用、或平台政策改變，服務可能受影響。
