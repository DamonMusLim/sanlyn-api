// api/stamp/apply.js
// Sanlyn OS — PDF 电子签章 API v2
// POST { pdfUrl, documentId, documentName?, stampKey?, pages?, position?, scale?, opacity?, operator }
// 返回 JSON: { success, stampedUrl, logId }

import { getPool, setCors } from '../db.js';
import { extractUser } from '../auth.js';
import { squareCropStamp, stampPdfBuffer } from './_straddle-shared.js';
import { signPdfViaEsign, esignConfigured } from './esign-jiandaoyun.js';

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
      mode = 'simulate',   // simulate=pdf-lib模拟章(日常·免费) | esign=简道云E签宝电子签章(正规·法律效力·gated)
    } = req.body;

    if (!pdfUrl) {
      return res.status(400).json({ error: 'pdfUrl required' });
    }
    if (!operator) {
      return res.status(400).json({ error: 'operator required' });
    }

    // ── DAS 正规签章通道:E签宝(简道云)。gated,未配置明确报错(绝不静默回退模拟章,否则以为盖了法律章其实是模拟) ──
    if (String(mode) === 'esign') {
      if (!esignConfigured()) {
        return res.status(400).json({ error: 'E签宝未配置', detail: '正规电子签章需:法人办e签宝企业实名+印章授权,建简道云表单/流程(挂e签宝节点·自动落章),再在.env填 JDY_API_KEY/JDY_ESIGN_APP_ID/JDY_ESIGN_ENTRY_ID/JDY_ESIGN_FILE_FIELD/JDY_ESIGN_RESULT_FIELD' });
      }
      let _u = pdfUrl;
      if (_u.startsWith('/')) _u = 'http://127.0.0.1:' + (process.env.PORT || 9000) + _u;
      if (/\/api\/db\/shipping-plan-pdf/.test(_u) && !_u.includes('format=')) _u += (_u.includes('?') ? '&' : '?') + 'format=pdf';
      const _r = await fetch(_u, req.headers.authorization ? { headers: { Authorization: req.headers.authorization } } : {});
      if (!_r.ok) return res.status(502).json({ error: '源PDF拉取失败', status: _r.status });
      const _buf = Buffer.from(await _r.arrayBuffer());
      const out = await signPdfViaEsign({ pdfBuffer: _buf, docName: documentName || documentId, companyCode: (req.body && req.body.companyCode) || null });
      if (!out.ok) return res.status(out.configured ? 502 : 400).json({ error: out.error, dataId: out.dataId });
      let archived = out.signedUrl;
      try { const sBuf = Buffer.from(await (await fetch(out.signedUrl)).arrayBuffer()); archived = await uploadToOSS(`documents/esigned/${(documentId || 'doc').replace(/[^\w.-]/g, '_')}_${Date.now()}.pdf`, sBuf); } catch (_) {}
      try { await logStampAction(getPool(), { documentId, documentName, stampKey: 'esign:' + ((req.body && req.body.companyCode) || ''), operator, pages: 'esign', position: 'esign', scale: 0, sourceUrl: pdfUrl, stampedUrl: archived }); } catch (_) {}
      return res.status(200).json({ success: true, mode: 'esign', stampedUrl: archived, esignSourceUrl: out.signedUrl, dataId: out.dataId, note: 'E签宝电子签章(法律效力)' });
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
    const rawStampBuffer = Buffer.from(await stampResp.arrayBuffer());
    // 源章图非正方(如 BABI 378x532 带下方大片留白)会把印章画歪/画小;裁到真实印泥边界再补方(与 straddle-confirm 一致)
    const stampBuffer = await squareCropStamp(rawStampBuffer);

    // ── 2. pdf-lib 签章(统一 overlay = _straddle-shared.stampPdfBuffer,apply/portcharge共用,不再各自drawImage) ──
    const stampedBytes = await stampPdfBuffer(pdfBuffer, stampBuffer, { pages, position, customX, customY, scale, sealMm, opacity });

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
      mode: 'simulate',
      stampedUrl,
      logId,
      pages,
      stampKey,
      position,
    });

  } catch (err) {
    console.error('Stamp API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
// 定位/分页/overlay 已统一到 _straddle-shared.js(calcPosition/calcCustomPosition/parseStampPages/stampPdfBuffer),此处不再重复。
