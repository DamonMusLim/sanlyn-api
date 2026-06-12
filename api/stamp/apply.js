// api/stamp/apply.js
// Sanlyn OS — PDF 电子签章 API v2
// POST { pdfUrl, documentId, documentName?, stampKey?, pages?, position?, scale?, opacity?, operator }
// 返回 JSON: { success, stampedUrl, logId }

import { getPool, setCors } from '../db.js';
import { extractUser } from '../auth.js';

// ── 印章 OSS 路径映射 ──────────────────────────────
const STAMP_MAP = {
  babi:       'stamps/babi_seal.png',
  yangbaobao: 'stamps/yangbaobao_seal.png',  // 上海洋宝宝国际物流 (2026-06-02 Damon授权)
  zhongsha:   'stamps/zhongsha_seal.png',
  shanling:   'stamps/shanling_seal.png',
};

const OSS_BASE = 'https://files.sanlynos.com';

// stampKey→公司编码;盖章优先用 DAS(customer_stamps)上传的最新公章,回退内置 STAMP_MAP(2026-06-05)
const STAMP_COMPANY = { babi:'BABI', yangbaobao:'YBB', zhongsha:'ZHONGSHA', shanling:'SHANLING' };
// 订单→工厂公司编码(多租户:厂检单等按订单工厂自动取章,不写死 stampKey)
async function factoryCompanyOf(pool, orderNo){
  try {
    const r = await pool.query(
      "SELECT f.company_code FROM orders o JOIN order_line_items oli ON oli.order_id=o.id JOIN products p ON p.sku=oli.sku JOIN factories f ON f.name=p.factory_name WHERE (o.order_no=$1 OR o.contract_no=$1) AND f.company_code IS NOT NULL LIMIT 1",
      [orderNo]);
    return (r.rows[0] && r.rows[0].company_code) || null;
  } catch(_){ return null; }
}
async function resolveStampUrl(pool, stampKey, companyCode){
  try {
    // companyCode(订单工厂公司)优先 → STAMP_COMPANY[stampKey] → stampKey大写
    const cc = companyCode || STAMP_COMPANY[stampKey] || String(stampKey||'').toUpperCase();
    const r = await pool.query("SELECT url FROM customer_stamps WHERE upper(company_code)=upper($1) AND is_active=true ORDER BY is_default DESC, uploaded_at DESC LIMIT 1",[cc]);
    const u = r.rows[0] && r.rows[0].url;
    // 只信任本司 OSS/CDN 域(防 SSRF/取外部恶意图);否则回退内置章(Codex note)
    if (u && /^https:\/\/(files\.sanlynos\.com|sanlyn-files\.[a-z0-9.-]*aliyuncs\.com)\//i.test(u)) return u;
  } catch(_){}
  return null; // 公章只存 DAS(customer_stamps);无 DAS 章 = 不盖,不再回退内置文件(Damon 2026-06-07)
}

// ── 权限校验 ────────────────────────────────────────
async function checkPermission(pool, operator, stampKey) {
  // superAdmin 跳过权限检查
  // 其他人必须在 stamp_permissions 表中有有效授权
  const sql = `
    SELECT id, permission_type, doc_types, max_per_day
    FROM stamp_permissions
    WHERE granted_to = $1
      AND stamp_key = $2
      AND is_active = true
      AND (valid_until IS NULL OR valid_until > NOW())
    LIMIT 1
  `;
  const res = await pool.query(sql, [operator, stampKey]);
  return res.rows[0] || null;
}

// ── 今日用量检查 ─────────────────────────────────────
async function getTodayUsage(pool, operator, stampKey) {
  const sql = `
    SELECT COUNT(*) AS cnt
    FROM stamp_log
    WHERE operator = $1
      AND stamp_key = $2
      AND stamped_at >= CURRENT_DATE
  `;
  const res = await pool.query(sql, [operator, stampKey]);
  return parseInt(res.rows[0]?.cnt || '0', 10);
}

// ── 签章记录写入 RDS ────────────────────────────────
async function logStampAction(pool, params) {
  const sql = `
    INSERT INTO stamp_log
      (document_id, document_name, stamp_key, operator, pages, position, scale, source_url, stamped_url, stamped_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    RETURNING id
  `;
  const res = await pool.query(sql, [
    params.documentId,
    params.documentName || null,
    params.stampKey,
    params.operator,
    params.pages,
    params.position,
    params.scale,
    params.sourceUrl,
    params.stampedUrl,
  ]);
  return res.rows[0]?.id;
}

// ── OSS 上传（直接用 ali-oss SDK）──────────────────
async function uploadToOSS(ossPath, buffer, contentType = 'application/pdf') {
  const OSS = (await import('ali-oss')).default;
  const client = new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
  });
  await client.put(ossPath, Buffer.from(buffer), { mime: contentType });
  // 返回 CDN 自定义域(客户端/大陆可达);原始 oss-cn-hongkong.aliyuncs.com 客户端 SSL 不通,导致盖章版下不到(2026-06-05)
  return `${OSS_BASE}/${ossPath}`;
}

// ── 主处理函数 ──────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const {
      pdfUrl,
      documentId,
      documentName,
      stampKey = 'babi',
      pages = 'last',
      position = 'br',
      customX,   // ★ S99: free-drag position (0-1 from left), overrides position preset when set
      customY,   // ★ S99: free-drag position (0-1 from top), overrides position preset when set
      scale = 0.19,
      sealMm,            // 印章物理直径(mm),默认40mm标准公章;按A4真实尺寸不随横竖变化
      opacity = 0.85,
      operator,
      customStampUrl,
      stampType,
      isSuperAdmin = false,
    } = req.body;

    if (!pdfUrl) {
      return res.status(400).json({ error: 'pdfUrl required' });
    }
    if (!operator) {
      return res.status(400).json({ error: 'operator required' });
    }

    const isCustom = (stampType === 'custom') && !!customStampUrl;
    const stampPath = STAMP_MAP[stampKey];
    if (!isCustom && !stampPath) {
      return res.status(400).json({
        error: `Unknown stamp: ${stampKey}. Valid: ${Object.keys(STAMP_MAP).join(', ')}`,
      });
    }

    // ── 0. 权限校验 ──
    const pool = getPool();

    // 服务端 JWT 角色校验:admin/superAdmin 角色直接放行(签名已验,安全),
    // 不依赖脆弱的 operator 字符串与 stamp_permissions 精确匹配(曾致 admin 仍 403)。
    let _jwtRole = '';
    try { extractUser(req); _jwtRole = (req.user && typeof req.user.role === 'string') ? req.user.role : ''; } catch (_) {}
    const _isAdminRole = ['admin','superadmin','super_admin'].includes(_jwtRole.toLowerCase());

    // 只信服务端验签的 JWT 角色放行 admin/superAdmin;不再信任客户端可伪造的 req.body.isSuperAdmin(Codex BLOCK 修正)。
    if (!_isAdminRole && !isCustom) {
      const perm = await checkPermission(pool, operator, stampKey);
      if (!perm) {
        return res.status(403).json({
          error: '无签章权限',
          detail: `用户 ${operator} 未被授权使用 ${stampKey} 印章`,
        });
      }

      // 每日用量检查
      const todayUsage = await getTodayUsage(pool, operator, stampKey);
      if (todayUsage >= perm.max_per_day) {
        return res.status(429).json({
          error: '今日签章次数已达上限',
          detail: `已使用 ${todayUsage}/${perm.max_per_day} 次`,
        });
      }
    }

    // 厂检单等工厂单据:按订单工厂公司取章(多租户),只取本工厂的章,绝不回退别公司。companyCode 也可显式传。
    let _companyCode = (req.body && req.body.companyCode) || null;
    const _isFactoryDoc = typeof documentId === 'string' && /::factory_inspection$/.test(documentId);
    try {
      if (_isFactoryDoc && !_companyCode) {
        _companyCode = await factoryCompanyOf(pool, documentId.replace(/::factory_inspection$/, ''));
      }
    } catch(_){}
    // 公章只能从 DAS(customer_stamps)取;工厂单严格只取本工厂章(绝不回退别公司);没录入=不盖,清晰错误(Damon 2026-06-07)
    const sealUrl = isCustom
      ? customStampUrl
      : (_isFactoryDoc
          ? (_companyCode ? await resolveStampUrl(pool, null, _companyCode) : null)
          : await resolveStampUrl(pool, stampKey, _companyCode));
    if (!sealUrl) {
      const who = _companyCode || (_isFactoryDoc ? '该订单工厂' : stampKey);
      return res.status(400).json({ error: '公章未录入 DAS', detail: `${who} 的公章未在 DAS 上传(或未能确定工厂公司),请先在 DAS 添加该公司公章。公章只存 DAS,别公司的章绝不混用。` });
    }
    // ── 1. 获取源 PDF 和印章图片 ──
    // Node.js fetch requires absolute URLs — convert relative paths to localhost
    let _pdfFetchUrl = pdfUrl;
    if (_pdfFetchUrl.startsWith('/')) {
      const _port = process.env.PORT || 9000;
      _pdfFetchUrl = 'http://127.0.0.1:' + _port + _pdfFetchUrl;
    }
    // shipping-plan-pdf returns HTML by default — append format=pdf to get actual PDF via puppeteer
    if (/\/api\/db\/shipping-plan-pdf/.test(_pdfFetchUrl) && !_pdfFetchUrl.includes('format=')) {
      _pdfFetchUrl += (_pdfFetchUrl.includes('?') ? '&' : '?') + 'format=pdf';
    }
    const _authHeader = req.headers.authorization || '';
    const [pdfResp, stampResp] = await Promise.all([
      fetch(_pdfFetchUrl, _authHeader ? { headers: { Authorization: _authHeader } } : {}),
      fetch(sealUrl),
    ]);

    if (!pdfResp.ok) throw new Error(`Failed to fetch PDF: ${pdfResp.status}`);
    if (!stampResp.ok) throw new Error(`Failed to fetch stamp: ${stampResp.status}`);

    const pdfBuffer = Buffer.from(await pdfResp.arrayBuffer());
    const stampBuffer = Buffer.from(await stampResp.arrayBuffer());

    // ── 2. pdf-lib 签章 ──
    const { PDFDocument } = await import('pdf-lib');

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const stampImage = await pdfDoc.embedPng(stampBuffer);

    const totalPages = pdfDoc.getPageCount();
    const targetPages = parsePages(pages, totalPages);

    for (const pageIdx of targetPages) {
      const page = pdfDoc.getPage(pageIdx);
      const { width: pageW, height: pageH } = page.getSize();

      const stampAspect = stampImage.height / stampImage.width;
      // 按真实物理尺寸定章大小(标准公章直径 ~40mm),不随页面点数/横竖变化。
      // 旧逻辑 sW=pageW*scale 在 A4 横版(842pt宽)会把章放成 56mm 过大。
      // 印章按 A4 短边(宽)为参照,横竖版一致(旧 pageW*scale 在A4横版842pt宽放成56mm过大)。
      // 默认 scale 0.19 × 短边595pt ≈ 113pt = 40mm 标准公章;也可传 sealMm(mm)精确指定。
      const refDim = Math.min(pageW, pageH);
      let sW = (typeof sealMm === 'number' && sealMm > 0) ? sealMm * (72 / 25.4) : refDim * scale;
      let sH = sW * stampAspect;
      if (sH > pageH * 0.35) {                  // 极端长宽比保护
        sH = pageH * 0.35;
        sW = sH / stampAspect;
      }

      const offsetX = 60, offsetY = 60;
      // ★ S99: customX/customY override preset — origin top-left, PDF-lib origin bottom-left
      const pos = (customX != null && customY != null)
        ? calcCustomPosition(customX, customY, pageW, pageH, sW, sH)
        : calcPosition(position, pageW, pageH, sW, sH, offsetX, offsetY);

      page.drawImage(stampImage, {
        x: pos.x,
        y: pos.y,
        width: sW,
        height: sH,
        opacity,
      });
    }

    const stampedBytes = await pdfDoc.save();

    // ── 3. 上传盖章后的 PDF 到 OSS ──
    const timestamp = Date.now();
    const originalName = pdfUrl.split('/').pop()?.replace('.pdf', '') || documentId || 'doc';
    const stampedOssPath = `documents/stamped/${originalName}_stamped_${timestamp}.pdf`;

    let stampedUrl;
    try {
      stampedUrl = await uploadToOSS(stampedOssPath, Buffer.from(stampedBytes));
    } catch (ossErr) {
      console.error('OSS upload failed, returning inline PDF:', ossErr.message);
      // 降级：OSS 上传失败时直接返回 PDF bytes
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="stamped_${originalName}.pdf"`);
      return res.status(200).send(Buffer.from(stampedBytes));
    }

    // ── 4. 记录签章日志 ──
    let logId = null;
    try {
      logId = await logStampAction(pool, {
        documentId,
        documentName,
        stampKey,
        operator,
        pages,
        position,
        scale,
        sourceUrl: pdfUrl,
        stampedUrl,
      });
    } catch (dbErr) {
      console.warn('stamp_log write failed (non-fatal):', dbErr.message);
    }

    // ── 5. 返回 JSON ──
    return res.status(200).json({
      success: true,
      stampedUrl,
      logId,
      pages: targetPages.map(i => i + 1),
      stampKey,
      position,
    });

  } catch (err) {
    console.error('Stamp API error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── 辅助函数 ──────────────────────────────────────

function parsePages(pagesStr, total) {
  if (pagesStr === 'all') return Array.from({ length: total }, (_, i) => i);
  if (pagesStr === 'last') return [total - 1];
  if (pagesStr === 'first') return [0];
  if (pagesStr === 'first_last') return total === 1 ? [0] : [0, total - 1];
  return pagesStr
    .split(',')
    .map(p => parseInt(p.trim()) - 1)
    .filter(i => i >= 0 && i < total);
}

function calcPosition(pos, pageW, pageH, sW, sH, ox, oy) {
  const map = {
    br: { x: pageW - sW - ox, y: oy },
    bl: { x: ox, y: oy },
    bc: { x: (pageW - sW) / 2, y: oy },
    tr: { x: pageW - sW - ox, y: pageH - sH - oy },
    tl: { x: ox, y: pageH - sH - oy },
    cr: { x: pageW - sW - ox, y: (pageH - sH) / 2 },
    cc: { x: (pageW - sW) / 2, y: (pageH - sH) / 2 },
  };
  return map[pos] || map.br;
}

// ★ S99: Free-drag custom position
// customX/customY are 0-1 fractions, origin = top-left (browser convention)
// PDF-lib x = left, y = from bottom → invert Y
function calcCustomPosition(cx, cy, pageW, pageH, sW, sH) {
  // Center the stamp on the drag point, clamped within page bounds
  const x = Math.min(Math.max(cx * pageW - sW / 2, 0), pageW - sW);
  const y = Math.min(Math.max((1 - cy) * pageH - sH / 2, 0), pageH - sH);
  return { x, y };
}
