import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  normalizeRegistry, computeSha256, packSkill, installSkill,
  uninstallSkill, checkUpdates, readInstalled, listInstalledSkills, REGISTRY_SCHEMA_VERSION, urlVariants,
} from '../lib/agent/skill-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_SKILLS = path.join(ROOT, 'skills');

function tmpSkillsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ic-market-test-'));
}

// 极简静态服务器：先监听拿到端口，再填路由（索引里要写自己的地址）
function serve() {
  return new Promise((resolve) => {
    const routes = {};
    const server = http.createServer((req, res) => {
      const hit = routes[req.url];
      if (!hit) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('content-type', hit.type || 'application/octet-stream');
      res.end(hit.body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, routes }));
  });
}

test('normalizeRegistry：解析合法索引并归一 latest', () => {
  const reg = normalizeRegistry({
    version: 1,
    skills: [{
      name: 'demo-skill',
      description: '示例',
      versions: { '1.0.0': { url: 'https://x/1.zip', sha256: 'ABC', size: 10 } },
    }],
  });
  assert.equal(reg.version, REGISTRY_SCHEMA_VERSION);
  assert.equal(reg.skills.length, 1);
  assert.equal(reg.skills[0].latest, '1.0.0', '未指定 latest 时取最后一个版本');
  assert.equal(reg.skills[0].versions[0].sha256, 'abc', 'sha256 统一小写');
  assert.equal(reg.skills[0].versions[0].size, 10);
});

test('normalizeRegistry：拒绝含路径分隔符的技能名', () => {
  assert.throws(
    () => normalizeRegistry({ skills: [{ name: '../evil', versions: { '1': { url: 'https://x/a.zip' } } }] }),
    /非法技能名/,
  );
  assert.throws(
    () => normalizeRegistry({ skills: [{ name: 'a\\b', versions: { '1': { url: 'https://x/a.zip' } } }] }),
    /非法技能名/,
  );
});

test('normalizeRegistry：索引版本高于支持版本时报错', () => {
  assert.throws(() => normalizeRegistry({ version: 99, skills: [] }), /高于本程序支持的/);
});

test('normalizeRegistry：跳过没有下载地址的条目，忽略无名条目', () => {
  const reg = normalizeRegistry({
    skills: [
      { name: 'a', versions: { '1': {} } },
      { versions: { '1': { url: 'https://x/a.zip' } } },
      { name: 'b', versions: { '2': { url: 'https://x/b.zip' } } },
    ],
  });
  assert.deepEqual(reg.skills.map((s) => s.name), ['b']);
});

test('computeSha256：与已知向量一致', () => {
  assert.equal(computeSha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(computeSha256(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('packSkill：打出可解包的 zip，sha256 与大小自洽', () => {
  const dir = fs.readdirSync(REAL_SKILLS).find((n) => fs.existsSync(path.join(REAL_SKILLS, n, 'SKILL.md')));
  assert.ok(dir, '仓库里应至少有一个带 SKILL.md 的技能');
  const packed = packSkill(dir, { skillsDir: REAL_SKILLS });
  assert.ok(packed.buffer.length > 0);
  assert.equal(packed.sha256, computeSha256(packed.buffer));
  assert.equal(packed.size, packed.buffer.length);
  assert.equal(packed.entry.sha256, packed.sha256);
});

test('packSkill：非技能目录被拒绝', () => {
  assert.throws(() => packSkill('绝对不存在的目录', { skillsDir: REAL_SKILLS }), /技能目录不存在/);
});

test('installSkill：完整闭环 —— 拉索引、校验 sha256、原子落盘、记录版本', async () => {
  const dir = fs.readdirSync(REAL_SKILLS).find((n) => fs.existsSync(path.join(REAL_SKILLS, n, 'SKILL.md')));
  const packed = packSkill(dir, { skillsDir: REAL_SKILLS });
  const target = tmpSkillsDir();

  const { server, port, routes } = await serve();
  routes['/registry.json'] = {
    type: 'application/json',
    body: JSON.stringify({
      version: 1,
      skills: [{ name: dir, description: '测试用', latest: '1.2.3', versions: { '1.2.3': { url: 'http://127.0.0.1:' + port + '/pkg.zip', sha256: packed.sha256, size: packed.size } } }],
    }),
  };
  routes['/pkg.zip'] = { body: packed.buffer };
  try {
    const r = await installSkill(dir, { url: 'http://127.0.0.1:' + port + '/registry.json', skillsDir: target });
    assert.equal(r.version, '1.2.3');
    assert.ok(fs.existsSync(path.join(target, r.dir, 'SKILL.md')), 'SKILL.md 应落到目标目录');
    const state = readInstalled({ skillsDir: target });
    assert.equal(state.skills[r.dir].version, '1.2.3');
    assert.equal(state.skills[r.dir].sha256, packed.sha256);
    assert.equal(listInstalledSkills({ skillsDir: target }).length, 1);

    // 重复安装 = 升级：目录被整体替换，不产生 _2 之类的新目录
    const again = await installSkill(dir, { url: 'http://127.0.0.1:' + port + '/registry.json', skillsDir: target });
    assert.equal(again.dir, r.dir);
    assert.deepEqual(fs.readdirSync(target).filter((n) => !n.startsWith('.')), [r.dir]);
  } finally {
    server.close();
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('installSkill：sha256 不一致时拒绝，且不落盘', async () => {
  const dir = fs.readdirSync(REAL_SKILLS).find((n) => fs.existsSync(path.join(REAL_SKILLS, n, 'SKILL.md')));
  const packed = packSkill(dir, { skillsDir: REAL_SKILLS });
  const target = tmpSkillsDir();
  const { server, port, routes } = await serve();
  routes['/registry.json'] = {
    type: 'application/json',
    body: JSON.stringify({
      version: 1,
      skills: [{ name: dir, latest: '2.0.0', versions: { '2.0.0': { url: 'http://127.0.0.1:' + port + '/pkg.zip', sha256: 'deadbeef' } } }],
    }),
  };
  routes['/pkg.zip'] = { body: packed.buffer };
  try {
    await assert.rejects(
      () => installSkill(dir, { url: 'http://127.0.0.1:' + port + '/registry.json', skillsDir: target }),
      /校验失败/,
    );
    assert.deepEqual(fs.readdirSync(target), [], '校验失败不应留下任何目录');
  } finally {
    server.close();
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('installSkill：索引缺 sha256 时拒绝安装', async () => {
  const dir = fs.readdirSync(REAL_SKILLS).find((n) => fs.existsSync(path.join(REAL_SKILLS, n, 'SKILL.md')));
  const target = tmpSkillsDir();
  const { server, port, routes } = await serve();
  routes['/registry.json'] = {
    type: 'application/json',
    body: JSON.stringify({ version: 1, skills: [{ name: dir, versions: { '1.0.0': { url: 'http://127.0.0.1:' + port + '/pkg.zip' } } }] }),
  };
  try {
    await assert.rejects(
      () => installSkill(dir, { url: 'http://127.0.0.1:' + port + '/registry.json', skillsDir: target }),
      /缺少 sha256/,
    );
  } finally {
    server.close();
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('uninstallSkill：拒绝卸载非市场安装的技能，force 才删', () => {
  const target = tmpSkillsDir();
  const fake = path.join(target, 'builtin-skill');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, 'SKILL.md'), '---\nname: builtin-skill\n---\n正文');
  try {
    assert.throws(() => uninstallSkill('builtin-skill', { skillsDir: target }), /不是通过技能市场安装的/);
    assert.ok(fs.existsSync(fake), '被拒绝时目录必须还在');
    uninstallSkill('builtin-skill', { skillsDir: target, force: true });
    assert.ok(!fs.existsSync(fake));
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('checkUpdates：区分 current / outdated / missing', async () => {
  const target = tmpSkillsDir();
  fs.writeFileSync(path.join(target, '.registry.json'), JSON.stringify({
    version: 1,
    skills: {
      a: { name: 'a', version: '1.0.0' },
      b: { name: 'b', version: '0.9.0' },
      c: { name: 'c', version: '1.0.0' },
    },
  }));
  const { server, port, routes } = await serve();
  routes['/registry.json'] = {
    type: 'application/json',
    body: JSON.stringify({
      version: 1,
      skills: [
        { name: 'a', latest: '1.0.0', versions: { '1.0.0': { url: 'https://x/a.zip' } } },
        { name: 'b', latest: '1.0.0', versions: { '1.0.0': { url: 'https://x/b.zip' } } },
      ],
    }),
  };
  try {
    const rows = await checkUpdates({ url: 'http://127.0.0.1:' + port + '/registry.json', skillsDir: target });
    const byDir = Object.fromEntries(rows.map((r) => [r.dir, r.status]));
    assert.equal(byDir.a, 'current');
    assert.equal(byDir.b, 'outdated');
    assert.equal(byDir.c, 'missing');
  } finally {
    server.close();
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('urlVariants：raw 与 jsDelivr gh 通道互相生成', () => {
  const raw = 'https://raw.githubusercontent.com/o/r/main/dist-skills/a.zip';
  const jsd = 'https://cdn.jsdelivr.net/gh/o/r@main/dist-skills/a.zip';
  assert.deepEqual(urlVariants(raw), [raw, jsd]);
  assert.deepEqual(urlVariants(jsd), [jsd, raw]);
  assert.deepEqual(urlVariants('https://example.com/a.zip'), ['https://example.com/a.zip'], '非 GitHub 地址不加工');
});
