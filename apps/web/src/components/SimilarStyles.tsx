import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Empty,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { StyleRecommendationDto } from '@flil/shared';
import { authedImageUrl } from '../api/client.js';
import { useResetStyleFeedback, useSimilarStyles, useStyleFeedback } from '../api/hooks.js';

interface Props {
  sourceId: string;
}

const DIM_COLOR: Record<string, string> = {
  palette: 'gold',
  tags: 'blue',
  light: 'orange',
  camera: 'geekblue',
};

/**
 * 风格相似推荐：色板 / 标签 / 光位 / 机位四维加权，结果逐项给出
 * "实际值 vs 目标值"的理由；赞/踩只做排序位移，可按卡或全部重置。
 * 打分在服务端是纯函数 + id 兜底排序，所以刷新后顺序稳定一致。
 */
export function SimilarStyles({ sourceId }: Props) {
  const { data, isLoading, isError, error, refetch, isFetching } = useSimilarStyles(sourceId);
  const feedback = useStyleFeedback(sourceId);
  const reset = useResetStyleFeedback(sourceId);
  const [showReasons, setShowReasons] = useState<Record<string, boolean>>({});

  async function vote(targetId: string, vote: 'up' | 'down') {
    try {
      await feedback.mutateAsync({ targetId, vote });
      message.success(vote === 'up' ? '已赞，之后会优先推荐这类风格' : '已踩，之后会减少这类推荐');
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  async function revokeVote(targetId: string) {
    await feedback.mutateAsync({ targetId, vote: 'none' });
    message.success('已撤销这条反馈');
  }

  async function doReset(scope: 'source' | 'library') {
    const r = await reset.mutateAsync(scope);
    message.success(r.deleted ? `已重置 ${r.deleted} 条反馈，排序恢复默认` : '当前没有可重置的反馈');
  }

  if (isError) return <Alert type="error" message={(error as Error).message} />;

  const items = data?.items ?? [];

  const columns = [
    {
      title: '灵感卡',
      dataIndex: ['inspiration', 'title'],
      render: (_: unknown, row: StyleRecommendationDto) => (
        <Space>
          {row.inspiration.assets[0] ? (
            <img
              src={authedImageUrl(row.inspiration.assets[0].thumbUrl)}
              alt=""
              width={56}
              height={40}
              style={{ objectFit: 'cover', borderRadius: 6 }}
            />
          ) : (
            <div style={{ width: 56, height: 40, background: '#eee', borderRadius: 6 }} />
          )}
          <Space direction="vertical" size={2}>
            <Link to={`/inspirations/${row.inspiration.id}`}>{row.inspiration.title}</Link>
            <Space size={4} wrap>
              {row.inspiration.tags.slice(0, 4).map((t) => (
                <Tag key={t.id} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                  {t.name}
                </Tag>
              ))}
            </Space>
          </Space>
        </Space>
      ),
    },
    {
      title: '风格分',
      width: 170,
      render: (_: unknown, row: StyleRecommendationDto) => (
        <Space direction="vertical" size={0} style={{ width: 150 }}>
          <Progress percent={Math.round(row.adjustedScore * 100)} size="small" status="normal" />
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            基础 {(row.score * 100).toFixed(0)}%
            {row.feedback.vote ? (row.feedback.vote === 'up' ? ' · 赞 +12' : ' · 踩 −40') : ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '为什么相似（可复算）',
      render: (_: unknown, row: StyleRecommendationDto) => {
        const open = showReasons[row.inspiration.id] ?? false;
        return (
          <Space direction="vertical" size={4}>
            <Typography.Text>{row.summary}</Typography.Text>
            <Space size={4} wrap>
              {row.dimensions
                .filter((d) => d.available)
                .map((d) => (
                  <Tooltip key={d.key} title={d.reason}>
                    <Tag color={DIM_COLOR[d.key]} style={{ marginInlineEnd: 0 }}>
                      {d.label} {(d.score * 100).toFixed(0)}%
                    </Tag>
                  </Tooltip>
                ))}
              {row.dimensions
                .filter((d) => !d.available)
                .map((d) => (
                  <Tooltip key={d.key} title={d.reason}>
                    <Tag style={{ marginInlineEnd: 0, color: '#999' }}>{d.label} 缺数据</Tag>
                  </Tooltip>
                ))}
              <Button
                size="small"
                type="link"
                style={{ padding: 0, height: 20, fontSize: 12 }}
                onClick={() =>
                  setShowReasons((m) => ({ ...m, [row.inspiration.id]: !(m[row.inspiration.id] ?? false) }))
                }
              >
                {open ? '收起明细' : '展开明细'}
              </Button>
            </Space>
            {open ? (
              <ul style={{ margin: '4px 0 0', paddingInlineStart: 18, color: '#666', fontSize: 12 }}>
                {row.dimensions.map((d) => (
                  <li key={d.key}>
                    <b>{d.label}</b>（权重 {(d.weight * 100).toFixed(0)}%）：{d.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '反馈',
      width: 110,
      render: (_: unknown, row: StyleRecommendationDto) => (
        <Space>
          <Tooltip title="多推荐这类（排序分 +12）">
            <Button
              size="small"
              type={row.feedback.vote === 'up' ? 'primary' : 'default'}
              onClick={() => (row.feedback.vote === 'up' ? void revokeVote(row.inspiration.id) : void vote(row.inspiration.id, 'up'))}
            >
              {row.feedback.vote === 'up' ? '👍 已赞' : '👍 赞'}
            </Button>
          </Tooltip>
          <Tooltip title="少推荐这类（排序分 −40）">
            <Button
              size="small"
              danger={row.feedback.vote === 'down'}
              onClick={() =>
                void (row.feedback.vote === 'down' ? revokeVote(row.inspiration.id) : vote(row.inspiration.id, 'down'))
              }
            >
              {row.feedback.vote === 'down' ? '👎 已踩' : '👎 踩'}
            </Button>
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="相似风格推荐（色板 + 标签 + 光位 + 机位）"
      size="small"
      extra={
        <Space>
          <Tooltip title="同一查询多次请求结果顺序一致；数据未变化时分数不会变">
            <Button size="small" loading={isFetching} onClick={() => void refetch()}>
              重新查询
            </Button>
          </Tooltip>
          <Popconfirm
            title="重置这张卡的反馈？"
            description="赞/踩会被清空，排序立刻回到纯风格分。"
            onConfirm={() => void doReset('source')}
          >
            <Button size="small" onClick={() => void doReset('source')}>
              重置本卡反馈
            </Button>
          </Popconfirm>
          <Popconfirm
            title="重置全部风格反馈？"
            description="会清空你在这个库里对所有卡片的赞/踩。"
            onConfirm={() => void doReset('library')}
          >
            <Button size="small" type="text">
              全部重置
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      {isLoading ? (
        <Card loading />
      ) : items.length === 0 ? (
        <Empty description="暂无足够相似的卡（需要色板/标签/光位/机位中至少两项可比较）" />
      ) : (
        <>
          <Table
            rowKey={(r) => r.inspiration.id}
            size="small"
            columns={columns}
            dataSource={items}
            pagination={false}
            loading={feedback.isPending || reset.isPending}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            扫描 {data?.scanned ?? 0} 张候选，{data?.skipped ?? 0} 张因分数过低或可比较维度不足被跳过；
            当前排序应用了 {data?.feedbackApplied ?? 0} 条你的反馈。
          </Typography.Text>
        </>
      )}
    </Card>
  );
}
