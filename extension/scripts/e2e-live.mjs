#!/usr/bin/env node
/**
 * 端到端验证：真浏览器 + 真扩展 + 本地伪造的「目标源」页面。
 *
 * 重要声明：本脚本**不访问** seats.dlmu.edu.cn，也不登录任何真实系统。
 * 它用 Playwright 拦截发往该域的请求，返回本地伪造的 HTML/JSON，
 * 目的是让扩展的 content script **按真实域名规则注入**（manifest 的 matches 不会被放宽），
 * 从而在离线条件下验证：manifest 能被浏览器接受 → hook 注入并捕获 → content 解析 → 侧边栏可取到数据。
 *
 * 这**不能**代替真站验收：真实站点的接口结构、登录态、刷新时机仍需人工验证。
 *
 * 用法：node scripts/e2e-live.mjs [--headed]
 * 退出码：0 全通过；1 有失败。
 */
import {chromium} from 'playwright-core';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dist = join(root, 'dist');
const headed = process.argv.includes('--headed');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({name, pass, detail});
  console.log(`${pass ? '  ✔' : '  ✘'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ---------- 构造夹具 ----------
const snapshot = JSON.parse(await readFile(join(root, 'src', 'data', 'verified-seat-snapshot.json'), 'utf8'));
const WITH_RESV = 7;
const seats = snapshot.seats.map((s, i) => ({
  devId: s.devId,
  devName: s.devName,
  roomId: s.roomId,
  roomName: s.roomName,
  coordinate: s.coordinate,
  devStatus: s.devStatus,
  openState: s.openState,
  openStart: '08:30',
  openEnd: '21:40',
  onlyView: false,
  ...(i < WITH_RESV
    ? {
        resvInfo: [
          {
            startTime: '2026-11-02 09:00:00',
            endTime: '2026-11-02 11:00:00',
            resvStatus: 0,
            title: {trueName: '测试甲'},
            trueName: '测试甲',
            logonName: 'leaked-account',
          },
        ],
      }
    : {}),
}));
const reserveBody = JSON.stringify({code: 0, message: '查询成功', data: seats});

const fakePage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>本地伪造座位页</title></head>
<body>
<div class="seat"><h3>电子阅览室</h3></div>
<div class="seat-area">${snapshot.seats
  .map((s, i) => {
    const [x, y] = s.coordinate.split(',');
    const cls = i < 10 ? 'green' : i < 56 ? 'yellowGreen' : 'yellow';
    const title = i < 10 ? s.devName : `${s.devName}\n空闲时间：\n21:30 - 21:40`;
    return `<div class="draggable ${cls}" style="left:${x}%;top:${y}%;" title="${title}"><em>${s.devName}</em></div>`;
  })
  .join('')}</div>
<script>
(function () {
  var x = new XMLHttpRequest();
  x.open('GET', '/ic-web/reserve?roomIds=100455855&resvDates=2026-11-02');
  x.onload = function () { window.__pageXhrDone = (x.responseText || '').length; };
  x.send();
})();
</script>
</body></html>`;

// ---------- 启动浏览器 ----------
const profile = await mkdtemp(join(tmpdir(), 'lsa-e2e-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge',
    headless: !headed,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run'],
  });
  check('浏览器启动（Microsoft Edge）', true, `headless=${!headed}`);

  await context.route('https://seats.dlmu.edu.cn/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/ic-web/reserve')) {
      return route.fulfill({status: 200, contentType: 'application/json; charset=utf-8', body: reserveBody});
    }
    return route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: fakePage});
  });

  // service worker → 扩展 ID
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', {timeout: 15000}).catch(() => null);
  check('Service Worker 已注册', Boolean(worker), worker ? worker.url() : '未捕获到');
  if (!worker) throw new Error('扩展未加载，无法继续');

  const extId = new URL(worker.url()).host;
  check('扩展 ID 取得', /^[a-p]{32}$/.test(extId), extId);

  // 打开「真实域名」的伪造页 → content script 按 matches 注入
  const page = await context.newPage();
  await page.goto('https://seats.dlmu.edu.cn/#/ic/seatPredetermine/100455855', {waitUntil: 'domcontentloaded'});
  await page.waitForTimeout(500);

  const pageXhr = await page.evaluate(() => window.__pageXhrDone || 0);
  check('伪造页面自身 XHR 完成', pageXhr > 1000, `${pageXhr} 字节`);

  // 在扩展页面上下文里，直接向内容脚本发消息（不依赖「当前活动标签页」）
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`, {waitUntil: 'domcontentloaded'});
  await panel.waitForTimeout(600);

  const panelTitle = await panel.title();
  check('侧边栏文档可加载', panelTitle.includes('海大图书馆预约助手'), panelTitle);

  const liveReply = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({url: 'https://seats.dlmu.edu.cn/*'});
    if (!tabs.length) return {error: '未找到目标标签页'};
    return await chrome.tabs.sendMessage(tabs[0].id, {type: 'GET_LIVE'});
  });

  check('GET_LIVE 有响应', Boolean(liveReply && liveReply.ok), JSON.stringify(liveReply?.error ?? 'ok'));
  check('hook 已安装并捕获', liveReply?.hookSeen === true, `捕获次数=${liveReply?.capturedCount}`);
  check('同一响应不重复计数', liveReply?.capturedCount === 1, `捕获次数=${liveReply?.capturedCount}`);
  check('实时座位数 = 152', liveReply?.live?.summary?.total === 152, String(liveReply?.live?.summary?.total));
  check(
    '含预约记录的座位数正确',
    liveReply?.live?.summary?.withResv === WITH_RESV,
    `${liveReply?.live?.summary?.withResv} / 期望 ${WITH_RESV}`,
  );
  check('房间识别为电子阅览室', liveReply?.live?.snapshot?.rooms?.[0]?.roomName === '电子阅览室', liveReply?.live?.snapshot?.rooms?.[0]?.roomName);
  check(
    'devStatus 原样保留未被解释',
    liveReply?.live?.snapshot?.seats?.every((s) => s.status === 'UNKNOWN' && s.devStatus === 0),
    '全部 status=UNKNOWN 且 devStatus=0',
  );

  const serialized = JSON.stringify(liveReply);
  check('他人姓名未进入扩展', !serialized.includes('测试甲'));
  check('他人账号未进入扩展', !serialized.includes('leaked-account'));

  const domReply = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({url: 'https://seats.dlmu.edu.cn/*'});
    return await chrome.tabs.sendMessage(tabs[0].id, {type: 'READ_PAGE_SEATS'});
  });
  check('DOM 读取成功', domReply?.ok === true, domReply?.error ?? 'ok');
  check('DOM 座位数 = 152', domReply?.dom?.count === 152, String(domReply?.dom?.count));
  check('DOM 路由校验通过', domReply?.dom?.route?.includes('seatPredetermine'), domReply?.dom?.route);
  check('DOM 状态类被统计', (domReply?.dom?.classCounts?.green ?? 0) === 10, JSON.stringify(domReply?.dom?.classCounts));
  check('DOM 空闲时段被识别', domReply?.dom?.withFreeIntervals === 142, String(domReply?.dom?.withFreeIntervals));

  // 错误路径：只有目标源标签页被注入（先让无关站点真的打开）
  await context.route('https://example.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><title>无关站点</title><p>not the target</p>',
    }),
  );
  const outside = await context.newPage();
  await outside.goto('https://example.com/', {waitUntil: 'domcontentloaded'});
  await outside.waitForTimeout(300);

  // 注意：tabs.query({url}) 本身受 host 权限限制，因此改为遍历全部标签页并逐个试探
  const spread = await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const injected = [];
    for (const t of tabs) {
      if (t.id == null) continue;
      try {
        const r = await chrome.tabs.sendMessage(t.id, {type: 'GET_LIVE'});
        if (r && r.ok) injected.push(t.id);
      } catch {
        /* 未注入 → 抛错，属预期 */
      }
    }
    return {total: tabs.length, injected};
  });
  check(
    '只有目标源标签页被注入内容脚本',
    spread.injected.length === 1,
    `共 ${spread.total} 个标签页，被注入 ${spread.injected.length} 个`,
  );

  // 界面层：把伪造页置前，让侧边栏的「当前活动标签页」指向它，再点刷新看渲染结果
  await page.bringToFront();
  await panel.locator('.legacy-tools > summary').click();
  await panel.click('#live-refresh');
  await panel.waitForTimeout(600);
  const panelText = await panel.locator('#live-section').innerText().catch(() => '');
  check('侧边栏渲染实时座位数', panelText.includes('152'), panelText.includes('实时座位数') ? '含「实时座位数」' : '未见该行');
  check('侧边栏标注响应旁路已运行', panelText.includes('已安装并运行'));
  check('侧边栏仍标注 UNKNOWN', panelText.includes('UNKNOWN'));

  // 实时座位地图：152 个可点按钮，且与历史快照区域互不干扰
  const liveSeatCount = await panel.locator('#live-seat-map .live-seat').count();
  check('实时座位地图渲染 152 个座位', liveSeatCount === 152, String(liveSeatCount));

  const positioned = await panel.locator('#live-seat-map .live-seat').evaluateAll((els) =>
    els.filter((el) => el.style.left && el.style.top).length,
  );
  check('实时座位带坐标定位', positioned === 152, `${positioned}/152`);

  const firstSeat = panel.locator('#live-seat-map .live-seat').first();
  await firstSeat.click();
  await panel.waitForTimeout(200);
  const selectedText = await panel.locator('#live-selected').innerText();
  check('点选实时座位显示 devId 与预约记录条数', /devId \d+/.test(selectedText) && selectedText.includes('预约时间记录'), selectedText.slice(0, 90));
  check('点选后仍不改写状态为可用', selectedText.includes('UNKNOWN') && !selectedText.includes('可预约'));

  // 搜索过滤
  await panel.fill('#live-search', '1D-152');
  await panel.waitForTimeout(250);
  const filtered = await panel.locator('#live-seat-map .live-seat').count();
  check('实时座位搜索生效', filtered === 1, `${filtered} 个`);
  await panel.fill('#live-search', '');
  await panel.waitForTimeout(200);

  // 自动更新：SPA 异步渲染座位，面板打开得早会读不到 152 个。
  // 这里改一个座位的 title（去掉空闲时段），验证侧边栏无需手动点刷新就会跟着变。
  await page.bringToFront();
  await page.evaluate(() => {
    const nodes = document.querySelectorAll('.seat-area .draggable');
    const target = nodes[10];
    target.setAttribute('title', target.querySelector('em').textContent.trim());
  });
  await panel.waitForTimeout(1800);
  const domAfter = await panel.locator('#live-dom').innerText();
  check('页面 DOM 变化后侧边栏自动更新', domAfter.includes('141'), domAfter.split('\n').find((l) => l.includes('空闲时段')) ?? '(未见该行)');
} catch (e) {
  check('执行过程未抛异常', false, e.message);
} finally {
  if (context) await context.close().catch(() => {});
  await rm(profile, {recursive: true, force: true}).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${results.length - failed.length}/${results.length} 项通过 ====`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? ' :: ' + f.detail : ''));
  process.exit(1);
}
