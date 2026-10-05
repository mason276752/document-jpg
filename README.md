# 紙鏡 · 網頁文件掃描

類似 Microsoft Lens 的純前端文件掃描工具（Vue 3 + Vite）。所有影像處理都在瀏覽器的 Web Worker 裡完成，不依賴 OpenCV、不上傳任何圖片。

```bash
npm install
npm run dev      # 開發
npm run build    # 輸出靜態檔到 dist/，可直接丟到任何靜態主機
```

## 功能

- 拖放 / 選擇 / 貼上 / 手機相機拍照，多頁
- 自動偵測紙張四角，可拖角或拖邊微調（拖曳時有放大鏡）
- 透視校正（拉正變形）、旋轉
- 去除陰影與光照不均，輸出像掃描器的白底文件
- 濾鏡：文件（彩色）、灰階、黑白、原圖；可調去陰影強度、亮度、對比、銳利度、黑白閾值
- 匯出 JPG / PNG（單頁）或多頁 PDF

## 演算法（`src/lib/`）

| 檔案 | 內容 |
| --- | --- |
| `detect.js` | 縮到 512px → 兩種候選：Otsu 亮度分割、Sobel 邊緣圍出的封閉區域；取凸包後求內接最大四邊形，挑最像矩形的那個 |
| `warp.js` | 單位正方形→四邊形的投影變換（Heckbert），反向映射 + 雙線性取樣，縮小時超取樣 |
| `enhance.js` | 去陰影：在 ~400px 的低解析度做形態學閉運算抹掉文字，得到「紙張背景」；色度差太大或太暗的大色塊判定為內容並以周圍紙色補洞；原圖除以背景 → 陰影抵消，再做黑白點拉伸與反銳化 |
| `worker.js` | 保存原圖、快取預覽用的校正結果 |

輸出最長邊上限 3508px（A4 300dpi），預覽 1400px。

## 部署到 GitHub Pages

推到 `main` 分支後，`.github/workflows/deploy.yml` 會自動建置並部署。
第一次需要到 repo 的 **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
