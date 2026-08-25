export default async function handler(req, res) {
  try {
    const albumSnapshot =
      "https://web.archive.org/web/20131227084024id_/http://www.wretch.cc/album/album.php?id=BaBy217&book=2";

    const albumRes = await fetch(albumSnapshot, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!albumRes.ok) {
      return res.status(502).json({
        ok: false,
        error: "相簿頁讀取失敗",
        status: albumRes.status
      });
    }

    const albumHtml = await albumRes.text();

    // 抓無名縮圖
    const imgs = [
      ...albumHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)
    ].map(m => m[1]);

    let thumbs = imgs
      .filter(u =>
        /wretch\.yimg\.com/i.test(u) &&
        /thumbs/i.test(u) &&
        /\.(jpg|jpeg|png|gif)/i.test(u)
      )
      .map(u => {
        if (u.startsWith("//")) return "http:" + u;
        if (u.startsWith("/")) return "http://www.wretch.cc" + u;
        return u;
      });

    thumbs = [...new Set(thumbs)].slice(0, 30);

    async function checkOne(imageUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);

      try {
        const api =
          "https://archive.org/wayback/available" +
          "?url=" + encodeURIComponent(imageUrl) +
          "&timestamp=20131227";

        const r = await fetch(api, {
          headers: {
            "User-Agent": "Mozilla/5.0"
          },
          signal: controller.signal
        });

        clearTimeout(timer);

        if (!r.ok) {
          return {
            imageUrl,
            found: false,
            status: r.status
          };
        }

        const data = await r.json();

        const closest =
          data &&
          data.archived_snapshots &&
          data.archived_snapshots.closest;

        if (!closest || !closest.available) {
          return {
            imageUrl,
            found: false
          };
        }

        return {
          imageUrl,
          found: true,
          timestamp: closest.timestamp,
          archivedUrl: closest.url
        };

      } catch (error) {
        clearTimeout(timer);

        return {
          imageUrl,
          found: false,
          error:
            error.name === "AbortError"
              ? "timeout"
              : error.message
        };
      }
    }

    // 分批查，避免一次太多請求
    const results = [];
    const batchSize = 6;

    for (let i = 0; i < thumbs.length; i += batchSize) {
      const batch = thumbs.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(checkOne)
      );

      results.push(...batchResults);
    }

    const recovered = results.filter(x => x.found);

    return res.status(200).json({
      ok: true,
      thumbCount: thumbs.length,
      testedCount: results.length,
      recoveredCount: recovered.length,
      recovered,
      results
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
