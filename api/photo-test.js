export default async function handler(req, res) {
  try {
    const baseThumb =
      "http://f12.wretch.yimg.com/baby217/2/thumbs/t1060718966.jpg";

    // 依舊無名常見路徑，先測縮圖與幾種可能原圖
    const candidates = [
      baseThumb,

      // 移除 thumbs/t
      "http://f12.wretch.yimg.com/baby217/2/1060718966.jpg",

      // 保留 t 但移除 thumbs
      "http://f12.wretch.yimg.com/baby217/2/t1060718966.jpg"
    ];

    async function checkWayback(imageUrl) {
      const controller = new AbortController();

      const timer = setTimeout(() => {
        controller.abort();
      }, 7000);

      try {
        // 使用較輕量的 Wayback availability API
        const api =
          "https://archive.org/wayback/available" +
          "?url=" + encodeURIComponent(imageUrl) +
          "&timestamp=20131227";

        const response = await fetch(api, {
          headers: {
            "User-Agent": "Mozilla/5.0"
          },
          signal: controller.signal
        });

        clearTimeout(timer);

        if (!response.ok) {
          return {
            imageUrl,
            found: false,
            status: response.status
          };
        }

        const data = await response.json();

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
              ? "查詢超過 7 秒"
              : error.message
        };
      }
    }

    // 三個一起查，不要一個一個慢慢等
    const results = await Promise.all(
      candidates.map(checkWayback)
    );

    const recovered = results.filter(x => x.found);

    return res.status(200).json({
      ok: true,

      testedCount: results.length,

      recoveredCount: recovered.length,

      results,

      recovered
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
