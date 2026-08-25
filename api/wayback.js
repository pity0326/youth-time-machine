module.exports = async function handler(req, res) {
  const { username, type } = req.query;

  const allowedTypes = new Set([
    "album",
    "blog",
    "guestbook"
  ]);

  if (!username || typeof username !== "string") {
    return res.status(400).json({
      error: "缺少帳號"
    });
  }

  if (!allowedTypes.has(type)) {
    return res.status(400).json({
      error: "查詢類型不正確"
    });
  }

  if (!/^[A-Za-z0-9._-]{1,80}$/.test(username)) {
    return res.status(400).json({
      error: "帳號格式不正確"
    });
  }

  const oldUrl =
    `http://www.wretch.cc/${type}/${username}`;

  const calendarUrl =
    `https://web.archive.org/web/*/${oldUrl}`;

  /*
    第一階段：
    使用 CDX 取得所有保存紀錄
  */

  const cdxUrl =
    "https://web.archive.org/cdx/search/cdx" +
    "?url=" + encodeURIComponent(oldUrl) +
    "&output=json" +
    "&fl=timestamp,original,statuscode" +
    "&filter=statuscode:200" +
    "&collapse=timestamp:4" +
    "&gzip=false";

  try {

    const controller = new AbortController();

    const timeout =
      setTimeout(() => {
        controller.abort();
      }, 15000);


    const response =
      await fetch(cdxUrl, {
        method: "GET",

        headers: {
          "Accept": "application/json,text/plain,*/*",
          "User-Agent":
            "Mozilla/5.0 YouthTimeMachine/1.0"
        },

        signal: controller.signal
      });


    clearTimeout(timeout);


    if (response.ok) {

      const text =
        await response.text();


      /*
        有些時候 Internet Archive
        回的不是 JSON，
        所以先自己解析。
      */

      try {

        const data =
          JSON.parse(text);


        if (
          Array.isArray(data) &&
          data.length > 1
        ) {

          const byYear =
            new Map();


          for (
            let i = 1;
            i < data.length;
            i++
          ) {

            const row =
              data[i];

            const timestamp =
              row && row[0];


            if (
              !timestamp ||
              timestamp.length < 4
            ) {
              continue;
            }


            const year =
              timestamp.substring(0, 4);


            if (!byYear.has(year)) {

              byYear.set(
                year,
                timestamp
              );

            }

          }


          const years =
            [...byYear.entries()]
              .sort(
                (a, b) =>
                  a[0].localeCompare(b[0])
              )
              .map(
                ([year, timestamp]) => ({
                  year,
                  timestamp,

                  url:
                    "https://web.archive.org/web/" +
                    timestamp +
                    "/" +
                    oldUrl
                })
              );


          if (years.length > 0) {

            return res.status(200).json({
              found: true,

              source: "cdx",

              username,
              type,
              oldUrl,

              firstYear:
                years[0].year,

              years,

              calendarUrl
            });

          }

        }

      }

      catch (parseError) {

        console.log(
          "CDX JSON parse error:",
          parseError
        );

      }

    }


    /*
      第二階段：
      CDX 沒成功時，
      改用 available API 確認至少
      有沒有一個快照。
    */

    const availableUrl =
      "https://archive.org/wayback/available" +
      "?url=" +
      encodeURIComponent(oldUrl);


    const availableResponse =
      await fetch(
        availableUrl,
        {
          headers: {
            "Accept":
              "application/json",

            "User-Agent":
              "Mozilla/5.0 YouthTimeMachine/1.0"
          }
        }
      );


    if (availableResponse.ok) {

      const availableData =
        await availableResponse.json();


      const closest =
        availableData &&
        availableData.archived_snapshots &&
        availableData.archived_snapshots.closest;


      if (
        closest &&
        closest.available &&
        closest.timestamp
      ) {

        const timestamp =
          closest.timestamp;

        const year =
          timestamp.substring(0, 4);


        return res.status(200).json({

          found: true,

          partial: true,

          source: "available",

          username,
          type,
          oldUrl,

          firstYear:
            year,

          years: [
            {
              year,
              timestamp,

              url:
                closest.url ||
                (
                  "https://web.archive.org/web/" +
                  timestamp +
                  "/" +
                  oldUrl
                )
            }
          ],

          calendarUrl
        });

      }

    }


    /*
      兩種方法都查不到
    */

    return res.status(200).json({

      found: false,

      username,
      type,
      oldUrl,

      years: [],

      calendarUrl

    });


  }

  catch (error) {

    return res.status(502).json({

      error:
        error &&
        error.name === "AbortError"

          ? "Internet Archive 查詢逾時"

          : "查詢 Internet Archive 時發生錯誤",

      detail:
        error &&
        error.message
          ? error.message
          : "unknown",

      calendarUrl

    });

  }
};
