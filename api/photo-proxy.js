export default async function handler(req, res) {
  const imageUrl =
    "https://web.archive.org/web/20131227084040id_/http://f12.wretch.yimg.com/baby217/2/thumbs/t1060718966.jpg?s7bLZKL6zK3xbuyNQfSXU0Hyfgeteo.3JGD5zqHaEw_SWofadpUoEFaHypk5NXtp";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      },
      redirect: "follow",
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        status: response.status,
        contentType: response.headers.get("content-type"),
        finalUrl: response.url
      });
    }

    const contentType =
      response.headers.get("content-type") || "";

    if (!contentType.startsWith("image/")) {
      return res.status(502).json({
        ok: false,
        error: "Wayback 回傳的不是圖片",
        contentType,
        finalUrl: response.url
      });
    }

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");

    return res.status(200).send(buffer);

  } catch (error) {
    return res.status(502).json({
      ok: false,
      error:
        error.name === "AbortError"
          ? "照片讀取超過 10 秒"
          : error.message
    });
  }
}
