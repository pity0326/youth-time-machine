export default async function handler(req, res) {
  try {
    const id = "1060718966";

    const candidates = [
      {
        name: "縮圖",
        url: `http://f12.wretch.yimg.com/baby217/2/thumbs/t${id}.jpg`
      },
      {
        name: "去掉 t 的縮圖路徑",
        url: `http://f12.wretch.yimg.com/baby217/2/thumbs/${id}.jpg`
      },
      {
        name: "相簿根目錄",
        url: `http://f12.wretch.yimg.com/baby217/2/${id}.jpg`
      },
      {
        name: "相簿根目錄 t 檔",
        url: `http://f12.wretch.yimg.com/baby217/2/t${id}.jpg`
      },
      {
        name: "photos 路徑",
        url: `http://f12.wretch.yimg.com/baby217/2/photos/${id}.jpg`
      },
      {
        name: "images 路徑",
        url: `http://f12.wretch.yimg.com/baby217/2/images/${id}.jpg`
      }
    ];

    async function checkWayback(item) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);

      try {
        const api =
          "https://archive.org/wayback/available" +
          "?url=" + encodeURIComponent(item.url) +
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
            name: item.name,
            imageUrl: item.url,
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
            name: item.name,
            imageUrl: item.url,
            found: false
          };
        }

        return {
          name: item.name,
          imageUrl: item.url,
          found: true,
          timestamp: closest.timestamp,
          archivedUrl: closest.url
        };

      } catch (error) {
        clearTimeout(timer);

        return {
          name: item.name,
          imageUrl: item.url,
          found: false,
          error:
            error.name === "AbortError"
              ? "timeout"
              : error.message
        };
      }
    }

    // 全部平行測，避免一個一個等
    const results = await Promise.all(
      candidates.map(checkWayback)
    );

    const recovered = results.filter(x => x.found);

    return res.status(200).json({
      ok: true,
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
