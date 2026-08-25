# 使用 gallery-dl 构建符合 Xlikes 结构的媒体库

> 目标：用 [gallery-dl](https://codeberg.org/mikf/gallery-dl) 自动下载 X（Twitter）媒体，
> 输出目录与文件名与 Xlikes 的解析规则完全一致，下载完成后 Xlikes 扫描即可展示。

## 为什么用 gallery-dl

- 活跃维护的 Python CLI，支持 100+ 站点，官方提供 Docker 镜像；
- 通过 `directory` / `filename` 模板可以精确生成 Xlikes 要求的目录与文件名；
- 支持登录 cookies、限速、跳过已下载（archive），适合长期追更。

## 1. 安装

任选一种：

```bash
pip install gallery-dl          # Python
brew install gallery-dl         # macOS
docker pull ghcr.io/mikf/gallery-dl   # Docker
```

## 2. 准备 X 登录 cookies

X 对未登录/自动化请求风控严格，建议使用小号并导出登录 cookies：

1. 浏览器登录 X 后，用扩展（如 Chrome 的 *Get cookies.txt LOCALLY*）导出 Netscape 格式的
   `cookies.txt`；
2. 保存到安全位置，如 `~/.config/gallery-dl/cookies.txt`；
3. cookies 会过期，定期重新导出。

## 3. 配置文件（对齐 Xlikes 结构）

配置文件默认位置 `~/.config/gallery-dl/config.json`：

```json
{
  "extractor": {
    "twitter": {
      "cookies": "/path/to/cookies.txt",
      "directory": ["{user[name]}", "{date:%Y-%m-%d}"],
      "filename": "{user[name]}_{date:%Y%m%d}__{tweet_id}_{num}_{id}.{extension}",
      "sleep-request": 5.0,
      "archive": "/path/to/archive.sqlite"
    }
  }
}
```

字段说明：

| 模板字段 | 含义 |
|---|---|
| `{user[name]}` | 发帖用户 ID |
| `{date:%Y-%m-%d}` / `{date:%Y%m%d}` | 发布日期（可格式化） |
| `{tweet_id}` | 帖子 ID |
| `{num}` | 帖内媒体序号 |
| `{id}` | 媒体 ID |
| `{extension}` | 扩展名 |

输出结果与 Xlikes 媒体库结构一致：

```
<媒体根目录>/
└── <用户ID>/
    └── <YYYY-MM-DD>/
        └── <用户ID>_<YYYYMMDD>__<帖子ID>_<媒体编号>_<媒体ID>.mp4
```

## 4. 下载使用

```bash
# 单个帖子
gallery-dl "https://x.com/<用户ID>/status/<帖子ID>"

# 整个账号的媒体
gallery-dl "https://x.com/<用户ID>"

# 批量（文件内每行一个链接）
gallery-dl -i urls.txt
```

## 5. 风控与限速建议

- 使用小号 + cookies，避免主账号被封；
- `sleep-request` 设置请求间隔（如上 5 秒）；
- 大批量下载建议分段执行，遇到限流停一段时间再继续；
- `archive` 记录已下载项，重复运行自动跳过。

## 6. 验证

- 用 `gallery-dl -K <链接>` 查看可用的元数据字段；
- 下载完成后在 Xlikes「控制台 → 扫描」点「立即扫描」，或在全部贴文页直接查看新内容；
- 也可用 `scripts/parse_xlikes.py --paths <文件路径>` 单独校验文件名是否符合解析规则。
