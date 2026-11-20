// Small mobile page that opens the phone dialer.
// Served at GET /call. HTML only, no data stored here.

const DEFAULTS = {
  phone: "+251989897171",
  phone_display: "0989897171",
  text_username: "Rohatool",
};

// Escape text for HTML body and attribute values.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Make a safe JavaScript string literal for use inside a <script> tag.
function jsString(s) {
  return JSON.stringify(String(s))
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function callPage(settings = {}) {
  const phone = String(settings.phone ?? DEFAULTS.phone);
  const phoneDisplay = String(settings.phone_display ?? DEFAULTS.phone_display);
  const username = String(settings.text_username ?? DEFAULTS.text_username);

  const telUrl = "tel:" + phone;
  const tgUrl = "https://t.me/" + username;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Call ROHA Tools</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 24px;
    padding: 24px;
    box-sizing: border-box;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #ffffff;
    color: #222222;
    text-align: center;
  }
  h1 { font-size: 22px; margin: 0; }
  .call {
    display: block;
    width: 100%;
    max-width: 420px;
    box-sizing: border-box;
    padding: 28px 16px;
    border-radius: 16px;
    background: #d32f2f;
    color: #ffffff;
    font-size: 26px;
    font-weight: 700;
    text-decoration: none;
  }
  .text {
    font-size: 18px;
    color: #1565c0;
    text-decoration: underline;
  }
</style>
</head>
<body>
  <h1>ROHA Tools</h1>
  <a class="call" href="${escapeHtml(telUrl)}">📞 Call ${escapeHtml(phoneDisplay)}</a>
  <a class="text" href="${escapeHtml(tgUrl)}">💬 Or message us on Telegram</a>
  <script>
    window.addEventListener("load", function () {
      location.href = ${jsString(telUrl)};
    });
  </script>
</body>
</html>
`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
