# Xlikes

> 自托管的 X（Twitter）媒体库浏览器 —— 从 Xlikes 媒体根目录扫描图片与视频，
> 提供 Pinterest 风格拼图瀑布流、ID 索引、仿 X 帖子详情与 gallery-dl 文案抓取。
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

服务端内置 HTTPS（自签证书）、基于 Cookie 的登录会话（多设备并存，可在设置里踢下线）、
全目录增量扫描、ffmpeg 缩略图缓存，以及 6 级数据源的文案抓取（含被删帖的 Wayback 历史快照）。
管理功能集中在**控制台**页面（左侧栏：扫描 / 文案 / 日志 / 账户管理）。
整个服务只用 Node.js 内置模块实现，任何能跑 Node 18+ 的设备都能运行。

## 功能特性

- **登录保护**：无注册入口；密码 scrypt 加盐哈希；多设备会话并存，可在设置里查看已登录设备并踢下线；记录每次登录的 IP / 设备 / 结果
- **HTTPS**：自签证书，局域网加密访问；HTTP 端口自动 302 跳转到 HTTPS
- **拼图瀑布流**：同一帖子的媒体自动合并（单图 / 上下 2 宫格 / 上 2 下 1 / 2×2 宫格，超过 4 张显示 `+N`）；单图按原始比例自适应高度，多图走统一档位；卡片底部渐变层显示用户 ID、时间与两行文案
- **筛选排序**：按发布时间新→旧 / 旧→新、添加时间新→旧 / 旧→新、时间段筛选；搜索支持模糊匹配用户 ID 与文案内容；筛选与排序在搜索结果中同样可用
- **缩略图加速**：320px WebP + 内容版本号长缓存（缩略图变了自动刷新，没变一直命中缓存）；视频优先抓封面，抓不到再抽帧
- **NSFW 模式**：顶部滑动开关（默认开启，手动改过则记住），一键模糊全部媒体；视频在开启时提示「NSFW 模式无法播放」且点击无效；头像不参与模糊
- **防盗链**：媒体 / 缩略图 / 头像校验 Referer 与 Origin，外站引用返回 403；无 Referer 的「另存为」正常放行
- **内置抓取**：顶部下载栏粘贴链接即可抓取（支持多条，按 `http` 自动切分，兼容新版分享链接格式），容器内调用 gallery-dl 按命名规则落盘并定向入库，**同时把帖子文案与作者信息写入文案缓存**（媒体目录里不留额外文件）；队列弹窗显示进行中 / 排队中 / 失败 / 已完成，失败可重试，任务落盘保留 7 天
- **重复抓取识别**：提交链接时若该帖已在库中，会标记为「已存在」并跳过下载，任务行可直接跳转站内记录；确实需要重抓时可选择「仍然抓取」
- **抓取维护**：控制台可检查 gallery-dl 是否有新版本，一键在容器内更新（升级后自动自检，未通过会自动回滚）；批量补抓带限速、随机间隔与连续无收获自动停止
- **响应式**：手机 / 平板 / 桌面与不同 DPI 自适应，窄屏时顶部栏、下载栏、队列弹窗自动折行或限高滚动
- **ID 索引**：A-Z / 0-9 / 特殊符号分组（字母不区分大小写），按字母或贴文数排序，右侧竖排面包屑平滑跳转
- **帖子详情**：缩略图点击看原图（图片灯箱 / 视频原地播放），仿 X 布局；头部提供「查看原文」，正文里指向站内已有账号的 @ID 可点击跳转
- **媒体交互**：大图模式与视频播放中长按（桌面为右键）弹出统一菜单，可保存到设备、复制图片 / 复制当前帧、画中画；返回手势或返回键优先退出大图、停止播放，而不是离开页面
- **gallery-dl 抓取**：抓取媒体时顺带把文案与作者信息写入缓存；扫描到的新帖与遗漏项会自动补抓，失败自动重试（最多 3 轮），也可单条重试 / 手动填写
- **控制台**：页面化管理，左侧栏菜单（扫描 / 抓取 / 日志 / 账户管理 / 登录设备）
- **扫描页**：显示用户 ID 数量、媒体数量、上次扫描时间与扫描类型（自动 / 手动），支持一键手动扫描
- **抓取管理**：进度条与抓取中状态、按状态筛选（已抓取 / 待抓取 / 失败 / 原帖不存在）、单条重试 / 手填文案；支持 gallery-dl 批量补抓（`刷新` 补抓未标记、`重试全部失败` 重抓失败项），带限速与自动止损
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
                          ├─ /api/download*      粘贴链接抓取（gallery-dl）与队列状态
                          ├─ /api/login|logout|me|login-log 认证
                          ├─ /thumb  ffmpeg 缩略图（缓存）
                          └─ /media  原图/原视频（HTTP Range）
媒体根目录（XLIKES_MEDIA_ROOT）──→ lib/scanner 全目录增量扫描
lib/fetcher ──→ 备用文案抓取（多级自动降级）
gallery-dl（容器内）──→ 按 gallery-dl.toml 落盘到媒体根目录 → 定向入库
```

## 目录结构

```
xlikes/
├── server.js              # 服务入口（HTTPS + HTTP 跳转）
├── lib/
│   ├── auth.js            # 用户、scrypt 哈希、多设备会话（可踢下线）、登录日志
│   ├── scanner.js         # 全目录增量扫描
│   ├── parser.js          # 文件名正则解析（snowflake 解码时间）
│   ├── store.js           # JSON 存储（原子写入）
│   ├── fetcher.js         # 6 级文案抓取源
│   └── thumbs.js          # ffmpeg 缩略图
├── public/                # SPA（瀑布流 / ID 索引 / 帖子页 / 控制台 / 登录页）
├── scripts/
│   ├── add-user.js        # 用户管理脚本（用法见文件内注释）
│   ├── refetch-missing.js # 批量补抓文案（只取元数据，限速）
│   ├── gen-cert.sh        # 生成 HTTPS 自签证书
│   ├── fetch-thumbs.js    # 批量生成缩略图（可断点续跑）
│   ├── fetch-user-meta.js # 按用户直接补头像 / 用户名
│   └── parse_xlikes.py    # 独立文件名解析工具
├── gallery-dl.toml        # gallery-dl 配置（cookies 路径、基目录、命名规则）
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

# 3. 首次部署需要一个账号才能登录（脚本用法见 scripts/add-user.js 内的注释）

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

# 首次部署：需要一个登录账号才能进入（见容器内 scripts/add-user.js 的注释说明）
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

### 备选：无 docker-compose（仅 docker）

部分精简系统（如只有 Docker 引擎、没装 compose 的 OpenWrt/iStoreOS）没有 `docker-compose`，可改用等价的
`docker build` + `docker run` 重建。镜像名、端口、挂载、环境变量与上面的 compose 版完全一致：

```bash
cd <部署目录>/xlikes

# 1. 构建镜像（tag 用 project_service 命名，与 compose 生成的一致）
docker build -t xlikes-xlikes:latest .

# 2. 停旧容器并删除（首次部署可跳过这两行）
docker stop xlikes
docker rm xlikes

# 3. 启动新容器
docker run -d --name xlikes --restart unless-stopped \
  -p 5287:3000 -p 5280:3080 \
  -e HTTPS_PORT=3000 -e HTTP_PORT=3080 -e CERT_DIR=/app/certs \
  -e XLIKES_MEDIA_ROOT=/data/xlikes -e DATA_DIR=/data/store \
  -v <证书目录>:/app/certs:ro \
  -v <媒体根目录>:/data/xlikes:rw \
  -v <媒体根目录>/.data:/data/store \
  xlikes-xlikes:latest
```

媒体目录用 `:rw`：内置抓取要在容器里写文件（只读也能跑，但粘贴抓取会失败）。
容器内 gallery-dl 固定读 `/data/store/cookies.txt`、写到 `/data/xlikes`，见 `gallery-dl.toml`。

更新代码时：先按上面「更新代码」的 `tar` 命令把代码传到目标机（排除 data / certs / docker-compose.yml），
再执行上面的三步即可，`data/` 与 `certs/` 仍走挂载卷，不会丢。

## 数据与备份

数据目录（`DATA_DIR`）包含全部可备份数据：媒体索引、文案缓存、用户库、登录日志、缩略图缓存。
Docker 部署建议把数据目录放在媒体根目录的 `.data` 子目录（如 `<媒体根目录>/.data`），
整体复制即可备份；容器崩溃 / 重建不影响数据，恢复后重启自动加载。

## 免责声明

本项目仅用于浏览本地备份的个人账户媒体归档，请遵守所在地法律法规与 X 平台服务条款； 文案抓取仅用于本地展示，请勿滥用或对外公开。

## 开源许可

本项目以 **MIT License** 开源，可自由使用、修改与分发（保留版权与许可声明即可），详见 [LICENSE](LICENSE)。

## 致谢

本项目的媒体抓取能力依赖以下开源项目，在此致谢：

- **[gallery-dl](https://github.com/mikf/gallery-dl)**（作者 mikf，GPL-2.0）—— 负责实际的媒体下载与元数据读取。
  本项目**不包含也不链接** gallery-dl 的源代码，只是在运行时以独立进程调用它的命令行（`gallery-dl --config-toml …`），
  并通过解析它的标准输出把文案与作者信息写入本地缓存；gallery-dl 的许可与版权归其作者所有，
  如需分发或修改 gallery-dl 本身，请遵循其 GPL-2.0 条款。
- **[FFmpeg](https://ffmpeg.org/)** —— 生成缩略图（图片缩放、视频抽帧）。
- **[Node.js](https://nodejs.org/)** —— 服务端运行时，本项目仅使用其内置模块，无第三方 npm 依赖。
- **Python** —— 容器内运行 gallery-dl 的解释器。
