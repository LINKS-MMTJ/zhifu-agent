# 智服 Agent 评测报告（1 万条）

- 用例总数：**10000**，总耗时 2.7s，异常 0
- 估算总成本：**¥1.8964**（按模型计价）

## 分类通过率
| 类别 | 数量 | 通过 | 通过率 |
|---|---|---|---|
| faq | 3000 | 3000 | 100.0% |
| order | 1500 | 1500 | 100.0% |
| logistics | 1000 | 1000 | 100.0% |
| return | 1000 | 1000 | 100.0% |
| refund | 500 | 500 | 100.0% |
| nonbusiness | 3000 | 3000 | 100.0% |

## 细分标签
- **faq**: rag-hit=3000
- **order**: tool-ok=1500
- **logistics**: tool-ok=1000
- **return**: confirm+exec=1000
- **refund**: confirm+exec=500
- **nonbusiness**: natural-reply=3000

## 模型路由分布
- lite-1: 6717（67.2%）
- std-1: 2498（25.0%）
- none: 511（5.1%）
- pro-1: 274（2.7%）

## 策略分布
- price: 5217
- balanced: 2498
- quality: 274

## 非业务题（DeepSeek 评委）
- 非业务总数 3000，已按固定种子（seed=42）抽取 **300** 条待 DeepSeek 网页版打分（judge_sample.json），重跑样本一致。