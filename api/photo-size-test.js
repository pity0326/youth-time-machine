export default async function handler(req, res) {
  try {
    const id = "1060718966";

    // 這串是前面已經確認能抓到縮圖的完整參數
    const query =
      "s7bLZKL6zK3xbuyNQfSXU0Hyfgeteo.3JGD5zqHaEw_SWofadpUoEFaHypk5NXtp";

    const candidates = [
      {
        name: "原縮圖",
        url: `http://f12.wretch.yimg.com/baby217/2/thumbs/t${id}.jpg?${query}`
      },
      {
        name: "縮圖去掉 t",
        url: `http://f12.wretch.yimg.com/baby217/2/thumbs/${id}.jpg?${query}`
      },
      {
        name: "相簿根目錄",
        url: `http://f12.wretch.yimg.com/baby217/2/${id}.jpg?${query}`
      },
      {
        name: "相簿根目錄 t",
        url: `http://f12.wretch.yimg.com/baby217/2/t${id}.jpg?${query}`
      },
      {
        name: "原圖候選 1",
        url: `http://f12.wretch.yimg.com/baby217/2/${id}_o.jpg?${query}`
      },
      {
        name: "原圖候選 2",
        url: `http://f12.wretch.yimg.com/baby217/2/${id}_m.jpg?${query}`
      }
    ];

    async function test(item) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      try {
        // 先用 2013/12/27 附近的 Wayback 快照路徑直接嘗試
        const archived =
          `https://web.archive.org/web/20131227084040id_/${item.url}`;

        const r = await fetch(archived, {
          headers: {
            "User-Agent": "Mozilla/5.0"
          },
          redirect: "follow",
          signal: controller.signal
        });

        clearTimeout(timer);

        const contentType =
          r.headers.get("content-type") || "";

        if (!r.ok || !contentType.startsWith("image/")) {
          return {
            name: item.name,
            found: false,
            status: r.status,
            contentType,
            finalUrl: r.url
          };
        }

        const buffer = Buffer.from(
          await r.arrayBuffer()
        );

        return {
          name: item.name,
          found: true,
          bytes: buffer.length,
          contentType,
          archivedUrl: archived,
          finalUrl: r.url
        };

      } catch (error) {
        clearTimeout(timer);

        return {
          name: item.name,
          found: false,
          error:
            error.name === "AbortError"
              ? "timeout"
              : error.message
        };
      }
    }

    const results = await Promise.all(
      candidates.map(test)
    );

    const recovered =
      results.filter(x => x.found);

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
