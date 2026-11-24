import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { allocateNextTrackingNumber } from './db.ts';
import { BackupManager, verifyDatabaseFile } from './backup.ts';
import {
  createAuthMiddleware,
  hasAnyPermission,
  loadUserProfile,
  requireAnyPermission,
  requirePermission,
  signAuthToken,
  verifyAuthToken,
  type AuthedRequest,
} from './auth.ts';
import {
  buildArabicSpokenAlert,
  canUserAccessScope,
  canUserViewTicket,
  createDirectNotificationsForDepartment,
  createNotificationsForTicket,
  evaluateClosureEligibility,
  fetchDepartmentMessages,
  fetchTicketDetail,
  fetchTicketSummaries,
  filterTicketsByAdenDate,
  getAdenDateKey,
  getRecipientUserIdsForTicket,
  getResponsibleAssignments,
  getResponsibleLabelForDepartment,
  getResponsibleMap,
  logUserActivity,
  markTicketsDeliveredToUserDept,
  recordTicketRead,
  type DispatchNotificationOptions,
  type TicketScope,
} from './domain.ts';
import {
  ALLOWED_GEMINI_PREBUILT_VOICES,
  generateArabicTtsAudio,
  isGeminiTtsConfigured,
} from './tts.ts';
import {
  ALL_STATION_CODES,
  ALL_VOICE_READER_CHANNELS,
  DEFAULT_TARGET_DEPT_BY_REASON,
  DEPARTMENT_LABELS,
  GEMINI_PREBUILT_VOICES,
  GRANULAR_PERMISSIONS,
  INQUIRY_CANNED_STATUSES,
  PLAYBACK_RATE_OPTIONS,
  REASON_LABELS,
  URGENCY_LABELS,
  type AudioDiagnosticRecord,
  type AudioFileRecord,
  type DepartmentCode,
  type EscalationSettings,
  type HumanVoiceRecord,
  type InquiryStatusCode,
  type MessageType,
  type NotificationItem,
  type PlaybackDiagnosticStatus,
  type ReasonCode,
  type ResponsibleRoleKey,
  type StationAudioSetting,
  type StationCode,
  type SystemReadinessReport,
  type TicketKind,
  type TicketSummary,
  type UrgencyLevel,
  type UserProfile,
  type VoiceKind,
  type VoiceReaderChannelCode,
  type VoiceReaderSetting,
  type VoiceReadScope,
} from '../src/types/domain.ts';

export interface WsConnectedUserSummary {
  user_id: number;
  username: string;
  full_name: string;
  department_code: DepartmentCode;
  is_test_account: boolean;
}

export interface ExpressAppOptions {
  audioDir?: string;
  backupManager?: BackupManager;
  replaceDatabase?: (verifiedSourcePath: string) => void;
  getServerStats?: () => {
    startedAt: string;
    connectedUsers: WsConnectedUserSummary[];
  };
}

export interface WsBroadcaster {
  broadcastTicketEvent: (
    eventType: string,
    ticket: TicketSummary,
    recipientIds: number[],
    notifications: NotificationItem[],
    actorName: string
  ) => void;
  broadcastSystemEvent?: (eventType: string, data: unknown) => void;
}

const DEFAULT_AUDIO_STORAGE_DIR = path.resolve(process.cwd(), 'data', 'audio');
const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.webm']);
const ALLOWED_AUDIO_MIMES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
};
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

function generateSynthesizedWavBuffer(notesHz: number[], noteDurationSec = 0.24): Buffer {
  const sampleRate = 22050;
  const gapSamples = Math.floor(sampleRate * 0.05);
  const noteSamples = Math.floor(sampleRate * noteDurationSec);
  const totalSamples = notesHz.length * noteSamples + Math.max(0, notesHz.length - 1) * gapSamples;
  const dataBytes = totalSamples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);

  let sampleOffset = 0;
  notesHz.forEach((freq, idx) => {
    for (let i = 0; i < noteSamples; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, i / (sampleRate * 0.015)) * Math.exp((-3.2 * i) / noteSamples);
      const val =
        (Math.sin(2 * Math.PI * freq * t) * 0.72 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.18) * env;
      const pcm = Math.max(-32767, Math.min(32767, Math.round(val * 24000)));
      buffer.writeInt16LE(pcm, 44 + (sampleOffset + i) * 2);
    }
    sampleOffset += noteSamples + (idx < notesHz.length - 1 ? gapSamples : 0);
  });

  return buffer;
}

function ensureBuiltInAudioLibrary(db: Database.Database, audioStorageDir: string) {
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM audio_files').get() as { cnt: number };
  if (Number(countRow?.cnt || 0) > 0) return;

  const adminRow = db
    .prepare("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin' LIMIT 1")
    .get() as { id: number } | undefined;
  const fallbackUserRow =
    adminRow || (db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined);
  if (!fallbackUserRow) return;

  const presets: Array<{
    displayName: string;
    originalName: string;
    storedFilename: string;
    notes: number[];
    isDefault: number;
  }> = [
    {
      displayName: 'نغمة المذاق اليمني القياسية',
      originalName: 'system-standard-chime.wav',
      storedFilename: 'builtin-standard-chime.wav',
      notes: [523.25, 659.25],
      isDefault: 1,
    },
    {
      displayName: 'نغمة التنبيه العاجل للتصعيد',
      originalName: 'system-urgent-chime.wav',
      storedFilename: 'builtin-urgent-chime.wav',
      notes: [783.99, 987.77, 1174.66],
      isDefault: 0,
    },
  ];

  const nowIso = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO audio_files (
      display_name, original_name, stored_filename, mime_type, size_bytes,
      source_type, is_default, uploaded_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'audio/wav', ?, 'upload', ?, ?, ?, ?)
  `);

  for (const preset of presets) {
    const wavBuf = generateSynthesizedWavBuffer(preset.notes);
    const diskPath = path.join(audioStorageDir, preset.storedFilename);
    fs.writeFileSync(diskPath, wavBuf);
    insert.run(
      preset.displayName,
      preset.originalName,
      preset.storedFilename,
      wavBuf.length,
      preset.isDefault,
      fallbackUserRow.id,
      nowIso,
      nowIso
    );
  }
}

export function createExpressApp(
  db: Database.Database,
  broadcaster?: WsBroadcaster,
  options?: ExpressAppOptions
) {
  const AUDIO_STORAGE_DIR = options?.audioDir || DEFAULT_AUDIO_STORAGE_DIR;
  const backupManager = options?.backupManager || new BackupManager();
  const appStartedAt = new Date().toISOString();
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  fs.mkdirSync(AUDIO_STORAGE_DIR, { recursive: true });
  ensureBuiltInAudioLibrary(db, AUDIO_STORAGE_DIR);

  const requireAuth = createAuthMiddleware(db);

  const emitWs = (
    eventType: string,
    ticket: TicketSummary,
    excludeUserId?: number,
    extraRole?: string,
    title?: string,
    body?: string,
    actorName = 'النظام',
    audioOptions?: DispatchNotificationOptions
  ) => {
    const notifications =
      title && body
        ? createNotificationsForTicket(db, ticket, eventType, title, body, excludeUserId, extraRole, audioOptions)
        : [];
    if (broadcaster) {
      // Include all ticket viewers for live UI refresh while only target station users receive non-null audio notifications
      const notifRecipients = getRecipientUserIdsForTicket(db, ticket, excludeUserId, extraRole, audioOptions);
      const generalViewers = audioOptions?.strictTargetOnly
        ? getRecipientUserIdsForTicket(db, ticket, excludeUserId, extraRole)
        : notifRecipients;
      const merged = Array.from(new Set([...notifRecipients, ...generalViewers]));
      broadcaster.broadcastTicketEvent(eventType, ticket, merged, notifications, actorName);
    }
    return notifications;
  };

  app.get('/api/health', (_req, res) => {
    let dbOk = false;
    try {
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      dbOk = Number(row?.ok || 0) === 1;
    } catch {
      dbOk = false;
    }
    res.json({
      status: dbOk ? 'ok' : 'degraded',
      db_connected: dbOk,
      timezone: 'Asia/Aden',
      timestamp: new Date().toISOString(),
    });
  });

  // Authentication
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return res.status(400).json({ error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
    }

    const row = db
      .prepare(`
        SELECT u.id, u.password_hash, u.is_active, r.code AS role_code
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE u.username = ?
      `)
      .get(String(username).trim()) as { id: number; password_hash: string; is_active: number; role_code: string } | undefined;

    if (!row || !bcrypt.compareSync(String(password), row.password_hash)) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    if (row.role_code === 'waiter') {
      return res.status(403).json({ error: 'تم إلغاء دور المباشرين وتعطيل صلاحيات الدخول الخاصة بهم' });
    }

    if (row.is_active !== 1) {
      return res.status(403).json({ error: 'هذا الحساب معطل حالياً، يرجى مراجعة مدير النظام' });
    }

    const user = loadUserProfile(db, row.id);
    if (!user) {
      return res.status(401).json({ error: 'تعذر تحميل بيانات الحساب' });
    }

    const token = signAuthToken(user.id, user.username);
    logUserActivity(db, user, 'login', 'user', user.id, `تسجيل دخول ناجح للمستخدم ${user.username}`);
    return res.json({ token, user });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.authUser });
  });

  // Metadata for dropdowns (waiters role disabled)
  app.get('/api/meta', requireAuth, (_req, res) => {
    const departments = db
      .prepare("SELECT id, code, name_ar, description FROM departments WHERE code != 'waiters' ORDER BY id")
      .all();
    const roles = db
      .prepare("SELECT id, code, name_ar, description FROM roles WHERE code != 'waiter' ORDER BY id")
      .all();
    res.json({ departments, roles, waiters: [], reasons: REASON_LABELS });
  });

  // Dashboard stats + Asia/Aden date & multi-criteria filtering scoped strictly to user permissions
  app.get('/api/dashboard', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const settings = db.prepare('SELECT * FROM escalation_settings WHERE id = 1').get() as EscalationSettings;
    const mode = String(req.query.mode || 'all').trim();
    const date = String(req.query.date || '').trim();
    const dateFrom = String(req.query.date_from || '').trim();
    const dateTo = String(req.query.date_to || '').trim();
    const deptFilter = String(req.query.department || '').trim();
    const statusFilter = String(req.query.status || '').trim();
    const urgencyFilter = String(req.query.urgency || '').trim();
    const invoiceFilter = String(req.query.invoice_number || '').trim().toLowerCase();
    const trackingFilter = String(req.query.tracking_number || '').trim().toLowerCase();

    const isTest = Boolean(user.is_test_account);
    const visibleAll = fetchTicketSummaries(db, { isTest }).filter((t) => canUserViewTicket(user, t, 'all'));
    let all = filterTicketsByAdenDate(visibleAll, { mode, date, dateFrom, dateTo });

    if (deptFilter) {
      all = all.filter((t) => t.target_department === deptFilter || t.sender_department === deptFilter);
    }
    if (statusFilter) {
      all = all.filter((t) => t.status === statusFilter);
    }
    if (urgencyFilter) {
      all = all.filter((t) => t.urgency_level === urgencyFilter);
    }
    if (invoiceFilter) {
      all = all.filter((t) => t.invoice_number.toLowerCase().includes(invoiceFilter));
    }
    if (trackingFilter) {
      all = all.filter((t) => t.ticket_number.toLowerCase().includes(trackingFilter));
    }

    const openTickets = all.filter((t) => t.status !== 'closed');
    const closedTickets = all.filter((t) => t.status === 'closed');
    const delayedTickets = openTickets.filter((t) => t.stall_minutes >= settings.first_warning_minutes);

    const responseTimes = all
      .filter((t) => t.received_at)
      .map((t) => Math.max(0, Math.round((new Date(t.received_at!).getTime() - new Date(t.created_at).getTime()) / 60000)));
    const resolutionTimes = closedTickets
      .filter((t) => t.closed_at)
      .map((t) => Math.max(0, Math.round((new Date(t.closed_at!).getTime() - new Date(t.created_at).getTime()) / 60000)));

    const avg = (arr: number[]) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0);

    const reasonCounts: Record<string, number> = {};
    for (const t of all) {
      const label = REASON_LABELS[t.reason_code] || t.reason_code;
      reasonCounts[label] = (reasonCounts[label] || 0) + 1;
    }
    const topReasons = Object.entries(reasonCounts)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    const prodWaits = all.map((t) => t.department_wait_minutes.production).filter((v) => v > 0);
    const asmWaits = all.map((t) => t.department_wait_minutes.assembly).filter((v) => v > 0);
    const hallWaits = all.map((t) => t.department_wait_minutes.hall).filter((v) => v > 0);

    res.json({
      filter: {
        mode,
        date,
        date_from: dateFrom,
        date_to: dateTo,
        aden_today: getAdenDateKey(new Date()),
      },
      counts: {
        total: all.length,
        open: openTickets.length,
        new: all.filter((t) => t.status === 'new').length,
        awaiting_receipt: openTickets.filter((t) => !t.received_at || t.status === 'new').length,
        unreceived: openTickets.filter((t) => !t.received_at).length,
        in_progress: all.filter((t) => t.status === 'in_progress' || t.status === 'received' || t.status === 'awaiting_other_dept').length,
        delayed: delayedTickets.length,
        awaiting_confirm: all.filter((t) => t.status === 'action_taken_awaiting_confirm').length,
        awaiting_arrival: openTickets.filter((t) => t.status === 'action_taken_awaiting_confirm' && !t.arrival_confirmed).length,
        arrived_assembly: all.filter((t) => t.status === 'arrived_assembly').length,
        ready_for_hall: all.filter((t) => t.status === 'ready_for_hall').length,
        reopened: all.filter((t) => t.status === 'reopened' || t.reopened_count > 0).length,
        closed: closedTickets.length,
        escalated: openTickets.filter((t) => t.escalation_level > 0).length,
      },
      metrics: {
        avg_response_minutes: avg(responseTimes),
        avg_resolution_minutes: avg(resolutionTimes),
        avg_stall_minutes: avg(all.map((t) => t.stall_minutes)),
        total_open_stall_minutes: openTickets.reduce((s, t) => s + t.stall_minutes, 0),
        avg_wait_by_department: {
          production: avg(prodWaits),
          assembly: avg(asmWaits),
          hall: avg(hallWaits),
        },
      },
      top_reasons: topReasons,
      recent_tickets: openTickets.slice(0, 6),
      tickets: all,
      responsibles: getResponsibleAssignments(db),
      stall_threshold_minutes: settings.first_warning_minutes,
    });
  });

  // Lookup ticket by unified tracking number (TRK-000001)
  app.get('/api/tickets/by-tracking/:trackingNumber', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const isTest = Boolean(user.is_test_account);
    const trk = String(req.params.trackingNumber || '').trim().toUpperCase();
    const match = fetchTicketSummaries(db, { isTest }).find((t) => t.ticket_number.toUpperCase() === trk);
    if (!match) return res.status(404).json({ error: 'رقم المتابعة غير موجود' });

    const preDetail = fetchTicketDetail(db, match.id, user);
    if (!preDetail) return res.status(404).json({ error: 'البلاغ غير موجود' });

    const allowedDirect = canUserViewTicket(user, preDetail, 'all');
    const allowedViaSupport = user.has_assembly_support && canUserViewTicket(user, preDetail, 'assembly_support');
    if (!allowedDirect && !allowedViaSupport) {
      return res.status(403).json({ error: 'غير مصرح لك بالاطلاع على هذا البلاغ' });
    }

    const newlyDelivered = markTicketsDeliveredToUserDept(db, user, [match.id], 'tracking_lookup');
    for (const dt of newlyDelivered) {
      emitWs('ticket_delivered', dt, user.id);
    }
    const detail = fetchTicketDetail(db, match.id, user) || preDetail;
    return res.json({ ticket: detail });
  });

  // List / Search / Filter tickets
  app.get('/api/tickets', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const scope = (String(req.query.scope || 'all') as TicketScope);
    if (!canUserAccessScope(user, scope)) {
      return res.status(403).json({ error: 'ليس لديك صلاحية مساندة قسم التجميع' });
    }

    const settings = db.prepare('SELECT * FROM escalation_settings WHERE id = 1').get() as EscalationSettings;
    const isTest = Boolean(user.is_test_account);
    let list = fetchTicketSummaries(db, { isTest }).filter((t) => canUserViewTicket(user, t, scope));

    const newlyDelivered = markTicketsDeliveredToUserDept(
      db,
      user,
      list.filter((t) => !t.delivered_to_dept_at && t.target_department === user.department_code).map((t) => t.id),
      'api_sync'
    );
    if (newlyDelivered.length > 0) {
      const deliveredById = new Map(newlyDelivered.map((d) => [d.id, d]));
      list = list.map((t) => deliveredById.get(t.id) || t);
      for (const dt of newlyDelivered) {
        emitWs('ticket_delivered', dt, user.id);
      }
    }

    if (scope === 'inbox') {
      if (user.role_code === 'production') {
        list = list.filter((t) => t.target_department === 'production' && t.status !== 'closed');
      } else if (user.role_code === 'assembly') {
        list = list.filter((t) => t.status !== 'closed');
      } else if (user.role_code === 'hall_supervisor') {
        list = list.filter((t) => (t.target_department === 'hall' || t.sender_department === 'hall') && t.status !== 'closed');
      } else {
        list = list.filter((t) => t.status !== 'closed');
      }
    } else if (scope === 'open') {
      list = list.filter((t) => t.status !== 'closed');
    } else if (scope === 'delayed') {
      list = list.filter((t) => t.status !== 'closed' && t.stall_minutes >= settings.first_warning_minutes);
    } else if (scope === 'assembly_support') {
      list = list.filter((t) => t.status !== 'closed');
    }

    const search = String(req.query.search || '').trim().toLowerCase();
    const trackingFilter = String(req.query.tracking_number || '').trim().toLowerCase();
    const invoiceFilter = String(req.query.invoice_number || '').trim().toLowerCase();
    const urgencyFilter = String(req.query.urgency || '').trim();
    const statusFilter = String(req.query.status || '').trim();
    const deptFilter = String(req.query.department || '').trim();
    const reasonFilter = String(req.query.reason || '').trim();
    const dateFrom = String(req.query.date_from || '').trim();
    const dateTo = String(req.query.date_to || '').trim();
    const minStall = Number(req.query.min_stall_minutes || 0);

    if (search) {
      list = list.filter(
        (t) =>
          t.ticket_number.toLowerCase().includes(search) ||
          t.invoice_number.toLowerCase().includes(search) ||
          t.item_name.toLowerCase().includes(search) ||
          t.created_by_name.toLowerCase().includes(search) ||
          t.problem_description.toLowerCase().includes(search) ||
          (DEPARTMENT_LABELS[t.target_department] || '').includes(search) ||
          (REASON_LABELS[t.reason_code] || '').includes(search)
      );
    }

    if (trackingFilter) list = list.filter((t) => t.ticket_number.toLowerCase().includes(trackingFilter));
    if (invoiceFilter) list = list.filter((t) => t.invoice_number.toLowerCase().includes(invoiceFilter));
    if (urgencyFilter) list = list.filter((t) => t.urgency_level === urgencyFilter);
    if (statusFilter) list = list.filter((t) => t.status === statusFilter);
    if (deptFilter) list = list.filter((t) => t.target_department === deptFilter || t.sender_department === deptFilter);
    if (reasonFilter) list = list.filter((t) => t.reason_code === reasonFilter);
    if (dateFrom) list = list.filter((t) => getAdenDateKey(t.created_at) >= dateFrom);
    if (dateTo) list = list.filter((t) => getAdenDateKey(t.created_at) <= dateTo);
    if (minStall > 0) list = list.filter((t) => t.stall_minutes >= minStall);

    res.json({ tickets: list });
  });

  // Create ticket (atomic TRK-000001 tracking number, urgency, idempotency & duplicate guard)
  app.post('/api/tickets', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const {
      invoice_number,
      item_name,
      quantity = 1,
      reason_code,
      urgency_level = 'normal',
      ticket_kind = 'stall',
      backlog_orders_count = 1,
      backlog_invoices = [],
      problem_description,
      target_department,
      created_via_support = false,
      parent_ticket_id = null,
      client_request_id = null,
    } = req.body ?? {};

    const isSupportCreate = Boolean(created_via_support);
    if (isSupportCreate) {
      if (!user.has_assembly_support && user.role_code !== 'admin') {
        return res.status(403).json({ error: 'ليس لديك صلاحية مساندة قسم التجميع لإنشاء بلاغ' });
      }
    } else if (!user.permissions.includes('create_ticket') && user.role_code !== 'admin') {
      return res.status(403).json({ error: 'ليس لديك صلاحية إنشاء بلاغ جديد' });
    }

    const inv = String(invoice_number || '').trim();
    const item = String(item_name || '').trim();
    const reason = String(reason_code || '').trim() as ReasonCode;
    const urgency = (['normal', 'urgent', 'critical'].includes(String(urgency_level))
      ? String(urgency_level)
      : 'normal') as UrgencyLevel;
    const kind = (['stall', 'backlog', 'inquiry'].includes(String(ticket_kind))
      ? String(ticket_kind)
      : 'stall') as TicketKind;
    const desc = String(problem_description || '').trim();

    if (!inv) return res.status(400).json({ error: 'رقم الفاتورة مطلوب' });
    if (!item) return res.status(400).json({ error: 'اسم الصنف المتعثر مطلوب' });
    if (!REASON_LABELS[reason]) return res.status(400).json({ error: 'سبب التعثر غير صالح' });
    if (reason === 'other' && desc.length < 4) {
      return res.status(400).json({ error: 'يجب كتابة توضيح واضح عند اختيار (سبب آخر)' });
    }

    const isTestInt = user.is_test_account ? 1 : 0;

    if (client_request_id) {
      const existingByReq = db
        .prepare('SELECT id FROM tickets WHERE client_request_id = ?')
        .get(String(client_request_id)) as { id: number } | undefined;
      if (existingByReq) {
        const detail = fetchTicketDetail(db, existingByReq.id, user);
        return res.status(200).json({ ticket: detail, idempotent: true });
      }
    }

    // Accidental duplicate guard (same invoice + normalized item + reason within 3 mins while open, scoped by sandbox)
    const threeMinsAgo = new Date(Date.now() - 3 * 60000).toISOString();
    const dupRow = db
      .prepare(`
        SELECT t.id, t.ticket_number
        FROM tickets t
        JOIN ticket_items ti ON ti.ticket_id = t.id
        WHERE t.invoice_number = ?
          AND LOWER(TRIM(ti.item_name)) = LOWER(TRIM(?))
          AND t.reason_code = ?
          AND t.status != 'closed'
          AND COALESCE(t.is_test, 0) = ?
          AND t.created_at >= ?
        LIMIT 1
      `)
      .get(inv, item, reason, isTestInt, threeMinsAgo) as { id: number; ticket_number: string } | undefined;

    if (dupRow) {
      return res.status(409).json({
        error: `يوجد بلاغ مفتوح مسبقاً (${dupRow.ticket_number}) لنفس الفاتورة والصنف والسبب. لمنع التكرار العرضي يمكنك متابعة البلاغ القائم أو تعديل الصنف/السبب.`,
        duplicate_ticket_id: dupRow.id,
      });
    }

    if (target_department === 'waiters') {
      return res.status(400).json({ error: 'تم إلغاء قسم المباشرين؛ يرجى التوجيه إلى إدارة الصالة أو التجميع أو الإنتاج' });
    }

    const resolvedTarget: DepartmentCode = isSupportCreate
      ? 'production'
      : (target_department && DEPARTMENT_LABELS[target_department as DepartmentCode]
          ? (target_department as DepartmentCode)
          : DEFAULT_TARGET_DEPT_BY_REASON[reason]);

    const nowIso = new Date().toISOString();
    const finalDesc = desc || `${REASON_LABELS[reason]} — الصنف: ${item}`;
    const invoiceList = Array.isArray(backlog_invoices) && backlog_invoices.length > 0
      ? backlog_invoices.map((x: unknown) => String(x).trim()).filter(Boolean)
      : [inv];

    const insertTx = db.transaction(() => {
      const ticketNumber = allocateNextTrackingNumber(db);
      const tRes = db
        .prepare(`
          INSERT INTO tickets (
            ticket_number, client_request_id, invoice_number, reason_code, urgency_level, ticket_kind,
            problem_description, target_department, sender_department, created_by_user_id, status,
            created_via_support, parent_ticket_id, backlog_orders_count, backlog_invoices, is_test, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          ticketNumber,
          client_request_id ? String(client_request_id) : null,
          inv,
          reason,
          urgency,
          kind,
          finalDesc,
          resolvedTarget,
          user.department_code,
          user.id,
          isSupportCreate ? 1 : 0,
          parent_ticket_id ? Number(parent_ticket_id) : null,
          Math.max(1, Number(backlog_orders_count) || invoiceList.length || 1),
          JSON.stringify(invoiceList),
          isTestInt,
          nowIso,
          nowIso
        );

      const newId = Number(tRes.lastInsertRowid);
      const qtyNum = Math.max(1, Number(quantity) || 1);

      db.prepare(`
        INSERT INTO ticket_items (ticket_id, item_name, quantity, expected_qty, delivered_qty, issue_note)
        VALUES (?, ?, ?, ?, 0, ?)
      `).run(newId, item, qtyNum, qtyNum, finalDesc);

      const originNote = isSupportCreate
        ? `إنشاء بلاغ مساندة ${ticketNumber} من ${user.full_name} (${user.department_name_ar}) وتوجيهه إلى ${DEPARTMENT_LABELS[resolvedTarget]}`
        : `إنشاء بلاغ ${ticketNumber} (${URGENCY_LABELS[urgency]}) من ${user.department_name_ar} وتوجيهه إلى ${DEPARTMENT_LABELS[resolvedTarget]}`;

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'created', NULL, 'new', ?, ?)
      `).run(newId, user.id, user.full_name, user.department_name_ar, originNote, nowIso);

      return newId;
    });

    const newTicketId = insertTx();
    const detail = fetchTicketDetail(db, newTicketId, user)!;
    logUserActivity(db, user, 'create_ticket', 'ticket', newTicketId, `إنشاء البلاغ ${detail.ticket_number} للفاتورة ${inv}`);

    const respMap = getResponsibleMap(db);
    const targetRespLabel = getResponsibleLabelForDepartment(respMap, resolvedTarget);
    const spokenText = buildArabicSpokenAlert({
      prefix:
        kind === 'backlog'
          ? `بلاغ تراكم طلبات من ${user.department_name_ar} إلى ${targetRespLabel}`
          : `بلاغ تعثر جديد موجه إلى ${DEPARTMENT_LABELS[resolvedTarget]} (${targetRespLabel})`,
      ticket: detail,
    });

    emitWs(
      kind === 'backlog' ? 'backlog_reported' : 'ticket_created',
      detail,
      user.id,
      undefined,
      `${kind === 'backlog' ? 'بلاغ تراكم' : 'بلاغ جديد'} ${detail.ticket_number} — فاتورة ${inv}`,
      `${item} (×${detail.quantity}): ${REASON_LABELS[reason]} — ${URGENCY_LABELS[urgency]} · المعني: ${targetRespLabel}`,
      user.full_name,
      {
        audioTargetDepartment: resolvedTarget,
        senderDepartment: user.department_code,
        strictTargetOnly: true,
        messageUid: `ticket-created-${newTicketId}`,
        spokenText,
        urgencyLevel: urgency,
      }
    );

    return res.status(201).json({ ticket: detail });
  });

  // Assembly -> Hall Backlog Report endpoint (Section 5)
  app.post('/api/backlog-reports', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role_code !== 'assembly' && user.role_code !== 'admin') {
      return res.status(403).json({ error: 'إرسال بلاغ تراكم الطلبات متاح لقسم التجميع فقط' });
    }

    const {
      stacked_orders_count = 1,
      invoice_numbers = [],
      items_summary = 'طلبات مكتملة متراكمة في التجميع',
      wait_duration_note = '',
      backlog_reason = 'تراكم الطلبات داخل التجميع',
      notes = '',
      urgency_level = 'urgent',
      client_request_id = null,
    } = req.body ?? {};

    const invoicesArr: string[] = Array.isArray(invoice_numbers)
      ? invoice_numbers.map((x: unknown) => String(x).trim()).filter(Boolean)
      : String(invoice_numbers || '')
          .split(/[،,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);

    if (invoicesArr.length === 0) {
      return res.status(400).json({ error: 'يرجى إدخال رقم فاتورة واحد على الأقل ضمن بلاغ التراكم' });
    }

    if (client_request_id) {
      const existing = db
        .prepare('SELECT id FROM tickets WHERE client_request_id = ?')
        .get(String(client_request_id)) as { id: number } | undefined;
      if (existing) {
        return res.status(200).json({ ticket: fetchTicketDetail(db, existing.id, user), idempotent: true });
      }
    }

    const urgency = (['normal', 'urgent', 'critical'].includes(String(urgency_level))
      ? String(urgency_level)
      : 'urgent') as UrgencyLevel;
    const countNum = Math.max(invoicesArr.length, Number(stacked_orders_count) || 1);
    const primaryInvoice = invoicesArr[0];
    const itemsText = String(items_summary || '').trim() || `طلبات متراكمة (${countNum})`;
    const reasonText = String(backlog_reason || '').trim() || 'تراكم الطلبات داخل التجميع';
    const waitNote = String(wait_duration_note || '').trim();
    const extraNotes = String(notes || '').trim();
    const fullDesc = [
      reasonText,
      `عدد الطلبات المتراكمة: ${countNum}`,
      `الفواتير: ${invoicesArr.join('، ')}`,
      waitNote ? `مدة الانتظار: ${waitNote}` : '',
      extraNotes ? `ملاحظات: ${extraNotes}` : '',
    ]
      .filter(Boolean)
      .join(' | ');

    const isTestInt = user.is_test_account ? 1 : 0;
    const nowIso = new Date().toISOString();
    const newId = db.transaction(() => {
      const trackingNumber = allocateNextTrackingNumber(db);
      const tRes = db
        .prepare(`
          INSERT INTO tickets (
            ticket_number, client_request_id, invoice_number, reason_code, urgency_level, ticket_kind,
            problem_description, target_department, sender_department, created_by_user_id, status,
            backlog_orders_count, backlog_invoices, is_test, created_at, updated_at
          ) VALUES (?, ?, ?, 'assembly_backlog', ?, 'backlog', ?, 'hall', ?, ?, 'new', ?, ?, ?, ?, ?)
        `)
        .run(
          trackingNumber,
          client_request_id ? String(client_request_id) : null,
          primaryInvoice,
          urgency,
          fullDesc,
          user.department_code === 'management' ? 'assembly' : user.department_code,
          user.id,
          countNum,
          JSON.stringify(invoicesArr),
          isTestInt,
          nowIso,
          nowIso
        );
      const id = Number(tRes.lastInsertRowid);

      db.prepare(`
        INSERT INTO ticket_items (ticket_id, item_name, quantity, expected_qty, delivered_qty, issue_note, arrival_confirmed, order_completed)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1)
      `).run(id, itemsText, countNum, countNum, countNum, fullDesc);

      db.prepare(`
        INSERT INTO department_messages (
          ticket_id, tracking_number, invoice_number, message_type, sender_department, recipient_department,
          sender_user_id, message_body, notes, is_test, sent_at
        ) VALUES (?, ?, ?, 'backlog_update', 'assembly', 'hall', ?, ?, ?, ?, ?)
      `).run(id, trackingNumber, primaryInvoice, user.id, fullDesc, extraNotes || null, isTestInt, nowIso);

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'backlog_reported', NULL, 'new', ?, ?)
      `).run(id, user.id, user.full_name, user.department_name_ar, `بلاغ تراكم طلبات ${trackingNumber}: ${fullDesc}`, nowIso);

      return id;
    })();

    const detail = fetchTicketDetail(db, newId, user)!;
    logUserActivity(db, user, 'create_backlog_report', 'ticket', newId, `بلاغ تراكم ${detail.ticket_number}`);

    const spokenText = `بلاغ تراكم طلبات من قسم التجميع إلى الصالة، رقم المتابعة ${detail.ticket_number}، عدد الطلبات المتراكمة ${countNum}، الفواتير ${invoicesArr.join(' و')}، الأصناف ${itemsText}، السبب ${reasonText}، مستوى الاستعجال ${URGENCY_LABELS[urgency]}${extraNotes ? `، ملاحظات: ${extraNotes}` : ''}.`;

    emitWs(
      'backlog_reported',
      detail,
      user.id,
      undefined,
      `بلاغ تراكم ${detail.ticket_number} — ${countNum} طلبات`,
      fullDesc,
      user.full_name,
      {
        audioTargetDepartment: 'hall',
        senderDepartment: 'assembly',
        strictTargetOnly: true,
        messageUid: `backlog-${newId}`,
        spokenText,
        urgencyLevel: urgency,
      }
    );

    return res.status(201).json({ ticket: detail });
  });

  // Hall -> Assembly Direct Inquiry endpoint (Section 4)
  app.post('/api/inquiries', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role_code !== 'hall_supervisor' && user.role_code !== 'admin') {
      return res.status(403).json({ error: 'إرسال الاستفسارات المباشرة إلى التجميع متاح لمسؤول الصالة فقط' });
    }

    const {
      ticket_id = null,
      tracking_number = null,
      invoice_number,
      item_name,
      quantity = 1,
      message,
      notes = '',
      urgency_level = 'normal',
      client_request_id = null,
    } = req.body ?? {};

    const inv = String(invoice_number || '').trim();
    const item = String(item_name || '').trim() || 'استفسار طلب';
    const msgBody = String(message || '').trim();
    const extraNotes = String(notes || '').trim();

    if (!inv && !ticket_id && !tracking_number) {
      return res.status(400).json({ error: 'رقم الفاتورة أو رقم المتابعة مطلوب للاستفسار' });
    }
    if (!msgBody) {
      return res.status(400).json({ error: 'نص الاستفسار مطلوب' });
    }

    if (client_request_id) {
      const existingMsg = db
        .prepare('SELECT id, ticket_id FROM department_messages WHERE client_request_id = ?')
        .get(String(client_request_id)) as { id: number; ticket_id: number | null } | undefined;
      if (existingMsg && existingMsg.ticket_id) {
        return res.status(200).json({
          ticket: fetchTicketDetail(db, existingMsg.ticket_id, user),
          idempotent: true,
        });
      }
    }

    const urgency = (['normal', 'urgent', 'critical'].includes(String(urgency_level))
      ? String(urgency_level)
      : 'normal') as UrgencyLevel;
    const qtyNum = Math.max(1, Number(quantity) || 1);
    const nowIso = new Date().toISOString();

    const isTestInt = user.is_test_account ? 1 : 0;
    const resultTx = db.transaction(() => {
      let resolvedTicketId: number | null = ticket_id ? Number(ticket_id) : null;
      let resolvedTracking = tracking_number ? String(tracking_number).trim().toUpperCase() : '';
      let resolvedInvoice = inv;

      if (!resolvedTicketId && resolvedTracking) {
        const found = db
          .prepare('SELECT id, invoice_number FROM tickets WHERE UPPER(ticket_number) = ? AND COALESCE(is_test, 0) = ?')
          .get(resolvedTracking, isTestInt) as { id: number; invoice_number: string } | undefined;
        if (found) {
          resolvedTicketId = found.id;
          resolvedInvoice = resolvedInvoice || found.invoice_number;
        }
      } else if (resolvedTicketId) {
        const found = db
          .prepare('SELECT ticket_number, invoice_number FROM tickets WHERE id = ? AND COALESCE(is_test, 0) = ?')
          .get(resolvedTicketId, isTestInt) as { ticket_number: string; invoice_number: string } | undefined;
        if (found) {
          resolvedTracking = found.ticket_number;
          resolvedInvoice = resolvedInvoice || found.invoice_number;
        } else {
          resolvedTicketId = null;
        }
      }

      if (!resolvedTicketId) {
        resolvedTracking = allocateNextTrackingNumber(db);
        const tRes = db
          .prepare(`
            INSERT INTO tickets (
              ticket_number, invoice_number, reason_code, urgency_level, ticket_kind,
              problem_description, target_department, sender_department, created_by_user_id, status,
              is_test, created_at, updated_at
            ) VALUES (?, ?, 'handover_delay', ?, 'inquiry', ?, 'assembly', 'hall', ?, 'new', ?, ?, ?)
          `)
          .run(resolvedTracking, resolvedInvoice, urgency, msgBody, user.id, isTestInt, nowIso, nowIso);
        resolvedTicketId = Number(tRes.lastInsertRowid);

        db.prepare(`
          INSERT INTO ticket_items (ticket_id, item_name, quantity, expected_qty, delivered_qty, issue_note)
          VALUES (?, ?, ?, ?, 0, ?)
        `).run(resolvedTicketId, item, qtyNum, qtyNum, msgBody);

        db.prepare(`
          INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
          VALUES (?, ?, ?, ?, 'inquiry_created', NULL, 'new', ?, ?)
        `).run(resolvedTicketId, user.id, user.full_name, user.department_name_ar, `استفسار مباشر من الصالة إلى التجميع (${resolvedTracking}): ${msgBody}`, nowIso);
      } else {
        db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(nowIso, resolvedTicketId);
        db.prepare(`
          INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
          VALUES (?, ?, ?, ?, 'inquiry_sent', NULL, NULL, ?, ?)
        `).run(resolvedTicketId, user.id, user.full_name, user.department_name_ar, `استفسار من الصالة إلى التجميع: ${msgBody}`, nowIso);
      }

      const mRes = db
        .prepare(`
          INSERT INTO department_messages (
            ticket_id, tracking_number, invoice_number, message_type, sender_department, recipient_department,
            sender_user_id, message_body, notes, is_test, sent_at, client_request_id
          ) VALUES (?, ?, ?, 'inquiry', 'hall', 'assembly', ?, ?, ?, ?, ?, ?)
        `)
        .run(
          resolvedTicketId,
          resolvedTracking,
          resolvedInvoice,
          user.id,
          msgBody,
          extraNotes || null,
          isTestInt,
          nowIso,
          client_request_id ? String(client_request_id) : null
        );

      return { ticketId: resolvedTicketId, messageId: Number(mRes.lastInsertRowid), trackingNumber: resolvedTracking, invoiceNumber: resolvedInvoice };
    })();

    const detail = fetchTicketDetail(db, resultTx.ticketId, user)!;
    const messageRec = fetchDepartmentMessages(db, user, { ticketId: resultTx.ticketId }).find((m) => m.id === resultTx.messageId)!;
    logUserActivity(db, user, 'send_inquiry', 'department_message', resultTx.messageId, `استفسار ${resultTx.trackingNumber}`);

    const spokenText = `استفسار مباشر من الصالة إلى قسم التجميع، فاتورة رقم ${resultTx.invoiceNumber}، رقم المتابعة ${resultTx.trackingNumber}، الصنف ${item}، الكمية ${qtyNum}، الاستفسار: ${msgBody}${extraNotes ? `، ملاحظات: ${extraNotes}` : ''}.`;

    emitWs(
      'inquiry_received',
      detail,
      user.id,
      undefined,
      `استفسار مباشر ${resultTx.trackingNumber} — فاتورة ${resultTx.invoiceNumber}`,
      `${item} (×${qtyNum}): ${msgBody}`,
      user.full_name,
      {
        audioTargetDepartment: 'assembly',
        senderDepartment: 'hall',
        strictTargetOnly: true,
        messageUid: `inquiry-${resultTx.messageId}`,
        spokenText,
        urgencyLevel: urgency,
        isTest: Boolean(user.is_test_account),
      }
    );

    return res.status(201).json({ ticket: detail, message: messageRec });
  });

  // Ticket detail (strict RBAC + sandbox check + read confirmation tracking)
  app.get('/api/tickets/:id', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const ticketId = Number(req.params.id);
    const scope = String(req.query.scope || 'all') as TicketScope;
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail || detail.is_test !== Boolean(user.is_test_account)) {
      return res.status(404).json({ error: 'البلاغ غير موجود' });
    }

    const allowedDirect = canUserViewTicket(user, detail, 'all');
    const allowedViaSupport = user.has_assembly_support && canUserViewTicket(user, detail, 'assembly_support');
    if (!allowedDirect && !allowedViaSupport && scope !== 'assembly_support') {
      return res.status(403).json({ error: 'غير مصرح لك بالاطلاع على هذا البلاغ' });
    }
    if (scope === 'assembly_support' && !allowedViaSupport && !allowedDirect) {
      return res.status(403).json({ error: 'غير مصرح لك بالاطلاع على هذا البلاغ' });
    }

    const readResult = recordTicketRead(db, ticketId, user);
    const updatedDetail = fetchTicketDetail(db, ticketId, user) || detail;

    if (readResult.firstReadRecorded) {
      emitWs(
        'ticket_read',
        updatedDetail,
        user.id,
        undefined,
        `تمت قراءة البلاغ ${updatedDetail.ticket_number} — فاتورة ${updatedDetail.invoice_number}`,
        `اطلع على التفاصيل: ${user.full_name} (${user.department_name_ar})`,
        user.full_name
      );
    }

    res.json({ ticket: updatedDetail });
  });

  // Receive ticket («تأكيد استلام البلاغ» — records receipt & starts processing; NEVER closes or confirms item arrival)
  app.post('/api/tickets/:id/receive', requireAuth, requirePermission('receive_ticket'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const ticketId = Number(req.params.id);
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail || detail.is_test !== Boolean(user.is_test_account)) {
      return res.status(404).json({ error: 'البلاغ غير موجود' });
    }
    if (!canUserViewTicket(user, detail, 'all')) {
      return res.status(403).json({ error: 'غير مصرح لك باستلام هذا البلاغ' });
    }
    if (detail.status === 'closed') {
      return res.status(400).json({ error: 'لا يمكن استلام بلاغ مغلق' });
    }

    const clientRequestId = req.body?.client_request_id ? String(req.body.client_request_id).trim() : null;
    if (clientRequestId) {
      const existingAction = db
        .prepare('SELECT id FROM ticket_actions WHERE client_request_id = ?')
        .get(clientRequestId);
      if (existingAction) {
        return res.status(200).json({ ticket: detail, idempotent: true });
      }
    }

    const nowIso = new Date().toISOString();
    const note = String(req.body?.note || '').trim() || `تم تأكيد استلام البلاغ بواسطة ${user.full_name} (${user.department_name_ar})`;

    db.transaction(() => {
      db.prepare(`
        UPDATE tickets
        SET status = 'received',
            delivered_to_dept_at = COALESCE(delivered_to_dept_at, ?),
            delivered_to_dept_via = COALESCE(delivered_to_dept_via, 'dept_receipt'),
            first_read_at = COALESCE(first_read_at, ?),
            first_read_by_user_id = COALESCE(first_read_by_user_id, ?),
            first_read_department = COALESCE(first_read_department, ?),
            received_at = COALESCE(received_at, ?),
            received_by_user_id = COALESCE(received_by_user_id, ?),
            processing_started_at = COALESCE(processing_started_at, ?),
            updated_at = ?
        WHERE id = ?
      `).run(nowIso, nowIso, user.id, user.department_code, nowIso, user.id, nowIso, nowIso, ticketId);

      db.prepare(`
        INSERT INTO receipt_confirmations (ticket_id, confirmation_type, confirmed_by_user_id, note, created_at)
        VALUES (?, 'dept_receipt', ?, ?, ?)
      `).run(ticketId, user.id, note, nowIso);

      if (clientRequestId) {
        db.prepare(`
          INSERT INTO ticket_actions (ticket_id, user_id, action_type, action_note, client_request_id, created_at)
          VALUES (?, ?, 'dept_receipt', ?, ?, ?)
        `).run(ticketId, user.id, note, clientRequestId, nowIso);
      }

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'received', ?, 'received', ?, ?)
      `).run(ticketId, user.id, user.full_name, user.department_name_ar, detail.status, note, nowIso);
    })();

    const updated = fetchTicketDetail(db, ticketId, user)!;
    logUserActivity(db, user, 'receive_ticket', 'ticket', ticketId, note);

    const receiptNotifyDept: DepartmentCode =
      detail.sender_department !== user.department_code
        ? detail.sender_department
        : detail.target_department !== user.department_code
          ? detail.target_department
          : 'hall';
    const spokenReceipt = `تم تأكيد استلام بلاغ الفاتورة رقم ${updated.invoice_number}، رقم المتابعة ${updated.ticket_number}، الصنف ${updated.item_name}، من ${user.department_name_ar}، المستلم ${user.full_name}، الملاحظات: ${note}.`;

    emitWs(
      'ticket_received',
      updated,
      user.id,
      undefined,
      `تأكيد استلام البلاغ ${updated.ticket_number} — فاتورة ${updated.invoice_number}`,
      `${updated.item_name}: استلمه ${user.full_name} (${user.department_name_ar})`,
      user.full_name,
      receiptNotifyDept !== user.department_code
        ? {
            audioTargetDepartment: receiptNotifyDept,
            senderDepartment: user.department_code,
            strictTargetOnly: true,
            messageUid: `received-${ticketId}-${Date.now()}`,
            spokenText: spokenReceipt,
          }
        : undefined
    );

    res.json({ ticket: updated });
  });

  // Process / take action on ticket (Production «تم التجهيز وإرسال الطلب إلى التجميع» or starts processing)
  app.post('/api/tickets/:id/process', requireAuth, requirePermission('process_ticket'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const ticketId = Number(req.params.id);
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail || detail.is_test !== Boolean(user.is_test_account)) {
      return res.status(404).json({ error: 'البلاغ غير موجود' });
    }
    if (!canUserViewTicket(user, detail, 'all')) {
      return res.status(403).json({ error: 'غير مصرح لك بمعالجة هذا البلاغ' });
    }
    if (detail.status === 'closed') {
      return res.status(400).json({ error: 'لا يمكن معالجة بلاغ مغلق؛ أعد فتحه أولاً' });
    }

    const clientRequestId = req.body?.client_request_id ? String(req.body.client_request_id).trim() : null;
    if (clientRequestId) {
      const existingAction = db.prepare('SELECT id FROM ticket_actions WHERE client_request_id = ?').get(clientRequestId);
      if (existingAction) {
        return res.status(200).json({ ticket: detail, idempotent: true });
      }
    }

    const actionType = String(req.body?.action_type || 'in_progress');
    const actionNote = String(req.body?.action_note || '').trim();
    if (!actionNote) return res.status(400).json({ error: 'يرجى كتابة تفاصيل الإجراء المتخذ أو حالة التجهيز' });

    const isDispatched = actionType === 'mark_dispatched';
    const nextStatus = isDispatched ? 'action_taken_awaiting_confirm' : 'in_progress';
    const nowIso = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        UPDATE tickets
        SET status = ?,
            delivered_to_dept_at = COALESCE(delivered_to_dept_at, ?),
            delivered_to_dept_via = COALESCE(delivered_to_dept_via, 'dept_process'),
            first_read_at = COALESCE(first_read_at, ?),
            first_read_by_user_id = COALESCE(first_read_by_user_id, ?),
            first_read_department = COALESCE(first_read_department, ?),
            received_at = COALESCE(received_at, ?),
            received_by_user_id = COALESCE(received_by_user_id, ?),
            processing_started_at = COALESCE(processing_started_at, ?),
            prepared_at = CASE WHEN ? = 'action_taken_awaiting_confirm' THEN ? ELSE prepared_at END,
            action_taken_at = CASE WHEN ? = 'action_taken_awaiting_confirm' THEN ? ELSE action_taken_at END,
            updated_at = ?
        WHERE id = ?
      `).run(
        nextStatus,
        nowIso,
        nowIso,
        user.id,
        user.department_code,
        nowIso,
        user.id,
        nowIso,
        nextStatus,
        nowIso,
        nextStatus,
        nowIso,
        nowIso,
        ticketId
      );

      db.prepare(`
        INSERT INTO ticket_actions (ticket_id, user_id, action_type, action_note, client_request_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(ticketId, user.id, actionType, actionNote, clientRequestId, nowIso);

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ticketId,
        user.id,
        user.full_name,
        user.department_name_ar,
        isDispatched ? 'action_taken' : 'status_changed',
        detail.status,
        nextStatus,
        actionNote,
        nowIso
      );
    })();

    const updated = fetchTicketDetail(db, ticketId, user)!;
    logUserActivity(db, user, 'process_ticket', 'ticket', ticketId, actionNote);

    // Production -> Assembly always targets Assembly when marking prepared/dispatched!
    const processAudioTarget: DepartmentCode =
      user.department_code === 'production'
        ? (isDispatched ? 'assembly' : (detail.sender_department !== 'production' ? detail.sender_department : 'assembly'))
        : user.department_code === 'hall'
          ? (detail.sender_department !== 'hall' ? detail.sender_department : 'assembly')
          : (detail.target_department !== user.department_code ? detail.target_department : 'hall');

    const spokenText = isDispatched && user.department_code === 'production'
      ? `تم تجهيز وإرسال طلب الفاتورة رقم ${updated.invoice_number}، رقم المتابعة ${updated.ticket_number}، الصنف ${updated.item_name}، الكمية ${updated.quantity}، من ${user.department_name_ar} إلى قسم التجميع، الملاحظات: ${actionNote}`
      : `تحديث معالجة من ${user.department_name_ar}، الفاتورة رقم ${updated.invoice_number}، رقم المتابعة ${updated.ticket_number}، الصنف ${updated.item_name}، الملاحظات: ${actionNote}`;

    emitWs(
      isDispatched ? 'awaiting_confirmation' : 'ticket_updated',
      updated,
      user.id,
      undefined,
      isDispatched
        ? `تم التجهيز وفي الطريق للتجميع ${updated.ticket_number} — فاتورة ${updated.invoice_number}`
        : `تحديث معالجة ${updated.ticket_number} — فاتورة ${updated.invoice_number}`,
      `${updated.item_name} (×${updated.quantity}): ${actionNote}`,
      user.full_name,
      {
        audioTargetDepartment: processAudioTarget,
        senderDepartment: user.department_code,
        strictTargetOnly: true,
        messageUid: `process-${ticketId}-${Date.now()}`,
        spokenText,
      }
    );

    res.json({ ticket: updated });
  });

  // Reply / send targeted message on ticket
  app.post('/api/tickets/:id/reply', requireAuth, requirePermission('reply_ticket'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const ticketId = Number(req.params.id);
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail || detail.is_test !== Boolean(user.is_test_account)) {
      return res.status(404).json({ error: 'البلاغ غير موجود' });
    }

    const allowed = canUserViewTicket(user, detail, 'all') || (user.has_assembly_support && canUserViewTicket(user, detail, 'assembly_support'));
    if (!allowed) return res.status(403).json({ error: 'غير مصرح لك بالرد على هذا البلاغ' });

    const clientRequestId = req.body?.client_request_id ? String(req.body.client_request_id).trim() : null;
    if (clientRequestId) {
      const existingReply = db.prepare('SELECT id FROM ticket_replies WHERE client_request_id = ?').get(clientRequestId);
      if (existingReply) {
        return res.status(200).json({ ticket: detail, idempotent: true });
      }
    }

    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'نص الرد مطلوب' });

    const requestedRecipient = String(req.body?.recipient_department || '').trim() as DepartmentCode;
    const allowedReplyTargets: DepartmentCode[] = ['production', 'assembly', 'hall'];
    if (requestedRecipient && !allowedReplyTargets.includes(requestedRecipient)) {
      return res.status(400).json({ error: 'القسم المستلم للرسالة غير صالح' });
    }
    if (requestedRecipient && requestedRecipient === user.department_code) {
      return res.status(400).json({ error: 'لا يمكن إرسال التنبيه الصوتي إلى نفس القسم المرسل' });
    }

    const inferredRecipient: DepartmentCode = requestedRecipient
      ? requestedRecipient
      : user.department_code === detail.target_department
        ? (detail.sender_department !== user.department_code && allowedReplyTargets.includes(detail.sender_department)
            ? detail.sender_department
            : user.department_code === 'production'
              ? 'assembly'
              : 'production')
        : allowedReplyTargets.includes(detail.target_department)
          ? detail.target_department
          : user.department_code === 'production'
            ? 'assembly'
            : 'production';

    const nowIso = new Date().toISOString();
    let newReplyId = 0;
    db.transaction(() => {
      const rRes = db.prepare(`
        INSERT INTO ticket_replies (ticket_id, user_id, sender_department, recipient_department, message, client_request_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(ticketId, user.id, user.department_code, inferredRecipient, message, clientRequestId, nowIso);
      newReplyId = Number(rRes.lastInsertRowid);

      db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(nowIso, ticketId);

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'reply', ?, ?, ?, ?)
      `).run(
        ticketId,
        user.id,
        user.full_name,
        user.department_name_ar,
        detail.status,
        detail.status,
        `رسالة إلى ${DEPARTMENT_LABELS[inferredRecipient]}: ${message}`,
        nowIso
      );
    })();

    const updated = fetchTicketDetail(db, ticketId, user)!;
    logUserActivity(db, user, 'reply_ticket', 'ticket', ticketId, `إلى ${inferredRecipient}: ${message}`);
    const replySpokenText = `تنبيه، رد جديد من ${user.department_name_ar} إلى ${DEPARTMENT_LABELS[inferredRecipient]}، فاتورة رقم ${updated.invoice_number}، رقم المتابعة ${updated.ticket_number}، الصنف ${updated.item_name}، نص الرد: ${message}.`;
    emitWs(
      'ticket_reply',
      updated,
      user.id,
      undefined,
      `رسالة جديدة من ${user.department_name_ar} — فاتورة ${updated.invoice_number}`,
      `${user.full_name}: ${message}`,
      user.full_name,
      {
        audioTargetDepartment: inferredRecipient,
        senderDepartment: user.department_code,
        strictTargetOnly: true,
        messageUid: `reply-${ticketId}-${newReplyId}`,
        spokenText: replySpokenText,
      }
    );

    res.json({ ticket: updated });
  });

  // Transfer ticket to another department (waiters disabled)
  app.post('/api/tickets/:id/transfer', requireAuth, requirePermission('transfer_ticket'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const ticketId = Number(req.params.id);
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail || detail.is_test !== Boolean(user.is_test_account)) {
      return res.status(404).json({ error: 'البلاغ غير موجود' });
    }
    if (!canUserViewTicket(user, detail, 'all')) {
      return res.status(403).json({ error: 'غير مصرح لك بتحويل هذا البلاغ' });
    }
    if (detail.status === 'closed') {
      return res.status(400).json({ error: 'لا يمكن تحويل بلاغ مغلق؛ أعد فتحه أولاً' });
    }

    const toDept = String(req.body?.to_department || '').trim() as DepartmentCode;
    const reason = String(req.body?.reason || '').trim();
    if (toDept === 'waiters') {
      return res.status(400).json({ error: 'تم إلغاء دور المباشرين؛ يرجى التحويل إلى إدارة الصالة أو التجميع أو الإنتاج' });
    }
    const allowedTransferDepts: DepartmentCode[] = ['production', 'assembly', 'hall'];
    if (!DEPARTMENT_LABELS[toDept] || !allowedTransferDepts.includes(toDept)) {
      return res.status(400).json({ error: 'القسم المحول إليه غير صالح' });
    }
    if (toDept === detail.target_department) {
      return res.status(400).json({ error: 'البلاغ موجه بالفعل إلى هذا القسم' });
    }
    if (!reason) return res.status(400).json({ error: 'يجب ذكر سبب التحويل' });

    const nowIso = new Date().toISOString();
    let transferId = 0;
    db.transaction(() => {
      db.prepare(`
        UPDATE tickets
        SET target_department = ?,
            status = 'awaiting_other_dept',
            delivered_to_dept_at = NULL,
            delivered_to_dept_via = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(toDept, nowIso, ticketId);

      const xRes = db.prepare(`
        INSERT INTO ticket_transfers (ticket_id, from_department, to_department, transferred_by_user_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(ticketId, detail.target_department, toDept, user.id, reason, nowIso);
      transferId = Number(xRes.lastInsertRowid);

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'transferred', ?, 'awaiting_other_dept', ?, ?)
      `).run(
        ticketId,
        user.id,
        user.full_name,
        user.department_name_ar,
        detail.status,
        `تحويل إلى ${DEPARTMENT_LABELS[toDept]}: ${reason}`,
        nowIso
      );
    })();

    const updated = fetchTicketDetail(db, ticketId, user)!;
    logUserActivity(db, user, 'transfer_ticket', 'ticket', ticketId, `تحويل إلى ${toDept}: ${reason}`);
    const transferSpoken = `تم تحويل بلاغ رقم ${updated.ticket_number}، فاتورة رقم ${updated.invoice_number}، الصنف ${updated.item_name}، إلى قسم ${DEPARTMENT_LABELS[toDept]}، السبب: ${reason}.`;
    emitWs(
      'ticket_transferred',
      updated,
      user.id,
      undefined,
      `تحويل بلاغ ${updated.ticket_number} — فاتورة ${updated.invoice_number}`,
      `تم تحويل ${updated.item_name} إلى ${DEPARTMENT_LABELS[toDept]}: ${reason}`,
      user.full_name,
      {
        audioTargetDepartment: toDept,
        senderDepartment: user.department_code,
        strictTargetOnly: true,
        messageUid: `transfer-${ticketId}-${transferId}`,
        spokenText: transferSpoken,
      }
    );

    res.json({ ticket: updated });
  });

  // Return ticket back to production (Assembly / Admin)
  app.post('/api/tickets/:id/return', requireAuth, requirePermission('confirm_item_arrival'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const ticketId = Number(req.params.id);
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail) return res.status(404).json({ error: 'البلاغ غير موجود' });

    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'يجب توضيح سبب إعادة البلاغ' });

    const nowIso = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE tickets
        SET target_department = 'production', status = 'in_progress', updated_at = ?
        WHERE id = ?
      `).run(nowIso, ticketId);

      db.prepare('UPDATE ticket_items SET arrival_confirmed = 0 WHERE ticket_id = ?').run(ticketId);

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'returned_to_dept', ?, 'in_progress', ?, ?)
      `).run(ticketId, user.id, user.full_name, user.department_name_ar, detail.status, `إعادة إلى الإنتاج لعدم الحل: ${reason}`, nowIso);
    })();

    const updated = fetchTicketDetail(db, ticketId, user)!;
    logUserActivity(db, user, 'return_ticket', 'ticket', ticketId, reason);
    const returnSpokenText = `تنبيه، تم إعادة البلاغ من ${user.department_name_ar} إلى قسم الإنتاج، فاتورة رقم ${updated.invoice_number}، رقم المتابعة ${updated.ticket_number}، الصنف ${updated.item_name}، الملاحظات: ${reason}.`;
    emitWs(
      'ticket_returned',
      updated,
      user.id,
      undefined,
      `إعادة بلاغ للإنتاج — فاتورة ${updated.invoice_number}`,
      `${updated.item_name}: ${reason}`,
      user.full_name,
      {
        audioTargetDepartment: 'production',
        senderDepartment: user.department_code,
        strictTargetOnly: true,
        messageUid: `return-${ticketId}-${Date.now()}`,
        spokenText: returnSpokenText,
      }
    );

    res.json({ ticket: updated });
  });

  // Assembly-only confirmation of physical order arrival («تأكيد وصول الطلب» -> notifies Production!)
  app.post('/api/tickets/:id/confirm-arrival', requireAuth, requirePermission('confirm_item_arrival'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role_code !== 'assembly' && user.role_code !== 'admin') {
      return res.status(403).json({ error: 'التجميع هو الجهة المخولة بتأكيد وصول الأصناف فعلياً' });
    }

    const ticketId = Number(req.params.id);
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail || detail.is_test !== Boolean(user.is_test_account)) {
      return res.status(404).json({ error: 'البلاغ غير موجود' });
    }
    if (detail.status === 'closed') {
      return res.status(400).json({ error: 'لا يمكن تأكيد وصول صنف لبلاغ مغلق' });
    }

    const clientRequestId = req.body?.client_request_id ? String(req.body.client_request_id).trim() : null;
    if (clientRequestId) {
      const existingAction = db.prepare('SELECT id FROM ticket_actions WHERE client_request_id = ?').get(clientRequestId);
      if (existingAction) {
        return res.status(200).json({ ticket: detail, idempotent: true });
      }
    }

    const markComplete = Boolean(req.body?.mark_order_complete);
    const note = String(req.body?.note || '').trim() || 'تم استلام الطلب فعلياً في قسم التجميع';
    const nowIso = new Date().toISOString();
    const nextStatus = detail.status === 'ready_for_hall' ? 'ready_for_hall' : 'arrived_assembly';

    db.transaction(() => {
      db.prepare(`
        UPDATE ticket_items
        SET arrival_confirmed = 1,
            arrival_confirmed_by = ?,
            arrival_confirmed_at = ?,
            delivered_qty = COALESCE(expected_qty, quantity),
            order_completed = CASE WHEN ? = 1 THEN 1 ELSE order_completed END,
            order_completed_by = CASE WHEN ? = 1 THEN ? ELSE order_completed_by END,
            order_completed_at = CASE WHEN ? = 1 THEN ? ELSE order_completed_at END
        WHERE ticket_id = ?
      `).run(user.id, nowIso, markComplete ? 1 : 0, markComplete ? 1 : 0, user.id, markComplete ? 1 : 0, nowIso, ticketId);

      db.prepare(`
        INSERT INTO receipt_confirmations (ticket_id, confirmation_type, confirmed_by_user_id, note, created_at)
        VALUES (?, 'assembly_item_arrival', ?, ?, ?)
      `).run(ticketId, user.id, note, nowIso);

      if (clientRequestId) {
        db.prepare(`
          INSERT INTO ticket_actions (ticket_id, user_id, action_type, action_note, client_request_id, created_at)
          VALUES (?, ?, 'confirm_arrival', ?, ?, ?)
        `).run(ticketId, user.id, note, clientRequestId, nowIso);
      }

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'arrival_confirmed', ?, ?, ?, ?)
      `).run(ticketId, user.id, user.full_name, user.department_name_ar, detail.status, nextStatus, note, nowIso);

      if (markComplete) {
        db.prepare(`
          INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
          VALUES (?, ?, ?, ?, 'order_completed', ?, ?, 'تم اعتماد اكتمال الطلب في التجميع', ?)
        `).run(ticketId, user.id, user.full_name, user.department_name_ar, nextStatus, nextStatus, nowIso);
      }

      db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, nowIso, ticketId);
    })();

    const updated = fetchTicketDetail(db, ticketId, user)!;
    logUserActivity(db, user, 'confirm_arrival', 'ticket', ticketId, note);

    const spokenText = `تم استلام طلب الفاتورة رقم ${updated.invoice_number}، رقم المتابعة ${updated.ticket_number}، في قسم التجميع.`;

    emitWs(
      'arrival_confirmed',
      updated,
      user.id,
      undefined,
      `تم استلام الطلب في التجميع ${updated.ticket_number} — فاتورة ${updated.invoice_number}`,
      `${updated.item_name}: ${note}`,
      user.full_name,
      {
        audioTargetDepartment: 'production',
        senderDepartment: user.department_code,
        strictTargetOnly: true,
        messageUid: `arrival-confirmed-${ticketId}-${Date.now()}`,
        spokenText,
      }
    );

    res.json({ ticket: updated });
  });

  // Assembly -> Hall Ready Order Dispatch («الطلب جاهز – إرسال إلى الصالة»)
  app.post('/api/tickets/:id/send-to-hall', requireAuth, requirePermission('confirm_order_complete'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role_code !== 'assembly' && user.role_code !== 'admin') {
      return res.status(403).json({ error: 'إرسال الطلبات الجاهزة إلى الصالة متاح لقسم التجميع فقط' });
    }

    const ticketId = Number(req.params.id);
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail || detail.is_test !== Boolean(user.is_test_account)) {
      return res.status(404).json({ error: 'البلاغ غير موجود' });
    }
    if (detail.status === 'closed') {
      return res.status(400).json({ error: 'لا يمكن إرسال طلب لبلاغ مغلق' });
    }

    const clientRequestId = req.body?.client_request_id ? String(req.body.client_request_id).trim() : null;
    if (clientRequestId) {
      const existingAction = db.prepare('SELECT id FROM ticket_actions WHERE client_request_id = ?').get(clientRequestId);
      if (existingAction) {
        return res.status(200).json({ ticket: detail, idempotent: true });
      }
    }

    const isProdLinked = ['production_delay', 'dispatched_not_arrived', 'item_shortage', 'item_mismatch'].includes(detail.reason_code);
    if (isProdLinked && !detail.arrival_confirmed) {
      return res.status(400).json({ error: 'يجب تأكيد وصول الطلب إلى التجميع أولاً قبل إرساله إلى الصالة' });
    }

    const note = String(req.body?.note || '').trim() || 'الطلب مكتمل وجاهز وفي الطريق إلى الصالة';
    const nowIso = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        UPDATE ticket_items
        SET order_completed = 1,
            order_completed_by = ?,
            order_completed_at = COALESCE(order_completed_at, ?)
        WHERE ticket_id = ?
      `).run(user.id, nowIso, ticketId);

      db.prepare(`
        UPDATE tickets
        SET status = 'ready_for_hall',
            target_department = 'hall',
            dispatched_to_hall_at = ?,
            action_taken_at = COALESCE(action_taken_at, ?),
            updated_at = ?
        WHERE id = ?
      `).run(nowIso, nowIso, nowIso, ticketId);

      if (clientRequestId) {
        db.prepare(`
          INSERT INTO ticket_actions (ticket_id, user_id, action_type, action_note, client_request_id, created_at)
          VALUES (?, ?, 'send_to_hall', ?, ?, ?)
        `).run(ticketId, user.id, note, clientRequestId, nowIso);
      }

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'dispatched_to_hall', ?, 'ready_for_hall', ?, ?)
      `).run(ticketId, user.id, user.full_name, user.department_name_ar, detail.status, note, nowIso);
    })();

    const updated = fetchTicketDetail(db, ticketId, user)!;
    logUserActivity(db, user, 'send_to_hall', 'ticket', ticketId, note);

    const spokenText = `الطلب جاهز وفي الطريق إلى الصالة، الفاتورة رقم ${updated.invoice_number}، رقم المتابعة ${updated.ticket_number}، الصنف ${updated.item_name}، الكمية ${updated.quantity}.`;

    emitWs(
      'ready_for_hall',
      updated,
      user.id,
      undefined,
      `الطلب جاهز – إرسال إلى الصالة ${updated.ticket_number} — فاتورة ${updated.invoice_number}`,
      `${updated.item_name} (×${updated.quantity}): ${note}`,
      user.full_name,
      {
        audioTargetDepartment: 'hall',
        senderDepartment: user.department_code,
        strictTargetOnly: true,
        messageUid: `ready-hall-${ticketId}-${Date.now()}`,
        spokenText,
      }
    );

    res.json({ ticket: updated });
  });

  // Hall final receipt confirmation («تأكيد استلام الطلب النهائي» in Hall)
  app.post('/api/tickets/:id/hall-confirm', requireAuth, requirePermission('receive_ticket'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role_code !== 'hall_supervisor' && user.role_code !== 'admin') {
      return res.status(403).json({ error: 'تأكيد استلام الطلب النهائي في الصالة متاح لمسؤول الصالة فقط' });
    }

    const ticketId = Number(req.params.id);
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail || detail.is_test !== Boolean(user.is_test_account)) {
      return res.status(404).json({ error: 'البلاغ غير موجود' });
    }
    if (detail.status === 'closed') {
      return res.status(400).json({ error: 'البلاغ مغلق بالفعل' });
    }

    const clientRequestId = req.body?.client_request_id ? String(req.body.client_request_id).trim() : null;
    if (clientRequestId) {
      const existingAction = db.prepare('SELECT id FROM ticket_actions WHERE client_request_id = ?').get(clientRequestId);
      if (existingAction) {
        return res.status(200).json({ ticket: detail, idempotent: true });
      }
    }

    const note = String(req.body?.note || '').trim() || `تم تأكيد استلام الطلب النهائي في الصالة بواسطة ${user.full_name}`;
    const nowIso = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        UPDATE tickets
        SET hall_received_at = COALESCE(hall_received_at, ?),
            hall_received_by_user_id = COALESCE(hall_received_by_user_id, ?),
            received_at = COALESCE(received_at, ?),
            received_by_user_id = COALESCE(received_by_user_id, ?),
            updated_at = ?
        WHERE id = ?
      `).run(nowIso, user.id, nowIso, user.id, nowIso, ticketId);

      db.prepare(`
        INSERT INTO receipt_confirmations (ticket_id, confirmation_type, confirmed_by_user_id, note, created_at)
        VALUES (?, 'hall_final_receipt', ?, ?, ?)
      `).run(ticketId, user.id, note, nowIso);

      if (clientRequestId) {
        db.prepare(`
          INSERT INTO ticket_actions (ticket_id, user_id, action_type, action_note, client_request_id, created_at)
          VALUES (?, ?, 'hall_confirm_receipt', ?, ?, ?)
        `).run(ticketId, user.id, note, clientRequestId, nowIso);
      }

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'hall_confirmed', ?, ?, ?, ?)
      `).run(ticketId, user.id, user.full_name, user.department_name_ar, detail.status, detail.status, note, nowIso);
    })();

    const updated = fetchTicketDetail(db, ticketId, user)!;
    logUserActivity(db, user, 'hall_confirm_receipt', 'ticket', ticketId, note);

    emitWs(
      'hall_confirmed',
      updated,
      user.id,
      undefined,
      `تأكيد استلام الصالة النهائي ${updated.ticket_number} — فاتورة ${updated.invoice_number}`,
      `${updated.item_name}: ${note}`,
      user.full_name,
      {
        audioTargetDepartment: 'assembly',
        senderDepartment: user.department_code,
        strictTargetOnly: true,
        messageUid: `hall-confirm-${ticketId}-${Date.now()}`,
        spokenText: `تم تأكيد استلام الطلب النهائي في الصالة، الفاتورة رقم ${updated.invoice_number}، رقم المتابعة ${updated.ticket_number}.`,
      }
    );

    res.json({ ticket: updated });
  });

  // Legacy Waiter endpoints explicitly disabled (role abolished, readiness managed by Hall Supervisor)
  app.post('/api/tickets/:id/assign-waiter', requireAuth, (_req, res) => {
    return res.status(403).json({
      error: 'تم إلغاء دور المباشرين؛ تتم متابعة جاهزية وتسليم الطلبات مباشرة عبر مسؤول الصالة',
    });
  });

  app.post('/api/tickets/:id/waiter-confirm', requireAuth, (_req, res) => {
    return res.status(403).json({
      error: 'تم إلغاء صلاحيات تأكيد الاستلام والتوصيل للمباشرين؛ المتابعة تتم عبر مسؤول الصالة والتجميع',
    });
  });

  // Close ticket (strictly guarded by server-side closure rules)
  app.post('/api/tickets/:id/close', requireAuth, requirePermission('close_ticket'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const ticketId = Number(req.params.id);
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail || detail.is_test !== Boolean(user.is_test_account)) {
      return res.status(404).json({ error: 'البلاغ غير موجود' });
    }

    const clientRequestId = req.body?.client_request_id ? String(req.body.client_request_id).trim() : null;
    if (clientRequestId) {
      const existingAction = db.prepare('SELECT id FROM ticket_actions WHERE client_request_id = ?').get(clientRequestId);
      if (existingAction) {
        return res.status(200).json({ ticket: detail, idempotent: true });
      }
    }

    const check = evaluateClosureEligibility(user, detail, detail.items);
    if (!check.canClose) {
      return res.status(400).json({ error: check.blockReason || 'لم تكتمل شروط إغلاق البلاغ' });
    }

    const note = String(req.body?.note || '').trim() || 'تم التحقق الفعلي من حل المشكلة وإغلاق البلاغ';
    const nowIso = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        UPDATE tickets
        SET status = 'closed', closed_at = ?, closed_by_user_id = ?, updated_at = ?
        WHERE id = ?
      `).run(nowIso, user.id, nowIso, ticketId);

      db.prepare(`
        INSERT INTO resolution_confirmations (ticket_id, confirmed_by_user_id, verification_type, note, created_at)
        VALUES (?, ?, 'final_closure', ?, ?)
      `).run(ticketId, user.id, note, nowIso);

      if (clientRequestId) {
        db.prepare(`
          INSERT INTO ticket_actions (ticket_id, user_id, action_type, action_note, client_request_id, created_at)
          VALUES (?, ?, 'close_ticket', ?, ?, ?)
        `).run(ticketId, user.id, note, clientRequestId, nowIso);
      }

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'closed', ?, 'closed', ?, ?)
      `).run(ticketId, user.id, user.full_name, user.department_name_ar, detail.status, note, nowIso);
    })();

    const updated = fetchTicketDetail(db, ticketId, user)!;
    logUserActivity(db, user, 'close_ticket', 'ticket', ticketId, note);
    emitWs(
      'ticket_closed',
      updated,
      user.id,
      undefined,
      `إغلاق البلاغ ${updated.ticket_number} — فاتورة ${updated.invoice_number}`,
      `${updated.item_name}: ${note}`,
      user.full_name
    );

    res.json({ ticket: updated });
  });

  // Reopen ticket
  app.post('/api/tickets/:id/reopen', requireAuth, requirePermission('reopen_ticket'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const ticketId = Number(req.params.id);
    const detail = fetchTicketDetail(db, ticketId, user);
    if (!detail || detail.is_test !== Boolean(user.is_test_account)) {
      return res.status(404).json({ error: 'البلاغ غير موجود' });
    }
    if (detail.status !== 'closed') {
      return res.status(400).json({ error: 'يمكن إعادة فتح البلاغات المغلقة فقط' });
    }

    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'يجب كتابة سبب إعادة فتح البلاغ' });

    const nowIso = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE tickets
        SET status = 'reopened', closed_at = NULL, closed_by_user_id = NULL, reopened_count = reopened_count + 1, updated_at = ?
        WHERE id = ?
      `).run(nowIso, ticketId);

      if (['production_delay', 'dispatched_not_arrived', 'item_shortage', 'item_mismatch'].includes(detail.reason_code)) {
        db.prepare('UPDATE ticket_items SET arrival_confirmed = 0 WHERE ticket_id = ?').run(ticketId);
      }

      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'reopened', 'closed', 'reopened', ?, ?)
      `).run(ticketId, user.id, user.full_name, user.department_name_ar, `إعادة فتح البلاغ: ${reason}`, nowIso);
    })();

    const updated = fetchTicketDetail(db, ticketId, user)!;
    logUserActivity(db, user, 'reopen_ticket', 'ticket', ticketId, reason);
    emitWs(
      'ticket_reopened',
      updated,
      user.id,
      undefined,
      `إعادة فتح بلاغ — فاتورة ${updated.invoice_number}`,
      `${updated.item_name}: ${reason}`,
      user.full_name
    );

    res.json({ ticket: updated });
  });

  // Notifications
  app.get('/api/notifications', requireAuth, (req: AuthedRequest, res) => {
    const isTestInt = req.authUser!.is_test_account ? 1 : 0;
    const rows = db
      .prepare(`
        SELECT
          n.*,
          t.ticket_number,
          t.invoice_number,
          t.reason_code,
          t.sender_department AS ticket_sender_department,
          (SELECT ti.item_name FROM ticket_items ti WHERE ti.ticket_id = n.ticket_id LIMIT 1) AS item_name
        FROM notifications n
        LEFT JOIN tickets t ON t.id = n.ticket_id
        WHERE n.user_id = ? AND COALESCE(n.is_test, 0) = ?
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT 50
      `)
      .all(req.authUser!.id, isTestInt) as Array<Record<string, unknown>>;

    res.json({
      notifications: rows.map((r) => {
        const isEscalated = String(r.event_type || '') === 'escalated' || String(r.event_type || '') === 'unreceived_reminder';
        const rawSender = (
          isEscalated ? r.sender_department_code || null : r.sender_department_code || r.ticket_sender_department || null
        ) as DepartmentCode | null;
        return {
          ...r,
          is_read: Number(r.is_read) === 1,
          is_test: Number(r.is_test || 0) === 1,
          should_play_audio: Number(r.should_play_audio) === 1,
          sender_department_code: rawSender,
          sender_department: rawSender ? DEPARTMENT_LABELS[rawSender] || String(rawSender) : null,
          target_department: (r.target_department || null) as DepartmentCode | null,
        };
      }),
    });
  });

  // Delivery confirmation (independent from read status and independent from audio playback)
  app.post('/api/notifications/:id/delivered', requireAuth, (req: AuthedRequest, res) => {
    const nowIso = new Date().toISOString();
    db.prepare(
      'UPDATE notifications SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND user_id = ?'
    ).run(nowIso, Number(req.params.id), req.authUser!.id);
    res.json({ ok: true, delivered_at: nowIso });
  });

  app.post('/api/notifications/:id/read', requireAuth, (req: AuthedRequest, res) => {
    const nowIso = new Date().toISOString();
    db.prepare(
      'UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?'
    ).run(nowIso, Number(req.params.id), req.authUser!.id);
    res.json({ ok: true });
  });

  app.post('/api/notifications/read-all', requireAuth, (req: AuthedRequest, res) => {
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE notifications SET is_read = 1, read_at = COALESCE(read_at, ?) WHERE user_id = ?').run(
      nowIso,
      req.authUser!.id
    );
    res.json({ ok: true });
  });

  // Bidirectional 6-direction Department Messages (Hall <-> Production <-> Assembly)
  app.get('/api/messages', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const ticketId = req.query.ticket_id ? Number(req.query.ticket_id) : undefined;
    const trackingNumber = req.query.tracking_number ? String(req.query.tracking_number) : undefined;
    const messageType = req.query.message_type ? String(req.query.message_type) : undefined;
    const messages = fetchDepartmentMessages(db, user, { ticketId, trackingNumber, messageType });
    res.json({ messages });
  });

  app.post('/api/messages', requireAuth, requirePermission('reply_ticket'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const {
      ticket_id = null,
      tracking_number = '',
      invoice_number = '',
      recipient_department,
      sender_department = null,
      message_body = '',
      notes = '',
      message_type = 'general',
      canned_status_code = null,
      parent_message_id = null,
      client_request_id = null,
    } = req.body ?? {};

    const validDepts: DepartmentCode[] = ['hall', 'production', 'assembly'];
    const resolvedSender: DepartmentCode =
      user.role_code === 'admin' && sender_department && validDepts.includes(sender_department)
        ? sender_department
        : (user.department_code as DepartmentCode);

    if (!validDepts.includes(resolvedSender)) {
      return res.status(403).json({ error: 'لا يملك قسمك صلاحية إرسال رسائل تشغيلية مباشرة' });
    }

    const recipient = String(recipient_department || '').trim() as DepartmentCode;
    if (!validDepts.includes(recipient)) {
      return res.status(400).json({ error: 'القسم المستلم غير صالح (المتاح: الصالة، الإنتاج، التجميع)' });
    }
    if (recipient === resolvedSender) {
      return res.status(400).json({ error: 'لا يمكن إرسال رسالة إلى نفس القسم المرسل' });
    }

    const cannedCodeNum = canned_status_code ? (Number(canned_status_code) as InquiryStatusCode) : null;
    if (cannedCodeNum !== null && !INQUIRY_CANNED_STATUSES[cannedCodeNum]) {
      return res.status(400).json({ error: 'رمز الرد الجاهز غير صالح (1 إلى 6)' });
    }

    if (cannedCodeNum !== null && user.role_code !== 'assembly' && user.role_code !== 'admin') {
      return res.status(403).json({ error: 'اختيار ردود الاستفسار المنظمة (1-6) متاح لقسم التجميع فقط' });
    }

    const rawBody = String(message_body || '').trim();
    const cannedLabel = cannedCodeNum ? INQUIRY_CANNED_STATUSES[cannedCodeNum] : '';
    const extraNotes = String(notes || '').trim();
    const finalBody = rawBody || cannedLabel;
    if (!finalBody) {
      return res.status(400).json({ error: 'نص الرسالة مطلوب' });
    }
    if (cannedCodeNum === 6 && !rawBody && !extraNotes) {
      return res.status(400).json({ error: 'يرجى كتابة نص الرد عند اختيار (رد كتابي)' });
    }

    if (client_request_id) {
      const dup = db.prepare('SELECT id FROM department_messages WHERE client_request_id = ?').get(String(client_request_id)) as
        | { id: number }
        | undefined;
      if (dup) {
        const existingMsg = fetchDepartmentMessages(db, user).find((m) => m.id === dup.id);
        return res.status(200).json({ message: existingMsg, idempotent: true });
      }
    }

    const nowIso = new Date().toISOString();
    const msgType = (['inquiry', 'inquiry_reply', 'backlog_update', 'general'].includes(String(message_type))
      ? String(message_type)
      : cannedCodeNum
        ? 'inquiry_reply'
        : 'general') as MessageType;

    const txRes = db.transaction(() => {
      let resolvedTicketId: number | null = ticket_id ? Number(ticket_id) : null;
      let resolvedTrk = String(tracking_number || '').trim().toUpperCase();
      let resolvedInv = String(invoice_number || '').trim();

      if (parent_message_id && (!resolvedTicketId || !resolvedTrk || !resolvedInv)) {
        const parentRow = db
          .prepare('SELECT ticket_id, tracking_number, invoice_number FROM department_messages WHERE id = ?')
          .get(Number(parent_message_id)) as { ticket_id: number | null; tracking_number: string; invoice_number: string } | undefined;
        if (parentRow) {
          resolvedTicketId = resolvedTicketId || parentRow.ticket_id;
          resolvedTrk = resolvedTrk || parentRow.tracking_number;
          resolvedInv = resolvedInv || parentRow.invoice_number;
        }
      }

      const isTestInt = user.is_test_account ? 1 : 0;

      if (!resolvedTicketId && resolvedTrk) {
        const found = db
          .prepare('SELECT id, invoice_number FROM tickets WHERE UPPER(ticket_number) = ? AND COALESCE(is_test, 0) = ?')
          .get(resolvedTrk, isTestInt) as { id: number; invoice_number: string } | undefined;
        if (found) {
          resolvedTicketId = found.id;
          resolvedInv = resolvedInv || found.invoice_number;
        }
      } else if (resolvedTicketId) {
        const found = db
          .prepare('SELECT ticket_number, invoice_number FROM tickets WHERE id = ? AND COALESCE(is_test, 0) = ?')
          .get(resolvedTicketId, isTestInt) as { ticket_number: string; invoice_number: string } | undefined;
        if (found) {
          resolvedTrk = found.ticket_number;
          resolvedInv = resolvedInv || found.invoice_number;
        } else {
          resolvedTicketId = null;
        }
      }

      if (!resolvedTrk) {
        resolvedTrk = allocateNextTrackingNumber(db);
      }
      if (!resolvedInv) {
        resolvedInv = resolvedTrk;
      }

      const fullMsgText = cannedLabel && rawBody && rawBody !== cannedLabel
        ? `${cannedLabel}: ${rawBody}`
        : finalBody;

      const ins = db
        .prepare(`
          INSERT INTO department_messages (
            ticket_id, tracking_number, invoice_number, message_type, canned_status_code,
            sender_department, recipient_department, sender_user_id, message_body, notes,
            parent_message_id, is_test, sent_at, client_request_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          resolvedTicketId,
          resolvedTrk,
          resolvedInv,
          msgType,
          cannedCodeNum,
          resolvedSender,
          recipient,
          user.id,
          fullMsgText,
          extraNotes || null,
          parent_message_id ? Number(parent_message_id) : null,
          isTestInt,
          nowIso,
          client_request_id ? String(client_request_id) : null
        );

      if (resolvedTicketId) {
        db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(nowIso, resolvedTicketId);
        db.prepare(`
          INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
          VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
        `).run(
          resolvedTicketId,
          user.id,
          user.full_name,
          DEPARTMENT_LABELS[resolvedSender],
          msgType === 'inquiry_reply' ? 'inquiry_replied' : 'dept_message_sent',
          `رسالة (${DEPARTMENT_LABELS[resolvedSender]} ← ${DEPARTMENT_LABELS[recipient]}): ${fullMsgText}${extraNotes ? ` — ${extraNotes}` : ''}`,
          nowIso
        );
      }

      return {
        messageId: Number(ins.lastInsertRowid),
        ticketId: resolvedTicketId,
        trackingNumber: resolvedTrk,
        invoiceNumber: resolvedInv,
        fullMsgText,
      };
    })();

    const savedMessage = fetchDepartmentMessages(db, user).find((m) => m.id === txRes.messageId)!;
    logUserActivity(db, user, 'send_dept_message', 'department_message', txRes.messageId, `${resolvedSender} -> ${recipient} (${txRes.trackingNumber})`);

    let linkedItemName: string | null = null;
    if (txRes.ticketId) {
      const itemRow = db
        .prepare('SELECT item_name FROM ticket_items WHERE ticket_id = ? ORDER BY id ASC LIMIT 1')
        .get(txRes.ticketId) as { item_name: string } | undefined;
      if (itemRow?.item_name) linkedItemName = itemRow.item_name;
    }

    const itemSegment = linkedItemName ? `، الصنف ${linkedItemName}` : '';
    const spokenText =
      msgType === 'inquiry_reply'
        ? `تنبيه، رد جديد من ${DEPARTMENT_LABELS[resolvedSender]} إلى ${DEPARTMENT_LABELS[recipient]}، فاتورة رقم ${txRes.invoiceNumber}، رقم المتابعة ${txRes.trackingNumber}${itemSegment}، محتوى الرسالة: ${txRes.fullMsgText}${extraNotes ? `، الملاحظات: ${extraNotes}` : ''}.`
        : `تنبيه، رسالة جديدة من ${DEPARTMENT_LABELS[resolvedSender]} إلى ${DEPARTMENT_LABELS[recipient]}، فاتورة رقم ${txRes.invoiceNumber}، رقم المتابعة ${txRes.trackingNumber}${itemSegment}، محتوى الرسالة: ${txRes.fullMsgText}${extraNotes ? `، الملاحظات: ${extraNotes}` : ''}.`;

    const msgUid = `dept-msg-${txRes.messageId}`;
    const directNotifs = createDirectNotificationsForDepartment(db, {
      ticketId: txRes.ticketId,
      trackingNumber: txRes.trackingNumber,
      invoiceNumber: txRes.invoiceNumber,
      itemName: linkedItemName,
      senderDepartment: resolvedSender,
      recipientDepartment: recipient,
      eventType: msgType === 'inquiry_reply' ? 'inquiry_replied' : 'dept_message',
      title: `${msgType === 'inquiry_reply' ? 'رد على استفسار' : 'رسالة مباشرة'} ${txRes.trackingNumber} — فاتورة ${txRes.invoiceNumber}`,
      body: `من ${DEPARTMENT_LABELS[resolvedSender]}: ${txRes.fullMsgText}`,
      spokenText,
      messageUid: msgUid,
      excludeUserId: user.id,
      isTest: Boolean(user.is_test_account),
    });

    if (broadcaster && directNotifs.recipientIds.length > 0) {
      const ticketObj = txRes.ticketId ? fetchTicketDetail(db, txRes.ticketId, user) : null;
      if (ticketObj) {
        broadcaster.broadcastTicketEvent(
          msgType === 'inquiry_reply' ? 'inquiry_replied' : 'dept_message',
          ticketObj,
          directNotifs.recipientIds,
          directNotifs.notifications,
          user.full_name
        );
      } else {
        broadcaster.broadcastSystemEvent?.('dept_message', {
          message: savedMessage,
          recipientIds: directNotifs.recipientIds,
          notifications: directNotifs.notifications,
        });
      }
    }

    return res.status(201).json({ message: savedMessage });
  });

  // Confirm receipt of a department message / inquiry («تأكيد استلام الرسالة / الاستفسار» — does NOT mark read_at!)
  app.post('/api/messages/:id/receive', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const msgId = Number(req.params.id);
    const row = db.prepare('SELECT * FROM department_messages WHERE id = ?').get(msgId) as Record<string, unknown> | undefined;
    if (!row) return res.status(404).json({ error: 'الرسالة غير موجودة' });

    if (user.role_code !== 'admin' && row.recipient_department !== user.department_code) {
      return res.status(403).json({ error: 'فقط القسم المستلم يمكنه تأكيد استلام هذه الرسالة' });
    }

    const nowIso = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE department_messages
        SET received_at = COALESCE(received_at, ?),
            received_by_user_id = COALESCE(received_by_user_id, ?)
        WHERE id = ?
      `).run(nowIso, user.id, msgId);

      if (row.ticket_id) {
        db.prepare(`
          INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
          VALUES (?, ?, ?, ?, 'message_received', NULL, NULL, ?, ?)
        `).run(
          Number(row.ticket_id),
          user.id,
          user.full_name,
          user.department_name_ar,
          `تأكيد استلام ${row.message_type === 'inquiry' ? 'الاستفسار' : 'الرسالة'} رقم #${msgId} بواسطة ${user.full_name}`,
          nowIso
        );
      }
    })();

    const updated = fetchDepartmentMessages(db, user).find((m) => m.id === msgId)!;
    logUserActivity(db, user, 'receive_dept_message', 'department_message', msgId, `تأكيد استلام رسالة ${updated.tracking_number}`);

    // Notify sender department with receipt confirmation audio (never touching read_at!)
    const senderDept = String(row.sender_department) as DepartmentCode;
    if (senderDept !== user.department_code) {
      const notifs = createDirectNotificationsForDepartment(db, {
        ticketId: row.ticket_id ? Number(row.ticket_id) : null,
        trackingNumber: String(row.tracking_number),
        invoiceNumber: String(row.invoice_number),
        senderDepartment: user.department_code,
        recipientDepartment: senderDept,
        eventType: 'message_receipt_confirmed',
        title: `تأكيد استلام ${row.message_type === 'inquiry' ? 'الاستفسار' : 'الرسالة'} ${row.tracking_number}`,
        body: `تم تأكيد الاستلام في ${user.department_name_ar} بواسطة ${user.full_name}`,
        spokenText: `تم تأكيد استلام ${row.message_type === 'inquiry' ? 'الاستفسار' : 'الرسالة'} لفاتورة رقم ${row.invoice_number}، رقم المتابعة ${row.tracking_number}، من ${user.department_name_ar}.`,
        messageUid: `msg-recv-${msgId}`,
        excludeUserId: user.id,
      });
      if (broadcaster && row.ticket_id) {
        const ticketObj = fetchTicketDetail(db, Number(row.ticket_id), user);
        if (ticketObj) {
          broadcaster.broadcastTicketEvent('message_receipt_confirmed', ticketObj, notifs.recipientIds, notifs.notifications, user.full_name);
        }
      }
    }

    res.json({ message: updated });
  });

  // Mark department message as explicitly read (strictly independent from delivery/receipt)
  app.post('/api/messages/:id/read', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const msgId = Number(req.params.id);
    const row = db.prepare('SELECT * FROM department_messages WHERE id = ?').get(msgId) as Record<string, unknown> | undefined;
    if (!row) return res.status(404).json({ error: 'الرسالة غير موجودة' });

    if (user.role_code !== 'admin' && row.recipient_department !== user.department_code) {
      return res.status(403).json({ error: 'فقط القسم المستلم يمكنه توثيق قراءة هذه الرسالة' });
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE department_messages
      SET read_at = COALESCE(read_at, ?),
          read_by_user_id = COALESCE(read_by_user_id, ?)
      WHERE id = ?
    `).run(nowIso, user.id, msgId);

    const updated = fetchDepartmentMessages(db, user).find((m) => m.id === msgId)!;
    res.json({ message: updated });
  });

  // Reports (all operational report aggregations + Yemen timezone + per-dept wait durations)
  app.get('/api/reports', requireAuth, requirePermission('view_reports'), (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const settings = db.prepare('SELECT * FROM escalation_settings WHERE id = 1').get() as EscalationSettings;

    let list = fetchTicketSummaries(db, { isTest: Boolean(user.is_test_account) }).filter((t) => canUserViewTicket(user, t, 'all'));
    const mode = String(req.query.mode || '').trim();
    const date = String(req.query.date || '').trim();
    const dateFrom = String(req.query.date_from || '').trim();
    const dateTo = String(req.query.date_to || '').trim();
    const dept = String(req.query.department || '').trim();
    const reason = String(req.query.reason || '').trim();
    const status = String(req.query.status || '').trim();
    const urgency = String(req.query.urgency || '').trim();
    const invoice = String(req.query.invoice_number || '').trim().toLowerCase();
    const tracking = String(req.query.tracking_number || '').trim().toLowerCase();

    if (mode || date || dateFrom || dateTo) {
      list = filterTicketsByAdenDate(list, { mode, date, dateFrom, dateTo });
    }
    if (dept) list = list.filter((t) => t.target_department === dept || t.sender_department === dept);
    if (reason) list = list.filter((t) => t.reason_code === reason);
    if (status) list = list.filter((t) => t.status === status);
    if (urgency) list = list.filter((t) => t.urgency_level === urgency);
    if (invoice) list = list.filter((t) => t.invoice_number.toLowerCase().includes(invoice));
    if (tracking) list = list.filter((t) => t.ticket_number.toLowerCase().includes(tracking));

    const groupCount = (keys: string[]) => {
      const map: Record<string, number> = {};
      for (const k of keys) map[k] = (map[k] || 0) + 1;
      return Object.entries(map)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
    };

    const byDepartment = groupCount(list.map((t) => DEPARTMENT_LABELS[t.target_department] || t.target_department));
    const byReason = groupCount(list.map((t) => REASON_LABELS[t.reason_code] || t.reason_code));
    const byEmployee = groupCount(list.map((t) => t.created_by_name));

    const itemStatsMap: Record<string, { item_name: string; count: number; total_stall_minutes: number }> = {};
    for (const t of list) {
      if (!itemStatsMap[t.item_name]) {
        itemStatsMap[t.item_name] = { item_name: t.item_name, count: 0, total_stall_minutes: 0 };
      }
      itemStatsMap[t.item_name].count += 1;
      itemStatsMap[t.item_name].total_stall_minutes += t.stall_minutes;
    }
    const topDelayedItems = Object.values(itemStatsMap)
      .map((x) => ({ ...x, avg_stall_minutes: Math.round((x.total_stall_minutes / x.count) * 10) / 10 }))
      .sort((a, b) => b.total_stall_minutes - a.total_stall_minutes);

    const invoiceCounts: Record<string, number> = {};
    for (const t of list) invoiceCounts[t.invoice_number] = (invoiceCounts[t.invoice_number] || 0) + 1;
    const repeatedIssues = Object.entries(invoiceCounts)
      .filter(([, c]) => c > 1)
      .map(([invoice_number, count]) => ({ invoice_number, count }))
      .sort((a, b) => b.count - a.count);

    const openTickets = list.filter((t) => t.status !== 'closed');
    const closedTickets = list.filter((t) => t.status === 'closed');
    const delayedTickets = openTickets.filter((t) => t.stall_minutes >= settings.first_warning_minutes);

    const responseTimes = list
      .filter((t) => t.received_at)
      .map((t) => Math.max(0, Math.round((new Date(t.received_at!).getTime() - new Date(t.created_at).getTime()) / 60000)));
    const resolutionTimes = closedTickets
      .filter((t) => t.closed_at)
      .map((t) => Math.max(0, Math.round((new Date(t.closed_at!).getTime() - new Date(t.created_at).getTime()) / 60000)));

    const avg = (arr: number[]) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0);

    res.json({
      summary: {
        total: list.length,
        open: openTickets.length,
        closed: closedTickets.length,
        delayed: delayedTickets.length,
        reopened: list.filter((t) => t.reopened_count > 0 || t.status === 'reopened').length,
        awaiting_receipt: openTickets.filter((t) => !t.received_at || t.status === 'new').length,
        awaiting_arrival: openTickets.filter((t) => t.status === 'action_taken_awaiting_confirm' && !t.arrival_confirmed).length,
        awaiting_confirm: list.filter((t) => t.status === 'action_taken_awaiting_confirm').length,
        ready_for_hall: list.filter((t) => t.status === 'ready_for_hall').length,
        escalated: list.filter((t) => t.escalation_level > 0).length,
        avg_response_minutes: avg(responseTimes),
        avg_processing_minutes: avg(resolutionTimes),
        avg_stall_minutes: avg(list.map((t) => t.stall_minutes)),
        avg_wait_by_department: {
          production: avg(list.map((t) => t.department_wait_minutes.production).filter((v) => v > 0)),
          assembly: avg(list.map((t) => t.department_wait_minutes.assembly).filter((v) => v > 0)),
          hall: avg(list.map((t) => t.department_wait_minutes.hall).filter((v) => v > 0)),
        },
      },
      by_department: byDepartment,
      by_reason: byReason,
      by_employee: byEmployee,
      top_delayed_items: topDelayedItems,
      repeated_invoices: repeatedIssues,
      tickets: list,
      responsibles: getResponsibleAssignments(db),
      stall_threshold_minutes: settings.first_warning_minutes,
    });
  });

  // ==========================================
  // Responsible Assignments Management API
  // ==========================================
  app.get('/api/responsibles', requireAuth, (_req, res) => {
    res.json({ responsibles: getResponsibleAssignments(db) });
  });

  app.put(
    '/api/responsibles/:roleKey',
    requireAuth,
    requireAnyPermission('manage_responsibles', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const roleKey = String(req.params.roleKey || '').trim() as ResponsibleRoleKey;
      if (!['production', 'assembly', 'hall_supervisor', 'admin'].includes(roleKey)) {
        return res.status(400).json({ error: 'رمز المسؤول الوظيفي غير صالح' });
      }

      const existing = db
        .prepare('SELECT * FROM responsible_assignments WHERE role_key = ?')
        .get(roleKey) as
        | { role_key: string; role_title_ar: string; assigned_person_name: string; updated_at: string }
        | undefined;
      if (!existing) {
        return res.status(404).json({ error: 'سجل المسؤول غير موجود' });
      }

      const nextTitle =
        req.body?.role_title_ar !== undefined
          ? String(req.body.role_title_ar).trim()
          : existing.role_title_ar;
      const nextPerson =
        req.body?.assigned_person_name !== undefined
          ? String(req.body.assigned_person_name).trim()
          : existing.assigned_person_name;

      if (!nextTitle || !nextPerson) {
        return res.status(400).json({ error: 'يرجى إدخال المسمى الوظيفي واسم الشخص المكلف بالمسؤولية' });
      }

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE responsible_assignments
        SET role_title_ar = ?,
            assigned_person_name = ?,
            updated_by_user_id = ?,
            updated_by_name = ?,
            updated_at = ?
        WHERE role_key = ?
      `).run(nextTitle, nextPerson, req.authUser!.id, req.authUser!.full_name, nowIso, roleKey);

      const responsibles = getResponsibleAssignments(db);
      const updated = responsibles.find((r) => r.role_key === roleKey)!;

      logUserActivity(
        db,
        req.authUser!,
        'update_responsible_assignment',
        'responsible',
        null,
        `تحديث المسؤول (${roleKey}): ${existing.role_title_ar} (${existing.assigned_person_name}) ← ${nextTitle} (${nextPerson})`,
        {
          oldValue: { role_title_ar: existing.role_title_ar, assigned_person_name: existing.assigned_person_name },
          newValue: { role_title_ar: nextTitle, assigned_person_name: nextPerson },
        }
      );

      broadcaster?.broadcastSystemEvent?.('responsibles_updated', { responsibles });
      res.json({ responsible: updated, responsibles });
    }
  );

  // ==========================================
  // Roles Management API
  // ==========================================
  app.get(
    '/api/roles',
    requireAuth,
    requireAnyPermission('manage_roles', 'manage_users'),
    (_req, res) => {
      const roles = db
        .prepare("SELECT id, code, name_ar, description FROM roles WHERE code != 'waiter' ORDER BY id ASC")
        .all();
      res.json({ roles });
    }
  );

  app.patch(
    '/api/roles/:code',
    requireAuth,
    requireAnyPermission('manage_roles', 'manage_users'),
    (req: AuthedRequest, res) => {
      const code = String(req.params.code || '').trim();
      if (code === 'waiter') {
        return res.status(400).json({ error: 'تم إلغاء دور المباشرين ولا يمكن تعديله' });
      }
      const existing = db.prepare('SELECT id, code, name_ar, description FROM roles WHERE code = ?').get(code) as
        | { id: number; code: string; name_ar: string; description: string }
        | undefined;
      if (!existing) return res.status(404).json({ error: 'الدور غير موجود' });

      const nextName = req.body?.name_ar !== undefined ? String(req.body.name_ar).trim() : existing.name_ar;
      const nextDesc = req.body?.description !== undefined ? String(req.body.description).trim() : existing.description;
      if (!nextName) return res.status(400).json({ error: 'اسم الدور مطلوب' });

      db.prepare('UPDATE roles SET name_ar = ?, description = ? WHERE id = ?').run(nextName, nextDesc, existing.id);

      logUserActivity(
        db,
        req.authUser!,
        'update_role',
        'role',
        existing.id,
        `تعديل مسمى الدور (${code}): ${existing.name_ar} ← ${nextName}`,
        { oldValue: { name_ar: existing.name_ar, description: existing.description }, newValue: { name_ar: nextName, description: nextDesc } }
      );

      const updated = db.prepare('SELECT id, code, name_ar, description FROM roles WHERE id = ?').get(existing.id);
      res.json({ role: updated });
    }
  );

  // Users & Granular Permissions management
  app.get(
    '/api/users',
    requireAuth,
    requireAnyPermission('manage_users', 'manage_roles'),
    (_req, res) => {
      const rows = db.prepare('SELECT id FROM users ORDER BY id ASC').all() as { id: number }[];
      const users = rows.map((r) => {
        const row = db
          .prepare(`
            SELECT u.id, u.full_name, u.username, u.email, u.is_active, COALESCE(u.is_test_account, 0) AS is_test_account,
                   r.code AS role_code, r.name_ar AS role_name_ar,
                   d.code AS department_code, d.name_ar AS department_name_ar
            FROM users u
            JOIN roles r ON r.id = u.role_id
            JOIN departments d ON d.id = u.department_id
            WHERE u.id = ?
          `)
          .get(r.id) as Record<string, unknown>;
        const profile = loadUserProfile(db, r.id);
        if (profile) return profile;
        return {
          ...row,
          is_active: Number(row.is_active) === 1,
          is_test_account: Number(row.is_test_account || 0) === 1,
          permissions: [],
          role_permissions: [],
          explicit_permissions: {},
          has_assembly_support: false,
        } as unknown as UserProfile;
      });
      res.json({ users, available_permissions: GRANULAR_PERMISSIONS });
    }
  );

  app.post('/api/users', requireAuth, requirePermission('manage_users'), (req: AuthedRequest, res) => {
    const {
      full_name,
      username,
      email,
      password,
      role_code,
      department_code,
      assembly_support = false,
      granted_permissions = [],
    } = req.body ?? {};
    if (!full_name || !username || !password || !role_code || !department_code) {
      return res.status(400).json({ error: 'يرجى استكمال الاسم واسم المستخدم وكلمة المرور والدور والقسم' });
    }
    if (String(role_code) === 'waiter' || String(department_code) === 'waiters') {
      return res.status(400).json({ error: 'تم إلغاء دور المباشرين ولا يمكن إنشاء حسابات جديدة بهذا الدور' });
    }

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim());
    if (exists) return res.status(409).json({ error: 'اسم المستخدم مستخدم بالفعل' });

    const roleRow = db.prepare('SELECT id FROM roles WHERE code = ?').get(String(role_code)) as { id: number } | undefined;
    const deptRow = db.prepare('SELECT id FROM departments WHERE code = ?').get(String(department_code)) as { id: number } | undefined;
    if (!roleRow || !deptRow) return res.status(400).json({ error: 'الدور أو القسم غير صالح' });

    const hash = bcrypt.hashSync(String(password), 8);
    const result = db
      .prepare(`
        INSERT INTO users (full_name, username, email, password_hash, role_id, department_id, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `)
      .run(String(full_name).trim(), String(username).trim(), email ? String(email).trim() : null, hash, roleRow.id, deptRow.id);

    const newUserId = Number(result.lastInsertRowid);
    if (assembly_support) {
      const perm = db.prepare("SELECT id FROM permissions WHERE code = 'assembly_support'").get() as { id: number } | undefined;
      if (perm) {
        db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission_id, granted) VALUES (?, ?, 1)').run(
          newUserId,
          perm.id
        );
      }
    }
    if (Array.isArray(granted_permissions)) {
      const insertUp = db.prepare(`
        INSERT INTO user_permissions (user_id, permission_id, granted)
        VALUES (?, ?, 1)
        ON CONFLICT(user_id, permission_id) DO UPDATE SET granted = 1
      `);
      for (const code of granted_permissions) {
        const perm = db.prepare('SELECT id FROM permissions WHERE code = ?').get(String(code)) as { id: number } | undefined;
        if (perm) insertUp.run(newUserId, perm.id);
      }
    }

    const profile = loadUserProfile(db, newUserId)!;
    logUserActivity(db, req.authUser!, 'create_user', 'user', newUserId, `إنشاء حساب ${profile.username}`, {
      newValue: { username: profile.username, role_code: profile.role_code, permissions: profile.permissions },
    });
    res.status(201).json({ user: profile });
  });

  app.patch(
    '/api/users/:id',
    requireAuth,
    requireAnyPermission('manage_users', 'manage_roles'),
    (req: AuthedRequest, res) => {
      const targetId = Number(req.params.id);
      const {
        full_name,
        email,
        role_code,
        department_code,
        is_active,
        assembly_support,
        password,
        permission_updates,
      } = req.body ?? {};

      const existing = db
        .prepare(`
          SELECT u.id, u.full_name, u.is_active, r.code AS role_code
          FROM users u
          JOIN roles r ON r.id = u.role_id
          WHERE u.id = ?
        `)
        .get(targetId) as { id: number; full_name: string; is_active: number; role_code: string } | undefined;
      if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });

      if (role_code === 'waiter' || department_code === 'waiters') {
        return res.status(400).json({ error: 'تم إلغاء دور المباشرين ولا يمكن إسناد هذا الدور' });
      }
      if (existing.role_code === 'waiter' && is_active === true && role_code === undefined) {
        return res.status(400).json({ error: 'تم إلغاء دور المباشرين ولا يمكن إعادة تفعيل حساب مباشر ملغى' });
      }

      const prevProfile = loadUserProfile(db, targetId);

      db.transaction(() => {
        if (full_name !== undefined) {
          db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(String(full_name).trim(), targetId);
        }
        if (email !== undefined) {
          db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email ? String(email).trim() : null, targetId);
        }
        if (role_code !== undefined) {
          const r = db.prepare('SELECT id FROM roles WHERE code = ?').get(String(role_code)) as { id: number } | undefined;
          if (r) db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(r.id, targetId);
        }
        if (department_code !== undefined) {
          const d = db.prepare('SELECT id FROM departments WHERE code = ?').get(String(department_code)) as { id: number } | undefined;
          if (d) db.prepare('UPDATE users SET department_id = ? WHERE id = ?').run(d.id, targetId);
        }
        if (is_active !== undefined) {
          db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, targetId);
        }
        if (password && String(password).length >= 4) {
          const hash = bcrypt.hashSync(String(password), 8);
          db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, targetId);
        }
        if (assembly_support !== undefined) {
          const perm = db.prepare("SELECT id FROM permissions WHERE code = 'assembly_support'").get() as { id: number } | undefined;
          if (perm) {
            db.prepare(`
              INSERT INTO user_permissions (user_id, permission_id, granted)
              VALUES (?, ?, ?)
              ON CONFLICT(user_id, permission_id) DO UPDATE SET granted = excluded.granted
            `).run(targetId, perm.id, assembly_support ? 1 : 0);
          }
        }
        if (permission_updates && typeof permission_updates === 'object') {
          const upsert = db.prepare(`
            INSERT INTO user_permissions (user_id, permission_id, granted)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, permission_id) DO UPDATE SET granted = excluded.granted
          `);
          const removeOverride = db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND permission_id = ?');
          for (const [permCode, grantVal] of Object.entries(permission_updates as Record<string, boolean | null>)) {
            const permRow = db.prepare('SELECT id FROM permissions WHERE code = ?').get(permCode) as { id: number } | undefined;
            if (!permRow) continue;
            if (grantVal === null) {
              removeOverride.run(targetId, permRow.id);
            } else {
              upsert.run(targetId, permRow.id, grantVal ? 1 : 0);
            }
          }
        }
      })();

      const updatedRow = db
        .prepare(`
          SELECT u.id, u.full_name, u.username, u.email, u.is_active,
                 r.code AS role_code, r.name_ar AS role_name_ar,
                 d.code AS department_code, d.name_ar AS department_name_ar
          FROM users u
          JOIN roles r ON r.id = u.role_id
          JOIN departments d ON d.id = u.department_id
          WHERE u.id = ?
        `)
        .get(targetId) as Record<string, unknown>;

      const profile = loadUserProfile(db, targetId) || {
        ...updatedRow,
        is_active: Number(updatedRow.is_active) === 1,
        permissions: [],
        role_permissions: [],
        explicit_permissions: {},
        has_assembly_support: false,
      };

      logUserActivity(
        db,
        req.authUser!,
        permission_updates ? 'update_user_permissions' : 'update_user',
        'user',
        targetId,
        `تحديث بيانات/صلاحيات المستخدم ${String(updatedRow.username)} (${String(updatedRow.full_name)})`,
        {
          oldValue: prevProfile
            ? { role_code: prevProfile.role_code, is_active: prevProfile.is_active, permissions: prevProfile.permissions }
            : null,
          newValue: {
            role_code: (profile as UserProfile).role_code,
            is_active: (profile as UserProfile).is_active,
            permissions: (profile as UserProfile).permissions,
          },
        }
      );
      broadcaster?.broadcastSystemEvent?.('user_permissions_updated', { userId: targetId });
      res.json({ user: profile });
    }
  );

  // Escalation & Stall Settings (independently permission-controlled)
  app.get('/api/settings/escalation', requireAuth, (_req, res) => {
    const settings = db.prepare('SELECT * FROM escalation_settings WHERE id = 1').get();
    res.json({ settings });
  });

  app.put(
    '/api/settings/escalation',
    requireAuth,
    requireAnyPermission('manage_stall_threshold', 'manage_escalation_timing', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const current = db.prepare('SELECT * FROM escalation_settings WHERE id = 1').get() as EscalationSettings;
      const body = req.body ?? {};
      const actor = req.authUser!;

      const nextWarning =
        body.first_warning_minutes !== undefined
          ? Math.max(1, Number(body.first_warning_minutes) || 5)
          : current.first_warning_minutes;
      const nextEscStart =
        body.escalation_start_minutes !== undefined
          ? Math.max(1, Number(body.escalation_start_minutes) || 10)
          : current.escalation_start_minutes;
      const nextTargetRole =
        body.escalation_target_role !== undefined
          ? String(body.escalation_target_role || 'admin')
          : current.escalation_target_role;
      const nextRepeatInterval =
        body.repeat_interval_minutes !== undefined
          ? Math.max(1, Number(body.repeat_interval_minutes) || 5)
          : current.repeat_interval_minutes;
      const nextMaxEsc =
        body.max_escalations !== undefined
          ? Math.max(1, Number(body.max_escalations) || 3)
          : current.max_escalations;

      const stallChanged = nextWarning !== current.first_warning_minutes;
      const escalationChanged =
        nextEscStart !== current.escalation_start_minutes ||
        nextTargetRole !== current.escalation_target_role ||
        nextRepeatInterval !== current.repeat_interval_minutes ||
        nextMaxEsc !== current.max_escalations;

      if (stallChanged && !hasAnyPermission(actor, 'manage_stall_threshold', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعديل مدة تعثر الطلبات' });
      }
      if (escalationChanged && !hasAnyPermission(actor, 'manage_escalation_timing', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعديل إعدادات وزمن التصعيد التلقائي' });
      }

      if (!['admin', 'hall_supervisor', 'assembly', 'production'].includes(nextTargetRole)) {
        return res.status(400).json({ error: 'الجهة المستقبلة للتصعيد غير صالحة' });
      }

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE escalation_settings
        SET first_warning_minutes = ?,
            escalation_start_minutes = ?,
            escalation_target_role = ?,
            repeat_interval_minutes = ?,
            max_escalations = ?,
            updated_by_user_id = ?,
            updated_at = ?
        WHERE id = 1
      `).run(nextWarning, nextEscStart, nextTargetRole, nextRepeatInterval, nextMaxEsc, actor.id, nowIso);

      const settings = db.prepare('SELECT * FROM escalation_settings WHERE id = 1').get() as EscalationSettings;

      const actionName =
        stallChanged && !escalationChanged
          ? 'update_stall_threshold'
          : escalationChanged && !stallChanged
            ? 'update_escalation_timing'
            : 'update_escalation_settings';

      logUserActivity(
        db,
        actor,
        actionName,
        'settings',
        1,
        `تعديل إعدادات التعثر/التصعيد: مدة التعثر=${settings.first_warning_minutes}د، بدء التصعيد=${settings.escalation_start_minutes}د، التكرار=${settings.repeat_interval_minutes}د، الحد الأقصى=${settings.max_escalations}`,
        { oldValue: current, newValue: settings }
      );

      broadcaster?.broadcastSystemEvent?.('escalation_settings_updated', { settings });
      res.json({ settings });
    }
  );

  // Activity Logs (immutable audit trail)
  app.get(
    '/api/audit-logs',
    requireAuth,
    requireAnyPermission(
      'manage_users',
      'manage_responsibles',
      'manage_roles',
      'manage_stall_threshold',
      'manage_escalation_timing',
      'manage_settings'
    ),
    (req: AuthedRequest, res) => {
      const category = String(req.query.category || 'all').trim();
      const limit = Math.min(300, Math.max(20, Number(req.query.limit) || 150));
      const isTestInt = req.authUser!.is_test_account ? 1 : 0;

      const whereClauses: string[] = ['COALESCE(is_test, 0) = ?'];
      const params: unknown[] = [isTestInt];

      if (category === 'responsibles') {
        whereClauses.push("entity_type IN ('responsible', 'role')");
      } else if (category === 'escalation') {
        whereClauses.push("entity_type = 'settings'");
      } else if (category === 'audio') {
        whereClauses.push("entity_type IN ('audio_file', 'station_audio', 'human_voice', 'voice_reader')");
      } else if (category === 'users') {
        whereClauses.push("entity_type = 'user'");
      } else if (category === 'backups') {
        whereClauses.push("entity_type = 'backup'");
      } else if (category === 'tickets') {
        whereClauses.push("entity_type IN ('ticket', 'department_message')");
      }

      const sql = `SELECT * FROM user_activity_logs WHERE ${whereClauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`;
      params.push(limit);

      const logs = db.prepare(sql).all(...params);
      res.json({ logs });
    }
  );

  // ==========================================
  // Central Audio Files & 6-Channel Station Settings API
  // ==========================================
  const loadStationSettings = (): StationAudioSetting[] => {
    const defaultFile = db
      .prepare('SELECT id, display_name, original_name FROM audio_files WHERE is_default = 1 ORDER BY id DESC LIMIT 1')
      .get() as { id: number; display_name: string | null; original_name: string } | undefined;

    const rows = db
      .prepare(`
        SELECT s.*, f.display_name AS audio_display_name, f.original_name AS audio_original_name
        FROM station_audio_settings s
        LEFT JOIN audio_files f ON f.id = s.audio_file_id
        ORDER BY CASE s.station_code
          WHEN 'production' THEN 1
          WHEN 'assembly' THEN 2
          WHEN 'hall' THEN 3
          WHEN 'delayed_critical' THEN 4
          WHEN 'escalation' THEN 5
          WHEN 'general' THEN 6
          ELSE 7
        END
      `)
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const explicitId = r.audio_file_id ? Number(r.audio_file_id) : null;
      const explicitName = explicitId
        ? String(r.audio_display_name || r.audio_original_name || '') || null
        : null;
      const explicitUrl = explicitId ? `/api/audio/files/${explicitId}/stream` : null;

      const resolvedId = explicitId ?? (defaultFile ? defaultFile.id : null);
      const resolvedName =
        explicitName ??
        (defaultFile ? String(defaultFile.display_name || defaultFile.original_name) : null);
      const resolvedUrl = resolvedId ? `/api/audio/files/${resolvedId}/stream` : null;

      return {
        station_code: r.station_code as StationCode,
        station_name_ar: String(r.station_name_ar),
        audio_file_id: explicitId,
        audio_file_name: explicitName,
        audio_file_url: explicitUrl,
        resolved_audio_file_id: resolvedId,
        resolved_audio_file_name: resolvedName,
        resolved_audio_file_url: resolvedUrl,
        uses_default_fallback: !explicitId && Boolean(defaultFile),
        playback_rate: Number(r.playback_rate || 1),
        volume_percent: Number(r.volume_percent ?? 85),
        is_enabled: Number(r.is_enabled) === 1,
        speak_text_enabled: Number(r.speak_text_enabled) === 1,
        updated_at: String(r.updated_at),
      };
    });
  };

  const loadAudioFilesList = (): AudioFileRecord[] => {
    const rows = db
      .prepare(`
        SELECT f.*, u.full_name AS uploaded_by_name
        FROM audio_files f
        LEFT JOIN users u ON u.id = f.uploaded_by_user_id
        ORDER BY f.is_default DESC, f.created_at DESC, f.id DESC
      `)
      .all() as Array<Record<string, unknown>>;

    const stationLinks = db
      .prepare('SELECT station_code, audio_file_id FROM station_audio_settings WHERE audio_file_id IS NOT NULL')
      .all() as Array<{ station_code: StationCode; audio_file_id: number }>;

    const stationsByFile = new Map<number, StationCode[]>();
    for (const s of stationLinks) {
      const arr = stationsByFile.get(s.audio_file_id) || [];
      arr.push(s.station_code);
      stationsByFile.set(s.audio_file_id, arr);
    }

    return rows.map((r) => {
      const id = Number(r.id);
      const origName = String(r.original_name);
      return {
        id,
        display_name: String(r.display_name || origName),
        original_name: origName,
        stored_filename: String(r.stored_filename),
        mime_type: String(r.mime_type),
        size_bytes: Number(r.size_bytes),
        source_type: (r.source_type === 'ai_tts' ? 'ai_tts' : 'upload') as 'upload' | 'ai_tts',
        file_category: (r.file_category === 'human_voice' ? 'human_voice' : 'alert_tone') as 'alert_tone' | 'human_voice',
        is_default: Number(r.is_default) === 1,
        uploaded_by_user_id: Number(r.uploaded_by_user_id),
        uploaded_by_name: r.uploaded_by_name ? String(r.uploaded_by_name) : undefined,
        used_by_stations: stationsByFile.get(id) || [],
        stream_url: `/api/audio/files/${id}/stream`,
        created_at: String(r.created_at),
        updated_at: r.updated_at ? String(r.updated_at) : undefined,
      };
    });
  };

  const loadHumanVoicesList = (): HumanVoiceRecord[] => {
    const rows = db
      .prepare(`
        SELECT v.*, u.full_name AS created_by_name
        FROM human_voices v
        LEFT JOIN users u ON u.id = v.created_by_user_id
        ORDER BY v.is_default DESC, v.is_favorite DESC, v.id ASC
      `)
      .all() as Array<Record<string, unknown>>;

    const channelLinks = db
      .prepare('SELECT channel_code, human_voice_id FROM voice_reader_settings WHERE human_voice_id IS NOT NULL')
      .all() as Array<{ channel_code: VoiceReaderChannelCode; human_voice_id: number }>;

    const channelsByVoice = new Map<number, VoiceReaderChannelCode[]>();
    for (const c of channelLinks) {
      const arr = channelsByVoice.get(c.human_voice_id) || [];
      arr.push(c.channel_code);
      channelsByVoice.set(c.human_voice_id, arr);
    }

    return rows.map((r) => {
      const id = Number(r.id);
      const audioFileId = r.audio_file_id ? Number(r.audio_file_id) : null;
      return {
        id,
        voice_key: r.voice_key ? String(r.voice_key) : null,
        display_name: String(r.display_name),
        description: r.description ? String(r.description) : null,
        gender: (r.gender === 'male' ? 'male' : 'female') as 'female' | 'male',
        voice_kind: (
          r.voice_kind === 'recorded_human'
            ? 'recorded_human'
            : r.voice_kind === 'browser_human'
              ? 'browser_human'
              : 'ai_human'
        ) as VoiceKind,
        prebuilt_voice_name: r.prebuilt_voice_name ? String(r.prebuilt_voice_name) : null,
        style_prompt: r.style_prompt ? String(r.style_prompt) : null,
        audio_file_id: audioFileId,
        audio_file_url: audioFileId ? `/api/audio/files/${audioFileId}/stream` : null,
        is_favorite: Number(r.is_favorite) === 1,
        is_default: Number(r.is_default) === 1,
        is_system: Number(r.is_system) === 1,
        used_by_channels: channelsByVoice.get(id) || [],
        created_by_user_id: r.created_by_user_id ? Number(r.created_by_user_id) : null,
        created_by_name: r.created_by_name ? String(r.created_by_name) : null,
        created_at: String(r.created_at),
        updated_at: r.updated_at ? String(r.updated_at) : undefined,
      };
    });
  };

  const loadVoiceReaderSettings = (): VoiceReaderSetting[] => {
    const voices = loadHumanVoicesList();
    const voiceById = new Map(voices.map((v) => [v.id, v]));
    const defaultVoice = voices.find((v) => v.is_default) || voices[0] || null;

    const rows = db
      .prepare(`
        SELECT * FROM voice_reader_settings
        ORDER BY CASE channel_code
          WHEN 'production' THEN 1
          WHEN 'assembly' THEN 2
          WHEN 'hall' THEN 3
          WHEN 'escalation' THEN 4
          WHEN 'general' THEN 5
          ELSE 6
        END
      `)
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const explicitId = r.human_voice_id ? Number(r.human_voice_id) : null;
      const explicitVoice = explicitId ? voiceById.get(explicitId) || null : null;
      const resolvedVoice = explicitVoice || defaultVoice;

      return {
        channel_code: r.channel_code as VoiceReaderChannelCode,
        channel_name_ar: String(r.channel_name_ar),
        human_voice_id: explicitVoice ? explicitVoice.id : null,
        human_voice_name: explicitVoice ? explicitVoice.display_name : null,
        human_voice_kind: explicitVoice ? explicitVoice.voice_kind : null,
        resolved_human_voice_id: resolvedVoice ? resolvedVoice.id : null,
        resolved_human_voice_name: resolvedVoice ? resolvedVoice.display_name : null,
        resolved_human_voice_kind: resolvedVoice ? resolvedVoice.voice_kind : null,
        resolved_prebuilt_voice_name: resolvedVoice ? resolvedVoice.prebuilt_voice_name : null,
        resolved_style_prompt: resolvedVoice ? resolvedVoice.style_prompt : null,
        resolved_audio_file_url: resolvedVoice ? resolvedVoice.audio_file_url : null,
        uses_default_fallback: !explicitVoice && Boolean(defaultVoice),
        is_enabled: Number(r.is_enabled) === 1,
        playback_rate: Number(r.playback_rate || 1),
        volume_percent: Number(r.volume_percent ?? 90),
        read_scope: (r.read_scope === 'important_only' ? 'important_only' : 'all') as VoiceReadScope,
        include_sender_dept: Number(r.include_sender_dept) === 1,
        updated_at: String(r.updated_at),
      };
    });
  };

  const isValidAudioBuffer = (ext: string, buffer: Buffer): boolean => {
    if (buffer.length < 8) return false;
    const headAscii = buffer.subarray(0, 12).toString('ascii');
    if (ext === '.wav') {
      return headAscii.startsWith('RIFF');
    }
    if (ext === '.mp3') {
      // ID3 tag OR MPEG frame sync (0xFF 0xE0..0xFF)
      const isId3 = headAscii.startsWith('ID3');
      const isMpegSync = buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
      return isId3 || isMpegSync;
    }
    if (ext === '.ogg') {
      return headAscii.startsWith('OggS');
    }
    if (ext === '.m4a') {
      return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
    }
    if (ext === '.webm') {
      return buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
    }
    return false;
  };

  const parseAudioUploadPayload = (
    req: express.Request
  ): { originalName: string; displayName: string; mimeType: string; buffer: Buffer } | { error: string } => {
    const rawName = String(req.body?.filename || req.headers['x-file-name'] || 'alert.mp3');
    const originalName = decodeURIComponent(rawName).trim() || 'alert.mp3';
    const rawDisplay = String(req.body?.display_name || '').trim();
    const displayName = rawDisplay || originalName.replace(/\.[^/.]+$/, '');
    const ext = path.extname(originalName).toLowerCase();
    if (!ALLOWED_AUDIO_EXTS.has(ext)) {
      return { error: 'صيغة الملف غير مدعومة. الصيغ المدعومة: MP3, WAV, M4A, OGG, WEBM' };
    }

    let buffer: Buffer;
    if (req.body && typeof req.body === 'object' && typeof req.body.data_base64 === 'string') {
      const base64Clean = req.body.data_base64.includes(',') ? req.body.data_base64.split(',')[1] : req.body.data_base64;
      buffer = Buffer.from(base64Clean, 'base64');
    } else if (Buffer.isBuffer(req.body)) {
      buffer = req.body;
    } else {
      return { error: 'بيانات الملف الصوتي غير مكتملة' };
    }

    if (!buffer || buffer.length === 0) {
      return { error: 'الملف الصوتي فارغ' };
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      return { error: 'حجم الملف يتجاوز الحد الأقصى المسموح (10 ميجابايت)' };
    }
    if (!isValidAudioBuffer(ext, buffer)) {
      return { error: `الملف المرفق لا يطابق بنية ملف صوتي صالح (${ext.toUpperCase()}) أو أن البيانات تالفة` };
    }

    const reqMime = String(req.body?.mime_type || req.headers['content-type'] || '').split(';')[0].trim();
    const mimeType = reqMime.startsWith('audio/') ? reqMime : ALLOWED_AUDIO_MIMES[ext] || 'audio/mpeg';
    return { originalName, displayName, mimeType, buffer };
  };

  // Any authenticated station can read current central station audio settings
  app.get('/api/audio/settings', requireAuth, (_req, res) => {
    res.json({ settings: loadStationSettings() });
  });

  // Granularly guarded: list audio library files
  app.get(
    '/api/audio/files',
    requireAuth,
    requireAnyPermission(
      'audio_test',
      'audio_add',
      'audio_upload',
      'audio_set_default',
      'audio_assign',
      'audio_delete',
      'audio_volume',
      'manage_settings'
    ),
    (_req, res) => {
      res.json({ files: loadAudioFilesList() });
    }
  );

  // Upload new audio file to library
  app.post(
    '/api/audio/files',
    requireAuth,
    requireAnyPermission('audio_upload', 'audio_add', 'manage_settings'),
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '15mb' }),
    (req: AuthedRequest, res) => {
      const parsed = parseAudioUploadPayload(req);
      if ('error' in parsed) {
        return res.status(400).json({ error: parsed.error });
      }

      const ext = path.extname(parsed.originalName).toLowerCase() || '.mp3';
      const storedFilename = `snd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const diskPath = path.join(AUDIO_STORAGE_DIR, storedFilename);
      fs.writeFileSync(diskPath, parsed.buffer);

      const nowIso = new Date().toISOString();
      const result = db
        .prepare(`
          INSERT INTO audio_files (
            display_name, original_name, stored_filename, mime_type, size_bytes,
            source_type, is_default, uploaded_by_user_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'upload', 0, ?, ?, ?)
        `)
        .run(
          parsed.displayName,
          parsed.originalName,
          storedFilename,
          parsed.mimeType,
          parsed.buffer.length,
          req.authUser!.id,
          nowIso,
          nowIso
        );

      const fileId = Number(result.lastInsertRowid);
      logUserActivity(
        db,
        req.authUser!,
        'upload_audio_file',
        'audio_file',
        fileId,
        `رفع ملف صوتي: ${parsed.displayName} (${parsed.originalName})`,
        { newValue: { display_name: parsed.displayName, original_name: parsed.originalName, size_bytes: parsed.buffer.length } }
      );
      const record = loadAudioFilesList().find((f) => f.id === fileId)!;
      return res.status(201).json({ file: record });
    }
  );

  // Generate & save an AI Arabic voice clip directly into the persistent library
  app.post(
    '/api/audio/files/generate-ai',
    requireAuth,
    requireAnyPermission('audio_add', 'manage_settings'),
    async (req: AuthedRequest, res) => {
      const displayName = String(req.body?.display_name || '').trim();
      const text = String(req.body?.text || '').trim();
      if (!displayName || !text) {
        return res.status(400).json({ error: 'يرجى إدخال اسم الصوت والنص العربي المطلوب تحويله' });
      }

      const result = await generateArabicTtsAudio(text);
      if (!result.ok) {
        return res.status(503).json({
          error: result.message || 'خدمة الصوت الذكي غير مهيأة حالياً؛ يمكنك رفع ملف صوتي من الجهاز',
          reason: result.reason,
        });
      }

      const ext = result.mimeType.includes('wav') ? '.wav' : '.mp3';
      const storedFilename = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const originalName = `${displayName}${ext}`;
      fs.writeFileSync(path.join(AUDIO_STORAGE_DIR, storedFilename), result.audioBuffer);

      const nowIso = new Date().toISOString();
      const insertRes = db
        .prepare(`
          INSERT INTO audio_files (
            display_name, original_name, stored_filename, mime_type, size_bytes,
            source_type, is_default, uploaded_by_user_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, 'ai_tts', 0, ?, ?, ?)
        `)
        .run(
          displayName,
          originalName,
          storedFilename,
          result.mimeType,
          result.audioBuffer.length,
          req.authUser!.id,
          nowIso,
          nowIso
        );

      const fileId = Number(insertRes.lastInsertRowid);
      logUserActivity(
        db,
        req.authUser!,
        'add_ai_audio_file',
        'audio_file',
        fileId,
        `إنشاء وحفظ صوت ذكي في المكتبة: ${displayName}`,
        { newValue: { display_name: displayName, source_type: 'ai_tts', size_bytes: result.audioBuffer.length } }
      );

      const record = loadAudioFilesList().find((f) => f.id === fileId)!;
      res.status(201).json({ file: record });
    }
  );

  // Rename audio file or designate as default system sound
  app.patch(
    '/api/audio/files/:id',
    requireAuth,
    requireAnyPermission('audio_set_default', 'audio_delete', 'audio_add', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const fileId = Number(req.params.id);
      const existing = db.prepare('SELECT * FROM audio_files WHERE id = ?').get(fileId) as
        | { id: number; display_name: string | null; original_name: string; is_default: number }
        | undefined;
      if (!existing) return res.status(404).json({ error: 'الملف الصوتي غير موجود' });

      const actor = req.authUser!;
      const nextDisplayName =
        req.body?.display_name !== undefined ? String(req.body.display_name).trim() : existing.display_name || existing.original_name;
      const setDefault = req.body?.is_default;

      if (req.body?.display_name !== undefined && !nextDisplayName) {
        return res.status(400).json({ error: 'اسم الصوت لا يمكن أن يكون فارغاً' });
      }
      if (req.body?.display_name !== undefined && !hasAnyPermission(actor, 'audio_delete', 'audio_add', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعديل اسم الصوت' });
      }
      if (setDefault !== undefined && !hasAnyPermission(actor, 'audio_set_default', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعيين الصوت الافتراضي للنظام' });
      }

      const nowIso = new Date().toISOString();
      db.transaction(() => {
        if (setDefault === true) {
          db.prepare('UPDATE audio_files SET is_default = 0').run();
          db.prepare('UPDATE audio_files SET is_default = 1, updated_at = ? WHERE id = ?').run(nowIso, fileId);
        } else if (setDefault === false) {
          db.prepare('UPDATE audio_files SET is_default = 0, updated_at = ? WHERE id = ?').run(nowIso, fileId);
        }
        if (req.body?.display_name !== undefined) {
          db.prepare('UPDATE audio_files SET display_name = ?, updated_at = ? WHERE id = ?').run(nextDisplayName, nowIso, fileId);
        }
      })();

      const updatedSettings = loadStationSettings();
      broadcaster?.broadcastSystemEvent?.('audio_settings_updated', { settings: updatedSettings });
      logUserActivity(
        db,
        actor,
        setDefault !== undefined ? 'set_default_audio_file' : 'rename_audio_file',
        'audio_file',
        fileId,
        `تحديث خصائص الصوت (${existing.display_name || existing.original_name}) ← ${nextDisplayName}${setDefault === true ? ' [افتراضي للنظام]' : ''}`,
        {
          oldValue: { display_name: existing.display_name || existing.original_name, is_default: existing.is_default === 1 },
          newValue: { display_name: nextDisplayName, is_default: setDefault !== undefined ? Boolean(setDefault) : existing.is_default === 1 },
        }
      );

      res.json({
        file: loadAudioFilesList().find((f) => f.id === fileId)!,
        files: loadAudioFilesList(),
        settings: updatedSettings,
      });
    }
  );

  // Replace an existing audio file cleanly without breaking station links
  app.post(
    '/api/audio/files/:id/replace',
    requireAuth,
    requireAnyPermission('audio_delete', 'audio_upload', 'manage_settings'),
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '15mb' }),
    (req: AuthedRequest, res) => {
      const fileId = Number(req.params.id);
      const existing = db.prepare('SELECT * FROM audio_files WHERE id = ?').get(fileId) as
        | { id: number; stored_filename: string; original_name: string; display_name: string | null }
        | undefined;
      if (!existing) return res.status(404).json({ error: 'الملف الصوتي غير موجود' });

      const parsed = parseAudioUploadPayload(req);
      if ('error' in parsed) {
        return res.status(400).json({ error: parsed.error });
      }

      const ext = path.extname(parsed.originalName).toLowerCase() || '.mp3';
      const newStoredFilename = `snd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      fs.writeFileSync(path.join(AUDIO_STORAGE_DIR, newStoredFilename), parsed.buffer);

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE audio_files
        SET display_name = ?, original_name = ?, stored_filename = ?, mime_type = ?, size_bytes = ?, uploaded_by_user_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        parsed.displayName,
        parsed.originalName,
        newStoredFilename,
        parsed.mimeType,
        parsed.buffer.length,
        req.authUser!.id,
        nowIso,
        fileId
      );

      db.prepare('UPDATE station_audio_settings SET updated_at = ? WHERE audio_file_id = ?').run(nowIso, fileId);

      // Remove old physical file safely
      const oldDiskPath = path.join(AUDIO_STORAGE_DIR, existing.stored_filename);
      if (fs.existsSync(oldDiskPath)) {
        try {
          fs.unlinkSync(oldDiskPath);
        } catch {
          // ignore cleanup failure
        }
      }

      const updatedSettings = loadStationSettings();
      broadcaster?.broadcastSystemEvent?.('audio_settings_updated', { settings: updatedSettings });
      logUserActivity(
        db,
        req.authUser!,
        'replace_audio_file',
        'audio_file',
        fileId,
        `استبدال الملف ${existing.original_name} بـ ${parsed.originalName}`,
        { oldValue: { original_name: existing.original_name }, newValue: { original_name: parsed.originalName } }
      );

      const record = loadAudioFilesList().find((f) => f.id === fileId)!;
      res.json({ file: record, settings: updatedSettings });
    }
  );

  // Dedicated permission-enforced endpoint to authorize & verify real audio file testing
  app.post(
    '/api/audio/files/:id/test',
    requireAuth,
    requireAnyPermission('audio_test', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const fileId = Number(req.params.id);
      const record = loadAudioFilesList().find((f) => f.id === fileId);
      if (!record) return res.status(404).json({ error: 'الملف الصوتي غير موجود' });

      const diskPath = path.join(AUDIO_STORAGE_DIR, path.basename(record.stored_filename));
      if (!fs.existsSync(diskPath)) {
        return res.status(404).json({ error: 'تعذر العثور على الملف الصوتي على وحدة التخزين' });
      }
      const stat = fs.statSync(diskPath);
      if (stat.size <= 0) {
        return res.status(422).json({ error: 'الملف الصوتي فارغ أو غير صالح للتشغيل' });
      }

      res.json({
        ok: true,
        file: {
          ...record,
          test_stream_url: `${record.stream_url}?mode=test`,
        },
      });
    }
  );

  // Authenticated stream endpoint (accepts Bearer header or ?token= for HTMLAudioElement compatibility + Range support)
  // When ?mode=test is specified, strictly enforces audio_test (or manage_settings/admin) permission!
  app.get('/api/audio/files/:id/stream', (req, res) => {
    const authHeader = req.headers.authorization;
    const queryToken = String(req.query.token || '').trim();
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : queryToken;

    if (!token) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول لتشغيل الملف الصوتي' });
    }
    let authedUser: UserProfile | null = null;
    try {
      const decoded = verifyAuthToken(token);
      authedUser = loadUserProfile(db, decoded.userId);
      if (!authedUser) return res.status(401).json({ error: 'جلسة غير صالحة' });
    } catch {
      return res.status(401).json({ error: 'جلسة غير صالحة' });
    }

    if (String(req.query.mode || '').trim() === 'test') {
      if (!hasAnyPermission(authedUser, 'audio_test', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تجربة الأصوات' });
      }
    }

    const fileId = Number(req.params.id);
    const row = db.prepare('SELECT * FROM audio_files WHERE id = ?').get(fileId) as
      | { id: number; stored_filename: string; mime_type: string; size_bytes: number }
      | undefined;
    if (!row) return res.status(404).json({ error: 'الملف الصوتي غير موجود' });

    const diskPath = path.join(AUDIO_STORAGE_DIR, path.basename(row.stored_filename));
    if (!fs.existsSync(diskPath)) {
      return res.status(404).json({ error: 'تعذر العثور على الملف على وحدة التخزين' });
    }

    const stat = fs.statSync(diskPath);
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', row.mime_type);
    res.setHeader('Cache-Control', 'no-store');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size || end >= stat.size) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(diskPath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(diskPath).pipe(res);
    }
  });

  // Safe delete (automatically detaches any station link cleanly so no broken audio links occur)
  app.delete(
    '/api/audio/files/:id',
    requireAuth,
    requireAnyPermission('audio_delete', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const fileId = Number(req.params.id);
      const existing = db.prepare('SELECT * FROM audio_files WHERE id = ?').get(fileId) as
        | { id: number; stored_filename: string; original_name: string; display_name: string | null }
        | undefined;
      if (!existing) return res.status(404).json({ error: 'الملف الصوتي غير موجود' });

      const nowIso = new Date().toISOString();
      db.transaction(() => {
        db.prepare('UPDATE station_audio_settings SET audio_file_id = NULL, updated_by_user_id = ?, updated_at = ? WHERE audio_file_id = ?').run(
          req.authUser!.id,
          nowIso,
          fileId
        );
        db.prepare('DELETE FROM audio_files WHERE id = ?').run(fileId);
      })();

      const diskPath = path.join(AUDIO_STORAGE_DIR, path.basename(existing.stored_filename));
      if (fs.existsSync(diskPath)) {
        try {
          fs.unlinkSync(diskPath);
        } catch {
          // ignore cleanup failure
        }
      }

      const updatedSettings = loadStationSettings();
      broadcaster?.broadcastSystemEvent?.('audio_settings_updated', { settings: updatedSettings });
      logUserActivity(
        db,
        req.authUser!,
        'delete_audio_file',
        'audio_file',
        fileId,
        `حذف آمن للملف الصوتي: ${existing.display_name || existing.original_name}`,
        { oldValue: { original_name: existing.original_name, display_name: existing.display_name } }
      );
      res.json({ ok: true, settings: updatedSettings, files: loadAudioFilesList() });
    }
  );

  // Update station/event audio channel settings (supports all 6 channels + granular permissions)
  app.put(
    '/api/audio/settings/:stationCode',
    requireAuth,
    requireAnyPermission('audio_assign', 'audio_volume', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const stationCode = String(req.params.stationCode || '').trim() as StationCode;
      if (!ALL_STATION_CODES.includes(stationCode)) {
        return res.status(400).json({ error: 'رمز القناة الصوتية غير صالح' });
      }

      const currentRow = db
        .prepare('SELECT * FROM station_audio_settings WHERE station_code = ?')
        .get(stationCode) as Record<string, unknown> | undefined;
      if (!currentRow) return res.status(404).json({ error: 'القناة الصوتية غير موجودة' });

      const actor = req.authUser!;
      const body = req.body ?? {};
      const validRates = new Set<number>(PLAYBACK_RATE_OPTIONS);
      const rateNum = body.playback_rate !== undefined ? Number(body.playback_rate) : Number(currentRow.playback_rate || 1);
      if (!validRates.has(rateNum)) {
        return res.status(400).json({ error: 'سرعة التشغيل غير صالحة (المسموح: 0.75x، 1x، 1.25x، 1.5x، 2x)' });
      }

      const volNum =
        body.volume_percent !== undefined
          ? Math.min(100, Math.max(0, Math.round(Number(body.volume_percent))))
          : Number(currentRow.volume_percent ?? 85);
      if (Number.isNaN(volNum)) {
        return res.status(400).json({ error: 'مستوى الصوت غير صالح' });
      }

      const currentFileId = currentRow.audio_file_id ? Number(currentRow.audio_file_id) : null;
      let resolvedFileId: number | null = currentFileId;
      if (body.audio_file_id !== undefined) {
        if (body.audio_file_id === null || body.audio_file_id === '') {
          resolvedFileId = null;
        } else {
          const fRow = db.prepare('SELECT id FROM audio_files WHERE id = ?').get(Number(body.audio_file_id)) as { id: number } | undefined;
          if (!fRow) return res.status(400).json({ error: 'الملف الصوتي المختار غير موجود' });
          resolvedFileId = fRow.id;
        }
      }

      const nextEnabled = body.is_enabled !== undefined ? (body.is_enabled === false ? 0 : 1) : Number(currentRow.is_enabled);
      const nextSpeak = body.speak_text_enabled !== undefined ? (body.speak_text_enabled === false ? 0 : 1) : Number(currentRow.speak_text_enabled);

      const fileChanged = resolvedFileId !== currentFileId;
      const volumeOrPlaybackChanged =
        volNum !== Number(currentRow.volume_percent ?? 85) ||
        rateNum !== Number(currentRow.playback_rate || 1) ||
        nextEnabled !== Number(currentRow.is_enabled) ||
        nextSpeak !== Number(currentRow.speak_text_enabled);

      if (fileChanged && !hasAnyPermission(actor, 'audio_assign', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تخصيص الأصوات للأقسام والتنبيهات' });
      }
      if (volumeOrPlaybackChanged && !hasAnyPermission(actor, 'audio_volume', 'audio_assign', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية التحكم في مستوى الصوت وإعداداته' });
      }

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE station_audio_settings
        SET audio_file_id = ?,
            playback_rate = ?,
            volume_percent = ?,
            is_enabled = ?,
            speak_text_enabled = ?,
            updated_by_user_id = ?,
            updated_at = ?
        WHERE station_code = ?
      `).run(resolvedFileId, rateNum, volNum, nextEnabled, nextSpeak, actor.id, nowIso, stationCode);

      const updatedSettings = loadStationSettings();
      broadcaster?.broadcastSystemEvent?.('audio_settings_updated', { settings: updatedSettings });
      logUserActivity(
        db,
        actor,
        'update_station_audio',
        'station_audio',
        null,
        `تحديث صوت ${stationCode}: ملف=${resolvedFileId ?? 'افتراضي'} سرعة=${rateNum}x مستوى=${volNum}%`,
        {
          oldValue: {
            station_code: stationCode,
            audio_file_id: currentFileId,
            playback_rate: currentRow.playback_rate,
            volume_percent: currentRow.volume_percent,
            is_enabled: Number(currentRow.is_enabled) === 1,
          },
          newValue: {
            station_code: stationCode,
            audio_file_id: resolvedFileId,
            playback_rate: rateNum,
            volume_percent: volNum,
            is_enabled: nextEnabled === 1,
          },
        }
      );

      res.json({
        setting: updatedSettings.find((s) => s.station_code === stationCode),
        settings: updatedSettings,
      });
    }
  );

  // Reset a station/event channel back to default audio settings
  app.post(
    '/api/audio/settings/:stationCode/reset',
    requireAuth,
    requireAnyPermission('audio_assign', 'audio_volume', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const stationCode = String(req.params.stationCode || '').trim() as StationCode;
      if (!ALL_STATION_CODES.includes(stationCode)) {
        return res.status(400).json({ error: 'رمز القناة الصوتية غير صالح' });
      }

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE station_audio_settings
        SET audio_file_id = NULL,
            playback_rate = 1.0,
            volume_percent = 85,
            is_enabled = 1,
            speak_text_enabled = 1,
            updated_by_user_id = ?,
            updated_at = ?
        WHERE station_code = ?
      `).run(req.authUser!.id, nowIso, stationCode);

      const updatedSettings = loadStationSettings();
      broadcaster?.broadcastSystemEvent?.('audio_settings_updated', { settings: updatedSettings });
      logUserActivity(
        db,
        req.authUser!,
        'reset_station_audio',
        'station_audio',
        null,
        `إعادة ضبط الصوت الافتراضي لقناة ${stationCode}`
      );

      res.json({
        setting: updatedSettings.find((s) => s.station_code === stationCode),
        settings: updatedSettings,
      });
    }
  );

  // Dedicated permission-enforced endpoint for testing a station/event channel's audio
  app.post(
    '/api/audio/settings/:stationCode/test',
    requireAuth,
    requireAnyPermission('audio_test', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const stationCode = String(req.params.stationCode || '').trim() as StationCode;
      if (!ALL_STATION_CODES.includes(stationCode)) {
        return res.status(400).json({ error: 'رمز القناة الصوتية غير صالح' });
      }
      const setting = loadStationSettings().find((s) => s.station_code === stationCode);
      if (!setting) return res.status(404).json({ error: 'القناة الصوتية غير موجودة' });

      const resolvedUrl = setting.audio_file_url || setting.resolved_audio_file_url || null;
      if (setting.resolved_audio_file_id) {
        const fRow = db
          .prepare('SELECT stored_filename FROM audio_files WHERE id = ?')
          .get(setting.resolved_audio_file_id) as { stored_filename: string } | undefined;
        if (!fRow || !fs.existsSync(path.join(AUDIO_STORAGE_DIR, path.basename(fRow.stored_filename)))) {
          return res.status(404).json({ error: 'ملف الصوت المربوط غير موجود على وحدة التخزين' });
        }
      }

      res.json({
        ok: true,
        setting,
        test_stream_url: resolvedUrl ? `${resolvedUrl}?mode=test` : null,
      });
    }
  );

  // Arabic Human TTS Engine Status & Multi-Voice Synthesis Route (DB-Authoritative Voice Selection)
  app.get('/api/audio/tts-status', requireAuth, (_req, res) => {
    res.json({
      gemini_tts_configured: isGeminiTtsConfigured(),
      model: 'gemini-3.8-flash-lite-tts',
      fallback_models: ['gemini-3.8-flash-tts', 'gemini-3.8-live'],
      browser_fallback: 'disabled',
      prebuilt_voices: GEMINI_PREBUILT_VOICES,
    });
  });

  app.post('/api/audio/tts', requireAuth, async (req: AuthedRequest, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'النص المطلوب تحويله إلى صوت بشري مطلوب' });
    }

    const mode = req.body?.mode === 'preview' ? 'preview' : 'alert';
    const reqChannelCode = req.body?.channelCode ? String(req.body.channelCode).trim() : null;
    const reqDeptCode = req.body?.departmentCode
      ? String(req.body.departmentCode).trim()
      : req.authUser?.department_code || null;

    const effectiveChannelCode: VoiceReaderChannelCode | null =
      reqChannelCode && ALL_VOICE_READER_CHANNELS.includes(reqChannelCode as VoiceReaderChannelCode)
        ? (reqChannelCode as VoiceReaderChannelCode)
        : reqDeptCode === 'production' || reqDeptCode === 'assembly' || reqDeptCode === 'hall'
          ? (reqDeptCode as VoiceReaderChannelCode)
          : reqDeptCode
            ? 'general'
            : null;

    let voiceName: string | null = req.body?.voiceName ? String(req.body.voiceName).trim() : null;
    let stylePrompt: string | null = req.body?.stylePrompt ? String(req.body.stylePrompt).trim() : null;
    let resolvedVoiceId: number | null = req.body?.humanVoiceId ? Number(req.body.humanVoiceId) : null;
    let resolvedVoiceDisplayName: string | null = null;
    let voiceSource: 'channel_assigned' | 'system_default' | 'preview_explicit' = 'preview_explicit';

    if (mode !== 'preview' && effectiveChannelCode) {
      // Operational alerts MUST honor authoritative database settings without client drift
      const allReaders = loadVoiceReaderSettings();
      const chSetting =
        allReaders.find((s) => s.channel_code === effectiveChannelCode) ||
        allReaders.find((s) => s.channel_code === 'general') ||
        null;

      if (chSetting && !chSetting.is_enabled) {
        return res.status(200).json({
          available: false,
          fallback: 'disabled',
          reason: 'channel_disabled',
          message: `القراءة الصوتية متوقفة حالياً لقناة (${chSetting.channel_name_ar})`,
        });
      }

      if (chSetting) {
        if (chSetting.human_voice_id) {
          resolvedVoiceId = chSetting.human_voice_id;
          voiceSource = 'channel_assigned';
        } else if (chSetting.resolved_human_voice_id) {
          resolvedVoiceId = chSetting.resolved_human_voice_id;
          voiceSource = 'system_default';
        } else {
          return res.status(200).json({
            available: false,
            fallback: 'disabled',
            reason: 'missing_voice',
            message: `لم يقم مدير النظام بتعيين صوت لقناة (${chSetting.channel_name_ar})`,
          });
        }
      }
    }

    if (resolvedVoiceId) {
      const hvRow = db
        .prepare('SELECT id, display_name, voice_kind, prebuilt_voice_name, style_prompt FROM human_voices WHERE id = ?')
        .get(resolvedVoiceId) as
        | {
            id: number;
            display_name: string;
            voice_kind: string;
            prebuilt_voice_name: string | null;
            style_prompt: string | null;
          }
        | undefined;
      if (!hvRow) {
        return res.status(200).json({
          available: false,
          fallback: 'disabled',
          reason: 'missing_voice',
          message: 'الصوت البشري المعتمد في الإعدادات غير موجود في قاعدة البيانات',
        });
      }
      if (hvRow.voice_kind === 'browser_human') {
        return res.status(200).json({
          available: false,
          fallback: 'disabled',
          reason: 'browser_voice_disabled',
          message: 'القارئ الفوري للمتصفح متوقف نهائياً؛ يرجى اعتماد صوت بشري ذكي',
        });
      }
      resolvedVoiceDisplayName = hvRow.display_name;
      voiceName = hvRow.prebuilt_voice_name;
      stylePrompt = hvRow.style_prompt;
    }

    const result = await generateArabicTtsAudio(text, { voiceName, stylePrompt });
    if (result.ok) {
      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('X-TTS-Source', result.cached ? 'gemini_cache' : result.engine);
      res.setHeader('X-TTS-Engine', result.engine);
      res.setHeader('X-TTS-Voice', result.voiceName);
      res.setHeader('X-TTS-Voice-Source', voiceSource);
      if (resolvedVoiceId) res.setHeader('X-TTS-Voice-Id', String(resolvedVoiceId));
      if (resolvedVoiceDisplayName) {
        res.setHeader('X-TTS-Voice-Label', encodeURIComponent(resolvedVoiceDisplayName));
      }
      return res.send(result.audioBuffer);
    }

    return res.status(200).json({
      available: false,
      fallback: 'disabled',
      reason: result.reason,
      voiceName: voiceName || null,
      voiceLabel: resolvedVoiceDisplayName || null,
      message: result.message,
    });
  });

  // ---------------------------------------------------------------------------
  // Human Voice Library & Independent Voice Reader Settings (5 channels)
  // ---------------------------------------------------------------------------
  app.get('/api/audio/human-voices', requireAuth, (_req, res) => {
    res.json({
      voices: loadHumanVoicesList(),
      gemini_tts_configured: isGeminiTtsConfigured(),
      prebuilt_voices: GEMINI_PREBUILT_VOICES,
    });
  });

  app.post(
    '/api/audio/human-voices',
    requireAuth,
    requireAnyPermission('audio_add', 'audio_upload', 'manage_settings'),
    express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '15mb' }),
    (req: AuthedRequest, res) => {
      const voiceKindRaw = String(req.body?.voice_kind || 'ai_human').trim();
      if (voiceKindRaw === 'browser_human') {
        return res.status(400).json({
          error: 'تم إيقاف القارئ العربي الفوري (المتصفح) نهائياً؛ يرجى اختيار صوت بشري ذكي أو رفع تسجيل صوتي بشري',
        });
      }
      const voiceKind: VoiceKind =
        voiceKindRaw === 'recorded_human' ? 'recorded_human' : 'ai_human';
      const displayName = String(req.body?.display_name || '').trim();
      if (!displayName) {
        return res.status(400).json({ error: 'يرجى كتابة اسم واضح للصوت البشري' });
      }
      const description = String(req.body?.description || '').trim() || null;
      const gender = req.body?.gender === 'male' ? 'male' : 'female';
      const stylePrompt = String(req.body?.style_prompt || '').trim() || null;
      const nowIso = new Date().toISOString();

      let linkedFileId: number | null = null;
      let prebuiltVoiceName: string | null = null;

      if (voiceKind === 'ai_human') {
        const reqVoice = String(req.body?.prebuilt_voice_name || 'Kore').trim();
        if (!ALLOWED_GEMINI_PREBUILT_VOICES.has(reqVoice)) {
          return res.status(400).json({ error: 'الصوت الذكي المختار غير مدعوم' });
        }
        prebuiltVoiceName = reqVoice;
      } else if (voiceKind === 'recorded_human') {
        if (!hasAnyPermission(req.authUser!, 'audio_upload', 'audio_add', 'manage_settings')) {
          return res.status(403).json({ error: 'ليس لديك صلاحية رفع ملفات الأصوات البشرية' });
        }
        const parsed = parseAudioUploadPayload(req);
        if ('error' in parsed) {
          return res.status(400).json({ error: parsed.error });
        }
        const ext = path.extname(parsed.originalName).toLowerCase() || '.mp3';
        const storedFilename = `human-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        fs.mkdirSync(AUDIO_STORAGE_DIR, { recursive: true });
        fs.writeFileSync(path.join(AUDIO_STORAGE_DIR, storedFilename), parsed.buffer);

        const insFile = db
          .prepare(`
            INSERT INTO audio_files (
              original_name, display_name, stored_filename, mime_type, size_bytes,
              source_type, file_category, is_default, uploaded_by_user_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'upload', 'human_voice', 0, ?, ?, ?)
          `)
          .run(
            parsed.originalName,
            displayName,
            storedFilename,
            parsed.mimeType,
            parsed.buffer.length,
            req.authUser!.id,
            nowIso,
            nowIso
          );
        linkedFileId = Number(insFile.lastInsertRowid);
      }

      const voiceKey = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const insVoice = db
        .prepare(`
          INSERT INTO human_voices (
            voice_key, display_name, description, gender, voice_kind,
            prebuilt_voice_name, style_prompt, audio_file_id,
            is_favorite, is_default, is_system, created_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
        `)
        .run(
          voiceKey,
          displayName,
          description,
          gender,
          voiceKind,
          prebuiltVoiceName,
          stylePrompt,
          linkedFileId,
          req.body?.is_favorite ? 1 : 0,
          req.authUser!.id,
          nowIso,
          nowIso
        );

      const createdId = Number(insVoice.lastInsertRowid);
      const voices = loadHumanVoicesList();
      const created = voices.find((v) => v.id === createdId);
      broadcaster?.broadcastSystemEvent?.('human_voices_updated', { voices });
      logUserActivity(
        db,
        req.authUser!,
        'create_human_voice',
        'human_voice',
        createdId,
        `إضافة صوت بشري جديد (${voiceKind}): ${displayName}`
      );
      return res.status(201).json({ voice: created, voices });
    }
  );

  app.patch(
    '/api/audio/human-voices/:id',
    requireAuth,
    requireAnyPermission('audio_set_default', 'audio_assign', 'audio_delete', 'audio_add', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const voiceId = Number(req.params.id);
      const existing = db.prepare('SELECT * FROM human_voices WHERE id = ?').get(voiceId) as
        | Record<string, unknown>
        | undefined;
      if (!existing) return res.status(404).json({ error: 'الصوت البشري غير موجود' });

      const actor = req.authUser!;
      const body = req.body ?? {};
      const wantsDefault = body.is_default !== undefined;
      const wantsFavorite = body.is_favorite !== undefined;
      const wantsEdit =
        body.display_name !== undefined ||
        body.description !== undefined ||
        body.style_prompt !== undefined ||
        body.gender !== undefined ||
        body.prebuilt_voice_name !== undefined;

      if (wantsDefault && !hasAnyPermission(actor, 'audio_set_default', 'audio_assign', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعيين الصوت البشري الافتراضي' });
      }
      if (wantsFavorite && !hasAnyPermission(actor, 'audio_set_default', 'audio_assign', 'audio_add', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تفضيل الأصوات البشرية' });
      }
      if (wantsEdit && !hasAnyPermission(actor, 'audio_delete', 'audio_add', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية تعديل بيانات الصوت البشري' });
      }

      const nextName =
        body.display_name !== undefined
          ? String(body.display_name).trim() || String(existing.display_name)
          : String(existing.display_name);
      const nextDesc =
        body.description !== undefined ? String(body.description).trim() || null : (existing.description as string | null);
      const nextGender =
        body.gender !== undefined ? (body.gender === 'male' ? 'male' : 'female') : String(existing.gender);
      const nextStyle =
        body.style_prompt !== undefined
          ? String(body.style_prompt).trim() || null
          : (existing.style_prompt as string | null);

      let nextPrebuilt = existing.prebuilt_voice_name ? String(existing.prebuilt_voice_name) : null;
      if (body.prebuilt_voice_name !== undefined && existing.voice_kind === 'ai_human') {
        const candidate = String(body.prebuilt_voice_name).trim();
        if (!ALLOWED_GEMINI_PREBUILT_VOICES.has(candidate)) {
          return res.status(400).json({ error: 'الصوت الذكي المختار غير صالح' });
        }
        nextPrebuilt = candidate;
      }

      const nextFav = wantsFavorite ? (body.is_favorite ? 1 : 0) : Number(existing.is_favorite);
      const nextDef = wantsDefault ? (body.is_default ? 1 : 0) : Number(existing.is_default);
      const nowIso = new Date().toISOString();

      db.transaction(() => {
        if (wantsDefault && nextDef === 1) {
          db.prepare('UPDATE human_voices SET is_default = 0').run();
        }
        db.prepare(`
          UPDATE human_voices
          SET display_name = ?, description = ?, gender = ?, prebuilt_voice_name = ?,
              style_prompt = ?, is_favorite = ?, is_default = ?, updated_at = ?
          WHERE id = ?
        `).run(nextName, nextDesc, nextGender, nextPrebuilt, nextStyle, nextFav, nextDef, nowIso, voiceId);
      })();

      const voices = loadHumanVoicesList();
      const settings = loadVoiceReaderSettings();
      broadcaster?.broadcastSystemEvent?.('human_voices_updated', { voices });
      broadcaster?.broadcastSystemEvent?.('voice_reader_settings_updated', { settings });
      logUserActivity(
        db,
        actor,
        'update_human_voice',
        'human_voice',
        voiceId,
        `تحديث الصوت البشري (${nextName}) افتراضي=${nextDef === 1 ? 'نعم' : 'لا'} مفضل=${nextFav === 1 ? 'نعم' : 'لا'}`
      );
      return res.json({ voice: voices.find((v) => v.id === voiceId), voices, settings });
    }
  );

  app.post(
    '/api/audio/human-voices/:id/test',
    requireAuth,
    requireAnyPermission('audio_test', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const voiceId = Number(req.params.id);
      const voice = loadHumanVoicesList().find((v) => v.id === voiceId);
      if (!voice) return res.status(404).json({ error: 'الصوت البشري غير موجود' });
      const sampleText =
        String(req.body?.text || '').trim() ||
        'تنبيه، رسالة جديدة من إدارة الصالة إلى قسم التجميع، يرجى مراجعة البلاغ الوارد.';
      return res.json({
        ok: true,
        voice,
        sample_text: sampleText,
        gemini_tts_configured: isGeminiTtsConfigured(),
      });
    }
  );

  app.delete(
    '/api/audio/human-voices/:id',
    requireAuth,
    requireAnyPermission('audio_delete', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const voiceId = Number(req.params.id);
      const existing = db.prepare('SELECT * FROM human_voices WHERE id = ?').get(voiceId) as
        | { id: number; display_name: string; is_system: number; audio_file_id: number | null }
        | undefined;
      if (!existing) return res.status(404).json({ error: 'الصوت البشري غير موجود' });
      if (Number(existing.is_system) === 1) {
        return res.status(400).json({ error: 'لا يمكن حذف الأصوات الأساسية للنظام' });
      }

      const nowIso = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          'UPDATE voice_reader_settings SET human_voice_id = NULL, updated_by_user_id = ?, updated_at = ? WHERE human_voice_id = ?'
        ).run(req.authUser!.id, nowIso, voiceId);
        db.prepare('DELETE FROM human_voices WHERE id = ?').run(voiceId);
      })();

      const voices = loadHumanVoicesList();
      const settings = loadVoiceReaderSettings();
      broadcaster?.broadcastSystemEvent?.('human_voices_updated', { voices });
      broadcaster?.broadcastSystemEvent?.('voice_reader_settings_updated', { settings });
      logUserActivity(
        db,
        req.authUser!,
        'delete_human_voice',
        'human_voice',
        voiceId,
        `حذف الصوت البشري: ${existing.display_name}`
      );
      return res.json({ ok: true, voices, settings });
    }
  );

  app.get('/api/audio/voice-reader/settings', requireAuth, (_req, res) => {
    res.json({ settings: loadVoiceReaderSettings() });
  });

  app.put(
    '/api/audio/voice-reader/settings/:channelCode',
    requireAuth,
    requireAnyPermission('audio_assign', 'audio_volume', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const channelCode = String(req.params.channelCode || '').trim() as VoiceReaderChannelCode;
      if (!ALL_VOICE_READER_CHANNELS.includes(channelCode)) {
        return res.status(400).json({ error: 'رمز قناة قارئ البلاغات غير صالح' });
      }
      const currentRow = db
        .prepare('SELECT * FROM voice_reader_settings WHERE channel_code = ?')
        .get(channelCode) as Record<string, unknown> | undefined;
      if (!currentRow) return res.status(404).json({ error: 'قناة قراءة البلاغات غير موجودة' });

      const actor = req.authUser!;
      const body = req.body ?? {};
      const validRates = new Set<number>(PLAYBACK_RATE_OPTIONS);
      const rateNum =
        body.playback_rate !== undefined ? Number(body.playback_rate) : Number(currentRow.playback_rate || 1);
      if (!validRates.has(rateNum)) {
        return res.status(400).json({ error: 'سرعة القراءة غير صالحة (المسموح: 0.75x، 1x، 1.25x، 1.5x، 2x)' });
      }
      const volNum =
        body.volume_percent !== undefined
          ? Math.min(100, Math.max(0, Math.round(Number(body.volume_percent))))
          : Number(currentRow.volume_percent ?? 90);
      if (Number.isNaN(volNum)) {
        return res.status(400).json({ error: 'مستوى الصوت غير صالح' });
      }

      const currentVoiceId = currentRow.human_voice_id ? Number(currentRow.human_voice_id) : null;
      let resolvedVoiceId: number | null = currentVoiceId;
      if (body.human_voice_id !== undefined) {
        if (body.human_voice_id === null || body.human_voice_id === '') {
          resolvedVoiceId = null;
        } else {
          const vRow = db.prepare('SELECT id FROM human_voices WHERE id = ?').get(Number(body.human_voice_id)) as
            | { id: number }
            | undefined;
          if (!vRow) return res.status(400).json({ error: 'الصوت البشري المختار غير موجود' });
          resolvedVoiceId = vRow.id;
        }
      }

      const nextEnabled =
        body.is_enabled !== undefined ? (body.is_enabled === false ? 0 : 1) : Number(currentRow.is_enabled);
      const nextScope: VoiceReadScope =
        body.read_scope !== undefined
          ? body.read_scope === 'important_only'
            ? 'important_only'
            : 'all'
          : currentRow.read_scope === 'important_only'
            ? 'important_only'
            : 'all';
      const nextIncludeSender =
        body.include_sender_dept !== undefined
          ? body.include_sender_dept === false
            ? 0
            : 1
          : Number(currentRow.include_sender_dept ?? 1);

      const voiceChanged = resolvedVoiceId !== currentVoiceId;
      const paramsChanged =
        volNum !== Number(currentRow.volume_percent ?? 90) ||
        rateNum !== Number(currentRow.playback_rate || 1) ||
        nextEnabled !== Number(currentRow.is_enabled) ||
        nextScope !== String(currentRow.read_scope) ||
        nextIncludeSender !== Number(currentRow.include_sender_dept ?? 1);

      if (voiceChanged && !hasAnyPermission(actor, 'audio_assign', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية اختيار صوت قراءة البلاغات' });
      }
      if (paramsChanged && !hasAnyPermission(actor, 'audio_volume', 'audio_assign', 'manage_settings')) {
        return res.status(403).json({ error: 'ليس لديك صلاحية التحكم في إعدادات قراءة البلاغات' });
      }

      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE voice_reader_settings
        SET human_voice_id = ?, playback_rate = ?, volume_percent = ?,
            is_enabled = ?, read_scope = ?, include_sender_dept = ?,
            updated_by_user_id = ?, updated_at = ?
        WHERE channel_code = ?
      `).run(
        resolvedVoiceId,
        rateNum,
        volNum,
        nextEnabled,
        nextScope,
        nextIncludeSender,
        actor.id,
        nowIso,
        channelCode
      );

      const updatedSettings = loadVoiceReaderSettings();
      broadcaster?.broadcastSystemEvent?.('voice_reader_settings_updated', { settings: updatedSettings });
      logUserActivity(
        db,
        actor,
        'update_voice_reader',
        'voice_reader',
        null,
        `تحديث قارئ البلاغات (${channelCode}): صوت=${resolvedVoiceId ?? 'افتراضي'} سرعة=${rateNum}x مستوى=${volNum}% نطاق=${nextScope}`,
        {
          oldValue: {
            channel_code: channelCode,
            human_voice_id: currentVoiceId,
            playback_rate: currentRow.playback_rate,
            volume_percent: currentRow.volume_percent,
            read_scope: currentRow.read_scope,
          },
          newValue: {
            channel_code: channelCode,
            human_voice_id: resolvedVoiceId,
            playback_rate: rateNum,
            volume_percent: volNum,
            read_scope: nextScope,
          },
        }
      );

      return res.json({
        setting: updatedSettings.find((s) => s.channel_code === channelCode),
        settings: updatedSettings,
      });
    }
  );

  app.post(
    '/api/audio/voice-reader/apply-all',
    requireAuth,
    requireAnyPermission('audio_assign', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const rawVoiceId = req.body?.human_voice_id;
      let resolvedVoiceId: number | null = null;
      if (rawVoiceId !== null && rawVoiceId !== '' && rawVoiceId !== undefined) {
        const vRow = db.prepare('SELECT id FROM human_voices WHERE id = ?').get(Number(rawVoiceId)) as
          | { id: number }
          | undefined;
        if (!vRow) return res.status(400).json({ error: 'الصوت البشري المختار غير موجود' });
        resolvedVoiceId = vRow.id;
      }
      const nowIso = new Date().toISOString();
      db.prepare('UPDATE voice_reader_settings SET human_voice_id = ?, updated_by_user_id = ?, updated_at = ?').run(
        resolvedVoiceId,
        req.authUser!.id,
        nowIso
      );
      const updatedSettings = loadVoiceReaderSettings();
      broadcaster?.broadcastSystemEvent?.('voice_reader_settings_updated', { settings: updatedSettings });
      logUserActivity(
        db,
        req.authUser!,
        'apply_all_voice_reader',
        'voice_reader',
        null,
        `تطبيق الصوت البشري (${resolvedVoiceId ?? 'الافتراضي'}) على جميع قنوات قراءة البلاغات`
      );
      return res.json({ ok: true, settings: updatedSettings });
    }
  );

  app.post(
    '/api/audio/voice-reader/settings/:channelCode/test',
    requireAuth,
    requireAnyPermission('audio_test', 'manage_settings'),
    (req: AuthedRequest, res) => {
      const channelCode = String(req.params.channelCode || '').trim() as VoiceReaderChannelCode;
      if (!ALL_VOICE_READER_CHANNELS.includes(channelCode)) {
        return res.status(400).json({ error: 'رمز قناة قارئ البلاغات غير صالح' });
      }
      const setting = loadVoiceReaderSettings().find((s) => s.channel_code === channelCode);
      if (!setting) return res.status(404).json({ error: 'القناة غير موجودة' });
      return res.json({
        ok: true,
        setting,
        gemini_tts_configured: isGeminiTtsConfigured(),
      });
    }
  );

  // ---------------------------------------------------------------------------
  // Audio Alert Diagnostic Log API («سجل تشخيص التنبيهات الصوتية»)
  // ---------------------------------------------------------------------------
  app.post('/api/audio/diagnostics', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const body = req.body ?? {};
    const uid = String(body.client_diag_uid || '').trim();
    if (!uid) {
      return res.status(400).json({ error: 'client_diag_uid مطلوب لتوثيق التشخيص الصوتي' });
    }

    const allowedStatuses = new Set<PlaybackDiagnosticStatus>(['requested', 'started', 'completed', 'blocked', 'failed']);
    const statusRaw = String(body.playback_status || 'requested').trim() as PlaybackDiagnosticStatus;
    const playbackStatus: PlaybackDiagnosticStatus = allowedStatuses.has(statusRaw) ? statusRaw : 'requested';

    const nowIso = new Date().toISOString();
    const arrivedAt = body.alert_arrived_at ? String(body.alert_arrived_at) : nowIso;
    const isTestInt = user.is_test_account ? 1 : 0;

    const reqFlag = body.playback_requested ? 1 : 0;
    const startFlag = body.playback_started ? 1 : 0;
    const compFlag = body.playback_completed ? 1 : 0;

    db.prepare(`
      INSERT INTO audio_alert_diagnostics (
        client_diag_uid, notification_id, ticket_id, ticket_number, invoice_number,
        target_department, channel_code, selected_voice_id, selected_voice_name,
        selected_prebuilt_voice, selected_tone_name, event_type, spoken_text,
        alert_arrived_at, playback_requested, playback_started, playback_completed,
        playback_status, tts_engine, failure_reason, user_id, user_name, is_test,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_diag_uid) DO UPDATE SET
        selected_voice_id = COALESCE(excluded.selected_voice_id, audio_alert_diagnostics.selected_voice_id),
        selected_voice_name = COALESCE(excluded.selected_voice_name, audio_alert_diagnostics.selected_voice_name),
        selected_prebuilt_voice = COALESCE(excluded.selected_prebuilt_voice, audio_alert_diagnostics.selected_prebuilt_voice),
        selected_tone_name = COALESCE(excluded.selected_tone_name, audio_alert_diagnostics.selected_tone_name),
        playback_requested = MAX(audio_alert_diagnostics.playback_requested, excluded.playback_requested),
        playback_started = MAX(audio_alert_diagnostics.playback_started, excluded.playback_started),
        playback_completed = MAX(audio_alert_diagnostics.playback_completed, excluded.playback_completed),
        playback_status = CASE
          WHEN audio_alert_diagnostics.playback_status = 'completed' THEN 'completed'
          ELSE excluded.playback_status
        END,
        tts_engine = COALESCE(excluded.tts_engine, audio_alert_diagnostics.tts_engine),
        failure_reason = CASE
          WHEN excluded.playback_status = 'completed' THEN NULL
          ELSE COALESCE(excluded.failure_reason, audio_alert_diagnostics.failure_reason)
        END,
        updated_at = excluded.updated_at
    `).run(
      uid,
      body.notification_id ? Number(body.notification_id) : null,
      body.ticket_id ? Number(body.ticket_id) : null,
      body.ticket_number ? String(body.ticket_number) : null,
      body.invoice_number ? String(body.invoice_number) : null,
      body.target_department ? String(body.target_department) : user.department_code,
      body.channel_code ? String(body.channel_code) : null,
      body.selected_voice_id ? Number(body.selected_voice_id) : null,
      body.selected_voice_name ? String(body.selected_voice_name) : null,
      body.selected_prebuilt_voice ? String(body.selected_prebuilt_voice) : null,
      body.selected_tone_name ? String(body.selected_tone_name) : null,
      body.event_type ? String(body.event_type) : null,
      body.spoken_text ? String(body.spoken_text).slice(0, 600) : null,
      arrivedAt,
      reqFlag,
      startFlag,
      compFlag,
      playbackStatus,
      body.tts_engine ? String(body.tts_engine) : null,
      body.failure_reason ? String(body.failure_reason).slice(0, 400) : null,
      user.id,
      user.full_name,
      isTestInt,
      nowIso,
      nowIso
    );

    return res.status(201).json({ ok: true });
  });

  app.get(
    '/api/audio/diagnostics',
    requireAuth,
    requireAnyPermission(
      'manage_settings',
      'audio_test',
      'audio_assign',
      'audio_volume',
      'audio_set_default',
      'audio_add',
      'audio_upload',
      'audio_delete'
    ),
    (req: AuthedRequest, res) => {
      const isTestInt = req.authUser!.is_test_account ? 1 : 0;
      const dept = String(req.query.department || '').trim();
      const status = String(req.query.status || '').trim();
      const search = String(req.query.search || '').trim().toLowerCase();
      const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 80));

      const where: string[] = ['COALESCE(is_test, 0) = ?'];
      const params: unknown[] = [isTestInt];
      if (dept) {
        where.push('target_department = ?');
        params.push(dept);
      }
      if (status) {
        where.push('playback_status = ?');
        params.push(status);
      }

      const rows = db
        .prepare(`SELECT * FROM audio_alert_diagnostics WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
        .all(...params, limit) as Array<Record<string, unknown>>;

      let diagnostics: AudioDiagnosticRecord[] = rows.map((r) => ({
        id: Number(r.id),
        client_diag_uid: String(r.client_diag_uid),
        notification_id: r.notification_id ? Number(r.notification_id) : null,
        ticket_id: r.ticket_id ? Number(r.ticket_id) : null,
        ticket_number: r.ticket_number ? String(r.ticket_number) : null,
        invoice_number: r.invoice_number ? String(r.invoice_number) : null,
        target_department: r.target_department ? String(r.target_department) : null,
        channel_code: r.channel_code ? String(r.channel_code) : null,
        selected_voice_id: r.selected_voice_id ? Number(r.selected_voice_id) : null,
        selected_voice_name: r.selected_voice_name ? String(r.selected_voice_name) : null,
        selected_prebuilt_voice: r.selected_prebuilt_voice ? String(r.selected_prebuilt_voice) : null,
        selected_tone_name: r.selected_tone_name ? String(r.selected_tone_name) : null,
        event_type: r.event_type ? String(r.event_type) : null,
        spoken_text: r.spoken_text ? String(r.spoken_text) : null,
        alert_arrived_at: String(r.alert_arrived_at),
        playback_requested: Number(r.playback_requested) === 1,
        playback_started: Number(r.playback_started) === 1,
        playback_completed: Number(r.playback_completed) === 1,
        playback_status: String(r.playback_status) as PlaybackDiagnosticStatus,
        tts_engine: r.tts_engine ? String(r.tts_engine) : null,
        failure_reason: r.failure_reason ? String(r.failure_reason) : null,
        user_id: r.user_id ? Number(r.user_id) : null,
        user_name: r.user_name ? String(r.user_name) : null,
        is_test: Number(r.is_test) === 1,
        created_at: String(r.created_at),
        updated_at: String(r.updated_at),
      }));

      if (search) {
        diagnostics = diagnostics.filter(
          (d) =>
            (d.ticket_number || '').toLowerCase().includes(search) ||
            (d.invoice_number || '').toLowerCase().includes(search) ||
            (d.selected_voice_name || '').toLowerCase().includes(search) ||
            (d.failure_reason || '').toLowerCase().includes(search) ||
            (d.spoken_text || '').toLowerCase().includes(search)
        );
      }

      res.json({ diagnostics });
    }
  );

  // ============================================================================
  // Admin System Readiness, Integrity & Verified Backups API
  // ============================================================================
  const requireAdminOrSettings = (req: AuthedRequest, res: express.Response, next: express.NextFunction) => {
    const user = req.authUser!;
    if (user.role_code === 'admin' || user.permissions.includes('manage_settings')) {
      return next();
    }
    return res.status(403).json({ error: 'هذه الشاشة مخصصة لإدارة النظام فقط' });
  };

  const getAppVersion = (): string => {
    try {
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      return pkg.version || '1.0.0';
    } catch {
      return '1.0.0';
    }
  };

  app.get('/api/admin/system-readiness', requireAuth, requireAdminOrSettings, (_req: AuthedRequest, res) => {
    const nowIso = new Date().toISOString();
    const uptimeSeconds = Math.round(process.uptime());
    const stats = options?.getServerStats?.() ?? { startedAt: appStartedAt, connectedUsers: [] };

    let integrityCheck = 'unknown';
    let dbOk = false;
    try {
      const qc = db.pragma('quick_check(1)') as Array<Record<string, unknown>>;
      integrityCheck = qc?.[0] ? String(Object.values(qc[0])[0] || '') : 'unknown';
      dbOk = integrityCheck.toLowerCase() === 'ok';
    } catch (err) {
      integrityCheck = err instanceof Error ? err.message : String(err);
      dbOk = false;
    }

    const dbFilePath = backupManager.dbFilePath;
    const dbFileExists = dbFilePath !== ':memory:' && fs.existsSync(dbFilePath);
    const dbSizeBytes = dbFileExists ? fs.statSync(dbFilePath).size : 0;

    const scalar = (sql: string): number => {
      const row = db.prepare(sql).get() as { c: number } | undefined;
      return Number(row?.c || 0);
    };

    const counts = {
      users_active: scalar("SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id WHERE u.is_active = 1 AND r.code != 'waiter' AND COALESCE(u.is_test_account, 0) = 0"),
      test_accounts: scalar("SELECT COUNT(*) AS c FROM users WHERE COALESCE(is_test_account, 0) = 1"),
      production_tickets: scalar("SELECT COUNT(*) AS c FROM tickets WHERE COALESCE(is_test, 0) = 0"),
      isolated_test_tickets: scalar("SELECT COUNT(*) AS c FROM tickets WHERE COALESCE(is_test, 0) = 1"),
      audio_files: scalar("SELECT COUNT(*) AS c FROM audio_files"),
      human_voices: scalar("SELECT COUNT(*) AS c FROM human_voices"),
      audit_logs: scalar("SELECT COUNT(*) AS c FROM user_activity_logs"),
    };

    const prodTickets = fetchTicketSummaries(db, { isTest: false });
    const openProd = prodTickets.filter((t) => t.status !== 'closed');
    const responseTimes = prodTickets
      .filter((t) => t.received_at)
      .map((t) => Math.max(0, Math.round((new Date(t.received_at!).getTime() - new Date(t.created_at).getTime()) / 60000)));
    const avgResponse = responseTimes.length
      ? Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) * 10) / 10
      : 0;

    const backups = backupManager.listBackups();
    const verifiedBackups = backups.filter((b) => b.integrity_status === 'verified' && b.file_exists);
    const latestBackup = backups[0] || null;

    const isCloudRunContainer = Boolean(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB);
    const hasExternalBackupDir = Boolean(process.env.BACKUP_DIR);

    const report: SystemReadinessReport = {
      generated_at: nowIso,
      server: {
        status: dbOk ? 'ok' : 'degraded',
        version: getAppVersion(),
        node_env: process.env.NODE_ENV || 'development',
        started_at: stats.startedAt,
        uptime_seconds: uptimeSeconds,
        timezone: 'Asia/Aden',
        persistence_mode: isCloudRunContainer && !hasExternalBackupDir ? 'ephemeral_container_fs' : 'local_disk',
        persistence_notice:
          isCloudRunContainer && !hasExternalBackupDir
            ? 'يعمل التطبيق حالياً على حاوية Cloud Run بنظام ملفات محلي مؤقت؛ النسخ الاحتياطية على القرص متاحة للتحميل الفوري ويجب ربط وحدة تخزين دائمة أو قاعدة سحابية/ملف Docker للإنتاج طويل الأمد.'
            : 'التخزين المحلي مفعل وقاعدة البيانات والنسخ الاحتياطية محفوظة في المسار الدائم المحدد.',
      },
      database: {
        engine: 'SQLite (better-sqlite3)',
        path: dbFilePath,
        size_bytes: dbSizeBytes,
        integrity_check: integrityCheck,
        counts,
      },
      websocket: {
        connected_clients: stats.connectedUsers.length,
        connected_departments: Array.from(new Set(stats.connectedUsers.map((u) => u.department_code))),
        connected_users: stats.connectedUsers.map((u) => ({
          user_id: u.user_id,
          username: u.username,
          full_name: u.full_name,
          department_code: u.department_code,
        })),
      },
      tickets_health: {
        new_unopened: openProd.filter((t) => !t.first_read_at && !t.received_at).length,
        read_awaiting_receipt: openProd.filter((t) => Boolean(t.first_read_at) && !t.received_at).length,
        unreceived: openProd.filter((t) => !t.received_at).length,
        in_progress: openProd.filter((t) => ['received', 'in_progress', 'awaiting_other_dept', 'action_taken_awaiting_confirm', 'arrived_assembly', 'ready_for_hall', 'reopened'].includes(t.status)).length,
        overdue_unreceived: openProd.filter((t) => t.is_overdue_unreceived).length,
        escalated_open: openProd.filter((t) => t.escalation_level > 0).length,
        closed_total: prodTickets.filter((t) => t.status === 'closed').length,
        avg_response_minutes: avgResponse,
      },
      audio_status: {
        gemini_tts_configured: isGeminiTtsConfigured(),
        browser_fallback_enabled: false,
        station_settings: loadStationSettings(),
        voice_reader_settings: loadVoiceReaderSettings(),
      },
      backups: {
        backup_dir: backupManager.backupDir,
        mirror_dir: backupManager.mirrorDir,
        total_count: backups.length,
        verified_count: verifiedBackups.length,
        last_backup: latestBackup,
      },
    };

    res.json(report);
  });

  app.get('/api/admin/backups', requireAuth, requireAdminOrSettings, (_req, res) => {
    res.json({
      backup_dir: backupManager.backupDir,
      mirror_dir: backupManager.mirrorDir,
      backups: backupManager.listBackups(),
    });
  });

  app.post('/api/admin/backups', requireAuth, requireAdminOrSettings, async (req: AuthedRequest, res) => {
    try {
      const reason = String(req.body?.reason || '').trim() || 'نسخة احتياطية يدوية موثقة من لوحة الجاهزية';
      const record = await backupManager.createVerifiedBackup(db, {
        trigger_type: 'manual',
        reason,
        created_by_user_id: req.authUser!.id,
        created_by_name: req.authUser!.full_name,
      });
      logUserActivity(
        db,
        req.authUser!,
        'create_backup',
        'backup',
        null,
        `إنشاء نسخة احتياطية موثقة: ${record.filename} (${record.size_bytes} بايت)`,
        { newValue: { id: record.id, sha256: record.sha256, integrity_status: record.integrity_status } }
      );
      res.status(201).json({ backup: record, backups: backupManager.listBackups() });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'تعذر إنشاء النسخة الاحتياطية',
      });
    }
  });

  app.post('/api/admin/backups/:id/verify', requireAuth, requireAdminOrSettings, (req: AuthedRequest, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const { record, verification } = backupManager.verifyBackupById(id);
      logUserActivity(
        db,
        req.authUser!,
        'verify_backup',
        'backup',
        null,
        `فحص سلامة النسخة ${record.filename}: ${verification.integrity_status}`,
        { status: verification.ok ? 'success' : 'failed', newValue: verification }
      );
      res.json({ record, verification, backups: backupManager.listBackups() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'تعذر فحص النسخة الاحتياطية' });
    }
  });

  app.get('/api/admin/backups/:id/download', requireAuth, requireAdminOrSettings, (req: AuthedRequest, res) => {
    const id = String(req.params.id || '').trim();
    const rec = backupManager.getBackupById(id);
    if (!rec) return res.status(404).json({ error: 'سجل النسخة الاحتياطية غير موجود' });
    const filePath = backupManager.resolveExistingBackupPath(rec);
    if (!filePath) return res.status(404).json({ error: 'ملف النسخة الاحتياطية غير موجود على القرص' });
    logUserActivity(db, req.authUser!, 'download_backup', 'backup', null, `تنزيل النسخة الاحتياطية: ${rec.filename}`);
    return res.download(filePath, rec.filename);
  });

  app.post('/api/admin/backups/:id/restore', requireAuth, async (req: AuthedRequest, res) => {
    const actor = req.authUser!;
    if (actor.role_code !== 'admin') {
      return res.status(403).json({ error: 'صلاحية استعادة قاعدة البيانات محصورة على مدير النظام فقط' });
    }
    if (req.body?.confirm_restore !== true) {
      return res.status(400).json({ error: 'يجب تأكيد عملية الاستعادة بشكل صريح قبل التنفيذ' });
    }
    if (!options?.replaceDatabase) {
      return res.status(503).json({ error: 'تبديل قاعدة البيانات الحية غير متاح في هذه البيئة' });
    }

    const id = String(req.params.id || '').trim();
    try {
      const outcome = await backupManager.restoreVerifiedBackup(db, id, {
        actorUserId: actor.id,
        actorName: actor.full_name,
        replaceLiveDatabase: options.replaceDatabase,
      });
      logUserActivity(
        db,
        actor,
        'restore_backup',
        'backup',
        null,
        `استعادة قاعدة البيانات من النسخة ${outcome.restoredRecord.filename} (مع حفظ نسخة أمان قبلية ${outcome.preRestoreBackup.filename})`,
        {
          newValue: {
            restored_id: outcome.restoredRecord.id,
            pre_restore_id: outcome.preRestoreBackup.id,
            sha256: outcome.verification.sha256,
          },
        }
      );
      broadcaster?.broadcastSystemEvent?.('system_restored', {
        restored_backup: outcome.restoredRecord,
        actor_name: actor.full_name,
      });
      return res.json({
        ok: true,
        restored_record: outcome.restoredRecord,
        pre_restore_backup: outcome.preRestoreBackup,
        verification: outcome.verification,
        backups: backupManager.listBackups(),
      });
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'تعذر استعادة النسخة الاحتياطية',
      });
    }
  });

  // Validate any uploaded/staged SQLite path helper export check (for diagnostics)
  void verifyDatabaseFile;

  return app;
}
