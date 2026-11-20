import { test } from "node:test";
import assert from "node:assert/strict";
import { callPage } from "../src/pages.js";

const settings = {
  phone: "+251989897171",
  phone_display: "0989897171",
  text_username: "Rohatool",
};

test("callPage returns 200 HTML with UTF-8 charset", async () => {
  const res = callPage(settings);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
});

test("callPage has a tel link and the call button text", async () => {
  const body = await callPage(settings).text();
  assert.match(body, /href="tel:\+251989897171"/);
  assert.match(body, /📞 Call 0989897171/);
  assert.match(body, /<title>Call ROHA Tools<\/title>/);
});

test("callPage has the Telegram text link", async () => {
  const body = await callPage(settings).text();
  assert.match(body, /href="https:\/\/t\.me\/Rohatool"/);
  assert.match(body, /💬 Or message us on Telegram/);
});

test("callPage escapes HTML in settings values", async () => {
  const body = await callPage({
    phone: '"><script>alert(1)</script>',
    phone_display: "<b>x</b>",
    text_username: "a\"b",
  }).text();
  assert.ok(!body.includes("<script>alert(1)</script>"), "raw script tag must not appear");
  assert.ok(!body.includes("<b>x</b>"), "raw display tag must not appear");
  assert.match(body, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(body, /&quot;&gt;&lt;script&gt;/);
});

test("callPage escapes the phone inside the JavaScript redirect", async () => {
  const body = await callPage({ phone: "</script><script>x()" }).text();
  assert.ok(!body.includes("</script><script>x()"), "script breakout must be escaped");
  assert.match(body, /\\u003c\/script\\u003e/);
});

test("callPage falls back to defaults when settings are empty", async () => {
  const body = await callPage({}).text();
  assert.match(body, /href="tel:\+251989897171"/);
  assert.match(body, /https:\/\/t\.me\/Rohatool/);
});
