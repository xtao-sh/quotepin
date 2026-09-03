#!/usr/bin/env python3
"""重新生成 examples/files 下的示例文档。

生成结果已经提交在仓库里，平时不需要跑这个脚本——它存在是为了让示例内容可以被修改和复现，
而不是一堆来历不明的二进制文件。

中文用 reportlab 的 STSong-Light：这是 Adobe 标准 CJK CID 字体，PDF 里只引用不嵌入，所以
每份讲义只有几 KB，仓库里也不需要放字体文件。代价是 PDF 不自包含——阅读器得自己有中文字体。
macOS 和装了中文字体的 Linux 都没问题，纯净的容器里会显示空白。示例文档接受这个取舍；
真正的文档不受影响，因为它们本来就是你自己的文件。
"""

import subprocess
import sys
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

FILES = Path(__file__).resolve().parent / "files"
FONT = "STSong-Light"
WIDTH, HEIGHT = A4
MARGIN = 60
FOOTER = "本文件为示例内容，其中的课程、人物与数据均为虚构。"


def write_pdf(name, pages, outline=True):
    """pages: [(标题, [正文行...]), ...]"""
    target = FILES / name
    pdf = canvas.Canvas(str(target), pagesize=A4)
    pdf.setTitle(name.replace(".pdf", ""))
    for index, (title, lines) in enumerate(pages):
        y = HEIGHT - MARGIN - 10
        pdf.setFont(FONT, 20)
        pdf.drawString(MARGIN, y, title)
        if outline:
            pdf.bookmarkPage(f"p{index}")
            pdf.addOutlineEntry(title, f"p{index}", level=0)
        y -= 34
        pdf.setFont(FONT, 11.5)
        for line in lines:
            if not line:
                y -= 9
                continue
            if line.startswith("## "):
                y -= 6
                pdf.setFont(FONT, 14)
                pdf.drawString(MARGIN, y, line[3:])
                pdf.setFont(FONT, 11.5)
                y -= 22
                continue
            pdf.drawString(MARGIN, y, line)
            y -= 19
        pdf.setFont(FONT, 8.5)
        pdf.drawString(MARGIN, 40, FOOTER)
        pdf.drawRightString(WIDTH - MARGIN, 40, f"第 {index + 1} 页")
        pdf.showPage()
    pdf.save()
    print(f"  {name}  ({target.stat().st_size} 字节, {len(pages)} 页)")


# --------------------------------------------------------------- 课程大纲
# 主力批注对象。第 2 页那句「课程共 12 周」和课程日历.csv 里的 14 周互相矛盾，
# 是全文搜索能同时命中 PDF 和 CSV 两种格式的落点。
SYLLABUS = [
    ("示例课程 · 课程大纲", [
        "## 课程定位",
        "本课程面向没有统计背景的高年级本科生，目标是让学生能读懂一份带",
        "数据的报告，并说出它哪里可信、哪里不可信。不要求编程基础。",
        "",
        "## 授课安排",
        "课程共 12 周，每周一次，每次两课时。",
        "前 6 周讲数据从哪里来，后 6 周讲结论怎么被夸大。",
        "",
        "## 考核方式",
        "平时作业 40%，期末项目 60%。没有闭卷考试。",
    ]),
    ("示例课程 · 周次安排", [
        "## 第一部分：数据从哪里来",
        "第 1 讲　什么算证据",
        "第 2 讲　抽样为什么会骗人",
        "第 3 讲　问卷是怎么写坏的",
        "第 4 讲　抽样与偏差",
        "第 5 讲　缺失值",
        "第 6 讲　中期回顾",
        "",
        "## 第二部分：结论怎么被夸大",
        "第 7 讲　相关不是因果",
        "第 8 讲　图表里的手脚",
    ]),
    ("示例课程 · 期末项目", [
        "## 要求",
        "自选一份公开发布的数据报告，指出其中至少三处可疑之处，",
        "并说明如果你来做，会怎么重新设计取数或呈现方式。",
        "",
        "## 篇幅",
        "正文 300 字以内，图表不计入字数。",
        "",
        "## 提交",
        "学期最后一周课上提交纸质稿，不接受邮件。",
    ]),
]

# --------------------------------------------------------------- 第 3 讲讲义（归档演示）
LECTURE3 = [
    ("第 3 讲　问卷是怎么写坏的", [
        "## 本讲要点",
        "一个问题的问法会决定它得到什么答案。",
        "这一讲用三个改写前后的对照来说明这件事。",
        "",
        "## 对照一：诱导性措辞",
        "改写前：你是否同意本次改革带来了积极变化？",
        "改写后：你如何评价本次改革带来的变化？",
    ]),
    ("第 3 讲　练习", [
        "## 课堂练习",
        "把下面这三个问题各改写一遍，使它们不再暗示答案：",
        "1. 你有多满意目前的服务质量？",
        "2. 你是否认为应当继续加大投入？",
        "3. 大多数同学都选择了住校，你的选择是？",
    ]),
]

# --------------------------------------------------------------- 第 4 讲讲义 v1
# 刷新演示的主角。v2 在第 2 页之后插入一整页，于是原来第 3 页的内容整体后移；
# 文字批注引用的句子逐字未变，重新定位后应当仍然命中。
LECTURE4_V1 = [
    ("第 4 讲　抽样与偏差", [
        "## 本讲要点",
        "抽样偏差不是样本太小，而是样本取错了地方。",
        "样本再大，取错了地方也不会自己变对。",
    ]),
    ("第 4 讲　一个例子", [
        "## 电话调查",
        "上世纪一次著名的选举预测靠电话名录抽样，结论错得离谱。",
        "原因不是打得不够多，而是当年装得起电话的人本身就不具代表性。",
        "",
        "这类偏差无法用扩大样本量补救。",
    ]),
    ("第 4 讲　怎么识别", [
        "## 三个提问",
        "一、这份数据里，谁被系统性地漏掉了？",
        "二、被漏掉的人，回答会不会和留下的人不同？",
        "三、如果会，结论会往哪个方向偏？",
        "",
        "把这三个问题问完，多数报告的问题就露出来了。",
    ]),
    ("第 4 讲　作业", [
        "## 本讲作业",
        "找一份你信任的调查报告，回答上一页的三个提问。",
        "作业于下周三 18:00 前提交。",
    ]),
]

# --------------------------------------------------------------- 第 4 讲讲义 v2
# 与 v1 的差别只有两处，都是刻意设计的：
#   1. 第 2 页之后插入「一个反例」整页 —— 后面所有页码后移，考验重新定位；
#   2. 作业截止时间由「下周三 18:00」改为「下周五 12:00」—— 引用这一句的批注会失配。
LECTURE4_V2 = [
    LECTURE4_V1[0],
    LECTURE4_V1[1],
    ("第 4 讲　一个反例", [
        "## 样本小但没有偏差",
        "体检抽血只取几毫升，却足以代表全身，因为血液是混匀的。",
        "抽样的成败不在量，而在抽之前有没有把总体搅匀。",
        "",
        "这一页是第二版新增的内容。",
    ]),
    LECTURE4_V1[2],
    ("第 4 讲　作业", [
        "## 本讲作业",
        "找一份你信任的调查报告，回答上一页的三个提问。",
        "作业于下周五 12:00 前提交。",
    ]),
]


def main():
    FILES.mkdir(parents=True, exist_ok=True)
    pdfmetrics.registerFont(UnicodeCIDFont(FONT))
    print("生成 PDF：")
    write_pdf("课程大纲.pdf", SYLLABUS)
    write_pdf("第3讲讲义.pdf", LECTURE3)
    write_pdf("第4讲讲义.pdf", LECTURE4_V1)
    write_pdf("第4讲讲义-v2.pdf", LECTURE4_V2)

    # 图片示例：先渲染一页 PDF 再转 PNG，省得引入绘图依赖。
    print("生成 PNG：")
    diagram = [("抽样与偏差　示意", [
        "总体　→　抽样框　→　样本　→　结论",
        "",
        "偏差进入的位置不在最后一步，而在第二步：",
        "抽样框漏掉了谁，结论就替谁说不了话。",
        "",
        "（图片文档只能用点标和框选批注；装了 chi_sim 之后",
        "　才能对它做按页 OCR，建立可选中的文字层。）",
    ])]
    write_pdf("_diagram.pdf", diagram, outline=False)
    source = FILES / "_diagram.pdf"
    subprocess.run(
        ["pdftoppm", "-png", "-r", "110", "-f", "1", "-l", "1",
         "-W", "1200", "-H", "780", "-x", "0", "-y", "0",
         str(source), str(FILES / "抽样示意图")],
        check=True,
    )
    produced = FILES / "抽样示意图-1.png"
    if produced.exists():
        produced.replace(FILES / "抽样示意图.png")
    source.unlink()
    print(f"  抽样示意图.png  ({(FILES / '抽样示意图.png').stat().st_size} 字节)")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - 这是给人看的脚本，报清楚就够了
        print(f"生成失败：{error}", file=sys.stderr)
        raise SystemExit(1)
