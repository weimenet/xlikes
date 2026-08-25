# Xlikes

> 自托管的 X（Twitter）媒体库浏览器 —— 从 xlikes 媒体根目录扫描图片与视频，
> 提供 Pinterest 风格拼图瀑布流、ID 索引、仿 X 帖子详情与多源文案抓取。
> 登录保护 + HTTPS，部署在局域网内使用，零 npm 依赖。

## 简介

媒体文件按 `用户 ID / 发布日期` 的目录结构保存，文件名中编码了帖子 ID 与媒体 ID。
Xlikes 直接扫描媒体根目录下的这些文件（只读文件名、不读内容），解析出帖子元数据并构建索引，
无需额外数据库。

浏览器端提供三层浏览体验：**全部贴文**（按时间排序的拼图瀑布流，同一帖子的多张媒体合并为一张卡片）、
**ID 索引**（按首字母 / 数字 / 特殊符号分组，右侧面包屑快速跳转）、**帖子页**（缩略图点击看原图，
自动抓取帖子文案并溯源到 x.com 原帖）。

服务端内置 HTTPS（自签证书）、基于 Cookie 的登录会话（新登录自动踢掉旧设备）、
全目录增量扫描、ffmpeg 缩略图缓存，以及 6 级数据源的文案抓取（含被删帖的 Wayback 历史快照）。
整个服务只用 Node.js 内置模块实现，任何能跑 Node 18+ 的设备都能运行。

## 功能特性

- **登录保护**：无注册入口，用户由管理员手动添加；密码 scrypt 加盐哈希；单设备会话（新登录使旧会话失效）；记录每次登录的 IP / 设备 / 结果
- **HTTPS**：自签证书，局域网加密访问；HTTP 端口自动 302 跳转到 HTTPS
- **拼图瀑布流**：同一帖子的媒体自动合并（单图 / 上下 2 宫格 / 上 2 下 1 / 2×2 宫格，超过 4 张显示 `+N`），底部渐变悬浮层显示发帖 ID 与两行文案摘录
- **筛选排序**：按日期新→旧 / 旧→新、时间段筛选；搜索支持模糊匹配用户 ID 与文案内容；筛选与排序在搜索结果中同样可用
- **ID 索引**：A-Z / 0-9 / 特殊符号分组（字母不区分大小写），按字母或贴文数排序，右侧竖排面包屑平滑跳转
- **帖子详情**：缩略图点击看原图（图片灯箱 / 视频原地播放），仿 X 布局，含原文链接
- **多源文案抓取**：fxtwitter → vxtwitter → oembed → Wayback 快照 → x.com embed → x.com 主站，6 级降级；失败自动重试（最多 3 轮），可手动重试 / 手动填写
- **抓取管理台**：进度条 + 抓取中状态、按状态筛选（已抓取 / 待抓取 / 失败 / 原帖不存在）、手动添加链接
- **增量扫描**：对比整个目录树（新增 / 删除 / 变更用户），新内容自动入索引并触发文案抓取；控制台提供手动扫描按钮
- **下载路径设置**：控制台可配置媒体下载输出目录（宿主机实际绝对路径），为媒体下载功能预留

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
├── public/                # SPA（瀑布流 / ID 索引 / 帖子页 / 管理台 / 登录页）
├── scripts/
│   ├── add-user.js        # 唯一建号入口（含改密）
│   ├── gen-cert.sh        # 生成 HTTPS 自签证书
│   └── parse_xlikes.py    # 独立文件名解析工具
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
`XLIKES_HOST_MEDIA_ROOT`（宿主机媒体根实际路径，用于把设置中的宿主机下载路径映射为容器内路径）、
`XLIKES_MEDIA_LIMIT`（媒体扫描上限，0 = 全部）、`DATA_DIR`、`HTTPS_PORT` / `HTTP_PORT`、
`CERT_DIR`、`RESCAN_MS`（增量扫描间隔）、`FETCH_INTERVAL_MS`（文案抓取限速）。

## Docker 部署

```bash
scp -r xlikes root@<主机IP>:<部署目录>/
ssh root@<主机IP>
cd <部署目录>/xlikes && docker-compose up -d --build
docker exec xlikes node scripts/add-user.js <用户名> <密码>
```

端口：`5287` HTTPS 主入口，`5280` HTTP 自动跳转 HTTPS。

部署前编辑 `docker-compose.yml`：
- `XLIKES_MEDIA_ROOT`：容器内媒体根目录（建议与下方挂载一致）；
- `XLIKES_HOST_MEDIA_ROOT`：宿主机媒体根的实际路径（部署机视角）；
- `volumes`：媒体目录**可写**挂载到容器内 `XLIKES_MEDIA_ROOT`（供下载功能输出）；数据目录建议放在媒体根目录的
  `.data` 子目录（容器崩溃/重建不影响配置与缓存）；证书目录改为实际路径。

控制台“设置”中的下载文件夹路径填宿主机实际路径；只要位于媒体根目录内，保存后会自动映射为容器内路径并立即生效。

容器 `restart: unless-stopped`，开机自启。

## 数据与备份

`data/` 目录包含全部可备份数据：媒体索引、文案缓存、用户库、登录日志、缩略图缓存。
整体复制即可备份；恢复后重启容器自动加载。

## 免责声明

本项目仅用于浏览个人已下载的媒体归档，请遵守所在地法律法规与 X 平台服务条款；
文案抓取仅用于本地展示，请勿滥用或对外公开。
