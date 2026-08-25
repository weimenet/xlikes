# Xlikes

> 自托管的 X（Twitter）媒体库浏览器 —— 从 Xlikes 媒体根目录扫描图片与视频，
> 提供 Pinterest 风格拼图瀑布流、ID 索引、仿 X 帖子详情与多源文案抓取。
> 登录保护 + HTTPS，部署在局域网内使用，零 npm 依赖。

## 简介

媒体文件按 `用户 ID / 发布日期` 的目录结构保存，文件名中编码了帖子 ID 与媒体 ID。
Xlikes 直接扫描媒体根目录下的这些文件（只读文件名、不读内容），解析出帖子元数据并构建索引，
无需额外数据库。

## 媒体库结构

媒体根目录（`XLIKES_MEDIA_ROOT`）下的目录与文件结构示例：

```
/path/to/media/                                ← 媒体根目录（部署者自定义）
└── <用户ID>/                                  ← 帖子来源的用户 ID
    └── <发布日期 YYYY-MM-DD>/                 ← 发布日期
        └── <用户ID>_<YYYYMMDD>__<帖子ID>_<媒体编号>_<媒体ID>.mp4
```

命名格式：`<用户ID>_<发布日期YYYYMMDD>__<帖子ID>_<媒体编号>_<媒体ID>.mp4`
支持图片（jpg / png）与视频（mp4），同一帖子的多张媒体通过媒体编号区分。
对应 X 链接模板：`https://x.com/<用户ID>/status/<帖子ID>`。

如需用 gallery-dl 自动下载并生成符合上述结构的媒体库，见
[使用 gallery-dl 构建媒体库](docs/gallery-dl-media-library.md)。

浏览器端提供三层浏览体验：**全部贴文**（按时间排序的拼图瀑布流，同一帖子的多张媒体合并为一张卡片）、
**ID 索引**（按首字母 / 数字 / 特殊符号分组，右侧面包屑快速跳转）、**帖子页**（缩略图点击看原图，
自动抓取帖子文案并溯源到 x.com 原帖）。

服务端内置 HTTPS（自签证书）、基于 Cookie 的登录会话（新登录自动踢掉旧设备）、
全目录增量扫描、ffmpeg 缩略图缓存，以及 6 级数据源的文案抓取（含被删帖的 Wayback 历史快照）。
管理功能集中在**控制台**页面（左侧栏：扫描 / 文案 / 日志 / 账户管理）。
整个服务只用 Node.js 内置模块实现，任何能跑 Node 18+ 的设备都能运行。

## 功能特性

- **登录保护**：无注册入口，用户由管理员手动添加；密码 scrypt 加盐哈希；单设备会话（新登录使旧会话失效）；记录每次登录的 IP / 设备 / 结果
- **HTTPS**：自签证书，局域网加密访问；HTTP 端口自动 302 跳转到 HTTPS
- **拼图瀑布流**：同一帖子的媒体自动合并（单图 / 上下 2 宫格 / 上 2 下 1 / 2×2 宫格，超过 4 张显示 `+N`），底部渐变悬浮层显示发帖 ID 与两行文案摘录
- **筛选排序**：按日期新→旧 / 旧→新、时间段筛选；搜索支持模糊匹配用户 ID 与文案内容；筛选与排序在搜索结果中同样可用
- **ID 索引**：A-Z / 0-9 / 特殊符号分组（字母不区分大小写），按字母或贴文数排序，右侧竖排面包屑平滑跳转
- **帖子详情**：缩略图点击看原图（图片灯箱 / 视频原地播放），仿 X 布局，含原文链接
- **多源文案抓取**：fxtwitter → vxtwitter → oembed → Wayback 快照 → x.com embed → x.com 主站，6 级降级；失败自动重试（最多 3 轮），可手动重试 / 手动填写
- **控制台**：页面化管理，左侧栏菜单（扫描 / 文案 / 日志 / 账户管理）
- **扫描页**：显示用户 ID 数量、媒体数量、上次扫描时间与扫描类型（自动 / 手动），支持一键手动扫描
- **文案抓取管理**：进度条 + 抓取中状态、按状态筛选（已抓取 / 待抓取 / 失败 / 原帖不存在）、手动添加链接
- **账户管理**：当前用户名、修改密码、退出登录（合并原改密与退出入口）
- **增量扫描**：对比整个目录树（新增 / 删除 / 变更用户），新内容自动入索引并触发文案抓取；扫描页显示最近一次扫描状态

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js 内置模块（http / https / crypto / fs），零 npm 依赖 |
| 前端 | 原生 HTML / CSS / JS SPA（hash 路由，无框架、无构建步骤） |
| 存储 | JSON 文件（索引、文案缓存、用户库、登录日志），原子写入 |
| 缩略图 | ffmpeg（图片缩放 / 视频抽帧），缓存到 `data/thumbs/` |
| 部署 | Docker（node:22-alpine + ffmpeg），OpenWrt procd 脚本备选 |

## 架构

```
浏览器 ──HTTPS 5287──→ server.js（Node 内置 https）
                          │ 认证中间件：HttpOnly Cookie 会话
                          ├─ /api/feed|search|users|post 帖子与索引 API
                          ├─ /api/texts* 文案抓取队列与状态
                          ├─ /api/stats|refresh 扫描统计与手动扫描
                          ├─ /api/login|logout|me|login-log 认证
                          ├─ /thumb  ffmpeg 缩略图（缓存）
                          └─ /media  原图/原视频（HTTP Range）
媒体根目录（XLIKES_MEDIA_ROOT）──→ lib/scanner 全目录增量扫描
lib/fetcher ──→ fxtwitter/vxtwitter/oembed/wayback/x embed/x 主站
```

## 目录结构

```
xlikes/
├── server.js              # 服务入口（HTTPS + HTTP 跳转）
├── lib/
│   ├── auth.js            # 用户、scrypt 哈希、单设备会话、登录日志
│   ├── scanner.js         # 全目录增量扫描
│   ├── parser.js          # 文件名正则解析（snowflake 解码时间）
│   ├── store.js           # JSON 存储（原子写入）
│   ├── fetcher.js         # 6 级文案抓取源
│   └── thumbs.js          # ffmpeg 缩略图
├── public/                # SPA（瀑布流 / ID 索引 / 帖子页 / 控制台 / 登录页）
├── scripts/
│   ├── add-user.js        # 唯一建号入口（含改密）
│   ├── gen-cert.sh        # 生成 HTTPS 自签证书
│   └── parse_xlikes.py    # 独立文件名解析工具
├── docs/                  # 设计/评估文档
├── init.d/xlikes          # OpenWrt procd 自启脚本（无 Docker 备选）
├── Dockerfile / docker-compose.yml
└── data/                  # 运行数据（索引、缓存、用户库；不提交）
```

## 快速开始（本地）

```bash
# 1. 生成 HTTPS 证书
sh scripts/gen-cert.sh

# 2. 启动（媒体根目录由 XLIKES_MEDIA_ROOT 指定，HTTPS 3000 / HTTP 跳转 3080）
XLIKES_MEDIA_ROOT=/path/to/media node server.js

# 3. 添加用户
node scripts/add-user.js <用户名> <密码>

# 4. 打开 https://localhost:3000 登录
```

环境变量：`XLIKES_MEDIA_ROOT`（媒体根目录，建议必填；缺省为 `./media`）、
`XLIKES_MEDIA_LIMIT`（媒体扫描上限，0 = 全部）、`DATA_DIR`、`HTTPS_PORT` / `HTTP_PORT`、
`CERT_DIR`、`RESCAN_MS`（增量扫描间隔）、`FETCH_INTERVAL_MS`（文案抓取限速）。

## Docker 部署

容器内的**代码**在构建镜像时通过 `Dockerfile` 的 `COPY` 写入镜像（`server.js`、`lib/`、`public/`、`scripts/`）；
**配置与数据**通过卷挂载进容器（媒体、数据、证书目录），不随镜像重建丢失。

### 使用发布镜像（推荐）

每个 Release 会构建并推送容器镜像 `ghcr.io/weimenet/xlikes`（含 `:latest`），并附带部署包
`xlikes-<版本>.tar.gz`。使用镜像部署无需本机构建：

```yaml
services:
  xlikes:
    image: ghcr.io/weimenet/xlikes:v1.0.0   # 替换为实际版本
    container_name: xlikes
    restart: unless-stopped
    ports:
      - "5287:3000"
      - "5280:3080"
    environment:
      XLIKES_MEDIA_ROOT: /data/xlikes
      DATA_DIR: /data/store
    volumes:
      - <媒体根目录>:/data/xlikes:ro
      - <媒体根目录>/.data:/data/store
      - <证书目录>:/app/certs:ro
```

证书生成、媒体目录准备与验证步骤与下文一致。

### 部署前置条件

- 目标机：Linux（含 OpenWrt/iStoreOS）、Docker 20+、`docker-compose`（或 v2 的 `docker compose`）、`openssl`；
- 本机：`ssh` / `scp` 客户端，且已配置免密登录目标机；
- 媒体根目录：宿主机上**已存在**的目录，内含 `<用户ID>/<YYYY-MM-DD>/` 结构（见「媒体库结构」）；
- 目标端口 `5287` / `5280` 未被占用（可用 `ss -ltn | grep -E '5287|5280'` 检查）。

### 占位符说明

下文命令中的占位符按实际环境替换：

| 占位符 | 含义与取值建议 |
|---|---|
| `<主机IP>` | 目标机 IP，如局域网路由器的管理地址 |
| `<部署目录>` | 目标机上的部署位置，建议 `/root/xlikes` |
| `<媒体根目录>` | 宿主机媒体根目录的实际路径，需已存在且可读 |
| `<证书目录>` | 宿主机证书目录的实际路径，建议 `<部署目录>/xlikes/certs` |

### 1. 生成 HTTPS 证书

```bash
sh scripts/gen-cert.sh
# 局域网 IP 部署时指定 IP：XLIKES_CERT_CN=<主机IP> sh scripts/gen-cert.sh
```

证书生成在项目 `certs/`（cert.pem / key.pem），随代码一起传输，并挂载进容器（见步骤 3 的 `volumes`）。

### 2. 编辑 docker-compose.yml

按实际环境修改环境变量与三个挂载路径（示例与仓库自带的 `docker-compose.yml` 一致）：

```yaml
services:
  xlikes:
    build: .                       # 从当前目录构建镜像（代码写入容器）
    container_name: xlikes
    restart: unless-stopped        # 开机/崩溃后自动拉起
    ports:
      - "5287:3000"                # HTTPS 主入口
      - "5280:3080"                # HTTP 跳转 HTTPS
    environment:
      XLIKES_MEDIA_ROOT: /data/xlikes      # 容器内媒体根目录
      DATA_DIR: /data/store                # 容器内数据目录
      HTTPS_PORT: "3000"
      HTTP_PORT: "3080"
      CERT_DIR: /app/certs                 # 容器内证书目录
    volumes:
      - <媒体根目录>:/data/xlikes:ro       # 媒体根目录（宿主机实际路径，只读）
      - <媒体根目录>/.data:/data/store     # 配置/缓存（建议放媒体根下 .data，可写）
      - <证书目录>:/app/certs:ro           # HTTPS 证书（宿主机实际路径，只读）
```

### 3. 传输代码并启动

```bash
# 从本机把项目目录传到目标机（排除 .git / data / certs / docker-compose.yml，配置以目标机为准）
tar czf - --exclude=.git --exclude=data --exclude=certs --exclude=docker-compose.yml . \
  | ssh root@<主机IP> 'mkdir -p <部署目录>/xlikes && tar xzf - -C <部署目录>/xlikes'
# 证书目录单独传输
scp -r certs root@<主机IP>:<部署目录>/xlikes/

# 登录目标机，构建镜像并启动容器
ssh root@<主机IP>
cd <部署目录>/xlikes
docker-compose up -d --build        # 使用 compose v2 时改为：docker compose up -d --build

# 首次部署：添加登录用户
docker exec xlikes node scripts/add-user.js <用户名> <密码>   # 密码非空即可，建议至少 8 位
```

端口：`5287` HTTPS 主入口，`5280` HTTP 自动跳转 HTTPS；容器 `restart: unless-stopped`，开机自启。

若 `5287` / `5280` 已被占用，修改 `ports` 映射（如 `"5288:3000"`）后重新 `up -d`，并据此调整访问地址。

### 4. 验证

```bash
docker ps                          # xlikes 状态为 Up
docker logs xlikes                 # 启动日志含：媒体根目录 / 数据目录 / 待抓取文案数
curl -k -o /dev/null -w "%{http_code}" https://127.0.0.1:5287/login.html   # 期望 200
```

### 更新代码

重新传输代码后重建（`docker-compose.yml`、`data/`、`certs/` 不要覆盖，保持实际配置）：

```bash
cd xlikes && tar czf - --exclude=.git --exclude=data --exclude=certs --exclude=docker-compose.yml . \
  | ssh root@<主机IP> 'tar xzf - -C <部署目录>/xlikes'
ssh root@<主机IP> 'cd <部署目录>/xlikes && docker-compose up -d --build'
```

## 数据与备份

数据目录（`DATA_DIR`）包含全部可备份数据：媒体索引、文案缓存、用户库、登录日志、缩略图缓存。
Docker 部署建议把数据目录放在媒体根目录的 `.data` 子目录（如 `<媒体根目录>/.data`），
整体复制即可备份；容器崩溃 / 重建不影响数据，恢复后重启自动加载。

## 免责声明

本项目仅用于浏览本地备份的个人账户媒体归档，请遵守所在地法律法规与 X 平台服务条款； 文案抓取仅用于本地展示，请勿滥用或对外公开。
