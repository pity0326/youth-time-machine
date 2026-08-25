module.exports = async function handler(req, res) {
  const { username, type } = req.query;

  const allowedTypes = new Set(["album", "blog", "guestbook"]);

  if (!username || typeof username !== "string") {
    return res.status(400).json({ error: "缺少帳號" });
  }

  if (!allowedTypes.has(type)) {
    return res.status(400).json({ error: "查詢類型不正確" });
  }

  // 只允許一般帳號字元，避免把任意網址送到後端查詢
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(username)) {
    return res.status(400).json({ error: "帳號格式不正確" });
  }

  const oldUrl = `http://www.wretch.cc/${type}/${username}`;
  const calendarUrl = `https://web.archive.org/web/*/${oldUrl}`;

  const cdxUrl =
    "https://web.archive.org/cdx/search/cdx" +
    "?url=" + encodeURIComponent(oldUrl) +
    "&output=json" +
    "&filter=statuscode:200" +
    "&filter=mimetype:text/html" +
    "&fl=timestamp,original,statuscode" +
    "&collapse=timestamp:4";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(cdxUrl, {
      headers: {
        "User-Agent": "YouthTimeMachine/1.0"
      },
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      return res.status(502).json({
        error: "Internet Archive 暫時沒有正常回應",
        calendarUrl
      });
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length <= 1) {
      return res.status(200).json({
        found: false,
        years: [],
        calendarUrl
      });
    }

    const byYear = new Map();

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const timestamp = row && row[0];

      if (!timestamp || timestamp.length < 4) continue;

      const year = timestamp.slice(0, 4);

      // 每個年份只保留第一個實際快照 timestamp
      if (!byYear.has(year)) {
        byYear.set(year, timestamp);
      }
    }

    const years = [...byYear.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([year, timestamp]) => ({
        year,
        timestamp,
        // 用完整 timestamp 比只放年份更準，避免 Wayback 找不到該年對應頁
        url: `https://web.archive.org/web/${timestamp}/${oldUrl}`
      }));

    if (years.length === 0) {
      return res.status(200).json({
        found: false,
        years: [],
        calendarUrl
      });
    }

    return res.status(200).json({
      found: true,
      username,
      type,
      oldUrl,
      firstYear: years[0].year,
      years,
      calendarUrl
    });

  } catch (error) {
    return res.status(502).json({
      error: error && error.name === "AbortError"
        ? "Internet Archive 查詢逾時"
        : "查詢 Internet Archive 時發生錯誤",
      calendarUrl
    });
  }
};
