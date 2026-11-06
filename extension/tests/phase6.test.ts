/**
 * Phase 6 测试：resvStatus 登记、安全审计、脚本保护、规则冲突区分。
 *
 * 说明：这些测试本身**不得**包含任何真实个人信息。
 * 敏感值一律以模式或哈希的形式检查，不在断言里写明文。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {legacyPath, legacyRoot} from './legacy-root';
import {
  RESV_STATUS_OBSERVED,
  canInferLifecycle,
  describeResvStatus,
  describeShare,
  isObservedButUnclear,
} from '../src/core/resv-status';
import {
  OBSERVED_DURATION_BOUNDS,
  OFFICIAL_DURATION_TEXT,
  effectiveMinDuration,
  hasMinDurationConflict,
  ruleById,
} from '../src/core/rule-model';

const projectRoot = legacyRoot;
const repoRoot = legacyPath('..');
const read = (rel: string) => readFileSync(legacyPath(rel), 'utf8');

// ---------------------------------------------------------------------------
// 1–3. resvStatus 登记与 1029 的独立性
// ---------------------------------------------------------------------------
test('1027：登记为「未开始样」相关，且相关比例不得被夸大', () => {
  const o = describeResvStatus(1027);
  assert.ok(o);
  assert.equal(o.hint, 'NOT_STARTED_LIKE');
  assert.equal(o.grade, 'B');
  assert.ok((o.inProgressShare ?? 1) < 0.2, '1027 的进行中占比应较低');
});

test('1093：登记为「进行中样」相关，比例 > 90%，但不得宣称业务含义', () => {
  const o = describeResvStatus(1093);
  assert.ok(o);
  assert.equal(o.hint, 'IN_PROGRESS_LIKE');
  assert.ok((o.inProgressShare ?? 0) > 0.9);
  assert.match(o.note, /未确认|不明/);
});

test('1029 必须独立：不得并入 1027 或 1093，且不得用于推断生命周期', () => {
  const o = describeResvStatus(1029);
  assert.ok(o);
  assert.equal(o.hint, 'UNKNOWN');
  assert.equal(o.grade, 'D');
  assert.equal(isObservedButUnclear(1029), true);
  assert.equal(canInferLifecycle(1029), false, '1029 样本不足，不得据此推断生命周期');

  // 三者的位组合互不相同
  const bits = [1027, 1029, 1093].map((v) => describeResvStatus(v)!.bits.join('+'));
  assert.equal(new Set(bits).size, 3, '三个取值的位组合应互不相同');
  assert.notDeepEqual(describeResvStatus(1029)!.bits, describeResvStatus(1093)!.bits);
});

test('未登记的取值一律返回 null，不得猜测', () => {
  for (const v of [2048, 0, 1, 7, 128, null, undefined, '1027' as unknown as number]) {
    assert.equal(describeResvStatus(v), null, `${String(v)} 不应有登记`);
    assert.equal(canInferLifecycle(v), false);
  }
});

test('登记表自身一致性：值唯一、位与值自洽、有人话说明', () => {
  const values = RESV_STATUS_OBSERVED.map((o) => o.value);
  assert.equal(new Set(values).size, values.length, '取值不得重复');
  for (const o of RESV_STATUS_OBSERVED) {
    const sum = o.bits.reduce((s, b) => s + b, 0);
    assert.equal(sum, o.value, `${o.value} 的位之和应等于其本身`);
    assert.ok(o.note.length > 0);
    assert.ok(describeShare(o.value).length > 0);
  }
});

// ---------------------------------------------------------------------------
// 4. 30 分钟：视觉分类阈值 vs 预约政策
// ---------------------------------------------------------------------------
test('30 分钟是「视觉分类阈值」与「政策」的区分必须成立', () => {
  // 视觉阈值：siteSeatClass 的默认参数（对网页行为的建模）
  // 政策：rule-model 里因冲突而恒为 null
  assert.equal(effectiveMinDuration(), null, '最短时长仍有来源冲突，生效政策值必须为 null');
  const rule = ruleById('min-duration');
  assert.equal(rule?.status, 'CONFLICT');
  assert.ok(rule?.conflict);
  assert.match(rule.conflict.officialSide, /60|1/);
  assert.match(rule.conflict.observedSide, /30/);
});

test('系统实测执行区间 30–240 分钟，且与官方口径在「下限」冲突、在「上限」一致', () => {
  assert.deepEqual(
    {min: OBSERVED_DURATION_BOUNDS.minMinutes, max: OBSERVED_DURATION_BOUNDS.maxMinutes},
    {min: 30, max: 240},
  );
  assert.equal(OBSERVED_DURATION_BOUNDS.grade, 'B');
  assert.equal(OFFICIAL_DURATION_TEXT.minHours * 60, 60);
  assert.equal(OFFICIAL_DURATION_TEXT.maxHours * 60, OBSERVED_DURATION_BOUNDS.maxMinutes, '上限一致（4 小时）');
  assert.notEqual(OFFICIAL_DURATION_TEXT.minHours * 60, OBSERVED_DURATION_BOUNDS.minMinutes, '下限冲突（60 vs 30）');
  assert.equal(hasMinDurationConflict(), true, '冲突未消解，必须保持 NEEDS_REVIEW');
});

test('实测区间来自真实探针证据，且探针脚本不点击确认', () => {
  const probe = readFileSync(join(projectRoot, 'research', 'phase6', 'evidence', 'duration-probe-start1530.json'), 'utf8');
  const parsed = JSON.parse(probe) as {conclusion: {minDeltaMinutes: number; maxDeltaMinutes: number; start: string}};
  assert.equal(parsed.conclusion.minDeltaMinutes, 30);
  assert.equal(parsed.conclusion.maxDeltaMinutes, 240);
  assert.equal(parsed.conclusion.start, '15:30');

  const script = read('scripts/study-duration-probe.mjs');
  assert.equal(script.includes('确认'), true, '脚本应明确声明不点击确认');
  assert.equal(/\.click\([^)]*确认/.test(script), false, '不得点击确认按钮');
});

// ---------------------------------------------------------------------------
// 5. 登录页保护：采集脚本不得读取登录表单
// ---------------------------------------------------------------------------
test('采集脚本不得包含登录表单选择器（唯一例外：scripts/lib/login.mjs）', () => {
  const scriptsDir = join(projectRoot, 'scripts');
  const loginModule = join(scriptsDir, 'lib', 'login.mjs');

  const targets: Array<{name: string; text: string}> = readdirSync(scriptsDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => ({name: f, text: readFileSync(join(scriptsDir, f), 'utf8')}));
  assert.ok(targets.length >= 4, `应扫到采集脚本，实际 ${targets.length} 个`);

  const forbidden = [
    'input[name="username"]',
    "input[name='username']",
    'input[type="password"]',
    'name="password"',
    "name='password'",
    'placeholder*="学工号"',
  ];

  // 除 lib/login.mjs 外，任何脚本都不得出现登录表单选择器
  for (const s of targets) {
    for (const f of forbidden) {
      assert.equal(s.text.includes(f), false, `${s.name} 含禁止的登录表单选择器: ${f}`);
    }
  }

  // 唯一例外必须存在（Phase 7.1 用户授权后代为登录，能力隔离到该模块）
  const loginText = readFileSync(loginModule, 'utf8');
  assert.ok(loginText.length > 0, 'scripts/lib/login.mjs 必须存在');
  assert.ok(loginText.includes('input[name="username"]'), '登录模块应包含登录表单选择器');
});

test('登录模块受更严格约束：只读环境变量、不写文件、不回显密码', () => {
  const loginText = readFileSync(join(projectRoot, 'scripts', 'lib', 'login.mjs'), 'utf8');
  assert.match(loginText, /process\.env/);
  assert.match(loginText, /LSA_USER|LSA_PASS/);
  assert.equal(/writeFile|appendFile|createWriteStream/.test(loginText), false, '登录模块不得写文件');
  assert.equal(/localStorage|sessionStorage|document\.cookie/.test(loginText), false, '登录模块不得读写浏览器存储');
  assert.equal(/console\.(log|info|error)\([^)]*pass/i.test(loginText), false, '登录模块不得回显密码');
});

test('采集脚本在读取页面前必须先确认座位页', () => {
  for (const name of ['study-watch.mjs', 'study-capture.mjs', 'study-inspect.mjs', 'capture-live.mjs']) {
    const text = read(`scripts/${name}`);
    assert.match(text, /seatPredetermine|seat-area/, `${name} 应校验座位页特征`);
    assert.match(text, /未到达座位页|未到座位页|超时/, `${name} 应有未到达座位页的退出路径`);
  }
});

// ---------------------------------------------------------------------------
// 6. 证据与日志脱敏
// ---------------------------------------------------------------------------
test('Phase 5/6 的证据文件不含他人身份字段', () => {
  const dirs = ['research/phase5/evidence/', 'research/live/2026-11-02/'];
  const identityKeys = ['trueName', 'logonName', 'realName', 'resvId'];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(legacyPath(dir)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const text = read(`${dir}${f}`);
      for (const key of identityKeys) {
        assert.equal(text.includes(key), false, `${dir}${f} 含身份字段 ${key}`);
      }
    }
  }
});

test('仓库文档里不得出现独立的 10 位数字（学工号形态），十六进制哈希除外', () => {
  const files = execFileSync('git', ['ls-files'], {cwd: repoRoot, encoding: 'utf8'}).split('\n').filter(Boolean);
  const offenders: string[] = [];
  for (const rel of files) {
    if (/\.(png|ico|jpg|jpeg|zip|glb)$/i.test(rel)) continue;
    let text: string;
    try {
      text = readFileSync(new URL(rel, new URL(`file:///${repoRoot.replace(/\\/g, '/')}/`)), 'utf8');
    } catch {
      continue;
    }
    if (/(?<![0-9A-Za-z])\d{10}(?![0-9A-Za-z])/.test(text) && !/(common|chunk-common)/i.test(rel)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `以下文件含独立的 10 位数字: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 7. Git 历史敏感数据检查
// ---------------------------------------------------------------------------
test('Git 历史中我们编写的文件从未出现独立的 10 位数字（个人数据）', () => {
  // 一次取出我们这些目录的全部历史 diff，再在 Node 里用 lookbehind 精确匹配，
  // 避免把十六进制哈希里的数字段误判为学工号。
  const patch = execFileSync(
    'git',
    [
      'log',
      '--all',
      '-p',
      '--',
      'library-seat-assistant/src',
      'library-seat-assistant/scripts',
      'library-seat-assistant/tests',
      'library-seat-assistant/docs',
      'library-seat-assistant/research',
      // 排除原 Codex 阶段抓取的站点打包产物（含 2^32-1 之类的库常数）
      ':!library-seat-assistant/research/phase2/evidence',
      'reports',
    ],
    {cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024},
  );
  const hit = /(?<![0-9A-Za-z])\d{10}(?![0-9A-Za-z])/.exec(patch);
  assert.equal(hit, null, `历史中出现疑似 10 位个人编号（位置 ${hit?.index}）`);
});

test('历史上唯一出现过的登录表单选择器已被移除，且从未读取其值', () => {
  // 见 security-audit.md §5：早期版本的 study-diagnose.mjs 曾用
  // input[name="username"] 仅做“是否存在登录表单”的计数判断，未读取 value。
  const current = read('scripts/study-diagnose.mjs');
  assert.equal(current.includes('input[name="username"]'), false, '当前版本必须已移除该选择器');
  assert.match(current, /redirectedToAuth/, '当前版本应改用域名判断');
});

test('站点自带 JS 里的登录字段属于原始抓取证据，已在文档中标注', () => {
  const doc = read('research/phase6/security-audit.md');
  assert.match(doc, /common\.js|站点自带|原始抓取/);
});

test('Git 历史中从未提交过 .handover-verify 临时目录', () => {
  const out = execFileSync('git', ['log', '--all', '--pretty=format:', '--name-only', '--diff-filter=A'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(out.includes('handover-verify'), false, '临时目录不应进入任何提交');
});

test('项目根目录存在 .gitignore 且排除了临时目录与备份', () => {
  const ignore = readFileSync(new URL('.gitignore', new URL(`file:///${repoRoot.replace(/\\/g, '/')}/`)), 'utf8');
  assert.match(ignore, /handover-verify/);
  assert.match(ignore, /backups\//);
});

// 保持 projectRoot 被使用（避免未使用变量告警）
test('测试运行目录正确', () => {
  assert.ok(projectRoot.length > 0);
});
