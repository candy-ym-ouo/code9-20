import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

/**
 * 风格相似推荐闭环（文档 15.4）：
 * 四维可解释打分 → 反馈影响排序 → 重置恢复 → 重复查询顺序一致。
 */

let app: Express;
let token = '';
let libraryId = '';
let tmpDir = '';

const ids: Record<string, string> = {};
let tagIds: Record<string, string> = {};

function call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

// 延迟加载 db 模块：必须在 beforeAll 设置完环境变量之后才能初始化
let dbModule: typeof import('../src/db.js');

function insertPalette(inspirationId: string, palette: { hex: string; ratio: number }[]): void {
  // 直接写库只是为了跳过图片管线（本测试关注的是推荐逻辑，不是色板提取）
  const id = dbModule.newId();
  dbModule
    .getDb()
    .prepare(
      `INSERT INTO asset (id, library_id, inspiration_id, role, file_path, palette, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      libraryId,
      inspirationId,
      'reference',
      `/tmp/${id}.jpg`,
      dbModule.toJson(palette),
      dbModule.nowIso(),
      dbModule.nowIso(),
    );
}

async function makeCard(opts: {
  title: string;
  tagIds?: string[];
  cameraBearing?: number;
  azimuthRange?: [number, number];
  palette?: { hex: string; ratio: number }[];
}): Promise<string> {
  const created = await call('post', '/api/inspirations', { title: opts.title });
  const id = created.body.id as string;
  if (opts.tagIds?.length) {
    await call('post', '/api/inspirations/bulk-tag', { ids: [id], addTagIds: opts.tagIds });
  }
  if (opts.cameraBearing !== undefined) {
    const place = await call('post', '/api/places', { name: `地点-${opts.title}`, city: '上海' });
    const spot = await call('post', '/api/spots', {
      placeId: place.body.id,
      lat: 31.24,
      lng: 121.44,
      cameraBearing: opts.cameraBearing,
    });
    await call('post', `/api/inspirations/${id}/spot`, { spotId: spot.body.id });
  }
  if (opts.azimuthRange) {
    await call('put', `/api/inspirations/${id}/timing`, {
      timeAnchor: 'sunset_minus',
      anchorOffsetMin: 40,
      elevationRange: [-4, 10],
      azimuthRange: opts.azimuthRange,
      azimuthTolerance: 15,
      windowToleranceMin: 12,
      weatherProfile: {},
      seasonWindow: null,
      notes: null,
    });
  }
  if (opts.palette) insertPalette(id, opts.palette);
  return id;
}

const RED = [
  { hex: '#c0392b', ratio: 0.6 },
  { hex: '#e74c3c', ratio: 0.4 },
];
const BLUE = [
  { hex: '#2980b9', ratio: 0.6 },
  { hex: '#3498db', ratio: 0.4 },
];

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-similar-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();
  dbModule = await import('../src/db.js');
  const reg = await call('post', '/api/auth/register', {
    email: 'similar@test.local',
    password: 'password123',
    displayName: '相似推荐测试',
  });
  token = reg.body.token;
  libraryId = reg.body.user.libraryId;

  const tags = await call('get', '/api/tags');
  const flat = (tags.body.items as { children?: { id: string; name: string }[] }[]).flatMap(
    (g) => g.children ?? [],
  );
  tagIds = Object.fromEntries(flat.map((t) => [t.name, t.id]));

  // 种子卡：红色调 + 逆光/连廊 + 机位 90° + 光位 200°
  ids.seed = await makeCard({
    title: '种子-连廊逆光',
    tagIds: [tagIds['逆光'], tagIds['连廊']],
    cameraBearing: 90,
    azimuthRange: [190, 210],
    palette: RED,
  });
  // A：几乎完全一致 → 应排第一
  ids.a = await makeCard({
    title: '候选A-同款',
    tagIds: [tagIds['逆光'], tagIds['连廊']],
    cameraBearing: 95,
    azimuthRange: [195, 205],
    palette: RED,
  });
  // B：标签减半、光位机位略偏 → 居中
  ids.b = await makeCard({
    title: '候选B-半像',
    tagIds: [tagIds['逆光']],
    cameraBearing: 100,
    azimuthRange: [180, 200],
    palette: RED,
  });
  // C：全维度都差 → 垫底
  ids.c = await makeCard({
    title: '候选C-不像',
    tagIds: [tagIds['顶光']],
    cameraBearing: 280,
    azimuthRange: [0, 20],
    palette: BLUE,
  });
  // D：什么数据都没有 → 无法比较，不应出现在列表里
  ids.d = await makeCard({ title: '候选D-空白' });
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function similarItems(): Promise<Record<string, unknown>[]> {
  const res = await call('get', `/api/inspirations/${ids.seed}/similar?limit=10`);
  expect(res.status).toBe(200);
  return res.body.items as Record<string, unknown>[];
}

function idsOf(items: Record<string, unknown>[]): string[] {
  return items.map((i) => (i.inspiration as { id: string }).id);
}

describe('风格相似 · 四维可解释打分', () => {
  it('排序符合直觉：A > B > C；空白卡 D 被排除', async () => {
    const items = await similarItems();
    expect(idsOf(items)).toEqual([ids.a, ids.b, ids.c]);
    const scores = items.map((i) => i.score as number);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });

  it('每个结果都带四个维度的分数与可复算理由，权重归一化', async () => {
    const items = await similarItems();
    for (const item of items) {
      const dims = item.dimensions as {
        key: string;
        label: string;
        weight: number;
        score: number | null;
        reason: string;
      }[];
      expect(dims.map((d) => d.key)).toEqual(['palette', 'tag', 'light', 'camera']);
      for (const d of dims) {
        expect(d.reason.length).toBeGreaterThan(0);
        expect(d.weight).toBeGreaterThan(0);
        expect(d.score).not.toBeNull();
      }
      const weightSum = dims.reduce((s, d) => s + d.weight, 0);
      expect(weightSum).toBeCloseTo(1, 6);
    }
    const a = items[0];
    const dims = a.dimensions as { key: string; score: number; reason: string }[];
    expect(dims[0].score).toBeCloseTo(1, 6); // 色板完全一致
    expect(dims[1].score).toBeCloseTo(1, 6); // 标签完全一致
    expect(dims[2].reason).toContain('相差 0°'); // 光位中心相同
    expect(dims[3].reason).toContain('机位朝向');
    // 无反馈时：最终分 = 基础分，调整量为 0
    expect(a.feedbackSignal).toBeNull();
    expect(a.feedbackDelta).toBe(0);
    expect(a.score).toBeCloseTo(a.baseScore as number, 12);
  });

  it('重复查询返回完全一致的顺序', async () => {
    const first = idsOf(await similarItems());
    const second = idsOf(await similarItems());
    expect(second).toEqual(first);
  });
});

describe('风格相似 · 反馈影响排序且可重置', () => {
  it('点踩第一名后它掉到第二，调整量与最终分可解释', async () => {
    const fb = await call('post', `/api/inspirations/${ids.seed}/similar/feedback`, {
      targetId: ids.a,
      signal: 'down',
    });
    expect(fb.status).toBe(200);
    expect(fb.body.feedbackCount).toBe(1);

    const items = await similarItems();
    expect(idsOf(items)).toEqual([ids.b, ids.a, ids.c]);
    const a = items[1];
    expect(a.feedbackSignal).toBe('down');
    expect(a.feedbackDelta).toBeLessThan(0);
    expect(a.score).toBeCloseTo((a.baseScore as number) + (a.feedbackDelta as number), 6);
  });

  it('点赞加分但不超过 1；同一对重复反馈只保留最新信号', async () => {
    await call('post', `/api/inspirations/${ids.seed}/similar/feedback`, {
      targetId: ids.c,
      signal: 'up',
    });
    // 重复提交改为 down：覆盖而不是叠加
    await call('post', `/api/inspirations/${ids.seed}/similar/feedback`, {
      targetId: ids.c,
      signal: 'down',
    });
    await call('post', `/api/inspirations/${ids.seed}/similar/feedback`, {
      targetId: ids.c,
      signal: 'up',
    });
    const res = await call('get', `/api/inspirations/${ids.seed}/similar?limit=10`);
    expect(res.body.feedbackCount).toBe(2); // A 的 down + C 的 up（覆盖不重复计数）
    const c = (res.body.items as Record<string, unknown>[]).find(
      (i) => (i.inspiration as { id: string }).id === ids.c,
    )!;
    expect(c.feedbackSignal).toBe('up');
    expect(c.feedbackDelta).toBeCloseTo(0.12, 6);
    expect(c.score).toBeCloseTo(Math.min(1, (c.baseScore as number) + 0.12), 6);
  });

  it('反馈后的排序依然是确定性的（连续两次查询顺序一致）', async () => {
    const first = idsOf(await similarItems());
    const second = idsOf(await similarItems());
    expect(second).toEqual(first);
  });

  it('可撤销单条反馈', async () => {
    const del = await call('delete', `/api/inspirations/${ids.seed}/similar/feedback/${ids.c}`);
    expect(del.status).toBe(200);
    expect(del.body.feedbackCount).toBe(1);
    const items = await similarItems();
    const c = items.find((i) => (i.inspiration as { id: string }).id === ids.c)!;
    expect(c.feedbackSignal).toBeNull();
    expect(c.score).toBeCloseTo(c.baseScore as number, 12);
  });

  it('重置清空全部反馈，排序恢复到初始状态', async () => {
    const reset = await call('post', `/api/inspirations/${ids.seed}/similar/feedback/reset`);
    expect(reset.status).toBe(200);
    expect(reset.body.cleared).toBe(1); // 只剩 A 的一条

    const res = await call('get', `/api/inspirations/${ids.seed}/similar?limit=10`);
    expect(res.body.feedbackCount).toBe(0);
    const items = res.body.items as Record<string, unknown>[];
    expect(idsOf(items)).toEqual([ids.a, ids.b, ids.c]);
    for (const item of items) {
      expect(item.feedbackSignal).toBeNull();
      expect(item.feedbackDelta).toBe(0);
      expect(item.score).toBeCloseTo(item.baseScore as number, 12);
    }
  });

  it('不能对种子卡本身反馈；不存在的候选返回 404', async () => {
    const self = await call('post', `/api/inspirations/${ids.seed}/similar/feedback`, {
      targetId: ids.seed,
      signal: 'up',
    });
    expect(self.status).toBe(400);
    const missing = await call('post', `/api/inspirations/${ids.seed}/similar/feedback`, {
      targetId: 'no-such-card',
      signal: 'up',
    });
    expect(missing.status).toBe(404);
    const badSignal = await call('post', `/api/inspirations/${ids.seed}/similar/feedback`, {
      targetId: ids.a,
      signal: 'meh',
    });
    expect(badSignal.status).toBe(400);
  });
});
