import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { BackupRecord, BackupTriggerType } from '../src/types/domain.ts';

export interface BackupVerificationResult {
  ok: boolean;
  integrity_status: 'verified' | 'failed';
  integrity_detail: string;
  size_bytes: number;
  sha256: string;
  table_counts: Record<string, number>;
}

export interface BackupManagerOptions {
  backupDir?: string;
  mirrorDir?: string | null;
  dbFilePath?: string;
  maxRetainedBackups?: number;
}

const CORE_TABLES = [
  'users',
  'roles',
  'departments',
  'permissions',
  'tickets',
  'ticket_items',
  'ticket_events',
  'notifications',
  'station_audio_settings',
  'voice_reader_settings',
  'human_voices',
  'audio_files',
  'responsible_assignments',
  'user_activity_logs',
] as const;

export function getDefaultBackupDir(): string {
  return process.env.BACKUP_DIR
    ? path.resolve(process.env.BACKUP_DIR)
    : path.resolve(process.cwd(), 'backups');
}

export function getDefaultMirrorDir(): string | null {
  if (process.env.BACKUP_MIRROR_DIR === 'none') return null;
  return process.env.BACKUP_MIRROR_DIR
    ? path.resolve(process.env.BACKUP_MIRROR_DIR)
    : path.resolve('/tmp', 'almazaq_backups_mirror');
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

export function verifyDatabaseFile(
  filePath: string,
  expectedSha256?: string | null
): BackupVerificationResult {
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      integrity_status: 'failed',
      integrity_detail: 'ملف النسخة الاحتياطية غير موجود على القرص',
      size_bytes: 0,
      sha256: '',
      table_counts: {},
    };
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    return {
      ok: false,
      integrity_status: 'failed',
      integrity_detail: 'ملف النسخة الاحتياطية فارغ (0 بايت)',
      size_bytes: 0,
      sha256: '',
      table_counts: {},
    };
  }

  const actualSha = sha256File(filePath);
  if (expectedSha256 && actualSha !== expectedSha256) {
    return {
      ok: false,
      integrity_status: 'failed',
      integrity_detail: 'فشل تطابق البصمة الرقمية SHA-256 — قد يكون الملف معدلاً أو تالفاً',
      size_bytes: stat.size,
      sha256: actualSha,
      table_counts: {},
    };
  }

  let checkDb: Database.Database | null = null;
  try {
    checkDb = new Database(filePath, { readonly: true, fileMustExist: true });
    const qc = checkDb.pragma('quick_check(1)') as Array<Record<string, unknown>>;
    const qcText = qc?.[0] ? String(Object.values(qc[0])[0] || '').toLowerCase() : '';
    if (qcText !== 'ok') {
      return {
        ok: false,
        integrity_status: 'failed',
        integrity_detail: `فشل فحص سلامة SQLite (quick_check): ${qcText || 'غير معروف'}`,
        size_bytes: stat.size,
        sha256: actualSha,
        table_counts: {},
      };
    }

    const existingTablesRows = checkDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const existingTables = new Set(existingTablesRows.map((r) => r.name));

    for (const required of ['users', 'roles', 'departments', 'tickets', 'station_audio_settings']) {
      if (!existingTables.has(required)) {
        return {
          ok: false,
          integrity_status: 'failed',
          integrity_detail: `النسخة الاحتياطية تفتقد الجدول الأساسي: ${required}`,
          size_bytes: stat.size,
          sha256: actualSha,
          table_counts: {},
        };
      }
    }

    const counts: Record<string, number> = {};
    for (const tbl of CORE_TABLES) {
      if (!existingTables.has(tbl)) continue;
      const row = checkDb.prepare(`SELECT COUNT(*) AS c FROM "${tbl}"`).get() as { c: number };
      counts[tbl] = Number(row?.c || 0);
    }

    if ((counts.users || 0) < 1) {
      return {
        ok: false,
        integrity_status: 'failed',
        integrity_detail: 'النسخة الاحتياطية لا تحتوي على حسابات مستخدمين صالحة',
        size_bytes: stat.size,
        sha256: actualSha,
        table_counts: counts,
      };
    }

    return {
      ok: true,
      integrity_status: 'verified',
      integrity_detail: `تم التحقق بنجاح (quick_check: ok · المستخدمون: ${counts.users} · البلاغات: ${counts.tickets ?? 0})`,
      size_bytes: stat.size,
      sha256: actualSha,
      table_counts: counts,
    };
  } catch (err) {
    return {
      ok: false,
      integrity_status: 'failed',
      integrity_detail: `تعذر فتح ملف النسخة الاحتياطية: ${err instanceof Error ? err.message : String(err)}`,
      size_bytes: stat.size,
      sha256: actualSha,
      table_counts: {},
    };
  } finally {
    try {
      checkDb?.close();
    } catch {
      // ignore close error
    }
  }
}

export class BackupManager {
  readonly backupDir: string;
  readonly mirrorDir: string | null;
  readonly dbFilePath: string;
  readonly manifestPath: string;
  readonly maxRetainedBackups: number;

  constructor(options?: BackupManagerOptions) {
    this.backupDir = options?.backupDir ? path.resolve(options.backupDir) : getDefaultBackupDir();
    this.mirrorDir = options?.mirrorDir !== undefined ? options.mirrorDir : getDefaultMirrorDir();
    this.dbFilePath =
      options?.dbFilePath ?? path.resolve(process.cwd(), 'data', 'yemeni_taste.db');
    this.manifestPath = path.join(this.backupDir, 'backup_manifest.json');
    this.maxRetainedBackups = options?.maxRetainedBackups ?? 60;
    fs.mkdirSync(this.backupDir, { recursive: true });
    if (this.mirrorDir) {
      try {
        fs.mkdirSync(this.mirrorDir, { recursive: true });
      } catch {
        // non-fatal if mirror path is not writable
      }
    }
  }

  private readManifest(): BackupRecord[] {
    try {
      if (!fs.existsSync(this.manifestPath)) return [];
      const raw = fs.readFileSync(this.manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as BackupRecord[]) : [];
    } catch {
      return [];
    }
  }

  private writeManifest(records: BackupRecord[]): void {
    const tmpPath = `${this.manifestPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.manifestPath);
  }

  listBackups(): BackupRecord[] {
    const records = this.readManifest();
    return records
      .map((rec) => {
        const primaryExists = fs.existsSync(rec.file_path);
        const mirrorExists = rec.mirror_path ? fs.existsSync(rec.mirror_path) : false;
        return {
          ...rec,
          file_exists: primaryExists || mirrorExists,
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  getBackupById(id: string): BackupRecord | null {
    const rec = this.listBackups().find((r) => r.id === id);
    return rec || null;
  }

  resolveExistingBackupPath(rec: BackupRecord): string | null {
    if (fs.existsSync(rec.file_path)) return rec.file_path;
    if (rec.mirror_path && fs.existsSync(rec.mirror_path)) return rec.mirror_path;
    return null;
  }

  async createVerifiedBackup(
    db: Database.Database,
    opts: {
      trigger_type: BackupTriggerType;
      reason: string;
      created_by_user_id?: number | null;
      created_by_name?: string;
    }
  ): Promise<BackupRecord> {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const now = new Date();
    const nowIso = now.toISOString();
    const safeStamp = nowIso.replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 6);
    const id = `bkp_${safeStamp}_${opts.trigger_type}_${rand}`;
    const filename = `yemeni_taste_${safeStamp}_${opts.trigger_type}_${rand}.db`;
    const destPath = path.join(this.backupDir, filename);

    await db.backup(destPath);
    const verification = verifyDatabaseFile(destPath);
    if (!verification.ok) {
      try {
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      } catch {
        // ignore
      }
      throw new Error(`فشل التحقق من سلامة النسخة الاحتياطية المنشأة: ${verification.integrity_detail}`);
    }

    let mirrorPath: string | null = null;
    if (this.mirrorDir) {
      try {
        fs.mkdirSync(this.mirrorDir, { recursive: true });
        const targetMirror = path.join(this.mirrorDir, filename);
        fs.copyFileSync(destPath, targetMirror);
        mirrorPath = targetMirror;
      } catch {
        mirrorPath = null;
      }
    }

    const record: BackupRecord = {
      id,
      filename,
      file_path: destPath,
      mirror_path: mirrorPath,
      trigger_type: opts.trigger_type,
      reason: opts.reason,
      size_bytes: verification.size_bytes,
      sha256: verification.sha256,
      integrity_status: verification.integrity_status,
      integrity_detail: verification.integrity_detail,
      table_counts: verification.table_counts,
      created_by_user_id: opts.created_by_user_id ?? null,
      created_by_name: opts.created_by_name || 'النظام الآلي',
      created_at: nowIso,
      restored_count: 0,
      last_restored_at: null,
      file_exists: true,
    };

    const existing = this.readManifest();
    const next = [record, ...existing];
    // Retain historical backups safely up to maxRetainedBackups (always keeping manual & pre_migration preferentially)
    if (next.length > this.maxRetainedBackups) {
      const keepImportant = next.filter(
        (r) => r.trigger_type === 'manual' || r.trigger_type === 'pre_migration' || r.trigger_type === 'pre_restore'
      );
      const automated = next.filter(
        (r) => r.trigger_type !== 'manual' && r.trigger_type !== 'pre_migration' && r.trigger_type !== 'pre_restore'
      );
      const allowedAutomated = Math.max(10, this.maxRetainedBackups - keepImportant.length);
      const trimmedAutomated = automated.slice(0, allowedAutomated);
      const prunedAutomated = automated.slice(allowedAutomated);
      for (const old of prunedAutomated) {
        try {
          if (fs.existsSync(old.file_path)) fs.unlinkSync(old.file_path);
          if (old.mirror_path && fs.existsSync(old.mirror_path)) fs.unlinkSync(old.mirror_path);
        } catch {
          // ignore file unlink errors
        }
      }
      const merged = [...keepImportant.slice(0, this.maxRetainedBackups), ...trimmedAutomated].sort((a, b) =>
        b.created_at.localeCompare(a.created_at)
      );
      this.writeManifest(merged);
    } else {
      this.writeManifest(next);
    }

    this.syncRecordToDb(db, record);
    return record;
  }

  private syncRecordToDb(db: Database.Database, record: BackupRecord): void {
    try {
      const hasTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'backup_logs'")
        .get();
      if (!hasTable) return;
      db.prepare(`
        INSERT OR REPLACE INTO backup_logs (
          id, filename, file_path, mirror_path, trigger_type, reason,
          size_bytes, sha256, integrity_status, integrity_detail,
          table_counts_json, created_by_user_id, created_by_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.filename,
        record.file_path,
        record.mirror_path,
        record.trigger_type,
        record.reason,
        record.size_bytes,
        record.sha256,
        record.integrity_status,
        record.integrity_detail,
        JSON.stringify(record.table_counts),
        record.created_by_user_id,
        record.created_by_name,
        record.created_at
      );
    } catch {
      // non-fatal if DB doesn't have table yet (e.g. pre-migration)
    }
  }

  verifyBackupById(id: string): { record: BackupRecord; verification: BackupVerificationResult } {
    const rec = this.getBackupById(id);
    if (!rec) {
      throw new Error('سجل النسخة الاحتياطية غير موجود');
    }
    const existingPath = this.resolveExistingBackupPath(rec);
    if (!existingPath) {
      throw new Error('ملف النسخة الاحتياطية مفقود من وحدة التخزين');
    }
    const verification = verifyDatabaseFile(existingPath, rec.sha256);
    // Update manifest status if changed
    const all = this.readManifest().map((item) =>
      item.id === id
        ? {
            ...item,
            integrity_status: verification.integrity_status,
            integrity_detail: verification.integrity_detail,
          }
        : item
    );
    this.writeManifest(all);
    return {
      record: { ...rec, integrity_status: verification.integrity_status, integrity_detail: verification.integrity_detail },
      verification,
    };
  }

  async restoreVerifiedBackup(
    db: Database.Database,
    backupId: string,
    opts: {
      actorUserId: number;
      actorName: string;
      replaceLiveDatabase: (verifiedSourcePath: string) => void;
    }
  ): Promise<{
    restoredRecord: BackupRecord;
    preRestoreBackup: BackupRecord;
    verification: BackupVerificationResult;
  }> {
    if (this.dbFilePath === ':memory:') {
      throw new Error('لا يمكن استبدال قاعدة البيانات الذاكرية مباشرة دون ملف مسار');
    }

    const { record, verification } = this.verifyBackupById(backupId);
    if (!verification.ok) {
      throw new Error(`تم إيقاف الاستعادة لحماية البيانات: ${verification.integrity_detail}`);
    }

    const sourcePath = this.resolveExistingBackupPath(record);
    if (!sourcePath) {
      throw new Error('ملف النسخة الاحتياطية غير متاح للاستعادة');
    }

    // Mandatory safety backup BEFORE restoring!
    const preRestoreBackup = await this.createVerifiedBackup(db, {
      trigger_type: 'pre_restore',
      reason: `نسخة أمان تلقائية قبل استعادة ${record.filename}`,
      created_by_user_id: opts.actorUserId,
      created_by_name: opts.actorName,
    });

    opts.replaceLiveDatabase(sourcePath);

    const nowIso = new Date().toISOString();
    const updatedManifest = this.readManifest().map((item) =>
      item.id === backupId
        ? {
            ...item,
            restored_count: (item.restored_count || 0) + 1,
            last_restored_at: nowIso,
          }
        : item
    );
    this.writeManifest(updatedManifest);

    const updatedRecord = updatedManifest.find((i) => i.id === backupId) || {
      ...record,
      restored_count: (record.restored_count || 0) + 1,
      last_restored_at: nowIso,
    };

    return {
      restoredRecord: updatedRecord,
      preRestoreBackup,
      verification,
    };
  }
}

export function replaceSqliteFileAtomically(verifiedSourcePath: string, targetDbPath: string): void {
  const dir = path.dirname(targetDbPath);
  fs.mkdirSync(dir, { recursive: true });
  const stagePath = `${targetDbPath}.restore-tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(verifiedSourcePath, stagePath);

  const stageCheck = verifyDatabaseFile(stagePath);
  if (!stageCheck.ok) {
    try {
      fs.unlinkSync(stagePath);
    } catch {
      // ignore
    }
    throw new Error(`فشل التحقق من الملف المؤقت للاستعادة: ${stageCheck.integrity_detail}`);
  }

  for (const sidecar of [`${targetDbPath}-wal`, `${targetDbPath}-shm`, `${targetDbPath}-journal`]) {
    try {
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    } catch {
      // ignore
    }
  }

  fs.renameSync(stagePath, targetDbPath);
}

export interface MutableDbHolder {
  current: Database.Database;
  filePath: string;
}

export function createDbProxy(holder: MutableDbHolder): Database.Database {
  return new Proxy({} as Database.Database, {
    get(_target, prop) {
      const targetDb = holder.current as unknown as Record<PropertyKey, unknown>;
      const val = Reflect.get(targetDb, prop, targetDb);
      return typeof val === 'function' ? val.bind(targetDb) : val;
    },
    set(_target, prop, value) {
      return Reflect.set(holder.current as unknown as Record<PropertyKey, unknown>, prop, value);
    },
  });
}
