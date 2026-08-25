module.exports = async function handler(req, res) {
  const redisUrl =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;

  const redisToken =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;

  if (!redisUrl || !redisToken) {
    return res.status(503).json({
      error: "尚未設定搜尋次數資料庫"
    });
  }

  const baseUrl = redisUrl.replace(/\/$/, "");

  async function redis(path) {
    const response = await fetch(baseUrl + path, {
      headers: {
        Authorization: `Bearer ${redisToken}`
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Redis HTTP ${response.status}`);
    }

    return response.json();
  }

  // Taiwan date, used for daily counter reset-by-key.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const today = formatter.format(new Date());
  const totalKey = "youth_time_machine:search_total";
  const todayKey = `youth_time_machine:search_daily:${today}`;

  try {
    if (req.method === "GET") {
      const [totalData, todayData] = await Promise.all([
        redis(`/get/${encodeURIComponent(totalKey)}`),
        redis(`/get/${encodeURIComponent(todayKey)}`)
      ]);

      const total = Number(totalData.result || 0);
      const todayCount = Number(todayData.result || 0);

      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        total: Number.isFinite(total) ? total : 0,
        today: Number.isFinite(todayCount) ? todayCount : 0,
        date: today
      });
    }

    if (req.method === "POST") {
      const [totalData, todayData] = await Promise.all([
        redis(`/incr/${encodeURIComponent(totalKey)}`),
        redis(`/incr/${encodeURIComponent(todayKey)}`)
      ]);

      const total = Number(totalData.result || 0);
      const todayCount = Number(todayData.result || 0);

      // Daily keys only need short retention; total remains permanent.
      // 3 days is enough to cover date boundaries while keeping Redis tidy.
      try {
        await redis(`/expire/${encodeURIComponent(todayKey)}/259200`);
      } catch {}

      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        total: Number.isFinite(total) ? total : 0,
        today: Number.isFinite(todayCount) ? todayCount : 0,
        date: today
      });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      error: "Method not allowed"
    });

  } catch (error) {
    return res.status(502).json({
      error: "搜尋次數統計暫時無法使用"
    });
  }
};
