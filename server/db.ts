import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';

export function allocateNextTrackingNumber(db: Database.Database): string {
  const row = db
    .prepare("UPDATE tracking_sequence SET last_value = last_value + 1 WHERE seq_name = 'ticket' RETURNING last_value")
    .get() as { last_value: number } | undefined;

  if (row) {
    return `TRK-${String(row.last_value).padStart(6, '0')}`;
  }

  db.prepare("INSERT OR IGNORE INTO tracking_sequence (seq_name, last_value) VALUES ('ticket', 1)").run();
  const inserted = db
    .prepare("SELECT last_value FROM tracking_sequence WHERE seq_name = 'ticket'")
    .get() as { last_value: number };
  return `TRK-${String(inserted.last_value).padStart(6, '0')}`;
}

function openSafeDatabase(targetPath: string): Database.Database {
  const db = new Database(targetPath);
  db.pragma('foreign_keys = ON');
  if (targetPath !== ':memory:') {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = NORMAL');
  }
  const qc = db.pragma('quick_check(1)') as Array<Record<string, unknown>>;
  const firstResult = qc?.[0] ? String(Object.values(qc[0])[0] || '').toLowerCase() : '';
  if (firstResult && firstResult !== 'ok') {
    throw Object.assign(new Error(`SQLite quick_check failed: ${firstResult}`), { code: 'SQLITE_CORRUPT' });
  }
  return db;
}

export function createDatabase(dbFilePath?: string): Database.Database {
  const targetPath = dbFilePath ?? path.resolve(process.cwd(), 'data', 'yemeni_taste.db');
  if (targetPath !== ':memory:') {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }

  let db: Database.Database;
  try {
    db = openSafeDatabase(targetPath);
  } catch (err) {
    if (targetPath === ':memory:') throw err;
    console.warn('Recovering corrupted SQLite database file cleanly:', (err as Error).message);
    const stamp = Date.now();
    try {
      if (fs.existsSync(targetPath)) {
        fs.renameSync(targetPath, `${targetPath}.corrupt-${stamp}`);
      }
    } catch {
      try {
        fs.unlinkSync(targetPath);
      } catch {
        // ignore
      }
    }
    for (const sidecar of [`${targetPath}-wal`, `${targetPath}-shm`, `${targetPath}-journal`]) {
      try {
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
      } catch {
        // ignore
      }
    }
    db = openSafeDatabase(targetPath);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracking_sequence (
      seq_name TEXT PRIMARY KEY,
      last_value INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name_ar TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name_ar TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name_ar TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      email TEXT,
      password_hash TEXT NOT NULL,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      department_id INTEGER NOT NULL REFERENCES departments(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      granted INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT NOT NULL UNIQUE,
      client_request_id TEXT UNIQUE,
      invoice_number TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      urgency_level TEXT NOT NULL DEFAULT 'normal',
      ticket_kind TEXT NOT NULL DEFAULT 'stall',
      problem_description TEXT NOT NULL,
      target_department TEXT NOT NULL,
      sender_department TEXT NOT NULL,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id),
      assigned_waiter_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'new',
      created_via_support INTEGER NOT NULL DEFAULT 0,
      parent_ticket_id INTEGER REFERENCES tickets(id),
      escalation_level INTEGER NOT NULL DEFAULT 0,
      last_escalated_at TEXT,
      received_at TEXT,
      received_by_user_id INTEGER REFERENCES users(id),
      processing_started_at TEXT,
      prepared_at TEXT,
      action_taken_at TEXT,
      dispatched_to_hall_at TEXT,
      hall_received_at TEXT,
      hall_received_by_user_id INTEGER REFERENCES users(id),
      backlog_orders_count INTEGER NOT NULL DEFAULT 1,
      backlog_invoices TEXT,
      waiter_received_at TEXT,
      waiter_delivered_at TEXT,
      closed_at TEXT,
      closed_by_user_id INTEGER REFERENCES users(id),
      reopened_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_invoice ON tickets(invoice_number);
    CREATE INDEX IF NOT EXISTS idx_tickets_number ON tickets(ticket_number);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_target ON tickets(target_department);

    CREATE TABLE IF NOT EXISTS ticket_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      expected_qty INTEGER,
      delivered_qty INTEGER,
      issue_note TEXT,
      arrival_confirmed INTEGER NOT NULL DEFAULT 0,
      arrival_confirmed_by INTEGER REFERENCES users(id),
      arrival_confirmed_at TEXT,
      order_completed INTEGER NOT NULL DEFAULT 0,
      order_completed_by INTEGER REFERENCES users(id),
      order_completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ticket_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      sender_department TEXT,
      recipient_department TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS department_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
      tracking_number TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'general',
      canned_status_code INTEGER,
      sender_department TEXT NOT NULL,
      recipient_department TEXT NOT NULL,
      sender_user_id INTEGER NOT NULL REFERENCES users(id),
      message_body TEXT NOT NULL,
      notes TEXT,
      parent_message_id INTEGER REFERENCES department_messages(id),
      sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      sent_status TEXT NOT NULL DEFAULT 'sent',
      received_at TEXT,
      received_by_user_id INTEGER REFERENCES users(id),
      read_at TEXT,
      read_by_user_id INTEGER REFERENCES users(id),
      client_request_id TEXT UNIQUE
    );

    CREATE INDEX IF NOT EXISTS idx_dept_msg_trk ON department_messages(tracking_number);
    CREATE INDEX IF NOT EXISTS idx_dept_msg_ticket ON department_messages(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_dept_msg_depts ON department_messages(sender_department, recipient_department);

    CREATE TABLE IF NOT EXISTS ticket_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      action_type TEXT NOT NULL,
      action_note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      from_department TEXT NOT NULL,
      to_department TEXT NOT NULL,
      transferred_by_user_id INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      actor_user_id INTEGER NOT NULL REFERENCES users(id),
      actor_name TEXT NOT NULL,
      actor_department TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS receipt_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      confirmation_type TEXT NOT NULL,
      confirmed_by_user_id INTEGER NOT NULL REFERENCES users(id),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS resolution_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      confirmed_by_user_id INTEGER NOT NULL REFERENCES users(id),
      verification_type TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      event_type TEXT NOT NULL,
      target_department TEXT,
      sender_department_code TEXT,
      message_uid TEXT,
      should_play_audio INTEGER NOT NULL DEFAULT 0,
      spoken_text TEXT,
      urgency_level TEXT DEFAULT 'normal',
      delivered_at TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS audio_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL,
      stored_filename TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      file_category TEXT NOT NULL DEFAULT 'alert_tone',
      uploaded_by_user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS station_audio_settings (
      station_code TEXT PRIMARY KEY,
      station_name_ar TEXT NOT NULL,
      audio_file_id INTEGER REFERENCES audio_files(id) ON DELETE SET NULL,
      playback_rate REAL NOT NULL DEFAULT 1.0,
      volume_percent INTEGER NOT NULL DEFAULT 85,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      speak_text_enabled INTEGER NOT NULL DEFAULT 1,
      updated_by_user_id INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS human_voices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      voice_key TEXT UNIQUE,
      display_name TEXT NOT NULL,
      description TEXT,
      gender TEXT NOT NULL DEFAULT 'female',
      voice_kind TEXT NOT NULL DEFAULT 'ai_human',
      prebuilt_voice_name TEXT,
      style_prompt TEXT,
      audio_file_id INTEGER REFERENCES audio_files(id) ON DELETE CASCADE,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      created_by_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS voice_reader_settings (
      channel_code TEXT PRIMARY KEY,
      channel_name_ar TEXT NOT NULL,
      human_voice_id INTEGER REFERENCES human_voices(id) ON DELETE SET NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      playback_rate REAL NOT NULL DEFAULT 1.0,
      volume_percent INTEGER NOT NULL DEFAULT 90,
      read_scope TEXT NOT NULL DEFAULT 'all',
      include_sender_dept INTEGER NOT NULL DEFAULT 1,
      updated_by_user_id INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS escalation_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      first_warning_minutes INTEGER NOT NULL DEFAULT 5,
      escalation_start_minutes INTEGER NOT NULL DEFAULT 10,
      escalation_target_role TEXT NOT NULL DEFAULT 'admin',
      repeat_interval_minutes INTEGER NOT NULL DEFAULT 5,
      max_escalations INTEGER NOT NULL DEFAULT 3,
      updated_by_user_id INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS user_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      username TEXT NOT NULL,
      actor_name TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id INTEGER,
      old_value TEXT,
      new_value TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS responsible_assignments (
      role_key TEXT PRIMARY KEY,
      role_title_ar TEXT NOT NULL,
      assigned_person_name TEXT NOT NULL,
      updated_by_user_id INTEGER REFERENCES users(id),
      updated_by_name TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      user_name TEXT NOT NULL,
      department_code TEXT NOT NULL,
      department_name_ar TEXT NOT NULL,
      read_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ticket_reads_ticket ON ticket_reads(ticket_id, read_at);

    CREATE TABLE IF NOT EXISTS backup_logs (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mirror_path TEXT,
      trigger_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      integrity_status TEXT NOT NULL,
      integrity_detail TEXT NOT NULL,
      table_counts_json TEXT NOT NULL,
      created_by_user_id INTEGER REFERENCES users(id),
      created_by_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  seedInitialData(db);
  runSchemaMigrations(db);
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const GRANULAR_PERMISSION_DEFS: Array<[string, string, string]> = [
  ['manage_responsibles', 'تعديل أسماء المسؤولين وتغيير المكلفين', 'صلاحية تعديل أسماء المسؤولين والمكلفين دون المساس بحسابات الدخول'],
  ['manage_roles', 'إدارة الأدوار والمسميات الوظيفية', 'صلاحية إدارة الأدوار والصلاحيات الوظيفية'],
  ['manage_stall_threshold', 'إدارة مدة تعثر الطلبات', 'صلاحية تحديد وتعديل مدة اعتبار الطلب متعثراً'],
  ['manage_escalation_timing', 'إدارة زمن التصعيد التلقائي', 'صلاحية تحديد وتعديل أزمنة التصعيد التلقائي والتكرار'],
  ['audio_add', 'إضافة أصوات جديدة', 'صلاحية إضافة أصوات جديدة وتوليد الصوت الذكي'],
  ['audio_upload', 'رفع ملفات صوتية', 'صلاحية رفع ملفات صوتية من الجهاز'],
  ['audio_test', 'تجربة الأصوات', 'صلاحية تجربة ومقارنة الأصوات داخل المكتبة'],
  ['audio_set_default', 'اختيار الصوت الافتراضي', 'صلاحية تعيين الصوت الافتراضي للنظام'],
  ['audio_assign', 'تخصيص الأصوات للأقسام والتنبيهات', 'صلاحية ربط الأصوات بالأقسام والفعاليات المختلفة'],
  ['audio_delete', 'حذف الأصوات وتعديلها', 'صلاحية تعديل واستبدال وحذف الملفات الصوتية'],
  ['audio_volume', 'التحكم في مستوى الصوت وإعداداته', 'صلاحية تعديل مستوى الصوت والسرعة والتفعيل'],
];

function runSchemaMigrations(db: Database.Database) {
  // Non-destructive column additions for existing databases
  ensureColumn(db, 'users', 'is_test_account', 'INTEGER NOT NULL DEFAULT 0');

  ensureColumn(db, 'tickets', 'urgency_level', "TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(db, 'tickets', 'ticket_kind', "TEXT NOT NULL DEFAULT 'stall'");
  ensureColumn(db, 'tickets', 'delivered_to_dept_at', 'TEXT');
  ensureColumn(db, 'tickets', 'delivered_to_dept_via', 'TEXT');
  ensureColumn(db, 'tickets', 'first_read_at', 'TEXT');
  ensureColumn(db, 'tickets', 'first_read_by_user_id', 'INTEGER REFERENCES users(id)');
  ensureColumn(db, 'tickets', 'first_read_department', 'TEXT');
  ensureColumn(db, 'tickets', 'unreceived_reminder_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tickets', 'last_reminder_at', 'TEXT');
  ensureColumn(db, 'tickets', 'is_test', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tickets', 'processing_started_at', 'TEXT');
  ensureColumn(db, 'tickets', 'prepared_at', 'TEXT');
  ensureColumn(db, 'tickets', 'dispatched_to_hall_at', 'TEXT');
  ensureColumn(db, 'tickets', 'hall_received_at', 'TEXT');
  ensureColumn(db, 'tickets', 'hall_received_by_user_id', 'INTEGER REFERENCES users(id)');
  ensureColumn(db, 'tickets', 'backlog_orders_count', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'tickets', 'backlog_invoices', 'TEXT');

  ensureColumn(db, 'ticket_replies', 'sender_department', 'TEXT');
  ensureColumn(db, 'ticket_replies', 'recipient_department', 'TEXT');
  ensureColumn(db, 'ticket_replies', 'client_request_id', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_replies_client_req ON ticket_replies(client_request_id) WHERE client_request_id IS NOT NULL;');

  ensureColumn(db, 'ticket_actions', 'client_request_id', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_actions_client_req ON ticket_actions(client_request_id) WHERE client_request_id IS NOT NULL;');

  ensureColumn(db, 'department_messages', 'is_test', 'INTEGER NOT NULL DEFAULT 0');

  ensureColumn(db, 'notifications', 'target_department', 'TEXT');
  ensureColumn(db, 'notifications', 'sender_department_code', 'TEXT');
  ensureColumn(db, 'notifications', 'message_uid', 'TEXT');
  ensureColumn(db, 'notifications', 'should_play_audio', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'notifications', 'spoken_text', 'TEXT');
  ensureColumn(db, 'notifications', 'urgency_level', "TEXT DEFAULT 'normal'");
  ensureColumn(db, 'notifications', 'delivered_at', 'TEXT');
  ensureColumn(db, 'notifications', 'read_at', 'TEXT');
  ensureColumn(db, 'notifications', 'is_test', 'INTEGER NOT NULL DEFAULT 0');

  ensureColumn(db, 'audio_files', 'display_name', 'TEXT');
  ensureColumn(db, 'audio_files', 'source_type', "TEXT NOT NULL DEFAULT 'upload'");
  ensureColumn(db, 'audio_files', 'file_category', "TEXT NOT NULL DEFAULT 'alert_tone'");
  ensureColumn(db, 'audio_files', 'is_default', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'audio_files', 'updated_at', 'TEXT');
  db.exec(`UPDATE audio_files SET display_name = original_name WHERE display_name IS NULL OR TRIM(display_name) = '';`);

  ensureColumn(db, 'user_activity_logs', 'actor_name', 'TEXT');
  ensureColumn(db, 'user_activity_logs', 'department_code', 'TEXT');
  ensureColumn(db, 'user_activity_logs', 'department_name_ar', 'TEXT');
  ensureColumn(db, 'user_activity_logs', 'status', "TEXT NOT NULL DEFAULT 'success'");
  ensureColumn(db, 'user_activity_logs', 'is_test', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'user_activity_logs', 'old_value', 'TEXT');
  ensureColumn(db, 'user_activity_logs', 'new_value', 'TEXT');

  // Enforce strict immutability on user_activity_logs at database engine level
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS prevent_audit_log_delete
    BEFORE DELETE ON user_activity_logs
    BEGIN
      SELECT RAISE(ABORT, 'Audit logs are immutable and cannot be deleted');
    END;

    CREATE TRIGGER IF NOT EXISTS prevent_audit_log_update
    BEFORE UPDATE ON user_activity_logs
    BEGIN
      SELECT RAISE(ABORT, 'Audit logs are immutable and cannot be modified');
    END;
  `);

  // Ensure atomic tracking_sequence initialized cleanly at max existing TRK suffix
  const maxTrkRow = db
    .prepare(
      "SELECT COALESCE(MAX(CAST(SUBSTR(ticket_number, 5) AS INTEGER)), 0) AS max_seq FROM tickets WHERE ticket_number LIKE 'TRK-%'"
    )
    .get() as { max_seq: number };
  db.prepare("INSERT OR IGNORE INTO tracking_sequence (seq_name, last_value) VALUES ('ticket', ?)").run(
    Math.max(0, Number(maxTrkRow.max_seq) || 0)
  );
  db.prepare(
    "UPDATE tracking_sequence SET last_value = MAX(last_value, ?) WHERE seq_name = 'ticket'"
  ).run(Math.max(0, Number(maxTrkRow.max_seq) || 0));

  // Ensure new index on ticket_number exists on upgraded DBs
  db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_number ON tickets(ticket_number);');

  // Seed all 6 independent station & event audio channels cleanly
  const insertStation = db.prepare(`
    INSERT OR IGNORE INTO station_audio_settings (
      station_code, station_name_ar, audio_file_id, playback_rate, volume_percent, is_enabled, speak_text_enabled
    ) VALUES (?, ?, NULL, 1.0, 85, 1, 1)
  `);
  const stationChannels: Array<[string, string]> = [
    ['production', 'صوت تنبيهات قسم الإنتاج'],
    ['assembly', 'صوت تنبيهات قسم التجميع والتسليم'],
    ['hall', 'صوت تنبيهات مسؤول الصالة'],
    ['delayed_critical', 'صوت التنبيهات الحرجة والطلبات المتعثرة'],
    ['escalation', 'صوت التصعيد التلقائي'],
    ['general', 'صوت الإشعارات العامة'],
  ];
  for (const [code, label] of stationChannels) {
    insertStation.run(code, label);
    db.prepare('UPDATE station_audio_settings SET station_name_ar = ? WHERE station_code = ?').run(label, code);
  }

  // Seed natural Arabic human voices library idempotently (never confuses chimes with human voices)
  const existingVoiceCount = (db.prepare('SELECT COUNT(*) as c FROM human_voices').get() as { c: number }).c;
  if (existingVoiceCount === 0) {
    const insertVoice = db.prepare(`
      INSERT OR IGNORE INTO human_voices (
        voice_key, display_name, description, gender, voice_kind,
        prebuilt_voice_name, style_prompt, audio_file_id, is_favorite, is_default, is_system
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)
    `);
    const builtInVoices: Array<[string, string, string, string, string, string | null, string, number, number]> = [
      [
        'gemini-kore',
        'نورة — صوت نسائي رسمي واضح',
        'نبرة واضحة ومتزنة لقراءة البلاغات اليومية في الأقسام التشغيلية',
        'female',
        'ai_human',
        'Kore',
        'اقرأ البلاغ بالعربية الفصحى الواضحة بنبرة تشغيلية هادئة ومفهومة مع نطق الأرقام وأسماء الأقسام بدقة.',
        1,
        1,
      ],
      [
        'gemini-charon',
        'سلمان — صوت رجالي جهوري متزن',
        'نبرة رجالية واضحة وحازمة مناسبة لمطبخ الإنتاج ومتابعة التنفيذ',
        'male',
        'ai_human',
        'Charon',
        'اقرأ البلاغ بالعربية الفصحى بصوت رجالي جهوري واضح ومرتب دون تسرع.',
        1,
        0,
      ],
      [
        'gemini-aoede',
        'سارة — صوت نسائي هادئ وسلس',
        'صوت ناعم وواضح مناسب لإدارة الصالة وتنسيق التسليم',
        'female',
        'ai_human',
        'Aoede',
        'اقرأ الرسالة بالعربية بنبرة مهذبة وواضحة ومريحة للأذن.',
        0,
        0,
      ],
      [
        'gemini-fenrir',
        'طارق — صوت رجالي حازم للتنبيهات',
        'نبرة سريعة الانتباه مثالية للتنبيهات العاجلة والتصعيدات الحرجة',
        'male',
        'ai_human',
        'Fenrir',
        'اقرأ التنبيه بالعربية بنبرة حازمة وجادة تُبرز أهمية البلاغ.',
        0,
        0,
      ],
      [
        'gemini-puck',
        'راشد — صوت رجالي نشيط وسريع',
        'صوت عملي خفيف ومناسب لقراءة الرسائل القصيرة السريعة في التجميع',
        'male',
        'ai_human',
        'Puck',
        'اقرأ البلاغ بالعربية بنشاط ووضوح تام دون بتر الكلمات.',
        0,
        0,
      ],
      [
        'gemini-orus',
        'فيصل — صوت رجالي عميق رسمي',
        'صوت رسمي عميق مخصص للتقارير التنفيذية وإشعارات التصعيد الإداري',
        'male',
        'ai_human',
        'Orus',
        'اقرأ الإشعار بالعربية الفصحى الرسمية برزانة ووقار.',
        0,
        0,
      ],
      [
        'gemini-leda',
        'ليلى — صوت نسائي دافئ وواضح',
        'صوت عربي مألوف لقراءة الاستفسارات والردود بين الأقسام',
        'female',
        'ai_human',
        'Leda',
        'اقرأ الرد بالعربية بوضوح تام وسلاسة في وصل الجمل.',
        0,
        0,
      ],
    ];
    for (const v of builtInVoices) {
      insertVoice.run(...v);
    }
  }

  // Stop & remove Browser instant Arabic reader ('browser_human') due to inaccurate Arabic name pronunciation
  db.prepare(`
    UPDATE voice_reader_settings
    SET human_voice_id = NULL
    WHERE human_voice_id IN (SELECT id FROM human_voices WHERE voice_kind = 'browser_human')
  `).run();
  db.prepare(
    "DELETE FROM human_voices WHERE voice_kind = 'browser_human' OR voice_key = 'browser-arabic-fallback'"
  ).run();

  // Ensure all 5 independent Voice Reader channels exist
  const defaultHumanVoice = db
    .prepare('SELECT id FROM human_voices WHERE is_default = 1 ORDER BY id ASC LIMIT 1')
    .get() as { id: number } | undefined;
  const insertReader = db.prepare(`
    INSERT OR IGNORE INTO voice_reader_settings (
      channel_code, channel_name_ar, human_voice_id, is_enabled, playback_rate, volume_percent, read_scope, include_sender_dept
    ) VALUES (?, ?, ?, 1, 1.0, 90, 'all', 1)
  `);
  const readerChannels: Array<[string, string]> = [
    ['production', 'صوت قراءة بلاغات الإنتاج'],
    ['assembly', 'صوت قراءة بلاغات التجميع'],
    ['hall', 'صوت قراءة بلاغات مسؤول الصالة'],
    ['escalation', 'صوت قراءة التنبيهات والتصعيدات'],
    ['general', 'صوت قراءة الإشعارات العامة'],
  ];
  for (const [code, label] of readerChannels) {
    insertReader.run(code, label, defaultHumanVoice ? defaultHumanVoice.id : null);
    db.prepare('UPDATE voice_reader_settings SET channel_name_ar = ? WHERE channel_code = ?').run(label, code);
  }

  // Seed granular permissions idempotently & assign to admin role
  const insertPermIgnore = db.prepare('INSERT OR IGNORE INTO permissions (code, name_ar, description) VALUES (?, ?, ?)');
  for (const [code, nameAr, desc] of GRANULAR_PERMISSION_DEFS) {
    insertPermIgnore.run(code, nameAr, desc);
  }
  const adminRoleRow = db.prepare("SELECT id FROM roles WHERE code = 'admin'").get() as { id: number } | undefined;
  if (adminRoleRow) {
    const grantIgnore = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    for (const [code] of GRANULAR_PERMISSION_DEFS) {
      const permRow = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number } | undefined;
      if (permRow) grantIgnore.run(adminRoleRow.id, permRow.id);
    }
  }

  // Unify hall_supervisor role: grant ALL operational hall + support permissions to unified role_permissions
  db.prepare("UPDATE roles SET name_ar = 'مسؤول الصالة' WHERE code = 'hall_supervisor'").run();
  db.prepare("UPDATE roles SET name_ar = 'مسؤول الإنتاج' WHERE code = 'production'").run();
  db.prepare("UPDATE roles SET name_ar = 'مسؤول التجميع والتسليم' WHERE code = 'assembly'").run();

  const hallRoleRow = db.prepare("SELECT id FROM roles WHERE code = 'hall_supervisor'").get() as { id: number } | undefined;
  if (hallRoleRow) {
    const unifiedHallPerms = [
      'view_dashboard', 'create_ticket', 'view_hall_tickets', 'assembly_support',
      'receive_ticket', 'process_ticket', 'reply_ticket', 'transfer_ticket',
      'close_ticket', 'reopen_ticket', 'view_reports', 'export_reports',
    ];
    const grantIgnore = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    for (const code of unifiedHallPerms) {
      const p = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number } | undefined;
      if (p) grantIgnore.run(hallRoleRow.id, p.id);
    }
    // Remove any legacy user-level restriction denying assembly_support to hall_supervisor accounts
    const supportPerm = db.prepare("SELECT id FROM permissions WHERE code = 'assembly_support'").get() as { id: number } | undefined;
    if (supportPerm) {
      db.prepare(`
        DELETE FROM user_permissions
        WHERE permission_id = ?
          AND granted = 0
          AND user_id IN (SELECT id FROM users WHERE role_id = ?)
      `).run(supportPerm.id, hallRoleRow.id);
    }
  }

  // Seed default responsible_assignments cleanly (non-destructive)
  const insertResponsible = db.prepare(`
    INSERT OR IGNORE INTO responsible_assignments (role_key, role_title_ar, assigned_person_name, updated_by_name)
    VALUES (?, ?, ?, 'النظام')
  `);
  insertResponsible.run('production', 'مسؤول الإنتاج', 'محمد الصنعاني');
  insertResponsible.run('assembly', 'مسؤول التجميع والتسليم', 'أحمد المقطري');
  insertResponsible.run('hall_supervisor', 'مسؤول الصالة', 'سالم الحضرمي');
  insertResponsible.run('admin', 'مدير النظام', 'م. فيصل الخولاني');

  // Non-destructively disable waiter accounts & strip waiter operational permissions
  db.exec(`
    UPDATE users
    SET is_active = 0
    WHERE role_id IN (SELECT id FROM roles WHERE code = 'waiter') AND is_active != 0;

    DELETE FROM role_permissions
    WHERE role_id IN (SELECT id FROM roles WHERE code = 'waiter');

    DELETE FROM role_permissions
    WHERE permission_id IN (
      SELECT id FROM permissions WHERE code IN ('confirm_waiter_delivery', 'view_waiter_tickets')
    );

    DELETE FROM user_permissions
    WHERE user_id IN (SELECT id FROM users WHERE role_id IN (SELECT id FROM roles WHERE code = 'waiter'));
  `);

  // Seed isolated test sandbox accounts idempotently (NEVER pollutes operational restaurant data)
  const getRoleId = (code: string) =>
    (db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: number } | undefined)?.id;
  const getDeptId = (code: string) =>
    (db.prepare('SELECT id FROM departments WHERE code = ?').get(code) as { id: number } | undefined)?.id;
  const insertTestUser = db.prepare(`
    INSERT OR IGNORE INTO users (
      full_name, username, email, password_hash, role_id, department_id, is_active, is_test_account
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 1)
  `);
  const sandboxDefs: Array<[string, string, string, string, string]> = [
    ['حساب اختبار التجميع', 'test_assembly', 'test_assembly@almazaq.ye', 'assembly', 'assembly'],
    ['حساب اختبار الإنتاج', 'test_production', 'test_production@almazaq.ye', 'production', 'production'],
    ['حساب اختبار الصالة', 'test_hall', 'test_hall@almazaq.ye', 'hall_supervisor', 'hall'],
    ['حساب اختبار الإدارة', 'test_admin', 'test_admin@almazaq.ye', 'admin', 'management'],
  ];
  const existingTestCount = (db.prepare("SELECT COUNT(*) as c FROM users WHERE username LIKE 'test_%'").get() as { c: number }).c;
  if (existingTestCount < sandboxDefs.length) {
    const testHash = bcrypt.hashSync('Test@123', 8);
    for (const [fullName, username, email, roleCode, deptCode] of sandboxDefs) {
      const rid = getRoleId(roleCode);
      const did = getDeptId(deptCode);
      if (rid && did) {
        insertTestUser.run(fullName, username, email, testHash, rid, did);
      }
    }
  }

  // Audio playback diagnostic log (non-destructive additive schema migration)
  db.exec(`
    CREATE TABLE IF NOT EXISTS audio_alert_diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_diag_uid TEXT NOT NULL UNIQUE,
      notification_id INTEGER,
      ticket_id INTEGER,
      ticket_number TEXT,
      invoice_number TEXT,
      target_department TEXT,
      channel_code TEXT,
      selected_voice_id INTEGER,
      selected_voice_name TEXT,
      selected_prebuilt_voice TEXT,
      selected_tone_name TEXT,
      event_type TEXT,
      spoken_text TEXT,
      alert_arrived_at TEXT NOT NULL,
      playback_requested INTEGER NOT NULL DEFAULT 0,
      playback_started INTEGER NOT NULL DEFAULT 0,
      playback_completed INTEGER NOT NULL DEFAULT 0,
      playback_status TEXT NOT NULL DEFAULT 'requested',
      tts_engine TEXT,
      failure_reason TEXT,
      user_id INTEGER,
      user_name TEXT,
      is_test INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audio_diag_created_at ON audio_alert_diagnostics(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audio_diag_dept_status ON audio_alert_diagnostics(target_department, playback_status);
  `);
}

function seedInitialData(db: Database.Database) {
  const deptCount = (db.prepare('SELECT COUNT(*) as c FROM departments').get() as { c: number }).c;
  if (deptCount > 0) return;

  const insertDept = db.prepare('INSERT INTO departments (code, name_ar, description) VALUES (?, ?, ?)');
  const depts = [
    ['assembly', 'قسم التجميع', 'مراجعة اكتمال الطلبات ومطابقة الأصناف وتجهيزها للصالة'],
    ['production', 'قسم الإنتاج', 'تجهيز وإخراج الأصناف من المطابخ'],
    ['hall', 'إدارة الصالة', 'متابعة الطلبات وبلاغات التراكم والجاهزية في الصالة'],
    ['waiters', 'قسم المباشرين', 'دور ملغى – سجل تاريخي فقط'],
    ['management', 'الإدارة والتشغيل', 'إدارة النظام والتقارير والصلاحيات والتصعيد'],
  ];
  for (const d of depts) insertDept.run(...d);

  const insertRole = db.prepare('INSERT INTO roles (code, name_ar, description) VALUES (?, ?, ?)');
  const roles = [
    ['assembly', 'مسؤول التجميع والتسليم', 'تأكيد وصول الأصناف، الرد على استفسارات الصالة، إرسال الطلبات الجاهزة'],
    ['production', 'مسؤول الإنتاج', 'استلام بلاغات الإنتاج ومعالجتها وتجهيز الأصناف وإرسالها للتجميع'],
    ['hall_supervisor', 'مسؤول الصالة', 'إرسال بلاغات الإنتاج، الاستفسار من التجميع، استلام التراكمات والجاهزية ومساندة التجميع'],
    ['waiter', 'مباشر صالة', 'دور ملغى – غير نشط'],
    ['admin', 'مدير النظام', 'صلاحيات إدارة المستخدمين والأصوات والتقارير الشاملة'],
  ];
  for (const r of roles) insertRole.run(...r);

  const insertPerm = db.prepare('INSERT INTO permissions (code, name_ar, description) VALUES (?, ?, ?)');
  const perms = [
    ['view_dashboard', 'عرض لوحة المتابعة', 'الاطلاع على مؤشرات القسم'],
    ['create_ticket', 'إنشاء بلاغ تعثر', 'رفع بلاغ تعثر لطلب متأخر أو ناقص'],
    ['view_production_tickets', 'عرض بلاغات الإنتاج', 'الاطلاع على بلاغات الإنتاج الموجهة'],
    ['view_assembly_tickets', 'عرض بلاغات التجميع', 'الاطلاع على بلاغات قسم التجميع'],
    ['view_hall_tickets', 'عرض بلاغات الصالة', 'الاطلاع على بلاغات الصالة والتراكم والجاهزية'],
    ['view_waiter_tickets', 'عرض طلبات المباشر', 'صلاحية تاريخية ملغاة'],
    ['assembly_support', 'مساندة قسم التجميع', 'صلاحية موحدة لمسؤول الصالة لمتابعة تعثر التجميع والإنتاج'],
    ['receive_ticket', 'استلام البلاغ', 'تأكيد استلام البلاغ'],
    ['process_ticket', 'معالجة البلاغ', 'بدء المعالجة وتنفيذ الإجراء'],
    ['reply_ticket', 'الرد على البلاغ', 'إضافة رد أو رسالة بين الأقسام'],
    ['transfer_ticket', 'تحويل البلاغ', 'تحويل البلاغ إلى قسم آخر'],
    ['confirm_item_arrival', 'تأكيد وصول الصنف', 'صلاحية التجميع لتأكيد وصول الصنف فعلياً'],
    ['confirm_order_complete', 'تأكيد اكتمال الطلب', 'صلاحية التجميع لاعتماد اكتمال الطلب وإرساله للصالة'],
    ['confirm_waiter_delivery', 'تأكيد استلام وتوصيل المباشر', 'صلاحية تاريخية ملغاة'],
    ['close_ticket', 'إغلاق البلاغ', 'إغلاق البلاغ بعد استيفاء شروط التحقق'],
    ['reopen_ticket', 'إعادة فتح البلاغ', 'إعادة فتح بلاغ مغلق عند استمرار المشكلة'],
    ['view_reports', 'عرض التقارير', 'الاطلاع على تقارير الأداء والتعثر'],
    ['export_reports', 'تصدير التقارير', 'تصدير التقارير بصيغ Excel وPDF'],
    ['manage_users', 'إدارة المستخدمين والصلاحيات', 'إضافة وتعديل حسابات الموظفين وصلاحياتهم'],
    ['manage_settings', 'إدارة الإعدادات', 'تعديل إعدادات التصعيد والأصوات والتنبيهات'],
    ...GRANULAR_PERMISSION_DEFS,
  ];
  for (const p of perms) insertPerm.run(...p);

  const roleIdByCode = (code: string) =>
    (db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: number }).id;
  const deptIdByCode = (code: string) =>
    (db.prepare('SELECT id FROM departments WHERE code = ?').get(code) as { id: number }).id;
  const permIdByCode = (code: string) =>
    (db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number }).id;

  const grantRolePerm = db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
  const roleMatrix: Record<string, string[]> = {
    assembly: [
      'view_dashboard', 'create_ticket', 'view_assembly_tickets', 'view_production_tickets',
      'receive_ticket', 'process_ticket', 'reply_ticket', 'transfer_ticket',
      'confirm_item_arrival', 'confirm_order_complete', 'close_ticket', 'reopen_ticket',
      'view_reports', 'export_reports',
    ],
    production: [
      'view_dashboard', 'view_production_tickets', 'receive_ticket', 'process_ticket',
      'reply_ticket', 'transfer_ticket', 'view_reports',
    ],
    hall_supervisor: [
      'view_dashboard', 'create_ticket', 'view_hall_tickets', 'assembly_support', 'receive_ticket',
      'process_ticket', 'reply_ticket', 'transfer_ticket',
      'close_ticket', 'reopen_ticket', 'view_reports', 'export_reports',
    ],
    waiter: [],
    admin: perms.map((p) => p[0]).filter((code) => code !== 'confirm_waiter_delivery' && code !== 'view_waiter_tickets'),
  };

  for (const [roleCode, pCodes] of Object.entries(roleMatrix)) {
    const rid = roleIdByCode(roleCode);
    for (const pc of pCodes) {
      grantRolePerm.run(rid, permIdByCode(pc));
    }
  }

  const insertUser = db.prepare(`
    INSERT INTO users (full_name, username, email, password_hash, role_id, department_id, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);

  const adminHash = bcrypt.hashSync('Admin@123', 8);
  const staffHash = bcrypt.hashSync('Pass@123', 8);

  const adminRes = insertUser.run('م. فيصل الخولاني', 'admin', 'admin@almazaq.ye', adminHash, roleIdByCode('admin'), deptIdByCode('management'));
  const assemblyRes = insertUser.run('أحمد المقطري', 'assembly', 'assembly@almazaq.ye', staffHash, roleIdByCode('assembly'), deptIdByCode('assembly'));
  const prodRes = insertUser.run('محمد الصنعاني', 'production', 'production@almazaq.ye', staffHash, roleIdByCode('production'), deptIdByCode('production'));
  const hallRes = insertUser.run('سالم الحضرمي', 'hall', 'hall@almazaq.ye', staffHash, roleIdByCode('hall_supervisor'), deptIdByCode('hall'));
  insertUser.run('عمر البيضاني', 'hall2', 'hall2@almazaq.ye', staffHash, roleIdByCode('hall_supervisor'), deptIdByCode('hall'));
  const waiter1Res = insertUser.run('خالد التعزي', 'waiter1', 'waiter1@almazaq.ye', staffHash, roleIdByCode('waiter'), deptIdByCode('waiters'));
  insertUser.run('ياسر العدني', 'waiter2', 'waiter2@almazaq.ye', staffHash, roleIdByCode('waiter'), deptIdByCode('waiters'));

  db.prepare(`
    INSERT INTO escalation_settings (id, first_warning_minutes, escalation_start_minutes, escalation_target_role, repeat_interval_minutes, max_escalations, updated_by_user_id)
    VALUES (1, 5, 10, 'admin', 5, 3, ?)
  `).run(Number(adminRes.lastInsertRowid));

  db.prepare("INSERT OR IGNORE INTO tracking_sequence (seq_name, last_value) VALUES ('ticket', 5)").run();

  // Seed initial realistic tickets using unified sequential TRK-000001..TRK-000005 format
  const now = Date.now();
  const isoAgo = (mins: number) => new Date(now - mins * 60000).toISOString();

  const insertTicket = db.prepare(`
    INSERT INTO tickets (
      ticket_number, client_request_id, invoice_number, reason_code, urgency_level, ticket_kind,
      problem_description, target_department, sender_department, created_by_user_id, assigned_waiter_id, status,
      created_via_support, escalation_level, received_at, received_by_user_id, processing_started_at,
      prepared_at, action_taken_at, waiter_received_at, waiter_delivered_at, closed_at, closed_by_user_id,
      backlog_orders_count, backlog_invoices, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertItem = db.prepare(`
    INSERT INTO ticket_items (
      ticket_id, item_name, quantity, expected_qty, delivered_qty, issue_note,
      arrival_confirmed, arrival_confirmed_by, arrival_confirmed_at,
      order_completed, order_completed_by, order_completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO ticket_events (
      ticket_id, actor_user_id, actor_name, actor_department, event_type,
      from_status, to_status, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const adminId = Number(adminRes.lastInsertRowid);
  const assemblyId = Number(assemblyRes.lastInsertRowid);
  const prodId = Number(prodRes.lastInsertRowid);
  const hallId = Number(hallRes.lastInsertRowid);
  const waiter1Id = Number(waiter1Res.lastInsertRowid);

  // Ticket 1: TRK-000001 Invoice 1250 - ربع بروستد
  const t1 = insertTicket.run(
    'TRK-000001', 'seed-1001', '1250', 'production_delay', 'urgent', 'stall',
    'تأخر خروج صنف ربع بروستد لأكثر من الوقت المعتاد والعميل ينتظر في الصالة',
    'production', 'assembly', assemblyId, null, 'in_progress',
    0, 1, isoAgo(9), prodId, isoAgo(7), null, null, null, null, null, null,
    1, null, isoAgo(12), isoAgo(2)
  );
  const t1Id = Number(t1.lastInsertRowid);
  insertItem.run(t1Id, 'ربع بروستد', 1, 1, 0, 'لم يخرج من المقلاة بعد', 0, null, null, 0, null, null);
  insertEvent.run(t1Id, assemblyId, 'أحمد المقطري', 'قسم التجميع', 'created', null, 'new', 'إنشاء بلاغ تأخر إنتاج برقم المتابعة TRK-000001 لفاتورة 1250', isoAgo(12));
  insertEvent.run(t1Id, prodId, 'محمد الصنعاني', 'قسم الإنتاج', 'received', 'new', 'received', 'تم استلام البلاغ في قسم الإنتاج', isoAgo(9));
  insertEvent.run(t1Id, prodId, 'محمد الصنعاني', 'قسم الإنتاج', 'status_changed', 'received', 'in_progress', 'جاري تجهيز الدفعة الحالية خلال 3 دقائق', isoAgo(7));
  insertEvent.run(t1Id, adminId, 'النظام الآلي', 'الإدارة والتشغيل', 'escalated', 'in_progress', 'in_progress', 'تصعيد مستوى 1 لتجاوز 10 دقائق تعثر', isoAgo(2));

  // Ticket 2: TRK-000002 Invoice 1250 - واحد رز
  const t2 = insertTicket.run(
    'TRK-000002', 'seed-1002', '1250', 'dispatched_not_arrived', 'normal', 'stall',
    'تم إشعار التجميع بخروج صحن الرز من المطبخ ولكن لم يصل إلى طاولة التجميع',
    'production', 'assembly', assemblyId, null, 'new',
    0, 0, null, null, null, null, null, null, null, null, null,
    1, null, isoAgo(4), isoAgo(4)
  );
  const t2Id = Number(t2.lastInsertRowid);
  insertItem.run(t2Id, 'واحد رز', 1, 1, 0, 'خرج ولم يصل للتجميع', 0, null, null, 0, null, null);
  insertEvent.run(t2Id, assemblyId, 'أحمد المقطري', 'قسم التجميع', 'created', null, 'new', 'بلاغ مستقل TRK-000002 لنفس الفاتورة 1250 عن صنف واحد رز', isoAgo(4));

  // Ticket 3: TRK-000003 Backlog report Assembly -> Hall
  const t3 = insertTicket.run(
    'TRK-000003', 'seed-1003', '1248', 'assembly_backlog', 'urgent', 'backlog',
    'تكدس 4 طلبات مكتملة على عربة التجميع وتحتاج متابعة فورية في الصالة',
    'hall', 'assembly', assemblyId, null, 'received',
    0, 0, isoAgo(3), hallId, isoAgo(3), null, null, null, null, null, null,
    4, JSON.stringify(['1248', '1249', '1251', '1252']), isoAgo(6), isoAgo(3)
  );
  const t3Id = Number(t3.lastInsertRowid);
  insertItem.run(t3Id, 'طلب متكامل (4 فواتير)', 4, 4, 4, 'تكدس على عربة التسليم', 1, assemblyId, isoAgo(6), 1, assemblyId, isoAgo(6));
  insertEvent.run(t3Id, assemblyId, 'أحمد المقطري', 'قسم التجميع', 'created', null, 'new', 'بلاغ تراكم الطلبات في قسم التجميع TRK-000003', isoAgo(6));
  insertEvent.run(t3Id, hallId, 'سالم الحضرمي', 'إدارة الصالة', 'received', 'new', 'received', 'تم استلام بلاغ التراكم وجارٍ التنسيق في الصالة', isoAgo(3));

  // Ticket 4: TRK-000004 Invoice 1247 (preserves historical disabled waiter link safely)
  const t4 = insertTicket.run(
    'TRK-000004', 'seed-1004', '1247', 'no_waiter_available', 'normal', 'stall',
    'الطلب جاهز ومكتمل في التجميع وبانتظار التسليم لطاولة 7 في الصالة',
    'hall', 'assembly', assemblyId, waiter1Id, 'in_progress',
    0, 0, isoAgo(5), hallId, isoAgo(4), null, null, null, null, null, null,
    1, null, isoAgo(8), isoAgo(4)
  );
  const t4Id = Number(t4.lastInsertRowid);
  insertItem.run(t4Id, 'نفر مندي لحم + سلطة', 1, 1, 1, 'جاهز على عربة الطلبات', 1, assemblyId, isoAgo(8), 1, assemblyId, isoAgo(8));
  insertEvent.run(t4Id, assemblyId, 'أحمد المقطري', 'قسم التجميع', 'created', null, 'new', 'الطلب جاهز في التجميع — TRK-000004', isoAgo(8));
  insertEvent.run(t4Id, hallId, 'سالم الحضرمي', 'إدارة الصالة', 'status_changed', 'received', 'in_progress', 'متابعة التسليم مباشرة عبر مسؤول الصالة', isoAgo(4));

  // Ticket 5: TRK-000005 Invoice 1245 - closed verified ticket
  const t5 = insertTicket.run(
    'TRK-000005', 'seed-1005', '1245', 'item_shortage', 'normal', 'stall',
    'نقص علبة سحاوق مع طلب الفحسة',
    'production', 'assembly', assemblyId, null, 'closed',
    0, 0, isoAgo(42), prodId, isoAgo(41), isoAgo(39), isoAgo(39), null, null, isoAgo(37), assemblyId,
    1, null, isoAgo(45), isoAgo(37)
  );
  const t5Id = Number(t5.lastInsertRowid);
  insertItem.run(t5Id, 'سحاوق حار', 1, 2, 2, 'تم توفير الكمية الناقصة', 1, assemblyId, isoAgo(38), 1, assemblyId, isoAgo(37));
  insertEvent.run(t5Id, assemblyId, 'أحمد المقطري', 'قسم التجميع', 'created', null, 'new', 'بلاغ نقص صنف سحاوق — TRK-000005', isoAgo(45));
  insertEvent.run(t5Id, prodId, 'محمد الصنعاني', 'قسم الإنتاج', 'received', 'new', 'received', 'استلام البلاغ', isoAgo(42));
  insertEvent.run(t5Id, prodId, 'محمد الصنعاني', 'قسم الإنتاج', 'action_taken', 'received', 'action_taken_awaiting_confirm', 'تم إرسال السحاوق الناقص للتجميع', isoAgo(39));
  insertEvent.run(t5Id, assemblyId, 'أحمد المقطري', 'قسم التجميع', 'arrival_confirmed', 'action_taken_awaiting_confirm', 'arrived_assembly', 'تأكيد وصول الكمية الصحيحة في التجميع', isoAgo(38));
  insertEvent.run(t5Id, assemblyId, 'أحمد المقطري', 'قسم التجميع', 'closed', 'arrived_assembly', 'closed', 'إغلاق البلاغ بعد التحقق الفعلي', isoAgo(37));

  const insertNotif = db.prepare(`
    INSERT INTO notifications (user_id, ticket_id, title, body, event_type, target_department, sender_department_code, should_play_audio, spoken_text, urgency_level, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);
  insertNotif.run(
    prodId,
    t2Id,
    'بلاغ جديد TRK-000002 — فاتورة 1250',
    'واحد رز: الصنف خرج ولم يصل إلى التجميع (من قسم التجميع)',
    'ticket_created',
    'production',
    'assembly',
    1,
    'بلاغ تعثر جديد في الإنتاج، رقم المتابعة TRK-000002، فاتورة رقم 1250، الصنف واحد رز، الكمية 1، السبب الصنف خرج ولم يصل إلى التجميع.',
    'normal',
    isoAgo(4)
  );
  insertNotif.run(
    hallId,
    t3Id,
    'بلاغ تراكم الطلبات TRK-000003 — فاتورة 1248',
    'تكدس 4 طلبات في التجميع بانتظار المتابعة في الصالة',
    'backlog_reported',
    'hall',
    'assembly',
    1,
    'تنبيه تراكم طلبات من قسم التجميع، رقم المتابعة TRK-000003، عدد الطلبات المتراكمة 4، الفواتير 1248 و1249 و1251 و1252، مستوى الاستعجال عاجل.',
    'urgent',
    isoAgo(6)
  );
}
