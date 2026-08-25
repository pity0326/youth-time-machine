export default async function handler(req, res) {
  try {
    // 我們已經從相簿頁確認存在的第一張照片頁
    const photoPage =
      "http://www.wretch.cc/album/show.php?i=BaBy217&b=2&f=1060718966&p=0&sp=0";

    // 查這個照片頁自己在 Wayback 的保存紀錄
    const cdx =
      "https://web.archive.org/cdx/search/cdx" +
      "?url=" + encodeURIComponent(photoPage) +
      "&output=json" +
      "&filter=statuscode:200" +
      "&filter=mimetype:text/html" +
      "&fl=timestamp,original,statuscode,mimetype,digest" +
      "&collapse=digest";

    const cdxRes = await fetch(cdx, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!cdxRes.ok) {
      return res.status(502).json({
        ok: false,
        step: "cdx",
        error: "Wayback 保存紀錄查詢失敗",
        status: cdxRes.status
      });
    }

    const text = await cdxRes.text();

    let rows;

    try {
      rows = JSON.parse(text);
    } catch {
      return res.status(502).json({
        ok: false,
        step: "cdx",
        error: "Wayback 回傳格式無法解析",
        preview: text.slice(0, 500)
      });
    }

    // 第一列是欄位名稱
    if (!Array.isArray(rows) || rows.length <= 1) {
      return res.status(200).json({
        ok: true,
        photoPage,
        snapshotCount: 0,
        message: "這張照片頁沒有找到可用的 Wayback 保存紀錄",
        snapshots: []
      });
    }

    const snapshots = rows.slice(1).map(row => ({
      timestamp: row[0],
      original: row[1],
      status: row[2],
      mimetype: row[3],
      digest: row[4],
      archivedPage:
        `https://web.archive.org/web/${row[0]}id_/${row[1]}`
    }));

    return res.status(200).json({
      ok: true,
      photoPage,
      snapshotCount: snapshots.length,
      snapshots
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
