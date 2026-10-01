import { Button, Card, Empty, List, Popconfirm, Progress, Space, Tag, Tooltip, Typography, message } from 'antd';
import { Link } from 'react-router-dom';
import type { SimilarItemDto } from '@flil/shared';
import { authedImageUrl } from '../api/client.js';
import { useSimilar, useSimilarFeedback } from '../api/hooks.js';

/**
 * 风格相似推荐（文档 15.4）：
 * 每条推荐都能展开"为什么像"（色板/标签/光位/机位逐项理由）；
 * 👍/👎 反馈立即影响排序，可一键重置回纯基础分。
 */
export function SimilarList({ seedId }: { seedId: string }) {
  const { data, isLoading } = useSimilar(seedId);
  const feedback = useSimilarFeedback(seedId);

  const items = data?.items ?? [];

  async function send(targetId: string, signal: 'up' | 'down', current: 'up' | 'down' | null) {
    try {
      // 再点一次同一个信号 = 撤销这条反馈
      if (current === signal) {
        await feedback.clearOne.mutateAsync(targetId);
        message.success('已撤销这条反馈');
      } else {
        await feedback.send.mutateAsync({ targetId, signal });
        message.success(signal === 'up' ? '已点赞，会排得更靠前' : '已点踩，会被压下去');
      }
    } catch (err) {
      message.error((err as Error).message);
    }
  }

  return (
    <Card
      title="风格相似推荐"
      extra={
        <Space>
          {data?.feedbackCount ? (
            <Popconfirm
              title={`重置全部 ${data.feedbackCount} 条反馈？`}
              description="排序将恢复到纯基础分，反馈记录会被清空。"
              onConfirm={async () => {
                try {
                  const res = await feedback.reset.mutateAsync();
                  message.success(`已重置 ${res.cleared} 条反馈`);
                } catch (err) {
                  message.error((err as Error).message);
                }
              }}
            >
              <Button size="small" danger loading={feedback.reset.isPending}>
                重置反馈（{data.feedbackCount}）
              </Button>
            </Popconfirm>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              色板 · 标签 · 光位 · 机位 四维打分
            </Typography.Text>
          )}
        </Space>
      }
    >
      {isLoading ? (
        <Card loading style={{ border: 'none' }} />
      ) : items.length === 0 ? (
        <Empty description="库里还没有可比较的卡：给其它卡补上标签、图片色板、光位或机位后再来看" />
      ) : (
        <List
          dataSource={items}
          renderItem={(item) => <SimilarRow item={item} onFeedback={send} pending={feedback.send.isPending} />}
        />
      )}
    </Card>
  );
}

function SimilarRow({
  item,
  onFeedback,
  pending,
}: {
  item: SimilarItemDto;
  onFeedback: (targetId: string, signal: 'up' | 'down', current: 'up' | 'down' | null) => void;
  pending: boolean;
}) {
  const insp = item.inspiration;
  const thumb = insp.assets[0]?.thumbUrl;
  const pct = Math.round(item.score * 100);
  const deltaPct = Math.round(item.feedbackDelta * 100);

  return (
    <List.Item
      actions={[
        <Button
          key="up"
          size="small"
          type={item.feedbackSignal === 'up' ? 'primary' : 'default'}
          disabled={pending}
          onClick={() => onFeedback(insp.id, 'up', item.feedbackSignal)}
        >
          👍 像
        </Button>,
        <Button
          key="down"
          size="small"
          danger={item.feedbackSignal === 'down'}
          disabled={pending}
          onClick={() => onFeedback(insp.id, 'down', item.feedbackSignal)}
        >
          👎 不像
        </Button>,
      ]}
    >
      <List.Item.Meta
        avatar={
          thumb ? (
            <img
              src={authedImageUrl(thumb)}
              alt={insp.title}
              style={{ width: 72, height: 52, objectFit: 'cover', borderRadius: 6 }}
            />
          ) : (
            <div
              style={{
                width: 72,
                height: 52,
                borderRadius: 6,
                background: '#f0f2f5',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#999',
                fontSize: 12,
              }}
            >
              无图
            </div>
          )
        }
        title={
          <Space wrap size={8}>
            <Link to={`/inspirations/${insp.id}`}>{insp.title}</Link>
            <Tag color={pct >= 70 ? 'green' : pct >= 40 ? 'gold' : 'default'}>{pct}%</Tag>
            {deltaPct !== 0 ? (
              <Tooltip title={`基础分 ${Math.round(item.baseScore * 100)}%，反馈调整 ${deltaPct > 0 ? '+' : ''}${deltaPct}%`}>
                <Tag color={deltaPct > 0 ? 'blue' : 'red'}>
                  反馈 {deltaPct > 0 ? '+' : ''}
                  {deltaPct}%
                </Tag>
              </Tooltip>
            ) : null}
          </Space>
        }
        description={
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space wrap size={6}>
              {item.dimensions.map((d) => (
                <Tooltip key={d.key} title={d.reason}>
                  <Tag style={{ marginInlineEnd: 0 }} color={d.score === null ? 'default' : undefined}>
                    {d.label} {d.score === null ? '—' : `${Math.round(d.score * 100)}%`}
                  </Tag>
                </Tooltip>
              ))}
            </Space>
            <Progress
              percent={pct}
              size="small"
              showInfo={false}
              strokeColor={pct >= 70 ? '#52c41a' : pct >= 40 ? '#faad14' : '#bfbfbf'}
              style={{ maxWidth: 320 }}
            />
          </Space>
        }
      />
    </List.Item>
  );
}
