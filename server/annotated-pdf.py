#!/usr/bin/env python3
import html
import io
import json
import os
import sys

from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer


TAG_LABELS = {"todo": "待改", "question": "疑问", "resolved": "已解决"}
TYPE_LABELS = {"note": "整页备注", "pin": "标记", "region": "框选", "text": "文字批注"}
VIOLET = colors.HexColor("#5B4CE2")
AMBER = colors.HexColor("#E0932A")
CORAL = colors.HexColor("#D85A4A")


def overlay_page(page, annotations):
    if page.rotation:
        page.transfer_rotation_to_content()
    width = float(page.mediabox.width)
    height = float(page.mediabox.height)
    buffer = io.BytesIO()
    layer = canvas.Canvas(buffer, pagesize=(width, height))
    for annotation in annotations:
        annotation_type = annotation.get("type")
        if annotation_type == "note":
            continue
        marker_number = annotation.get("displayLabel") or "•"
        marker_color = AMBER if annotation.get("tag") == "todo" else CORAL if annotation.get("tag") == "question" else VIOLET
        if annotation_type == "pin":
            x = width * number(annotation.get("x")) / 100
            y = height * (1 - number(annotation.get("y")) / 100)
            draw_marker(layer, x, y, marker_number, marker_color, min(width, height) * 0.018)
            continue

        rects = annotation.get("rects") if annotation_type == "text" else [annotation]
        rects = rects or [annotation]
        first_rect = None
        for rect in rects:
            x = width * number(rect.get("x")) / 100
            rect_width = width * number(rect.get("w")) / 100
            rect_height = height * number(rect.get("h")) / 100
            y = height * (1 - (number(rect.get("y")) + number(rect.get("h"))) / 100)
            if first_rect is None:
                first_rect = (x, y + rect_height)
            layer.saveState()
            if annotation_type == "text":
                layer.setFillColor(VIOLET)
                layer.setFillAlpha(0.22)
                layer.setStrokeAlpha(0)
                layer.rect(x, y, rect_width, rect_height, fill=1, stroke=0)
            else:
                layer.setStrokeColor(marker_color)
                layer.setLineWidth(max(1.2, min(width, height) * 0.0025))
                layer.setFillColor(marker_color)
                layer.setFillAlpha(0.08)
                layer.rect(x, y, rect_width, rect_height, fill=1, stroke=1)
            layer.restoreState()
        if first_rect:
            draw_marker(layer, first_rect[0], first_rect[1], marker_number, marker_color, min(width, height) * 0.014)

    layer.save()
    buffer.seek(0)
    if annotations:
        page.merge_page(PdfReader(buffer).pages[0])
    return page


def draw_marker(layer, x, y, label, color, radius):
    radius = max(7, radius)
    layer.saveState()
    layer.setFillColor(color)
    layer.setStrokeColor(colors.white)
    layer.setLineWidth(max(1, radius * 0.18))
    layer.circle(x, y, radius, fill=1, stroke=1)
    layer.setFillColor(colors.white)
    layer.setFont("Helvetica-Bold", max(7, radius * 0.95))
    layer.drawCentredString(x, y - radius * 0.34, str(label))
    layer.restoreState()


def summary_pdf(payload, page):
    font_name = register_cjk_font()
    buffer = io.BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=f"{payload.get('documentName', '文档')} - 批注汇总",
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("CjkTitle", parent=styles["Title"], fontName=font_name, fontSize=18, leading=24, textColor=colors.HexColor("#20242B"), alignment=TA_LEFT)
    page_style = ParagraphStyle("CjkPage", parent=styles["Heading2"], fontName=font_name, fontSize=13, leading=18, textColor=VIOLET, spaceBefore=9 * mm, spaceAfter=3 * mm)
    body_style = ParagraphStyle("CjkBody", parent=styles["BodyText"], fontName=font_name, fontSize=10.5, leading=16, textColor=colors.HexColor("#303640"), spaceAfter=2.5 * mm)
    quote_style = ParagraphStyle("CjkQuote", parent=body_style, leftIndent=5 * mm, textColor=colors.HexColor("#626A76"), borderColor=colors.HexColor("#D9D6FA"), borderWidth=0, borderPadding=(2 * mm, 3 * mm, 2 * mm, 3 * mm), backColor=colors.HexColor("#F3F1FE"))

    story = [
        Paragraph(escape(payload.get("documentName", "文档")), title_style),
        Paragraph(f"原文第 {page.get('page')} 页 · 批注意见", body_style),
        Spacer(1, 3 * mm),
    ]
    story.append(Paragraph(escape(page.get("title", "")), page_style))
    for annotation in page.get("annotations", []):
        annotation_type = annotation.get("type")
        marker = "整页" if annotation_type == "note" else str(annotation.get("displayLabel") or "•")
        tag = TAG_LABELS.get(annotation.get("tag"), "未分类")
        heading = f"<b>{marker} · {TYPE_LABELS.get(annotation_type, '批注')} · {tag}</b>"
        story.append(Paragraph(heading, body_style))
        if annotation.get("quote"):
            story.append(Paragraph(f"原文：{escape(annotation.get('quote'))}", quote_style))
        comment = annotation.get("text") or "此处尚未填写具体修改意见。"
        story.append(Paragraph(f"意见：{escape(comment)}", body_style))
        for message in annotation.get("reviewMessages", []):
            author = message.get("author") or ("AI" if message.get("role") == "assistant" else "用户")
            story.append(Paragraph(f"{escape(author)}：{escape(message.get('body', ''))}", body_style))
            change = message.get("change") or {}
            if change.get("summary"):
                story.append(Paragraph(f"修改记录：{escape(change.get('summary'))}", quote_style))
    story.append(Spacer(1, 2 * mm))
    document.build(story)
    buffer.seek(0)
    return buffer


def register_cjk_font():
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
    ]
    for font_path in candidates:
        if not os.path.isfile(font_path):
            continue
        try:
            pdfmetrics.registerFont(TTFont("ReviewCJK", font_path, subfontIndex=0))
            return "ReviewCJK"
        except Exception:
            continue
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    return "STSong-Light"


def escape(value):
    return html.escape(str(value or "")).replace("\n", "<br/>")


def number(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: annotated-pdf.py source.pdf payload.json output.pdf")
    source_path, payload_path, output_path = sys.argv[1:]
    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    pages_by_number = {int(page["page"]): page for page in payload.get("pages", [])}
    selected_pages = set(int(page) for page in payload.get("selectedPages", []))
    source = PdfReader(source_path)
    writer = PdfWriter()
    for page_number, page in enumerate(source.pages, start=1):
        if selected_pages and page_number not in selected_pages:
            continue
        page_payload = pages_by_number.get(page_number, {"page": page_number, "title": "", "annotations": []})
        annotations = page_payload.get("annotations", [])
        writer.add_page(overlay_page(page, annotations))
        if annotations:
            summary = PdfReader(summary_pdf(payload, page_payload))
            for summary_page in summary.pages:
                writer.add_page(summary_page)
    writer.add_metadata({"/Title": f"{payload.get('documentName', 'Document')} - Review annotations"})
    with open(output_path, "wb") as handle:
        writer.write(handle)


if __name__ == "__main__":
    main()
