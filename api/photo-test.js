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
        error: "Wayback 相簿頁面讀取失敗",
        status: response.status
      });
    }

    const html = await response.text();

    // 抓所有照片頁連結，例如：
    // ./show.php?i=BaBy217&b=2&f=1060718966&p=1
    const showLinks = [
      ...html.matchAll(/href=["']([^"']*show\.php[^"']*)["']/gi)
    ].map(m => m[1]);

    const uniqueLinks = [...new Set(showLinks)];

    const photos = [];

    for (const link of uniqueLinks.slice(0, 30)) {
      try {
        const fullUrl = new URL(
          link,
          "http://www.wretch.cc/album/"
        ).href;

        const waybackPhotoPage =
          "https://web.archive.org/web/20131227084024id_/" +
          fullUrl;

        const r = await fetch(waybackPhotoPage, {
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        });

        if (!r.ok) continue;

        const pageHtml = await r.text();

        const imgs = [
          ...pageHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)
        ].map(m => m[1]);

        // 找最像真正照片的網址
        const candidates = imgs.filter(u =>
          /wretch\.yimg\.com|pic\.wretch\.cc/i.test(u)
        );

        for (const img of candidates) {
          let clean = img;

          if (clean.startsWith("//")) {
            clean = "http:" + clean;
          }

          if (clean.startsWith("/")) {
            clean = "http://www.wretch.cc" + clean;
          }

          photos.push({
            photoPage: waybackPhotoPage,
            originalImage: clean,
            archivedImage:
              "https://web.archive.org/web/20131227084024id_/" +
              clean
          });
        }

      } catch {}
    }

    // 去除重複圖片
    const seen = new Set();

    const finalPhotos = photos.filter(p => {
      if (seen.has(p.originalImage)) return false;
      seen.add(p.originalImage);
      return true;
    });

    return res.status(200).json({
      ok: true,
      photoPageCount: uniqueLinks.length,
      recoveredCount: finalPhotos.length,
      photos: finalPhotos.slice(0, 50)
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
