export default async function handler(req, res) {
  try {
    const photoPage =
      "http://www.wretch.cc/album/show.php?i=BaBy217&b=2&f=1060718966&p=0&sp=0";

    const cdx =
      "https://web.archive.org/cdx/search/cdx" +
      "?url=" + encodeURIComponent(photoPage) +
      "&output=json" +
      "&filter=statuscode:200" +
      "&fl=timestamp,original,statuscode,mimetype,digest" +
      "&collapse=digest";

    const calendarUrl =
      "https://web.archive.org/web/*/" + photoPage;

    async function fetchWithRetry(url, tries = 3) {
      let lastStatus = 0;

      for (let i = 0; i < tries; i++) {
        const r = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        });

        lastStatus = r.status;

        if (r.ok) return r;

        // 503 / 502 / 429 才重試
        if (![429, 502, 503].includes(r.status)) {
          return r;
        }

        await new Promise(resolve =>
          setTimeout(resolve, 1000 + i * 1000)
        );
      }

      return {
        ok: false,
        status: lastStatus
      };
    }

    const cdxRes = await fetchWithRetry(cdx, 3);

    if (!cdxRes.ok) {
      return res.status(200).json({
        ok: false,
        temporary: true,
        step: "cdx",
        error: "Wayback 查詢服務目前比較忙，請稍後再試",
        status: cdxRes.status,
        photoPage,
        calendarUrl
      });
    }

    const text = await cdxRes.text();

    let rows;

    try {
      rows = JSON.parse(text);
    } catch {
      return res.status(200).json({
        ok: false,
        step: "cdx",
        error: "Wayback 回傳資料格式異常",
        calendarUrl
      });
    }

    if (!Array.isArray(rows) || rows.length <= 1) {
      return res.status(200).json({
        ok: true,
        photoPage,
        snapshotCount: 0,
        message: "這張照片頁沒有找到保存紀錄",
        calendarUrl,
        snapshots: []
      });
    }

    const snapshots = rows.slice(1).map(row => ({
      timestamp: row[0],
      original: row[1],
      status: row[2],
      mimetype: row[3],
      archivedPage:
        `https://web.archive.org/web/${row[0]}id_/${row[1]}`
    }));

    return res.status(200).json({
      ok: true,
      photoPage,
      snapshotCount: snapshots.length,
      snapshots,
      calendarUrl
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
