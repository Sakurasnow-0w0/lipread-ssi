"""從霞鶩文楷 TC 抽出句庫用得到的字，產生錄影頁字幕條用的子集字型。

改了 assets/phrases.js 之後重跑一次：

    pip install fonttools==4.68.0 brotli==1.2.1
    python -X utf8 tools/make-kai-subset.py <LXGWWenKaiTC-Regular.ttf 的路徑>

字型來源：https://github.com/lxgw/LxgwWenkaiTC/releases （OFL-1.1，授權全文在 assets/fonts/OFL.txt）
輸出：
  assets/fonts/wenkai-tc-subset.woff2  子集字型
  assets/fonts/kai-chars.js            子集收了哪些字；整句都在裡面才用楷體，否則整句改用黑體，避免一句混兩種字
"""
import json
import pathlib
import re
import sys

from fontTools import subset

ROOT = pathlib.Path(__file__).resolve().parent.parent
PHRASES = ROOT / "assets" / "phrases.js"
OUT_DIR = ROOT / "assets" / "fonts"


def phrase_chars() -> str:
    src = PHRASES.read_text(encoding="utf-8")
    # 只取 items 陣列裡的字串
    chars = set()
    for block in re.findall(r"items:\s*\[([^\]]*)\]", src):
        for s in re.findall(r'"([^"\\]*)"', block):
            chars.update(s)
    chars.discard(" ")
    if not chars:
        sys.exit("phrases.js 裡找不到任何句子")
    return "".join(sorted(chars))


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    font_path = pathlib.Path(sys.argv[1])
    if not font_path.is_file():
        sys.exit(f"找不到字型檔：{font_path}")
    chars = phrase_chars()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "wenkai-tc-subset.woff2"
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = []
    opts.name_IDs = ["*"]  # 保留版權與授權資訊
    opts.notdef_outline = True
    font = subset.load_font(str(font_path), opts)
    sub = subset.Subsetter(opts)
    sub.populate(text=chars)
    sub.subset(font)
    subset.save_font(font, str(out), opts)
    (OUT_DIR / "kai-chars.js").write_text(
        "/* 由 tools/make-kai-subset.py 產生，不要手改。子集字型收錄的字。 */\n"
        f"window.LR_KAI_CHARS = {json.dumps(chars, ensure_ascii=False)};\n",
        encoding="utf-8",
    )
    print(f"{len(chars)} 個字，{out.stat().st_size / 1024:.1f} KB → {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
