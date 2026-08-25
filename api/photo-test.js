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

    // 找第一個照片頁
    const showLinks = [
      ...albumHtml.matchAll(/href=["']([^"']*show\.php[^"']*)["']/gi)
    ].map(m => m[1]);

    const uniqueShowLinks = [...new Set(showLinks)];

    if (uniqueShowLinks.length === 0) {
      return res.status(200).json({
        ok: false,
        error: "找不到照片頁連結"
      });
    }

    const firstPhotoLink = uniqueShowLinks[0];

    const fullPhotoPageUrl = new URL(
      firstPhotoLink,
      "http://www.wretch.cc/album/"
    ).href;

    const archivedPhotoPage =
      "https://web.archive.org/web/20131227084024id_/" +
      fullPhotoPageUrl;

    const photoRes = await fetch(archivedPhotoPage, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!photoRes.ok) {
      return res.status(502).json({
        ok: false,
        error: "照片頁讀取失敗",
        status: photoRes.status,
        archivedPhotoPage
      });
    }

    const photoHtml = await photoRes.text();

    // 1. 所有 img src
    const imgSrcs = [
      ...photoHtml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)
    ].map(m => m[1]);

    // 2. 所有 href
    const hrefs = [
      ...photoHtml.matchAll(/href=["']([^"']+)["']/gi)
    ].map(m => m[1]);

    // 3. 所有可能的圖片檔網址
    const imageFiles = [
      ...photoHtml.matchAll(
        /https?:\/\/[^"'()\s<>]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^"'()\s<>]*)?/gi
      )
    ].map(m => m[0]);

    // 4. 相對路徑圖片
    const relativeImages = [
      ...photoHtml.matchAll(
        /["']([^"']+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^"']*)?)["']/gi
      )
    ].map(m => m[1]);

    // 5. CSS background-image
    const backgroundImages = [
      ...photoHtml.matchAll(
        /url\(["']?([^"')]+)["']?\)/gi
      )
    ].map(m => m[1]);

    // 6. 找所有看起來像無名圖片主機的字串
    const wretchCandidates = [
      ...photoHtml.matchAll(
        /[^"'()\s<>]*(?:wretch|yimg|f\d+\.wretch)[^"'()\s<>]*/gi
      )
    ].map(m => m[0]);

    function unique(arr) {
      return [...new Set(arr.filter(Boolean))];
    }

    return res.status(200).json({
      ok: true,

      firstPhotoLink,
      archivedPhotoPage,

      htmlLength: photoHtml.length,

      imgSrcs: unique(imgSrcs).slice(0, 100),

      hrefs: unique(hrefs).slice(0, 100),

      imageFiles: unique(imageFiles).slice(0, 100),

      relativeImages: unique(relativeImages).slice(0, 100),

      backgroundImages: unique(backgroundImages).slice(0, 100),

      wretchCandidates: unique(wretchCandidates).slice(0, 100)
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
