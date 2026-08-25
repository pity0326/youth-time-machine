export default async function handler(req, res) {
  try {
    const snapshot =
      "https://web.archive.org/web/20131227084024id_/http://www.wretch.cc/album/album.php?id=BaBy217&book=2";

    const response = await fetch(snapshot, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: "Wayback 頁面讀取失敗",
        status: response.status
      });
    }

    const html = await response.text();

    // 抓 href
    const hrefs = [
      ...html.matchAll(/href=["']([^"']+)["']/gi)
    ].map(m => m[1]);

    // 抓 img src
    const images = [
      ...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)
    ].map(m => m[1]);

    // 找出可能與相簿 / 照片有關的連結
    const photoLinks = hrefs.filter(url =>
      /album|photo|show|book|pic|image/i.test(url)
    );

    return res.status(200).json({
      ok: true,

      htmlLength: html.length,

      hrefCount: hrefs.length,

      imageCount: images.length,

      photoLinks: [...new Set(photoLinks)].slice(0, 100),

      images: [...new Set(images)].slice(0, 100)
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
