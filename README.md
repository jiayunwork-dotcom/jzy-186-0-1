# GHG 温室气体核算后端

一个面向审计场景的温室气体核算服务：**每一个数字都能回溯到具体的原始活动记录、更正链版本、排放因子、密度/热值与 GWP 值；任意两个口径的差额都能严格拆成“活动数据变化 / 因子变化 / 潜势值变化”三部分，且三部分之和恒等于总差额。**

- 运行时：Node.js 20 + TypeScript（strict）+ NestJS 10
- 数据库：PostgreSQL 16（生产），另附零依赖内存实现（本地/单测）
- 高精度：全程 `decimal.js`（40 位有效数字），**不使用 JS 浮点参与金额/排放运算**
- 测试：Jest（59 个用例），另含需要 PostgreSQL 的存储契约测试

---

## 1. 快速开始

### Docker Compose（PostgreSQL 16 + 应用）

```bash
docker compose up --build
# 应用：http://localhost:3000 ；数据库：localhost:5432（卷 ghg-pgdata 持久化）
```

应用镜像基于 `node:20-slim`（多阶段构建），数据库使用 `postgres:16-alpine`，数据落在具名卷 `ghg-pgdata`。

### 本地（内存驱动，零外部依赖）

```bash
npm ci
npm test          # 全部单元/集成测试（内存驱动）
npm run start     # 起 HTTP 服务（DB_DRIVER=memory）
```

### 连接外部 PostgreSQL

```bash
DB_DRIVER=pg DATABASE_URL=postgres://ghg:ghg_secret@localhost:5432/ghg npm run start
# schema 在启动时自动执行（src/persistence/schema.sql，IF NOT EXISTS）
npm run test:pg   # 仅在 DATABASE_URL 可达时运行 PG 契约测试，否则自动跳过
```

---

## 2. 一分钟示例（对应需求中的 5.61 t 算例）

```bash
# 1) 发布因子库（CO2 56.1 kg/GJ）与 GWP 集合
curl -X POST localhost:3000/factor-versions -H 'content-type: application/json' -d '{
  "id":"fv-2024","label":"2024","effectiveStart":"2024-01","effectiveEnd":null,
  "rows":[
    {"fuelOrActivity":"natural_gas","type":"emission","gas":"CO2","scope":1,"value":"56.1","unit":"kg/GJ"},
    {"fuelOrActivity":"natural_gas","type":"emission","gas":"CH4","scope":1,"value":"0.001","unit":"kg/GJ"},
    {"fuelOrActivity":"natural_gas","type":"emission","gas":"N2O","scope":1,"value":"0.0001","unit":"kg/GJ"}]}'

curl -X POST localhost:3000/gwp-sets -H 'content-type: application/json' -d '{
  "id":"ar5","label":"AR5","values":[{"gas":"CO2","value":"1"},{"gas":"CH4","value":"28"},{"gas":"N2O","value":"265"}]}'

# 2) 导入活动数据：某月锅炉消耗天然气 100 GJ
curl -X POST localhost:3000/activities/import -H 'content-type: application/json' -d '{
  "items":[{"id":"r1","plantId":"P1","sourceId":"BOILER","fuelOrActivity":"natural_gas",
            "month":"2024-01","quantity":100,"unit":"GJ"}]}'

# 3) 按口径查询 -> CO2 = 100 × 56.1 = 5610 kg = 5.61 t
curl -X POST localhost:3000/query/summary -H 'content-type: application/json' -d '{
  "caliber":{"factorVersionId":"fv-2024","gwpSetId":"ar5"}}'
```

返回中 `source / P1 / BOILER / 2024-01 / scope=1` 行的 `kg.CO2 = "5610"`，即 **5.61 t CO₂**（CO₂ 的 GWP 恒为 1）；CH₄/N₂O 按 GWP 折算后计入 `kgCo2e/tonnesCo2e`。

---

## 3. 核心概念与模块划分

| 模块 | 目录 | 职责 |
| --- | --- | --- |
| 单位换算 | `src/units` | 质量/体积/能量同量纲十进倍率；跨量纲经密度、热值（均为因子库一部分）；因子复合单位折算（`56.1 kg/GJ`、`50 GJ/t`、`0.8 kg/L`） |
| 因子库与版本 | `src/factors` | 不可变的因子版本（含适用期间）、GWP 集合（AR5/AR6…）发布与校验 |
| 活动数据与更正链 | `src/activity` | 按厂区/排放源/月登记；唯一编号；更正即“指向旧记录的新记录”，旧记录保留；按截止点取生效版本 |
| 核算引擎 | `src/accounting` | 口径三元组（活动截止点、因子版本、GWP 集合）→ 每条记录的三气体 kg → 叶子格子 → 各层级 rollup |
| 重述与分解 | `src/restatement` | 两口径对比，**Shapley 三因素分解**（见 §6） |
| 关账快照 | `src/closure` | 显式关账锁定口径、物化对外快照、基准年显著性（默认 5%）重算标记与说明记录 |
| 查询与追溯 | `src/query` | 按口径现算汇总；任意汇总数字追溯到原始记录链 + 因子行 |
| 持久化 | `src/persistence` | `Store` 端口 + 内存实现 + PostgreSQL 16 实现（同一接口） |
| 接口 | `*.controller.ts` | REST/JSON，错误含稳定 `code` 与字段级 `field` |

### “口径”（caliber）三元组

```jsonc
{ "activitySeq": 12, "factorVersionId": "fv-2024", "gwpSetId": "ar6" }
// activitySeq: 活动数据接受序号截止点（'latest' 会在进入引擎前解析为具体序号）
```

每个核算结果都记录这三个坐标。因子版本与 GWP 集合一经发布即不可变；活动事实只增不改（更正以新行表达），因此**口径三元组是结果的完全确定描述**。

---

## 4. 数据模型要点

- `activity_records`：`id` 主键（幂等）、`supersedes_id` 指向上一代、`root_id` 指向链条顶端、`seq BIGINT` 单调接受序号、`(plant_id, month)` 索引。
- 某截止点 S 的“生效记录”= 每个 `root_id` 下 `seq ≤ S` 的最后一条；旧记录永不删除。
- `factor_versions / factor_rows`：版本含半开适用期间 `[start, end)`；`factor_rows` 区分 `emission / density / ncv_mass / ncv_volume`，数值与单位成对保存。
- `gwp_sets / gwp_values`：CO₂ 的 GWP 恒为 1。
- `closure_snapshots`：`UNIQUE(plant_id, month)`，完整结果存 JSONB + `result_hash`。
- `base_year_flags`：基准年重算标记与说明记录。

---

## 5. 结果一致性：为什么“现算”而不是“为每个口径物化”

**决策：核算结果按口径“读穿现算”，只对“对外披露快照”做物化。**

1. 三个输入都不可变（因子版本、GWP 集合、只增不改的活动事实），现算是**确定性纯函数**：同一口径任何时候、任何实例算出来逐位相同，且天然等于“从原始记录全量重算”——不存在物化副本与源数据漂移的问题。
2. 若为每个已发布口径物化一份，因子/活动多版本组合是笛卡尔积，且每次补报/更正都要对所有口径做增量更新，一致性代价高、易漏。
3. 对外披露需要“冻结的法律事实”，因此**关账快照是唯一被物化的结果**，且它物化的是“开始那一刻钉死的坐标 + 当时的全量结果”，之后任何发布/更正都不可见。

工程上保证逐位一致的手段：

- 全程 `Decimal(40 位)`；`numeric` 列以字符串进出 PG；运算顺序固定（记录按 `(plant, source, month, id)` 排序后聚合）。
- 每次查询返回 `resultHash`（只覆盖口径坐标与全部结果数字的规范化 JSON 的 SHA-256），可直接核对两次查询是否逐位一致。
- 高层级由叶子格子**线性求和**得到（厂区=排放源之和、年=月之和、公司=厂区之和），从结构上保证加总恒等。

---

## 6. 差额分解方法：Shapley 值（对全部替换顺序取平均）

两口径 A、B 的总差 Δ = E(B) − E(A)。三个因素：

- **A** 活动数据（截止点变化，含补报与更正）
- **F** 因子版本
- **G** GWP 集合

三者有交互项（如“新增活动量 × 新因子”的交叉增量既属于活动也属于因子）。固定顺序逐项替换会把交互项判给“顺序靠后的因素”，换个顺序结论就变。

本实现采用合作博弈论的 **Shapley 值**：

```
Δi = Σ_{S⊆N\{i}}  |S|!·(n−|S|−1)! / n!  · ( v(S∪{i}) − v(S) )     （n = 3）
```

`v(S)` = “S 中的因素取 B 端取值、其余取 A 端取值”的混合口径下的排放。n=3 时权重只有两档：`1/3`（端点边际）与 `1/6`（中间边际）。

**公平性（为何选它）**

- *对称性*：互换两个因素的名字不改变其贡献（测试中 A、F 端点相同则二者贡献严格相等）。
- *有效性（配平）*：三部分严格相加等于总差额——这是线性恒等式，残差恒为 0（见 `restatement.spec.ts` / `shapley.spec.ts`，逐位断言）。
- *Dummy 性*：没变化的因素贡献为 0（只换 GWP 时活动/因子部分为 0；GWP 部分的分气体“物理质量变化”也恒为 0，因为换 GWP 不改变 CO₂/CH₄/N₂O 的 kg 数）。
- 交互项被所有相关因素**对称地对半分**，不偏袒任何替换顺序。

**计算代价**

- 需评估 2³ = **8 个混合口径**（固定顺序法只需 4 个）。在三因素下这是常数倍开销，每次评估对数据是线性扫描，且可加索引/结果缓存。
- 因素个数若未来增加，代价是 O(2ⁿ) 次核算；对 n=3（本问题的固定维度）完全可接受，且公平性是审计场景的刚需，故取 Shapley 而非固定顺序。

> 举例（纯 CO₂，GWP=1）：活动 100→106 GJ、因子 56.1→59.466 kg/GJ。
> 固定顺序“先活动后因子”：活动=336.6、因子=356.796；顺序反过来：因子=336.6、活动=356.796。
> Shapley 两者都为 **346.698 kg**（交互项 6×3.366=20.196 对半分，各得 10.098）。

---

## 7. 并发、关账与基准年规则

- **所有写操作与关账在同一把写临界区内**：
  - 内存实现：可重入异步互斥队列（`AsyncLocalStorage`）。
  - PG 实现：`BEGIN ISOLATION LEVEL SERIALIZABLE` + 固定键 `pg_advisory_xact_lock`，事务内查询复用同一连接（`AsyncLocalStorage`）。
- **两个并发更正只接受一个**：临界区内先取链头、再插入；后到者看到前者已插入的子记录，目标不再是链头，返回 `409 CONFLICT`。
- **同编号重复提交不重复计数**：主键 `ON CONFLICT DO NOTHING`，内容一致幂等返回，内容冲突拒绝（绝不覆盖）。
- **月度关账**：进入临界区第一刻把 `activitySeq` 钉为当时 `MAX(seq)`，随后在同一事务/临界区内完成核算与落盘；关账进行中发布的新因子或提交的更正被挡在外面。同 `(plant, month)` 重复关账 `409`。
- **基准年重算**：关账月份属于基准年时，用本口径重算基准年 12 个月合计，与基准年最早一次已关账快照的口径对比；`|变化率| > 阈值`（默认 5%，可按次覆盖）则写 `base_year_flags`（含两个总量、变化率、阈值、参照快照、中文说明）。首次建立基准年口径不算重述，不触发。

---

## 8. HTTP 接口

| 方法 路径 | 说明 |
| --- | --- |
| `POST /activities/import` | 批量导入；body `{items:[...]}`，逐条回报 `results`（created/duplicate）与 `failures`（含 `field`），非法记录不影响其余 |
| `POST /activities/correct` | `{correctionId,targetId,quantity,unit}`；并发第二者 409；重复 `correctionId` 幂等 |
| `GET /activities/:id`、`/activities/:id/chain` | 记录与更正链 |
| `POST /factor-versions` | 发布因子版本；适用期间重叠/单位非法/期间倒置 → 422 且指出字段 |
| `GET /factor-versions`、`/factor-versions/:id` | 列出/取版本（含因子行） |
| `POST /gwp-sets`、`GET /gwp-sets`、`/gwp-sets/:id` | GWP 集合 |
| `POST /query/summary` | `{caliber}` → 各层级行、范围一/二总量、`resultHash` |
| `POST /query/trace` | `{caliber, filter}` → 汇总数字由哪些记录（含链）、哪些因子/GWP 得出 |
| `POST /restatements/compare` | `{caliberA, caliberB, filter?}` → 总差额 + Shapley 三部分 + `residualKgCo2e` |
| `POST /closures` | `{month, plantId?, factorVersionId, gwpSetId, threshold?}` → 快照（必要时含基准年标记） |
| `GET /closures/:id`、`GET /closures?plantId=&month=` | 快照查询 |
| `GET /base-year-flags/:year` | 基准年重算标记与说明 |

错误体统一为：

```json
{ "error": { "code": "VALIDATION_FAILED | NOT_FOUND | CONFLICT", "message": "...", "field": "rows[0].unit", "details": {} } }
```

字段级校验至少覆盖：数量为负或非有限数（`quantity`）、单位无法换算到因子要求单位（`unit`，附 `missingParam`）、月份不在因子适用期间（`month`）、更正指向不存在或已被更正记录（`targetId`）、因子版本适用期间重叠（`effectiveStart`）。

### 追溯返回片段

```jsonc
{
  "record": { "id": "r1-c1", "supersedesId": "r1", "rootId": "r1", "quantity": "110", ... },
  "chain":  [ {"id":"r1","active":false,...}, {"id":"r1-c1","active":true,...} ],
  "baseActivityAmount": "110", "baseActivityUnit": "GJ",
  "conversionPath": "110 GJ -> 110 GJ",
  "gases": [
    {"gas":"CO2","factorRowId":"fv-2024:row:0","factorValue":"56.1","factorUnit":"kg/GJ","kg":"6171","gwp":"1","kgCo2e":"6171"}, ...
  ],
  "conversionFactors": []   // 跨量纲时列出实际使用的 density/ncv 行
}
```

---

## 9. 测试

```bash
npm test                 # 内存驱动全部用例（无需数据库）
npm run test:pg          # PG 契约测试（docker compose up db 后；不可达自动跳过）
npm run lint             # tsc --noEmit
```

覆盖（对应需求清单）：

- 5.61 t 算例；厂区合计=排放源之和、年合计=各月之和、公司=各厂区、总量=范围一+范围二；
- 单位换算往返不变（m³↔kg↔GJ，含密度/热值）；复合单位折算；
- 同一口径重复计算逐位相同（hash + 全数字 + 显式截止点）；
- 差额三部分之和严格等于总差额（残差 0）；只换 GWP 时 CO₂ 不变、活动/因子贡献为 0；单因素变化全部归该因素；Shapley 的对称/有效/dummy；
- 显著性阈值触发/不触发基准年标记、阈值可覆盖、说明记录完整；
- 关账快照不受之后的发布与更正影响、重复关账冲突；
- 两个并发更正只接受一个；导入幂等（重复编号、内容冲突不覆盖）；
- 因子期间重叠、月份超期、单位不可换算、更正目标非法等字段级错误；
- HTTP 端到端；PostgreSQL 存储契约（建表、seq、更正链、咨询锁并发、快照唯一约束）。

---

## 10. 目录

```
src/
  common/         Decimal 配置、错误、月份、哈希、可重入锁、异常过滤器
  units/          单位模型/注册表/换算器
  factors/        实体、存储端口、发布服务、控制器
  activity/       实体、存储端口、导入/更正服务、控制器
  accounting/     因子索引、单记录核算、聚合、rollup、引擎
  restatement/    层级过滤、Shapley 纯数学、重述服务、控制器
  closure/        快照与基准年实体、关账服务、控制器
  query/          汇总查询、追溯、控制器
  persistence/    Store 端口、内存实现、PG 实现、schema.sql
  config/         环境配置（DB_DRIVER / BASE_YEAR / SIGNIFICANCE_THRESHOLD）
test/             测试夹具、PG 契约测试
seed/             种子数据
docker-compose.yml  Dockerfile  jest.config.js
```
