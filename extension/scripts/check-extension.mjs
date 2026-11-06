#!/usr/bin/env node
/**
 * 扩展产物静态校验（不依赖浏览器）。
 *
 * 校验内容：
 *  1. manifest.json 是合法 JSON，关键 MV3 字段齐全且类型正确。
 *  2. manifest 引用的每个文件都真实存在于 dist/。
 *  3. MAIN world 的 hook.js 不含 chrome.* 调用（该世界没有扩展 API）。
 *  4. 权限清单未被悄悄扩大。
 *  5. content script 与 hook 的运行时机符合设计（hook 必须 document_start）。
 *
 * 用法：node scripts/check-extension.mjs [dist 目录]
 * 退出码：0 通过；1 失败。
 */
import {readFileSync, existsSync, statSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.argv[2] ?? join(here, '..', 'dist'));

const errors = [];
const notes = [];
const fail = (m) => errors.push(m);
const ok = (m) => notes.push(m);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`无法解析 ${path}: ${e.message}`);
    return null;
  }
}

function requireFile(rel, label) {
  const p = join(dist, rel);
  if (!existsSync(p)) return fail(`${label}: 缺少文件 ${rel}`);
  if (statSync(p).size === 0) return fail(`${label}: 文件为空 ${rel}`);
  ok(`${label}: ${rel} (${statSync(p).size} B)`);
  return p;
}

if (!existsSync(dist)) {
  console.error(`dist 目录不存在: ${dist}`);
  process.exit(1);
}

const manifest = readJson(join(dist, 'manifest.json'));
if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version 必须为 3');
  else ok('manifest_version = 3');

  for (const key of ['name', 'version', 'description']) {
    if (typeof manifest[key] !== 'string' || !manifest[key]) fail(`缺少字符串字段 ${key}`);
  }
  if (!manifest.background?.service_worker) fail('缺少 background.service_worker');
  else requireFile(manifest.background.service_worker, 'service worker');

  if (!manifest.side_panel?.default_path) fail('缺少 side_panel.default_path');
  else requireFile(manifest.side_panel.default_path, '侧边栏');

  for (const [size, rel] of Object.entries(manifest.icons ?? {})) requireFile(rel, `图标 ${size}`);
  if (manifest.action?.default_icon) {
    for (const [size, rel] of Object.entries(manifest.action.default_icon)) requireFile(rel, `action 图标 ${size}`);
  }

  const scripts = manifest.content_scripts ?? [];
  if (scripts.length < 2) fail('应至少有两个 content_scripts（hook + content）');
  const hook = scripts.find((s) => s.world === 'MAIN');
  const isolated = scripts.find((s) => s.world !== 'MAIN');
  if (!hook) fail('缺少 world=MAIN 的 hook 注入条目');
  if (!isolated) fail('缺少 ISOLATED world 的 content script');

  if (hook) {
    if (hook.run_at !== 'document_start') fail('hook 必须 run_at=document_start，否则抓不到早期请求');
    else ok('hook run_at = document_start');
    for (const js of hook.js ?? []) {
      const p = requireFile(js, 'hook 脚本');
      if (p) {
        const src = readFileSync(p, 'utf8');
        if (/\bchrome\.\w/.test(src)) fail(`${js} 在 MAIN world 中使用了 chrome.* API（运行时不可用）`);
        else ok(`${js} 未使用 chrome.* API`);
        if (!src.includes('/ic-web/reserve')) fail(`${js} 未包含目标路径常量`);
      }
    }
    for (const pattern of hook.matches ?? []) {
      if (!pattern.startsWith('https://seats.dlmu.edu.cn/')) fail(`hook matches 越界: ${pattern}`);
    }
  }
  if (isolated) {
    if (isolated.run_at !== 'document_idle') fail('content script 应 run_at=document_idle');
    for (const js of isolated.js ?? []) requireFile(js, 'content 脚本');
  }

  const allowed = new Set(['storage', 'alarms', 'sidePanel', 'activeTab', 'notifications']);
  for (const p of manifest.permissions ?? []) {
    if (!allowed.has(p)) fail(`出现未预期的权限: ${p}（若确有需要，请先更新本校验脚本与文档）`);
  }
  ok(`permissions = ${(manifest.permissions ?? []).join(',')}`);

  const hosts = manifest.host_permissions ?? [];
  if (hosts.length !== 1 || hosts[0] !== 'https://seats.dlmu.edu.cn/*') {
    fail(`host_permissions 应精确限定为单域，实际: ${JSON.stringify(hosts)}`);
  } else ok('host_permissions 仅限目标域');

  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("connect-src 'none'")) {
    notes.push('提示：CSP 未包含 connect-src none（若已决定允许扩展自身联网，请显式说明）');
  } else ok("CSP connect-src 'none'（扩展自身仍不联网）");
}

console.log('==== 通过项 ====');
for (const n of notes) console.log('  ✔ ' + n);
if (errors.length) {
  console.log('\n==== 失败项 ====');
  for (const e of errors) console.log('  ✘ ' + e);
  process.exit(1);
}
console.log('\n全部校验通过。');
