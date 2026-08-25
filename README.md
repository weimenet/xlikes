# Xlikes 瀑布流浏览服务

浏览 媒体下载目录的媒体：首页瀑布流（按时间轴倒序、缩略图分屏加载）、用户主页、
仿 X 的帖子详情页（缩略图点击看原图、文案与原文链接）、文案抓取管理页。
零 npm 依赖，只用 Node.js 内置模块，路由器上免编译免下载；缩略图依赖系统 `ffmpeg`。

## 文件结构

```
<media-root>/            # 媒体根目录（XLIKES_MEDIA_ROOT）
└── <user-id>/                    # 用户 ID
    └── 2026-04-03/               # 帖子发布日期
        └── <user-id>_20260403__<tweet-id>_1_<media-id>.mp4
```

文件名 = `<用户ID>_<YYYYMMDD>__<帖子ID>_<媒体编号>_<媒体ID>.<ext>`
原帖链接 = `https://x.com/<用户ID>/status/<帖子ID>`

## 本地运行

```bash
node server.js                       # 默认媒体根 <media-root>，端口 3000
node server.js --rescan              # 强制重建索引后启动
XLIKES_MEDIA_LIMIT=200 node server.js     # 只索引前 200 条（调试用）
```

打开 http://localhost:3000 。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `XLIKES_MEDIA_ROOT` | `<media-root>` | 媒体根目录 |
| `PORT` | `3000` | 服务端口 |
| `DATA_DIR` | `./data` | 索引与文案缓存目录 |
| `XLIKES_MEDIA_LIMIT` | `0`（全部） | 最多索引多少条媒体 |
| `RESCAN_MS` | `600000` | 增量扫描间隔（毫秒） |
| `FETCH_INTERVAL_MS` | `5000` | 文案抓取限速（毫秒/条） |

## API

- `GET /api/feed?offset=&limit=` 瀑布流媒体（按帖子时间倒序）
- `GET /api/users?offset=&limit=` 用户列表（按媒体数排序）
- `GET /api/user/:id?offset=&limit=` 指定用户的媒体
- `GET /api/post/:tweetId` 帖子详情（媒体 + 文案 + 原文链接）
- `GET /api/text/:tweetId` 文案状态（前端轮询用）
- `GET /api/texts?status=&offset=&limit=` 文案抓取列表 + 统计
- `POST /api/texts/retry` 手动重试单条 `{tweetId}`
- `POST /api/texts/retry-all` 按状态批量重试 `{status}`
- `POST /api/texts/add` 手动添加链接 `{url: "https://x.com/user/status/123"}`
- `GET /thumb/<相对路径>` 媒体缩略图（图片缩放 / 视频抽帧，缓存到 `data/thumbs/`）
- `GET /media/<相对路径>` 媒体文件（支持 HTTP Range，视频可拖动）
- `GET /api/refresh` 后台重建索引
- `GET /api/health` 健康检查

## 文案抓取

后台静默抓取全部帖子文案：优先走 `publish.twitter.com/oembed`（免登录、稳定），
失败后回退抓取 `x.com/<user>/status/<id>` 页面中 `class="r-bcqeeo"` 的 div。
结果缓存在 `DATA_DIR/xlikes-posts.json`，状态标记：

- `ok` 已抓取（含来源 oembed / x）
- `pending` 待抓取
- `failed` 抓取失败（可手动重试）
- `not_found` 原帖不存在（404，不自动重试）

打开帖子页会自动按需抓取；管理页 `#/texts` 可查看统计、按状态筛选、单条重试、
批量重试失败项、粘贴 x.com 链接手动添加抓取。

## 缩略图

瀑布流与帖子页默认加载 `/thumb/` 缩略图（图片缩放、视频抽帧，宽 480px），
点击帖子内媒体才加载原图/原视频。缩略图由 ffmpeg 生成并缓存到
`DATA_DIR/thumbs/`；若 ffmpeg 不可用，自动回退到原图（视频显示首帧占位）。

## 部署到目标机（<host-ip>:5287）

先在目标机上把 媒体共享挂载到 `<media-root>`（SMB/NFS 均可），再选一种方式：

### 方式一：Docker（推荐，需目标机支持 Docker）

```bash
scp -r xlikes root@<host-ip>:<deploy-dir>
ssh root@<host-ip>
cd <deploy-dir> && docker compose up -d --build
```

compose 已配置 `restart: unless-stopped`，开机自启、映射 5287 端口。
若目标机无法在线构建镜像，可在本机 `docker build` 后
`docker save | ssh root@<host-ip> docker load` 导入。

### 方式二：无 Docker（OpenWrt / iStoreOS）

```bash
ssh root@<host-ip>
opkg install node ffmpeg
cp <deploy-dir>/init.d/xlikes /etc/init.d/xlikes
chmod +x /etc/init.d/xlikes
/etc/init.d/xlikes enable && /etc/init.d/xlikes start
```

最后在目标机防火墙放行 5287 端口（或做端口转发）。
