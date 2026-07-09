#!/usr/bin/env python3
"""
通用工具：往银行原版docx模版里加一个占位符字段，不动任何排版/格式。
用法：
  python3 docx_add_field.py <docx路径> <紧挨在空白前面的唯一标签文字，如"付款人国别："> <占位符名，如payer_country>

原理：
- 在docx里找到"标签文字"这段文本，看它后面是不是已经有一段空白/占位符可以直接替换；
  没有就在标签所在段落末尾插入一个新的文字块(跟旁边格式一致：minorEastAsia字体/18号字/加粗)。
- 只在docx里插入一个新的{占位符名}标签，不改变任何已有的边框/字号/位置。
- 改完自动备份原文件（同目录 .bak-时间戳）。
"""
import sys, os, shutil, zipfile, re, time

def load(path):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    contents = {n: z.read(n) for n in names}
    z.close()
    return names, contents

def save(path, names, contents):
    zout = zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED)
    for n in names:
        zout.writestr(n, contents[n])
    zout.close()

RUN_TEMPLATE = ('<w:r><w:rPr><w:rFonts w:asciiTheme="minorEastAsia" w:hAnsiTheme="minorEastAsia" '
                 'w:eastAsiaTheme="minorEastAsia"/><w:b/><w:kern w:val="0"/><w:sz w:val="18"/>'
                 '<w:szCs w:val="18"/></w:rPr><w:t>{tag}</w:t></w:r>')

def main():
    if len(sys.argv) != 4:
        print("用法: docx_add_field.py <docx路径> <标签文字> <占位符名>")
        sys.exit(1)
    docx_path, label, tag_name = sys.argv[1], sys.argv[2], sys.argv[3]

    backup = docx_path + f".bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy(docx_path, backup)
    print(f"已备份: {backup}")

    names, contents = load(docx_path)
    xml = contents["word/document.xml"].decode("utf-8")

    label_pos = xml.find(label + "</w:t>")
    if label_pos < 0:
        print(f"❌ 没找到标签文字: {label!r}")
        sys.exit(1)

    # 情况1：标签后紧跟一段空白占位run（形如 <w:t ... preserve>   </w:t>），直接替换成占位符
    after = xml[label_pos: label_pos + 400]
    blank_run_match = re.search(r'(<w:t[^>]*xml:space="preserve"[^>]*>)(\s+)(</w:t>)', after)
    if blank_run_match and blank_run_match.start() < 250:
        old = blank_run_match.group(0)
        new = blank_run_match.group(1) + "{" + tag_name + "}" + blank_run_match.group(3)
        count = xml.count(old)
        if count == 1:
            xml = xml.replace(old, new, 1)
            contents["word/document.xml"] = xml.encode("utf-8")
            save(docx_path, names, contents)
            print(f"✅ 已替换空白占位为 {{{tag_name}}}")
            return
        else:
            print(f"⚠️ 空白占位文字不唯一(出现{count}次)，改用插入新run方式")

    # 情况2：标签紧跟 </w:r></w:p>，说明后面没有留空白，插入一个新的文字块
    old_close = label + "</w:t>\n            </w:r>\n          </w:p>"
    if xml.count(old_close) == 1:
        new_run = RUN_TEMPLATE.replace("{tag}", "{" + tag_name + "}")
        new_close = label + "</w:t>\n            </w:r>\n            " + new_run + "\n          </w:p>"
        xml = xml.replace(old_close, new_close, 1)
        contents["word/document.xml"] = xml.encode("utf-8")
        save(docx_path, names, contents)
        print(f"✅ 已在「{label}」段落末尾插入新字段 {{{tag_name}}}")
        return

    print(f"❌ 自动定位失败，「{label}」附近的XML结构跟预设的两种情况都不一样，需要人工看一下（原文件已还原，没有改坏）")
    shutil.copy(backup, docx_path)
    sys.exit(1)

if __name__ == "__main__":
    main()
