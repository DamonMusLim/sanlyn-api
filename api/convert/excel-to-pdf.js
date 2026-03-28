// api/convert/excel-to-pdf.js
// Sanlyn OS — Excel→PDF 转换 API
// POST { excelUrl, outputPath? }
// 流程: 下载Excel → 上传到杭州OSS → IMM转PDF → 下载PDF → 上传回香港OSS → 返回URL
//
// 依赖: ali-oss, @alicloud/imm20200930 (阿里云IMM SDK)

import { setCors } from '../db.js';

const OSS_HK = {
  region: process.env.OSS_REGION,                    // oss-cn-hongkong
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET,                    // sanlyn-files
};

const OSS_HZ = {
  region: 'oss-cn-hangzhou',
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: 'sanlyn-imm-temp',
};

const IMM_PROJECT = 'sanlyn-imm';
const IMM_REGION = 'cn-hangzhou';

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { excelUrl, outputPath } = req.body;
    if (!excelUrl) return res.status(400).json({ error: 'excelUrl required' });

    const OSSClient = (await import('ali-oss')).default;
    const timestamp = Date.now();
    const originalName = excelUrl.split('/').pop() || 'file.xlsx';
    const baseName = originalName.replace(/\.[^.]+$/, '');
    const ext = originalName.match(/\.([^.]+)$/)?.[1] || 'xlsx';

    // ── 1. 下载 Excel（从香港 OSS 或任意 URL）──
    console.log('[convert] Step 1: Downloading Excel...');
    const excelResp = await fetch(excelUrl);
    if (!excelResp.ok) throw new Error(`Failed to fetch Excel: ${excelResp.status}`);
    const excelBuffer = Buffer.from(await excelResp.arrayBuffer());
    console.log(`[convert] Excel downloaded: ${excelBuffer.length} bytes`);

    // ── 2. 上传到杭州 OSS（IMM 中转）──
    console.log('[convert] Step 2: Uploading to Hangzhou OSS...');
    const hzClient = new OSSClient(OSS_HZ);
    const hzInputKey = `convert/input/${baseName}_${timestamp}.${ext}`;
    await hzClient.put(hzInputKey, excelBuffer, { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    console.log(`[convert] Uploaded to: oss://${OSS_HZ.bucket}/${hzInputKey}`);

    // ── 3. 调用 IMM CreateOfficeConversionTask ──
    console.log('[convert] Step 3: Calling IMM conversion...');
    const hzOutputKey = `convert/output/${baseName}_${timestamp}.pdf`;

    // 使用 IMM OpenAPI (REST 方式，避免额外 SDK 依赖)
    const immResult = await callIMMConversion({
      accessKeyId: OSS_HZ.accessKeyId,
      accessKeySecret: OSS_HZ.accessKeySecret,
      region: IMM_REGION,
      project: IMM_PROJECT,
      sourceUri: `oss://${OSS_HZ.bucket}/${hzInputKey}`,
      targetUri: `oss://${OSS_HZ.bucket}/${hzOutputKey}`,
    });
    console.log('[convert] IMM conversion result:', immResult.taskId || 'done');

    // ── 4. 等待转换完成 + 下载 PDF ──
    console.log('[convert] Step 4: Downloading converted PDF...');
    // IMM 同步接口会直接完成，异步需要轮询
    // ConvertOfficeFormat 是同步的，CreateOfficeConversionTask 是异步的
    // 如果用同步接口，到这步PDF已经在OSS了

    const pdfResult = await hzClient.get(hzOutputKey);
    const pdfBuffer = pdfResult.content;
    console.log(`[convert] PDF downloaded: ${pdfBuffer.length} bytes`);

    // ── 5. 上传 PDF 到香港 OSS ──
    console.log('[convert] Step 5: Uploading PDF to Hong Kong OSS...');
    const hkClient = new OSSClient(OSS_HK);
    const hkOutputKey = outputPath || `documents/converted/${baseName}_${timestamp}.pdf`;
    await hkClient.put(hkOutputKey, pdfBuffer, { mime: 'application/pdf' });
    const pdfUrl = `https://${OSS_HK.bucket}.${OSS_HK.region}.aliyuncs.com/${hkOutputKey}`;
    console.log(`[convert] PDF uploaded to: ${pdfUrl}`);

    // ── 6. 清理杭州临时文件（异步，不阻塞响应）──
    hzClient.delete(hzInputKey).catch(() => {});
    hzClient.delete(hzOutputKey).catch(() => {});

    return res.status(200).json({
      success: true,
      pdfUrl,
      originalName,
      size: pdfBuffer.length,
    });

  } catch (err) {
    console.error('[convert] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── IMM 转换调用（使用 OpenAPI 签名）──────────────
async function callIMMConversion({ accessKeyId, accessKeySecret, region, project, sourceUri, targetUri }) {
  // 使用 IMM SDK (@alicloud/imm20200930)
  // 如果没装 SDK，降级用 HTTP 签名调用
  try {
    const IMMModule = await import('@alicloud/imm20200930');const IMM = IMMModule.default || IMMModule;
    const OpenApiModule = await import('@alicloud/openapi-client');
    const OpenApi = OpenApiModule.default || OpenApiModule;

    const config = new (OpenApi.Config || OpenApi.default.Config)({
      accessKeyId,
      accessKeySecret,
      regionId: region,
      endpoint: `imm.${region}.aliyuncs.com`,
    });

    const client = new IMM(config);

    // 使用同步转换接口 ConvertOfficeFormat（更快，无需轮询）
    // 如果文件大可能超时，那时再换异步接口
    const request = new (IMM.ConvertOfficeFormatRequest || IMM.default?.ConvertOfficeFormatRequest)({
      projectName: project,
      sourceUri,
      targetUri,
      targetType: 'pdf',
    });

    const result = await client.convertOfficeFormat(request);
    return { taskId: 'sync', status: 'completed', result };
  } catch (sdkErr) {
    // SDK 不可用时，降级用 CreateOfficeConversionTask (异步)
    console.warn('[convert] IMM SDK call failed, trying async task:', sdkErr.message);

    const IMMModule = await import('@alicloud/imm20200930');const IMM = IMMModule.default || IMMModule;
    const OpenApiModule = await import('@alicloud/openapi-client');
    const OpenApi = OpenApiModule.default || OpenApiModule;

    const config = new (OpenApi.Config || OpenApi.default.Config)({
      accessKeyId,
      accessKeySecret,
      regionId: region,
      endpoint: `imm.${region}.aliyuncs.com`,
    });

    const client = new IMM(config);

    const request = new (IMM.CreateOfficeConversionTaskRequest || IMM.default?.CreateOfficeConversionTaskRequest)({
      projectName: project,
      sourceUri,
      targetUri,
      targetType: 'pdf',
    });

    const taskResult = await client.createOfficeConversionTask(request);
    const taskId = taskResult.body?.taskId;

    if (!taskId) throw new Error('IMM task creation failed: no taskId');

    // 轮询等待完成（最多60秒）
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));

      const getRequest = new (IMM.GetTaskRequest || IMM.default?.GetTaskRequest)({
        projectName: project,
        taskType: 'OfficeConversion',
        taskId,
      });
      const status = await client.getTask(getRequest);
      const state = status.body?.status;

      if (state === 'Succeeded') return { taskId, status: 'completed' };
      if (state === 'Failed') throw new Error(`IMM task failed: ${status.body?.message || 'unknown'}`);
    }

    throw new Error('IMM conversion timeout (60s)');
  }
}
