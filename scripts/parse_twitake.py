#!/usr/bin/env python3
"""Xlikes 媒体文件解析器：文件名 -> 帖子元数据 + x.com 链接。

命名格式：<用户ID>_<发布日期YYYYMMDD>__<帖子ID>_<媒体编号>_<媒体ID>.mp4|jpg|png
目录结构：<根目录>/<用户ID>/<发布日期YYYY-MM-DD>/<文件名>

用法示例：
  python3 parse_xlikes.py --paths <media-root>/<user-id>/2026-04-03/<user-id>_20260403__<tweet-id>_1_<media-id>.mp4
  python3 parse_xlikes.py --root <media-root> --limit 20 --out index.json
"""

import argparse
import json
import os
import re
from pathlib import Path

# 非贪婪匹配 <用户ID>，可兼容用户名里带下划线的情况（如 my_user_20240301）
FILE_RE = re.compile(
    r"^(?P<user>.+?)_(?P<date>\d{8})__"
    r"(?P<tweet>\d+)_(?P<media>\d+)_(?P<media_id>\d+)"
    r"\.(?P<ext>jpg|jpeg|png|mp4)$",
    re.IGNORECASE,
)


def parse_path(path: str) -> dict | None:
    """解析单个文件路径，返回帖子元数据；文件名不匹配时返回 None。"""
    p = Path(path)
    m = FILE_RE.match(p.name)
    if not m:
        return None

    name_date = m.group("date")
    user = m.group("user")
    date = f"{name_date[:4]}-{name_date[4:6]}-{name_date[6:]}"

    return {
        "user": user,
        "date": date,
        "tweet_id": m.group("tweet"),
        "media_index": int(m.group("media")),
        "media_id": m.group("media_id"),
        "ext": m.group("ext").lower(),
        "file": str(p),
        "post_url": f"https://x.com/{user}/status/{m.group('tweet')}",
    }


def scan(root: str, limit: int | None = None) -> list[dict]:
    """遍历根目录，仅匹配文件名，不读取文件内容。"""
    items: list[dict] = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            if not FILE_RE.match(name):
                continue
            item = parse_path(os.path.join(dirpath, name))
            if item:
                items.append(item)
                if limit and len(items) >= limit:
                    return items
    return items


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--paths", nargs="*", help="直接解析的文件路径（不扫描目录）")
    ap.add_argument("--root", help="媒体根目录，如 <media-root>")
    ap.add_argument("--limit", type=int, help="最多输出多少条")
    ap.add_argument("--out", help="输出到 JSON 文件，缺省打印到终端")
    args = ap.parse_args()

    items: list[dict] = []
    for fp in args.paths or []:
        item = parse_path(fp)
        if item:
            items.append(item)

    if args.root:
        remaining = args.limit - len(items) if args.limit else None
        items += scan(args.root, limit=remaining)

    if args.limit:
        items = items[: args.limit]

    text = json.dumps(items, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    else:
        print(text)


if __name__ == "__main__":
    main()
