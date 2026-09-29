#!/usr/bin/env python3
# 填 Damon 原模版 (bl-sample-template.xlsx)，openpyxl 只改指定单元格，其余字节级保留（不重造）。
# 用法: python3 fill_bl_sample.py <template.xlsx>   数据从 stdin 读 JSON，xlsx 写 stdout。
import sys, json, io, re
from copy import copy
import openpyxl

tpl = sys.argv[1]
d = json.load(sys.stdin)
wb = openpyxl.load_workbook(tpl)
ws = wb.active

def n(v, dp=0):
    if v is None or v == "":
        return ""
    try:
        return f"{float(v):,.{dp}f}"
    except Exception:
        return str(v)

def s(addr, val):
    ws[addr] = "" if val is None else val

s("A2", (d.get("shipperName", "") or "") + (("\nADD: " + d["shipperAddrEn"]) if d.get("shipperAddrEn") else ""))
s("F2", d.get("blNo", ""))
s("F3", d.get("releaseType", "") or "SWB 海运单")
s("E4", "")  # 付款方式去掉（Damon 0813）
s("F4", "")
s("F5", d.get("hsCode", ""))
s("F6", "是 ( V )    否 (   )" if d.get("showHs") else "是 (   )    否 ( V )")
s("A6", (d.get("consignee", "") or "") + (("\n" + d["consAddr"]) if d.get("consAddr") else ""))
s("A10", d.get("notify", "") or "SAME AS CONSIGNEE")
s("A12", " ".join([x for x in [d.get("vessel", ""), d.get("voyage", "")] if x]))
s("E12", d.get("pol", ""))
s("A14", d.get("pod", ""))
s("E14", d.get("finalDest", "") or d.get("pod", ""))
s("A16", d.get("marks", "") or "N/M")
s("B16", (n(d["totalCtn"]) + " CARTONS") if d.get("totalCtn") else "")
s("C16", (d.get("description", "") or "") + (("\nHS: " + d["hsCode"]) if d.get("hsCode") else ""))
s("E16", (n(d["gwKg"], 2) + " KGS") if d.get("gwKg") else "")
s("G16", (n(d["cbm"], 3) + " CBM") if d.get("cbm") else "")
s("A21", d.get("confirmStatusText") or ("✓ 双方已确认，可提交报关行/船东" if d.get("confirmed") else "⚠ 待双方确认提单信息（HS/货描）——确认前请勿提交"))
s("A22", "⚠ 付款方式 P/C 请确认后再发（成交方式需与客户核对）")
s("A23", "VGM 称重方式：Method 2 累加计算法（货重 = 净重 + 纸箱 + 托盘）")

# 0807 柜号串票教训：模版第19行自带 38-LL-23 示例柜号（CSGU6557381 等）。
# 任何插行/填柜之前先把 A19..G19 清空——装柜前绝不许把模版样例柜号带出去。
for _col in range(1, 8):
    ws.cell(row=19, column=_col).value = ""

ctns = d.get("containers") or []
_src_style = copy(ws["A23"]._style)  # 来源行样式插行前先存——插行后 A23 已错位，不能插完再读
if len(ctns) > 1:  # 多柜：在第19行后插行并复制样式
    ws.insert_rows(20, amount=len(ctns) - 1)
    for i in range(1, len(ctns)):
        for col in range(1, 8):
            src = ws.cell(row=19, column=col)
            dst = ws.cell(row=19 + i, column=col)
            if src.has_style:
                dst._style = copy(src._style)

def fill_ctn(rn, c):
    ws.cell(row=rn, column=1).value = c.get("no", "")
    ws.cell(row=rn, column=2).value = c.get("seal", "")
    ws.cell(row=rn, column=3).value = c.get("type", "")
    ws.cell(row=rn, column=4).value = n(c.get("vgm"), 2)
    ws.cell(row=rn, column=5).value = n(c.get("pkgs"))
    ws.cell(row=rn, column=6).value = n(c.get("gw"), 2)
    ws.cell(row=rn, column=7).value = n(c.get("cbm"), 3)

for i, c in enumerate(ctns):
    fill_ctn(19 + i, c)

if not ctns:  # 未装柜：占位提示，不带任何柜号
    ws.cell(row=19, column=1).value = "待装柜后由拖车方提供柜号/封号/皮重"

# 收货人地址来源一行（documents.js 按 本票登记>历史提单高频>公司档案 优先级取），写在最后一行下一行，A..G 合并、样式抄 A23
_src_r = ws.max_row + 1
for _col in range(1, 8):
    ws.cell(row=_src_r, column=_col)._style = copy(_src_style)
ws.cell(row=_src_r, column=1).value = "收货人地址来源：" + ((d.get("consAddrSource") or "").strip() or "未取到")
ws.merge_cells(start_row=_src_r, start_column=1, end_row=_src_r, end_column=7)

# 兜底自检：全表任何格子出现不属于本票的柜号（带边界 ISO 6346：(?<![A-Z0-9])[A-Z]{4}\d{7}(?![A-Z0-9])）→ 打印原因并 exit 3，不出文件。
# 宁可出不来，也不许带错柜号出去（0807 教训）。0929：加边界，避免把提单号 OOLU2335623070（4字母+10数字）误当柜号。
_allowed = set(str((c or {}).get("no") or "").strip().upper() for c in ctns)
_allowed.discard("")
_bad = []
for _row in ws.iter_rows():
    for _cell in _row:
        if isinstance(_cell.value, str):
            for _m in re.findall(r"(?<![A-Z0-9])[A-Z]{4}\d{7}(?![A-Z0-9])", _cell.value):
                if _m.upper() not in _allowed and _m not in [b[0] for b in _bad]:
                    _bad.append((_m, _cell.coordinate))
if _bad:
    sys.stderr.write("fill_bl_sample: 已拦截——发现不在本票柜号清单里的疑似柜号 " +
                     ", ".join(m + "@" + pos for m, pos in _bad) +
                     "；本票柜号：" + (",".join(sorted(_allowed)) or "(无)") + "\n")
    sys.exit(3)

buf = io.BytesIO()
wb.save(buf)
sys.stdout.buffer.write(buf.getvalue())
