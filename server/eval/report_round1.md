# 智服 Agent 评测报告（1 万条）

- 用例总数：**10000**，总耗时 0.5s，异常 0
- 估算总成本：**¥8.5206**（按模型计价）

## 分类通过率
| 类别 | 数量 | 通过 | 通过率 |
|---|---|---|---|
| faq | 3000 | 2354 | 78.5% |
| order | 1500 | 1500 | 100.0% |
| logistics | 1000 | 1000 | 100.0% |
| return | 1000 | 1000 | 100.0% |
| refund | 500 | 500 | 100.0% |
| nonbusiness（待评委） | 3000 | — | 见 DeepSeek 抽样打分 |

## 细分标签
- **faq**: rag-hit=2354, rag-miss=646
- **order**: tool-ok=1500
- **logistics**: tool-ok=1000
- **return**: confirm+exec=1000
- **refund**: confirm+exec=500
- **nonbusiness**: to-judge=3000

## 模型路由分布
- lite-1: 5429（54.3%）
- pro-1: 4316（43.2%）
- none: 255（2.5%）

## 策略分布
- price: 3929
- balanced: 2960
- quality: 1356

## 非业务题（DeepSeek 评委）
- 非业务总数 3000，已随机抽取 **300** 条待 DeepSeek 网页版打分（judge_sample.json）。