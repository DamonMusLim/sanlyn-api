#!/usr/bin/env python3
"""
Sanlyn OS — PDF 电子签章引擎 v1.0
用法:
  python3 stamp_pdf.py <input.pdf> <stamp.png> <output.pdf> [options]

Options:
  --pages all|last|1,3,5    要盖章的页面 (默认: last)
  --position br|bl|bc|cr    位置预设 (默认: br = 右下)
  --scale 0.19              印章缩放比例 (默认: 0.19, 标准40mm公章)
  --opacity 0.85            透明度 (默认: 0.85)
  --offset-x 60             X偏移(从边缘) pt (默认: 60)
  --offset-y 60             Y偏移(从边缘) pt (默认: 60)

Position presets:
  br = bottom-right    bl = bottom-left    bc = bottom-center
  cr = center-right    tr = top-right      cc = center-center
"""

import sys
import io
import argparse
from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader, PdfWriter


def remove_black_bg(img_path):
    """去除黑色背景，返回透明 RGBA Image"""
    import numpy as np
    img = Image.open(img_path).convert('RGBA')
    data = np.array(img)
    r, g, b = data[:,:,0], data[:,:,1], data[:,:,2]
    brightness = (r.astype(int) + g.astype(int) + b.astype(int)) / 3
    red_ratio = np.where(brightness > 5, r.astype(float) / (brightness + 1), 0)

    # 红色印章部分
    seal_mask = (r > 40) & (red_ratio > 1.3)
    # 签名部分（底部25%）
    sig_y = int(data.shape[0] * 0.75)
    sig_mask = np.zeros_like(seal_mask)
    sig_mask[sig_y:] = brightness[sig_y:] > 25

    alpha = np.zeros_like(r, dtype=np.uint8)
    alpha = np.where(seal_mask, np.clip(r.astype(int) * 2, 0, 255).astype(np.uint8), alpha)
    alpha = np.where(sig_mask & ~seal_mask, np.clip(brightness * 3, 0, 255).astype(np.uint8), alpha)
    data[:,:,3] = alpha
    return Image.fromarray(data)


def make_stamp_overlay(stamp_img, page_w, page_h, position='br',
                       scale=0.19, opacity=0.85, offset_x=60, offset_y=60):
    """
    生成印章 PDF overlay (单页，与目标页同尺寸)
    stamp_img: PIL Image (RGBA)
    返回: bytes (PDF)
    """
    # 应用透明度到 alpha 通道
    import numpy as np
    arr = np.array(stamp_img)
    arr[:,:,3] = (arr[:,:,3].astype(float) * opacity).astype(np.uint8)
    stamp_img = Image.fromarray(arr)

    # 计算印章尺寸
    orig_w, orig_h = stamp_img.size
    stamp_w = page_w * scale
    stamp_h = stamp_w * (orig_h / orig_w)

    # 如果高度超出页面的40%，按高度缩
    if stamp_h > page_h * 0.4:
        stamp_h = page_h * 0.4
        stamp_w = stamp_h * (orig_w / orig_h)

    # 计算位置
    positions = {
        'br': (page_w - stamp_w - offset_x, offset_y),                          # 右下
        'bl': (offset_x, offset_y),                                              # 左下
        'bc': ((page_w - stamp_w) / 2, offset_y),                               # 下中
        'tr': (page_w - stamp_w - offset_x, page_h - stamp_h - offset_y),       # 右上
        'tl': (offset_x, page_h - stamp_h - offset_y),                          # 左上
        'cr': (page_w - stamp_w - offset_x, (page_h - stamp_h) / 2),            # 右中
        'cc': ((page_w - stamp_w) / 2, (page_h - stamp_h) / 2),                 # 正中
    }
    x, y = positions.get(position, positions['br'])

    # 生成 overlay PDF
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(page_w, page_h))
    img_reader = ImageReader(stamp_img)
    c.drawImage(img_reader, x, y, width=stamp_w, height=stamp_h, mask='auto')
    c.save()
    buf.seek(0)
    return buf


def parse_pages(pages_str, total_pages):
    """解析页码参数"""
    if pages_str == 'all':
        return list(range(total_pages))
    elif pages_str == 'last':
        return [total_pages - 1]
    elif pages_str == 'first':
        return [0]
    elif pages_str == 'first_last':
        if total_pages == 1:
            return [0]
        return [0, total_pages - 1]
    else:
        # 逗号分隔: "1,3,5" -> [0, 2, 4]
        indices = []
        for p in pages_str.split(','):
            p = p.strip()
            if p.isdigit():
                idx = int(p) - 1  # 1-based to 0-based
                if 0 <= idx < total_pages:
                    indices.append(idx)
        return indices


def stamp_pdf(input_pdf, stamp_img, output_pdf=None,
              pages='last', position='br', scale=0.19,
              opacity=0.85, offset_x=60, offset_y=60):
    """
    主函数：给 PDF 盖章
    
    Args:
        input_pdf:  输入PDF路径或bytes
        stamp_img:  印章图片 (PIL Image RGBA) 或路径
        output_pdf: 输出PDF路径 (None则返回bytes)
        pages:      'all'|'last'|'first'|'first_last'|'1,3,5'
        position:   'br'|'bl'|'bc'|'tr'|'cr'|'cc'
        scale:      印章缩放 (相对页宽)
        opacity:    透明度 0-1
        offset_x:   X边距 (pt)
        offset_y:   Y边距 (pt)
    
    Returns:
        如果 output_pdf=None, 返回 stamped PDF bytes
    """
    # 读取印章图片
    if isinstance(stamp_img, str):
        stamp_img = Image.open(stamp_img).convert('RGBA')
    
    # 读取源PDF
    if isinstance(input_pdf, bytes):
        reader = PdfReader(io.BytesIO(input_pdf))
    else:
        reader = PdfReader(input_pdf)
    
    total = len(reader.pages)
    target_pages = parse_pages(pages, total)
    
    writer = PdfWriter()
    
    for i, page in enumerate(reader.pages):
        if i in target_pages:
            # 获取页面尺寸
            box = page.mediabox
            page_w = float(box.width)
            page_h = float(box.height)
            
            # 生成 overlay
            overlay_buf = make_stamp_overlay(
                stamp_img, page_w, page_h,
                position=position, scale=scale,
                opacity=opacity, offset_x=offset_x, offset_y=offset_y
            )
            overlay_reader = PdfReader(overlay_buf)
            overlay_page = overlay_reader.pages[0]
            
            # 合并印章到源页面
            page.merge_page(overlay_page)
        
        writer.add_page(page)
    
    # 输出
    if output_pdf:
        with open(output_pdf, 'wb') as f:
            writer.write(f)
        return output_pdf
    else:
        out_buf = io.BytesIO()
        writer.write(out_buf)
        return out_buf.getvalue()


# ─── CLI ───────────────────────────────────────────────────
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Sanlyn OS PDF 电子签章引擎')
    parser.add_argument('input_pdf', help='输入PDF文件')
    parser.add_argument('stamp_png', help='印章PNG图片')
    parser.add_argument('output_pdf', help='输出PDF文件')
    parser.add_argument('--pages', default='last', help='盖章页面: all|last|first|1,3,5')
    parser.add_argument('--position', default='br', help='位置: br|bl|bc|tr|cr|cc')
    parser.add_argument('--scale', type=float, default=0.19, help='印章缩放 (默认0.19, 标准40mm)')
    parser.add_argument('--opacity', type=float, default=0.85, help='透明度 (默认0.85)')
    parser.add_argument('--offset-x', type=float, default=60, help='X偏移 pt')
    parser.add_argument('--offset-y', type=float, default=60, help='Y偏移 pt')
    parser.add_argument('--auto-transparent', action='store_true', help='自动去除黑色背景')
    
    args = parser.parse_args()
    
    # 加载印章
    if args.auto_transparent:
        stamp = remove_black_bg(args.stamp_png)
    else:
        stamp = Image.open(args.stamp_png).convert('RGBA')
    
    result = stamp_pdf(
        args.input_pdf, stamp, args.output_pdf,
        pages=args.pages, position=args.position,
        scale=args.scale, opacity=args.opacity,
        offset_x=args.offset_x, offset_y=args.offset_y
    )
    print(f"✅ 签章完成: {result}")
    print(f"   页面: {args.pages} | 位置: {args.position} | 缩放: {args.scale}")
