// api/convert/excel-to-pdf.js
// Sanlyn OS — Excel→PDF 转换 API
// POST { excelUrl, outputPath? }
// 流程: 下载Excel → 上传到杭州OSS → IMM转PDF → 下载PDF → 上传回香港OSS → 返回URL

import { setCors } from '../db.js';

const OSS_HK = {
  region: process.env.OSS_REGION,
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET,
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

    // 1. 下载 Excel
    console.log('[convert] Step 1: Downloading Excel...');
    const excelResp = await fetch(excelUrl);
    if (!excelResp.ok) throw new Error(`Failed to fetch Excel: ${excelResp.status}`);
    const excelBuffer = Buffer.from(await excelResp.arrayBuffer());
    console.log(`[convert] Excel downloaded: ${excelBuffer.length} bytes`);

    // 2. 上传到杭州 OSS
    console.log('[convert] Step 2: Uploading to Hangzhou OSS...');
    const hzClient = new OSSClient(OSS_HZ);
    const hzInputKey = `convert/input/${baseName}_${timestamp}.${ext}`;
    await hzClient.put(hzInputKey, excelBuffer);
    console.log(`[convert] Uploaded to: oss://${OSS_HZ.bucket}/${hzInputKey}`);

    // 3. 调用 IMM 转换
    console.log('[convert] Step 3: Calling IMM conversion...');
    const hzOutputKey = `convert/output/${baseName}_${timestamp}.pdf`;
    const immResult = await callIMMConversion({
      accessKeyId: OSS_HZ.accessKeyId,
      accessKeySecret: OSS_HZ.accessKeySecret,
      region: IMM_REGION,
      project: IMM_PROJECT,
      sourceUri: `oss://${OSS_HZ.bucket}/${hzInputKey}`,
      targetUri: `oss://${OSS_HZ.bucket}/${hzOutputKey}`,
    });
    console.log('[convert] IMM conversion done:', immResult.TaskId || 'ok');

    // 4. 下载转换后的 PDF
    console.log('[convert] Step 4: Downloading converted PDF...');
    const pdfResult = await hzClient.get(hzOutputKey);
    const pdfBuffer = pdfResult.content;
    console.log(`[convert] PDF downloaded: ${pdfBuffer.length} bytes`);

    // 5. 上传 PDF 到香港 OSS
    console.log('[convert] Step 5: Uploading PDF to Hong Kong OSS...');
    const hkClient = new OSSClient(OSS_HK);
    const hkOutputKey = outputPath || `documents/converted/${baseName}_${timestamp}.pdf`;
    await hkClient.put(hkOutputKey, pdfBuffer, { mime: 'application/pdf' });
    const pdfUrl = `https://${OSS_HK.bucket}.${OSS_HK.region}.aliyuncs.com/${hkOutputKey}`;
    console.log(`[convert] PDF uploaded to: ${pdfUrl}`);

    // 6. 清理杭州临时文件
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

// IMM 转换调用
async function callIMMConversion({ accessKeyId, accessKeySecret, region, project, sourceUri, targetUri }) {
  const IMMModule = await import('@alicloud/imm20200930');
  const IMM = IMMModule.default.default;
  const OpenApiModule = await import('@alicloud/openapi-client');
  const Config = OpenApiModule.default?.Config || OpenApiModule.Config;

  const config = new Config({
    accessKeyId,
    accessKeySecret,
    regionId: region,
    endpoint: `imm.${region}.aliyuncs.com`,
  });

  const client = new IMM(config);

  const request = new IMMModule.CreateOfficeConversionTaskRequest({
    projectName: project,
    sourceURI: sourceUri,
    targetURI: targetUri,
    targetType: 'pdf',
  });

  const taskResult = await client.createOfficeConversionTask(request);
  const taskId = taskResult.body?.TaskId || taskResult.body?.taskId;
  if (!taskId) throw new Error('IMM task creation failed: no taskId returned');

  // 轮询等待完成（最多90秒）
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const getRequest = new IMMModule.GetTaskRequest({
      projectName: project,
      taskType: 'OfficeConversion',
      taskId: taskId,
    });
    const status = await client.getTask(getRequest);
    const state = status.body?.Status || status.body?.status;

    if (state === 'Succeeded') return { taskId: taskId, status: 'completed' };
    if (state === 'Failed') throw new Error('IMM task failed: ' + (status.body?.Message || status.body?.message || 'unknown'));
  }

  throw new Error('IMM conversion timeout (90s)');
}
