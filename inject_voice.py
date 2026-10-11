"""
把语音文件内联进 client.js。

为什么要有这个脚本：宿主半（index.js）改了**必须重启 DSH 进程**才生效，而客户端半是
热更的。所以语音走"内联进客户端"这条路，改完立刻能响。代价是音频跟页面一起走
（206 KB 的 wav → 约 275 KB 的 base64），语音一多就该改成宿主扫目录提供列表。

用法（可传多个文件，点击时随机挑一条）：
    python inject_voice.py "C:\\path\\a.wav" "C:\\path\\b.wav"

写入的位置由 BEGIN/END 两个标记框住，重复运行是幂等的（旧的整块会被替换掉）。
"""
import base64
import re
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent
CLIENT = PLUGIN / "client.js"
BEGIN = "/* __VOICE_DATA_BEGIN__ */"
END = "/* __VOICE_DATA_END__ */"


def build_block(paths):
    """把每个音频编成 data URL，拼成一段 JS。"""
    lines = [BEGIN, "// 语音数据由 inject_voice.py 注入；要改请重跑脚本，不要手改下面这行。"]
    entries = []
    for raw in paths:
        path = Path(raw)
        payload = base64.b64encode(path.read_bytes()).decode("ascii")
        entries.append(f'  "data:audio/wav;base64,{payload}",')
        print(f"  + {path.name}  {len(payload) // 1024} KB (base64)")
    lines.append("window.__PRIESTESS_VOICES__ = [")
    lines.extend(entries)
    lines.append("];")
    lines.append(END)
    return "\n".join(lines) + "\n"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    block = build_block(sys.argv[1:])
    source = CLIENT.read_text(encoding="utf-8")
    if BEGIN in source and END in source:
        pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?", re.DOTALL)
        updated = pattern.sub(block, source, count=1)
        action = "替换"
    else:
        updated = block + source
        action = "插入"
    CLIENT.write_text(updated, encoding="utf-8")
    print(f"{action}完成：{CLIENT.name} 现在 {len(updated.encode('utf-8')) // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
