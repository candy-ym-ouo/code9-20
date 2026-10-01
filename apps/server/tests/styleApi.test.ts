import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import type { StyleRecommendationResult } from '@flil/shared';

let app: Express;
let token = '';
let tmpDir = '';

const cards: Record<string, string> = {};
const tagIds: Record<string, string> = {};

function call(method: 'get' | 'post', url: string, body?: unknown, asToken?: string) {
  let req = request(app)[method](url);
  const t = asToken ?? token;
  if (t) req = req.set('authorization', `Bearer ${t}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

async function makeCard(title: string, tags: string[]): Promise<string> {
  const created = await call('post', '/api/inspirations', { title });
  const id = created.body.id as string;
  if (tags.length) {
    await call('post', '/api/inspirations/bulk-tag', { ids: [id], addTagIds: tags.map((n) => tagIds[n]) });
  }
  return id;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-style-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'fixture';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { getDb, migrate } = await import('../src/db.js');
  migrate();
  app = createApp();
  const db = getDb();

  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'style@test.local', password: 'password123', displayName: '风格测试' });
  token = reg.body.token;
  const libraryId = (
    db.prepare('SELECT library_id AS lid FROM library_member WHERE user_id = (SELECT id FROM user WHERE email = ?)').get(
      'style@test.local',
    ) as { lid: string }
  ).lid;

  const tagsRes = await call('get', '/api/tags');
  const flatten = (nodes: { id: string; name: string; children?: unknown[] }[]): { id: string; name: string }[] =>
    nodes.flatMap((n) => [{ id: n.id, name: n.name }, ...flatten((n.children as never[]) ?? [])]);
  const flat = flatten(tagsRes.body.items as never[]);
  for (const name of ['逆光', '侧逆光', '顺光', '连廊', '霓虹溢光']) {
    const found = flat.find((t) => t.name === name);
    if (!found) throw new Error(`基线缺少标签：${name}；现有：${flat.map((t) => t.name).join('/')}`);
    tagIds[name] = found.id;
  }

  cards.similar = await makeCard('相似卡-逆光连廊', ['逆光', '连廊']);
  cards.mid = await makeCard('中等卡-侧逆光连廊', ['侧逆光', '连廊']);
  cards.diff = await makeCard('差异卡-顺光霓虹', ['顺光', '霓虹溢光']);
  cards.bare = await makeCard('光秃卡-无标签', []);

  // 建两个机位：朝向差 10°
  const place = (
    await call('post', '/api/places', { name: '风格测试地点', city: '上海' })
  ).body.id as string;
  const spotA = (
    await call('post', '/api/spots', { placeId: place, lat: 31.24, lng: 121.44, cameraBearing: 265 })
  ).body.id as string;
  const spotB = (
    await call('post', '/api/spots', { placeId: place, lat: 31.25, lng: 121.45, cameraBearing: 275 })
  ).body.id as string;

  const ts = new Date().toISOString();
  const bindSpot = (inspirationId: string, spotId: string) =>
    db.prepare('UPDATE inspiration SET spot_id = ? WHERE id = ?').run(spotId, inspirationId);
  bindSpot(cards.similar, spotA);
  bindSpot(cards.mid, spotB);
  bindSpot(cards.diff, spotA);

  // 直接写入特征资产：色板完全相同，让差异由标签/光位/机位驱动
  const insertAsset = (inspirationId: string, palette: unknown, sun: { az: number; elev: number } | null) =>
    db.prepare(
      `INSERT INTO asset (id, library_id, inspiration_id, role, file_path, width, height, has_gps_exif,
         palette, sun_elevation, sun_azimuth, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `a_${inspirationId}`,
      libraryId,
      inspirationId,
      'reference',
      '/tmp/fake.jpg',
      800,
      600,
      0,
      JSON.stringify(palette),
      sun ? sun.elev : null,
      sun ? sun.az : null,
      ts,
      ts,
    );
  const palette = [{ hex: '#1a2a3a', ratio: 0.7 }, { hex: '#c9a86a', ratio: 0.3 }];
  insertAsset(cards.similar, palette, { az: 85, elev: 5 }); // 相对 265° 机位的光位角 = 180°（逆光）
  insertAsset(cards.mid, palette, { az: 102, elev: 8 }); // 相对 275° = 187°（侧逆光）
  insertAsset(cards.diff, palette, { az: 265, elev: 60 }); // 相对 265° = 0°（顺光）+ 高仰角
  insertAsset(cards.bare, palette, null);

  // 给源卡和相似卡补"拍摄条件"（期望太阳方位角 = 机位朝向 + 光位角）
  const insertTiming = (inspirationId: string, azimuthCenter: number, elevLo: number, elevHi: number) =>
    db.prepare(
      `INSERT INTO timing (id, library_id, inspiration_id, time_anchor, anchor_offset_min, elevation_range,
         azimuth_range, azimuth_tolerance, window_tolerance_min, weather_profile, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      `t_${inspirationId}`,
      libraryId,
      inspirationId,
      'sunset_minus',
      40,
      JSON.stringify([elevLo, elevHi]),
      JSON.stringify([azimuthCenter, azimuthCenter]),
      15,
      12,
      '{}',
      ts,
      ts,
    );
  insertTiming(cards.similar, 85, 0, 10); // 265 + 180 = 85
  insertTiming(cards.mid, 102, 3, 13);
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('S1 风格相似推荐：四维可解释结果', () => {
  it('返回按风格分排序的结果，每条带四个维度的实际值 vs 目标值理由', async () => {
    const res = await call('get', `/api/inspirations/${cards.similar}/similar?size=10`);
    expect(res.status).toBe(200);
    const body = res.body as StyleRecommendationResult;
    const ids = body.items.map((i) => i.inspiration.id);
    // 相似卡（共同标签：逆光/连廊、光位接近）排在顺光雾天卡之前
    expect(ids.indexOf(cards.mid)).toBeLessThan(ids.indexOf(cards.diff));
    // 光秃卡只有色板一维可比，被跳过（单维不足以支撑风格推荐）
    expect(ids).not.toContain(cards.bare);
    expect(body.skipped).toBeGreaterThanOrEqual(1);
    expect(body.sourceId).toBe(cards.similar);

    const first = body.items[0];
    expect(first.dimensions).toHaveLength(4);
    const byKey = Object.fromEntries(first.dimensions.map((d) => [d.key, d]));
    expect(byKey.palette.available).toBe(true);
    expect(byKey.palette.reason).toContain('%');
    expect(byKey.tags.reason).toContain('共同标签');
    expect(byKey.light.reason).toMatch(/光位角差/);
    expect(byKey.camera.reason).toMatch(/机位朝向差 \d+°/);
    // 权重在缺失维度被重分配后总和仍为 1
    const weightSum = first.dimensions.filter((d) => d.available).reduce((acc, d) => acc + d.weight, 0);
    expect(weightSum).toBeCloseTo(1, 5);
    expect(first.summary).toContain('主要相似点');
  });

  it('重复查询顺序与分数完全一致（无随机/无时钟）', async () => {
    const r1 = await call('get', `/api/inspirations/${cards.similar}/similar?size=10`);
    const r2 = await call('get', `/api/inspirations/${cards.similar}/similar?size=10`);
    const sig = (b: StyleRecommendationResult) =>
      JSON.stringify(b.items.map((i) => [i.inspiration.id, i.score, i.adjustedScore]));
    expect(sig(r2.body)).toBe(sig(r1.body));
  });

  it('源卡不出现在推荐里，dropped 卡不参与', async () => {
    const res = await call('get', `/api/inspirations/${cards.similar}/similar`);
    expect(res.body.items.map((i: { inspiration: { id: string } }) => i.inspiration.id)).not.toContain(cards.similar);
  });
});

describe('S2 反馈影响排序且可重置', () => {
  it('踩会把目标压后并标注反馈；赞/踩计数回填', async () => {
    const before = await call('get', `/api/inspirations/${cards.similar}/similar?size=10`);
    const beforeIds = before.body.items.map((i: { inspiration: { id: string } }) => i.inspiration.id);
    const topId = beforeIds[0] as string;
    expect(topId).toBe(cards.mid);

    const vote = await call('post', `/api/inspirations/${cards.similar}/similar/feedback`, {
      targetId: topId,
      vote: 'down',
    });
    expect(vote.status).toBe(201);
    expect(vote.body.vote).toBe('down');

    const after = await call('get', `/api/inspirations/${cards.similar}/similar?size=10`);
    const afterTop = after.body.items[0];
    expect(afterTop.inspiration.id).not.toBe(topId);
    const penalized = after.body.items.find((i: { inspiration: { id: string } }) => i.inspiration.id === topId);
    expect(penalized.adjustedScore).toBeLessThan(penalized.score);
    expect(penalized.feedback.vote).toBe('down');
    expect(penalized.summary).toContain('点过踩');
    expect(after.body.feedbackApplied).toBeGreaterThanOrEqual(1);
  });

  it('按源卡重置后排序恢复，且返回删除条数', async () => {
    const reset = await call('post', `/api/inspirations/${cards.similar}/similar/reset`, {});
    expect(reset.body.deleted).toBeGreaterThanOrEqual(1);
    const restored = await call('get', `/api/inspirations/${cards.similar}/similar?size=10`);
    expect(restored.body.items[0].inspiration.id).toBe(cards.mid);
    expect(restored.body.feedbackApplied).toBe(0);
  });

  it('赞会提升目标分数；赞末位+踩首位可制造换位；逐条撤销后恢复', async () => {
    const list = await call('get', `/api/inspirations/${cards.similar}/similar?size=10`);
    const ids = list.body.items.map((i: { inspiration: { id: string } }) => i.inspiration.id) as string[];
    const topId = ids[0];
    const bottomId = ids[ids.length - 1];
    const bottomScore = list.body.items[ids.length - 1].score as number;

    await call('post', `/api/inspirations/${cards.similar}/similar/feedback`, { targetId: bottomId, vote: 'up' });
    let res = await call('get', `/api/inspirations/${cards.similar}/similar?size=10`);
    let item = res.body.items.find((i: { inspiration: { id: string } }) => i.inspiration.id === bottomId);
    expect(item.adjustedScore).toBeCloseTo(Math.min(1, bottomScore + 0.12), 4);
    expect(item.feedback.vote).toBe('up');
    expect(item.summary).toContain('点过赞');

    // 叠加踩首位，确保末位反超（同时验证两种反馈的排序位移会叠加）
    await call('post', `/api/inspirations/${cards.similar}/similar/feedback`, { targetId: topId, vote: 'down' });
    res = await call('get', `/api/inspirations/${cards.similar}/similar?size=10`);
    const swappedIds = res.body.items.map((i: { inspiration: { id: string } }) => i.inspiration.id) as string[];
    expect(swappedIds[0]).toBe(bottomId);

    // 逐条撤销，顺序回到纯风格分
    await call('post', `/api/inspirations/${cards.similar}/similar/feedback`, { targetId: bottomId, vote: 'none' });
    await call('post', `/api/inspirations/${cards.similar}/similar/feedback`, { targetId: topId, vote: 'none' });
    const undone = await call('get', `/api/inspirations/${cards.similar}/similar?size=10`);
    const undoneIds = undone.body.items.map((i: { inspiration: { id: string } }) => i.inspiration.id);
    expect(undoneIds).toEqual(ids);
    for (const i of undone.body.items as { feedback: { vote: string | null }; adjustedScore: number; score: number }[]) {
      expect(i.feedback.vote).toBeNull();
      expect(i.adjustedScore).toBeCloseTo(i.score, 6);
    }
  });

  it('反馈可列出；非法目标（源卡本身/他库卡）被拒绝', async () => {
    const listing = await call('get', `/api/inspirations/${cards.similar}/similar/feedback`);
    expect(Array.isArray(listing.body.items)).toBe(true);

    const self = await call('post', `/api/inspirations/${cards.similar}/similar/feedback`, {
      targetId: cards.similar,
      vote: 'up',
    });
    expect(self.status).toBe(400);

    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'other@test.local', password: 'password123', displayName: '别的库' });
    const otherCard = (
      await request(app)
        .post('/api/inspirations')
        .set('authorization', `Bearer ${other.body.token}`)
        .send({ title: '别人的卡' })
    ).body.id as string;
    const cross = await call(
      'post',
      `/api/inspirations/${cards.similar}/similar/feedback`,
      { targetId: otherCard, vote: 'up' },
    );
    expect([403, 404]).toContain(cross.status);
  });

  it('全库重置清空当前用户所有反馈', async () => {
    await call('post', `/api/inspirations/${cards.similar}/similar/feedback`, {
      targetId: cards.diff,
      vote: 'down',
    });
    const all = await call('get', '/api/style-feedback');
    expect(all.body.items.length).toBeGreaterThan(0);
    const reset = await call('post', '/api/style-feedback/reset', {});
    expect(reset.body.deleted).toBeGreaterThanOrEqual(1);
    const empty = await call('get', '/api/style-feedback');
    expect(empty.body.items).toHaveLength(0);
  });
});
