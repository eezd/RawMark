#!/usr/bin/env python3
"""从指定 v7.9 ZIP 重建本地字体：python3 scripts/prepare-maple-font.py /path/to/MapleMonoNormalNL-NF-CN.zip。
仅重建字体时需要 fonttools[woff]；应用构建直接使用已入库的 WOFF2。
来源：https://github.com/subframe7536/maple-font/releases/tag/v7.9
"""
import io
from pathlib import Path
import sys
import zipfile

from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parents[1] / 'web/src/common/appearance'
output = root / 'fonts/maple'
output.mkdir(exist_ok=True)
family = 'Maple Mono Normal NL NF CN'
css = ['/* Maple Mono v7.9；由 scripts/prepare-maple-font.py 生成，授权见 fonts/maple/LICENSE.txt。 */']
with zipfile.ZipFile(sys.argv[1]) as archive:
    (output / 'LICENSE.txt').write_bytes(archive.read('LICENSE.txt'))
    for variant, weight, style in [('Regular', 400, 'normal'), ('Bold', 700, 'normal'), ('Italic', 400, 'italic'), ('BoldItalic', 700, 'italic')]:
        data = archive.read('MapleMonoNormalNL-NF-CN-' + variant + '.ttf')
        source = TTFont(io.BytesIO(data))
        points = sorted(source.getBestCmap())
        # 按 Unicode 区间分片，中文和 Nerd Font 不强制随拉丁文字一起下载。
        for block in sorted({cp // 4096 for cp in points}):
            unicodes = [cp for cp in points if cp // 4096 == block]
            font = TTFont(io.BytesIO(data), recalcTimestamp=False)
            options = subset.Options()
            options.flavor = 'woff2'
            subsetter = subset.Subsetter(options=options)
            subsetter.populate(unicodes=unicodes)
            subsetter.subset(font)
            font.flavor = 'woff2'
            name = f'{variant.lower()}-{block:02x}.woff2'
            font.save(output / name)
            css.append(f"@font-face {{ font-family: '{family}'; font-style: {style}; font-weight: {weight}; font-display: block; src: url('./fonts/maple/{name}') format('woff2'); unicode-range: U+{block * 4096:X}-{(block + 1) * 4096 - 1:X}; }}")
(root / 'maple-font.css').write_text('\n'.join(css) + '\n')
