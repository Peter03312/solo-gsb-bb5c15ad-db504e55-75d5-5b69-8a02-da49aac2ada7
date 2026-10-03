# DNS 区域审定台（dns-zone-console）

离线使用的 DNS 区域文件编制 / 复核 / 发布 Web 平台。运维人员在线编辑区域（SOA 参数与 NS、A、AAAA、CNAME、MX、TXT 记录），草稿可暂存；发布前整体验证并逐条定位错误；修订须由**另一账号复核**后方可发布；发布生成符合 BIND 区域文件语法、可下载的区域文件，SOA 序列号单调递增；支持回滚（同样生成更大序列号）；已发布文件与审计历史不可篡改。

技术栈：Node.js 20 + Express · React 18 + Vite · SQLite（better-sqlite3，单文件库，随容器自动初始化）。

---

## 一、快速启动

### 方式 A：Docker Compose（推荐，一键启动）

```bash
docker compose up --build
```

### 方式 B：Docker

```bash
docker build -t dns-zone-console .
docker run -d --name dns-zone-console -p 8080:8080 -v dnszone-data:/data dns-zone-console
```

### 方式 C：本地运行（Node.js ≥ 20）

```bash
npm run install:all     # 安装 server 与 client 依赖
npm run build           # 构建前端到 client/dist
npm start               # 启动后端（同时托管前端静态文件）
```

本地开发（前后端热更新，两个终端）：

```bash
npm run dev:server      # 后端 http://localhost:8080（--watch 热重载）
npm run dev:client      # 前端 http://localhost:5173（/api 代理到 8080）
```

## 二、访问地址与账号

- **访问地址：http://localhost:8080**（生产模式前后端同端口；Vite 开发模式为 http://localhost:5173）
- 首次启动自动初始化 SQLite 数据库并创建默认账号（仅在建库时生效）：

| 账号 | 默认密码 | 用途 |
| --- | --- | --- |
| `admin` | `admin123` | 管理员 |
| `operator` | `operator123` | 运维（编制/提交/发布） |
| `reviewer` | `reviewer123` | 复核员 |

> 任何账号都可编制与复核，但**不能复核自己提交的修订**——这正是“另一账号复核”的强制点。

## 三、配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口 |
| `DB_PATH` | 容器内 `/data/dnszone.db`；本地 `server/../data/dnszone.db` | SQLite 数据库文件路径 |
| `SESSION_TTL_HOURS` | `12` | 登录会话有效期（小时） |
| `ADMIN_PASSWORD` | `admin123` | 首次建库时 admin 的密码 |
| `OPERATOR_PASSWORD` | `operator123` | 首次建库时 operator 的密码 |
| `REVIEWER_PASSWORD` | `reviewer123` | 首次建库时 reviewer 的密码 |

Compose 中修改示例：

```yaml
environment:
  PORT: 8080
  ADMIN_PASSWORD: '请改成强口令'
```

数据库文件持久化在命名卷 `dnszone-data`（容器内 `/data`）。删除卷后重启会重新初始化账号。

## 四、工作流程

1. **创建区域**：填写区域名、主 DNS、管理员邮箱、默认 TTL（SOA 的 refresh/retry/expire/minimum 有默认值，可在草稿中调整）。
2. **编制草稿**：在「编辑修订」页编辑区域设置与记录表，随时「暂存草稿」；「立即校验」可随时做整体验证。
3. **提交复核**：点击「保存并提交复核」，系统先做整体验证，失败则逐条列出记录位置与原因，且不进入复核。
4. **他人复核**：另一账号打开同一修订，可「复核通过 / 驳回」。**复核后任何编辑都会使复核失效**（复核记录与内容指纹绑定，页面标注“已失效”），需重新提交复核。
5. **发布**：复核通过且未再改动时可发布。发布前再次整体验证；失败则返回错误定位，**现行文件不被替换**。成功则生成新的 BIND 区域文件，SOA 序列号 = 当前最大序列号 + 1。
6. **差异对比**：「差异对比」页实时展示草稿相对当前发布版的新增/删除记录及 SOA 设置变化。
7. **回滚**：「发布历史」中可对任一旧版本「回滚到此版」，系统以旧内容生成**序列号更大**的新发布文件。
8. **审计**：所有登录、编制、提交、复核、发布、回滚操作写入审计日志（区域级与全局两个视图）。

### 并发与过期保护

- 草稿保存带乐观锁（版本号）：他人已修改时保存返回 **409 冲突**，不会互相覆盖。
- 修订记录其基准序列号：期间若有新发布（含回滚），旧修订即“过期”，提交/发布返回 **409 冲突且不覆盖现行文件**；页面提供“基于当前发布版新建草稿”一键重建。

## 五、发布前整体验证规则

- 记录名必须属于区域（`@`、相对名、或以区域名结尾的 FQDN）；
- 区域顶点（@）至少一条 NS 记录；
- 同名 CNAME 不得与任何其他类型记录共存；
- TTL 必须为 1–2147483647 的正整数（留空则取默认 TTL）；
- A 必须为合法 IPv4，AAAA 必须为合法 IPv6；
- MX 必须为「优先级 目标主机」，优先级 0–65535，目标为合法主机名；
- NS / CNAME 目标必须为合法主机名；TXT 非空且 ≤ 65535 字符；
- 区域名、主 DNS、管理员邮箱、SOA 各计时器均须合法；
- 完全重复的记录会被拒绝。

验证失败时返回每条错误的**记录序号、名称、类型、字段与原因**。

## 六、生成的区域文件

符合 BIND master file 语法，示例：

```
$ORIGIN example.com.
$TTL 3600

@   IN  SOA ns1.example.com. hostmaster.example.com. (
        3 ; Serial
        7200 ; Refresh
        3600 ; Retry
        1209600 ; Expire
        300 ; Negative caching TTL
)

;; NS records
@                    3600    IN NS     ns1.example.com.
;; A records
www                  300     IN A      192.0.2.10
...
```

- 邮箱按 RFC 1035 转为 SOA RNAME（`hostmaster@example.com` → `hostmaster.example.com.`，本地部分的点会转义）；
- NS/CNAME/MX 目标统一写成带根点的绝对名，避免相对名歧义；
- TXT 自动加引号、转义并按 255 字符拆分；
- 每个发布文件带 SHA-256 指纹，内容与审计历史由数据库触发器保护，**不可修改、不可删除**。

## 七、目录结构

```
├── Dockerfile              # 多阶段构建：前端构建 → 后端依赖 → 运行时
├── docker-compose.yml      # 一键启动
├── package.json            # 根便捷脚本
├── server/                 # Express 后端
│   ├── index.js            #   路由与业务流程（会话、草稿、复核、发布、回滚、审计）
│   ├── db.js               #   SQLite 建库、不可变触发器、默认账号
│   ├── validate.js         #   整体验证规则
│   ├── zonefile.js         #   BIND 区域文件生成
│   ├── diff.js             #   记录差异与内容指纹
│   ├── dnsutil.js          #   DNS 名称工具
│   └── auth.js             #   scrypt 口令散列、令牌
└── client/                 # React 前端（Vite）
    └── src/pages/          #   登录 / 区域列表 / 区域详情（编辑·差异·历史·审计）/ 全局审计
```

## 八、主要 API（同源，Cookie 会话）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` `/api/auth/logout` | 登录 / 退出 |
| GET/POST | `/api/zones` | 区域列表 / 新建区域 |
| POST | `/api/zones/:id/draft` | 打开或新建草稿（`{fresh:true}` 基于最新发布版重建） |
| GET/PUT | `/api/revisions/:id` | 读取 / 暂存草稿（乐观锁 `version`） |
| POST | `/api/revisions/:id/submit` | 提交复核（先整体验证，过期返 409） |
| POST | `/api/revisions/:id/review` | 复核（须非提交人，`approve`/`reject`） |
| POST | `/api/revisions/:id/publish` | 发布（校验 + 复核有效 + 未过期） |
| GET | `/api/revisions/:id/diff` | 与当前发布版的差异 |
| GET | `/api/zones/:id/files` · `/api/files/:id/download` | 发布历史 / 下载区域文件 |
| POST | `/api/files/:id/rollback` | 回滚（生成更大序列号） |
| GET | `/api/audit?zone_id=` | 审计日志 |
