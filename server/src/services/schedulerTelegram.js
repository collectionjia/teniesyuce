/**
 * 调度任务完成 → Telegram Bot 通知（配置存 app_settings）
 */
const pool = require('../db');

const KEYS = {
  enabled: 'scheduler_tg_enabled',
  botToken: 'scheduler_tg_bot_token',
  chatId: 'scheduler_tg_chat_id',
  notifyManual: 'scheduler_tg_notify_manual',
};

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value VARCHAR(512) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  tableReady = true;
}

async function getSetting(key) {
  await ensureTable();
  const [[row]] = await pool.query(
    'SELECT setting_value FROM app_settings WHERE setting_key=? LIMIT 1',
    [key],
  );
  return row?.setting_value ?? '';
}

async function setSetting(key, value) {
  await ensureTable();
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)`,
    [key, String(value ?? '').slice(0, 512)],
  );
}

function maskToken(token) {
  const t = String(token || '').trim();
  if (!t) return '';
  if (t.length <= 8) return '***';
  return `***${t.slice(-6)}`;
}

async function getConfig() {
  const [enabled, botToken, chatId, notifyManual] = await Promise.all([
    getSetting(KEYS.enabled),
    getSetting(KEYS.botToken),
    getSetting(KEYS.chatId),
    getSetting(KEYS.notifyManual),
  ]);
  return {
    enabled: String(enabled).trim() === '1',
    botToken: String(botToken || '').trim(),
    chatId: String(chatId || '').trim(),
    notifyManual: String(notifyManual).trim() !== '0',
    botTokenPreview: maskToken(botToken),
    botTokenSet: !!String(botToken || '').trim(),
  };
}

async function saveConfig(input = {}) {
  if (input.enabled != null) {
    await setSetting(KEYS.enabled, input.enabled ? '1' : '0');
  }
  if (input.notifyManual != null) {
    await setSetting(KEYS.notifyManual, input.notifyManual ? '1' : '0');
  }
  if (input.chatId != null) {
    await setSetting(KEYS.chatId, String(input.chatId || '').trim());
  }
  if (input.botToken != null && String(input.botToken).trim()) {
    await setSetting(KEYS.botToken, String(input.botToken).trim());
  }
  return getConfig();
}

function statusEmoji(status) {
  if (status === 'success') return '✅';
  if (status === 'failed') return '❌';
  if (status === 'timeout') return '⏱';
  if (status === 'skipped') return '⏭';
  return 'ℹ️';
}

function triggerLabel(trigger) {
  return trigger === 'manual' ? '手动执行' : '定时调度';
}

function formatMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return '';
  try {
    const s = JSON.stringify(metrics);
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return '';
  }
}

function formatRunMessage({ job, trigger, status, message, error, metrics }) {
  const name = job?.name || job?.id || '—';
  const jt = job?.jobType || job?.job_type || '—';
  const bucket = job?.params?.bucket;
  const gi = job?.params?.groupIndex;
  const groupLine = bucket != null
    ? `分组：${bucket}${gi != null ? `#${gi}` : ''}${job?.params?.groupName ? ` · ${job.params.groupName}` : ''}`
    : '';
  const lines = [
    `${statusEmoji(status)} 调度任务执行完成`,
    '',
    `任务：${name}`,
    `类型：${jt}`,
    `触发：${triggerLabel(trigger)}`,
    `状态：${status}`,
    message ? `说明：${message}` : null,
    error ? `错误：${error}` : null,
    groupLine || null,
  ].filter(Boolean);
  const m = formatMetrics(metrics);
  if (m) lines.push('', `指标：${m}`);
  const now = new Date();
  const ts = now.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  lines.push('', `时间：${ts}`);
  return lines.join('\n');
}

async function sendTelegramMessage({ botToken, chatId, text }) {
  const token = String(botToken || '').trim();
  const cid = String(chatId || '').trim();
  if (!token || !cid) {
    return { ok: false, error: 'bot token or chat id missing' };
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: cid,
      text: String(text || '').slice(0, 4000),
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = data.description || res.statusText || 'telegram send failed';
    return { ok: false, error: err };
  }
  return { ok: true };
}

async function notifyRun({
  job,
  trigger = 'schedule',
  status = 'success',
  message = '',
  error = '',
  metrics = null,
} = {}) {
  const cfg = await getConfig();
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId) {
    return { ok: false, skipped: true, reason: 'telegram notify disabled' };
  }
  if (trigger === 'manual' && !cfg.notifyManual) {
    return { ok: false, skipped: true, reason: 'manual notify off' };
  }
  const text = formatRunMessage({ job, trigger, status, message, error, metrics });
  return sendTelegramMessage({ botToken: cfg.botToken, chatId: cfg.chatId, text });
}

async function sendTestMessage() {
  const cfg = await getConfig();
  if (!cfg.botToken || !cfg.chatId) {
    throw new Error('请先保存 Bot Token 与 Chat ID');
  }
  const r = await sendTelegramMessage({
    botToken: cfg.botToken,
    chatId: cfg.chatId,
    text: '✅ 调度中心 Telegram 通知测试成功',
  });
  if (!r.ok) throw new Error(r.error || '发送失败');
  return r;
}

module.exports = {
  getConfig,
  saveConfig,
  notifyRun,
  sendTestMessage,
  formatRunMessage,
};
