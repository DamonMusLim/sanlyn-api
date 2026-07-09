export const UPLOADS_DIR = '/opt/sanlyn-uploads/cn';
export const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || '';
export const BASE_URL = process.env.APP_BASE_URL || 'https://ai.sanlyn.cn';
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_FILES = 10;

// 8-state machine transitions
export const VALID_TRANSITIONS = {
  draft:                    ['pending_review'],
  pending_review:           ['approved', 'draft'],
  approved:                 ['issued_to_customer'],
  issued_to_customer:       ['signed_by_customer'],
  signed_by_customer:       ['pending_factory_decision'],
  pending_factory_decision: ['skip_factory_absorb', 'sent_to_factory'],
  sent_to_factory:          ['signed_by_factory'],
  signed_by_factory:        ['applied'],
  skip_factory_absorb:      ['applied'],
  applied:                  ['closed'],
  // legacy statuses kept for backward compat
  open:                     ['pending_review'],
  issued:                   ['signed_by_customer'],
  acknowledged:             ['pending_factory_decision'],
};

export const STATUS_LABELS = {
  draft:                    'Draft',
  pending_review:           'Pending Review',
  approved:                 'Approved',
  issued_to_customer:       'Issued to Customer',
  signed_by_customer:       'Signed by Customer',
  pending_factory_decision: 'Pending Factory Decision',
  skip_factory_absorb:      'BABI Absorbing',
  sent_to_factory:          'Sent to Factory',
  signed_by_factory:        'Signed by Factory',
  applied:                  'Applied',
  closed:                   'Closed',
  open:                     'Open',
  issued:                   'Issued',
  acknowledged:             'Acknowledged',
};

export async function pingWecom(msg) {
  if (!WECOM_WEBHOOK) return;
  try {
    await fetch(WECOM_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: msg } }),
    });
  } catch (e) { /* non-blocking */ }
}

export function getRaw(cn) {
  if (!cn.raw) return {};
  if (typeof cn.raw === 'string') {
    try { return JSON.parse(cn.raw); } catch { return {}; }
  }
  return cn.raw || {};
}

export function calcOutstanding(cn) {
  const raw = getRaw(cn);
  const total = Math.abs(parseFloat(cn.net_amount) || 0);
  const applied = (raw.applied_to || []).reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
  return Math.max(0, total - applied);
}
