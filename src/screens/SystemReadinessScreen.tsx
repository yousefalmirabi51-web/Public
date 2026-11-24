import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  HardDrive,
  Music,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Users,
  Wifi,
} from 'lucide-react';
import { apiRequest, getAuthToken } from '../api/client';
import {
  DEPARTMENT_LABELS,
  type BackupRecord,
  type DepartmentCode,
  type SystemReadinessReport,
  type UserProfile,
} from '../types/domain';
import { formatAdenDateTime } from '../utils/time';

interface SystemReadinessScreenProps {
  user: UserProfile;
  refreshTick: number;
  onSystemRestored?: () => void;
  onOpenSoundManagement?: () => void;
}

const TRIGGER_LABELS: Record<BackupRecord['trigger_type'], string> = {
  manual: 'يدوي',
  pre_migration: 'قبل الترقية',
  pre_restore: 'أمان قبل الاستعادة',
  scheduled: 'مجدول تلقائي',
  startup: 'عند بدء التشغيل',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 بايت';
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ك.ب`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} م.ب`;
}

function formatUptime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) return `${hrs}س ${mins}د ${secs}ث`;
  if (mins > 0) return `${mins}د ${secs}ث`;
  return `${secs}ث`;
}

export const SystemReadinessScreen: React.FC<SystemReadinessScreenProps> = ({
  user,
  refreshTick,
  onSystemRestored,
  onOpenSoundManagement,
}) => {
  const [report, setReport] = useState<SystemReadinessReport | null>(null);
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [backupReason, setBackupReason] = useState('');
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const isAdmin = user.role_code === 'admin';
  const canAccess = isAdmin || user.permissions.includes('manage_settings');

  const loadAll = useCallback(async () => {
    if (!canAccess) {
      setLoading(false);
      return;
    }
    try {
      const [readinessRes, backupsRes] = await Promise.all([
        apiRequest<SystemReadinessReport>('/api/admin/system-readiness'),
        apiRequest<{ backups: BackupRecord[] }>('/api/admin/backups'),
      ]);
      setReport(readinessRes);
      setBackups(backupsRes.backups || []);
      setErr(null);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر تحميل تقرير جاهزية النظام');
    } finally {
      setLoading(false);
    }
  }, [canAccess]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, refreshTick]);

  const handleCreateBackup = async () => {
    setBusyAction('create');
    setMsg(null);
    setErr(null);
    try {
      const res = await apiRequest<{ backup: BackupRecord; backups: BackupRecord[] }>('/api/admin/backups', {
        method: 'POST',
        body: JSON.stringify({
          reason: backupReason.trim() || 'نسخة احتياطية يدوية موثقة من لوحة جاهزية النظام',
        }),
      });
      setBackups(res.backups);
      setBackupReason('');
      setMsg(
        `تم إنشاء نسخة احتياطية موثقة بنجاح (${res.backup.filename} — ${formatBytes(res.backup.size_bytes)})`
      );
      await loadAll();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر إنشاء النسخة الاحتياطية');
    } finally {
      setBusyAction(null);
    }
  };

  const handleVerifyBackup = async (id: string) => {
    setBusyAction(`verify-${id}`);
    setMsg(null);
    setErr(null);
    try {
      const res = await apiRequest<{
        record: BackupRecord;
        verification: { ok: boolean; integrity_status: string; detail: string; sha256: string };
        backups: BackupRecord[];
      }>(`/api/admin/backups/${encodeURIComponent(id)}/verify`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setBackups(res.backups);
      if (res.verification.ok) {
        setMsg(`تم التحقق من سلامة النسخة (${res.record.filename}): ${res.verification.detail}`);
      } else {
        setErr(`فشل فحص سلامة النسخة (${res.record.filename}): ${res.verification.detail}`);
      }
      await loadAll();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر فحص النسخة الاحتياطية');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDownloadBackup = async (rec: BackupRecord) => {
    setBusyAction(`download-${rec.id}`);
    setErr(null);
    try {
      const token = getAuthToken();
      const res = await fetch(`/api/admin/backups/${encodeURIComponent(rec.id)}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        let message = 'تعذر تنزيل ملف النسخة الاحتياطية';
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          // ignore
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = rec.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg(`تم بدء تنزيل النسخة الاحتياطية (${rec.filename})`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر تنزيل النسخة الاحتياطية');
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmRestore = async (id: string) => {
    setBusyAction(`restore-${id}`);
    setMsg(null);
    setErr(null);
    try {
      const res = await apiRequest<{
        ok: boolean;
        restored_record: BackupRecord;
        pre_restore_backup: BackupRecord;
        backups: BackupRecord[];
      }>(`/api/admin/backups/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        body: JSON.stringify({ confirm_restore: true }),
      });
      setBackups(res.backups);
      setConfirmRestoreId(null);
      setMsg(
        `تمت استعادة قاعدة البيانات بنجاح من (${res.restored_record.filename}) بعد حفظ نسخة أمان تلقائية (${res.pre_restore_backup.filename}).`
      );
      onSystemRestored?.();
      await loadAll();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر استعادة قاعدة البيانات');
    } finally {
      setBusyAction(null);
    }
  };

  if (!canAccess) {
    return (
      <div className="app-card-urgent p-6 text-center text-sm font-bold text-[var(--brand-red)]">
        هذه اللوحة مخصصة لمدير النظام ومخولي الإعدادات فقط.
      </div>
    );
  }

  if (loading && !report) {
    return (
      <div className="space-y-4 max-w-5xl mx-auto">
        <div className="h-28 app-card animate-pulse" />
        <div className="h-44 app-card animate-pulse" />
        <div className="h-64 app-card animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-[var(--brand-charcoal)]">
            لوحة جاهزية النظام والنسخ الاحتياطي الموثق
          </h2>
          <p className="text-sm text-[var(--brand-charcoal)]/80">
            مراقبة صحة الخادم، استقرار قاعدة البيانات، تأكيدات وصول واستلام البلاغات، والنسخ الاحتياطية والاستعادة
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadAll()}
          className="min-h-[42px] inline-flex items-center gap-2 app-btn-outline px-4 text-xs"
        >
          <RefreshCw className="w-4 h-4 text-[var(--brand-red)]" />
          <span>تحديث الفحص الآن</span>
        </button>
      </div>

      {msg && (
        <div className="app-card px-4 py-3 text-sm font-bold text-[var(--brand-charcoal)] flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-[var(--brand-red)] shrink-0" />
          <span>{msg}</span>
        </div>
      )}

      {err && (
        <div className="app-card-urgent px-4 py-3 text-sm font-bold text-[var(--brand-red)] flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span>{err}</span>
        </div>
      )}

      {report && (
        <>
          {/* Environment & Storage Honesty Banner */}
          <section
            className={`p-4 sm:p-5 rounded-2xl border ${
              report.server.persistence_mode === 'ephemeral_container_fs'
                ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)]/10'
                : 'border-[var(--brand-gray-light)] bg-white'
            } space-y-2.5`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-extrabold text-[var(--brand-charcoal)]">
                    حالة الخادم والاستمرارية:{' '}
                    <span className="text-[var(--brand-red)]">
                      {report.server.status === 'ok' ? 'مستقر وجاهز' : 'يتطلب مراجعة'}
                    </span>
                  </div>
                  <div className="text-xs font-mono-num text-[var(--brand-charcoal)]/75">
                    الإصدار {report.server.version} · البيئة {report.server.node_env} · وقت التشغيل{' '}
                    {formatUptime(report.server.uptime_seconds)} · {report.server.timezone}
                  </div>
                </div>
              </div>
              <span className="text-xs font-mono-num text-[var(--brand-charcoal)]/80">
                بدء التشغيل: {formatAdenDateTime(report.server.started_at)}
              </span>
            </div>

            <p className="text-xs font-semibold text-[var(--brand-charcoal)] leading-relaxed">
              {report.server.persistence_notice}
            </p>
          </section>

          {/* Ticket Delivery, Read & Receipt Health */}
          <section className="app-card p-5 space-y-3.5">
            <div className="flex items-center gap-2.5">
              <Activity className="w-5 h-5 text-[var(--brand-red)]" />
              <h3 className="text-base font-extrabold text-[var(--brand-charcoal)]">
                مؤشرات موثوقية وصول وقراءة واستلام البلاغات (بيانات التشغيل الفعلية)
              </h3>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3.5">
                <div className="text-[var(--brand-charcoal)]/75 font-semibold">جديدة لم تُفتح بعد</div>
                <div className="mt-1.5 text-2xl font-extrabold font-mono-num text-[var(--brand-charcoal)]">
                  {report.tickets_health.new_unopened}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3.5">
                <div className="text-[var(--brand-charcoal)]/75 font-semibold">قُرئت بانتظار تأكيد الاستلام</div>
                <div className="mt-1.5 text-2xl font-extrabold font-mono-num text-[var(--brand-orange)]">
                  {report.tickets_health.read_awaiting_receipt}
                </div>
              </div>
              <div
                className={`rounded-2xl border p-3.5 ${
                  report.tickets_health.overdue_unreceived > 0
                    ? 'border-[var(--brand-red)] bg-[var(--brand-red)]/5'
                    : 'border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)]'
                }`}
              >
                <div className="text-[var(--brand-red)] font-bold">متأخرة عن تأكيد الاستلام</div>
                <div className="mt-1.5 text-2xl font-extrabold font-mono-num text-[var(--brand-red)]">
                  {report.tickets_health.overdue_unreceived}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3.5">
                <div className="text-[var(--brand-charcoal)]/75 font-semibold">متوسط سرعة الاستلام</div>
                <div className="mt-1.5 text-2xl font-extrabold font-mono-num text-[var(--brand-charcoal)]">
                  {report.tickets_health.avg_response_minutes} د
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-white p-3.5">
                <div className="text-[var(--brand-charcoal)]/75">إجمالي غير المستلمة</div>
                <div className="mt-1 text-lg font-extrabold font-mono-num text-[var(--brand-charcoal)]">
                  {report.tickets_health.unreceived}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-white p-3.5">
                <div className="text-[var(--brand-charcoal)]/75">جاري المعالجة والتحقق</div>
                <div className="mt-1 text-lg font-extrabold font-mono-num text-[var(--brand-orange)]">
                  {report.tickets_health.in_progress}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-white p-3.5">
                <div className="text-[var(--brand-charcoal)]/75">مفتوحة مصعدة</div>
                <div className="mt-1 text-lg font-extrabold font-mono-num text-[var(--brand-red)]">
                  {report.tickets_health.escalated_open}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-white p-3.5">
                <div className="text-[var(--brand-charcoal)]/75">مغلقة بعد التحقق</div>
                <div className="mt-1 text-lg font-extrabold font-mono-num text-[var(--brand-charcoal)]">
                  {report.tickets_health.closed_total}
                </div>
              </div>
            </div>
          </section>

          {/* Database Integrity & Live WebSocket Connected Devices */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section className="app-card p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Database className="w-5 h-5 text-[var(--brand-red)]" />
                  <h3 className="text-base font-extrabold text-[var(--brand-charcoal)]">سلامة قاعدة البيانات</h3>
                </div>
                <span className="text-xs font-mono-num font-extrabold text-[var(--brand-red)]">
                  quick_check: {report.database.integrity_check}
                </span>
              </div>

              <div className="text-xs space-y-1 text-[var(--brand-charcoal)]/85">
                <div>
                  المحرك: <strong className="text-[var(--brand-charcoal)]">{report.database.engine}</strong>
                  {' · '}
                  الحجم: <strong className="font-mono-num">{formatBytes(report.database.size_bytes)}</strong>
                </div>
                <div className="font-mono-num text-[11px] break-all text-[var(--brand-charcoal)]/70" dir="ltr">
                  {report.database.path}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                <div className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2 flex justify-between">
                  <span>الموظفون الفعليون</span>
                  <strong className="font-mono-num">{report.database.counts.users_active}</strong>
                </div>
                <div className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2 flex justify-between">
                  <span>حسابات الاختبار المعزولة</span>
                  <strong className="font-mono-num text-[var(--brand-orange)]">
                    {report.database.counts.test_accounts}
                  </strong>
                </div>
                <div className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2 flex justify-between">
                  <span>البلاغات الفعلية</span>
                  <strong className="font-mono-num">{report.database.counts.production_tickets}</strong>
                </div>
                <div className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2 flex justify-between">
                  <span>بلاغات الاختبار المعزولة</span>
                  <strong className="font-mono-num text-[var(--brand-orange)]">
                    {report.database.counts.isolated_test_tickets}
                  </strong>
                </div>
                <div className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2 flex justify-between">
                  <span>ملفات الأصوات والأصوات البشرية</span>
                  <strong className="font-mono-num">
                    {report.database.counts.audio_files} / {report.database.counts.human_voices}
                  </strong>
                </div>
                <div className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2 flex justify-between">
                  <span>سجل الرقابة غير القابل للحذف</span>
                  <strong className="font-mono-num">{report.database.counts.audit_logs}</strong>
                </div>
              </div>
            </section>

            <section className="app-card p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Wifi className="w-5 h-5 text-[var(--brand-orange)]" />
                  <h3 className="text-base font-extrabold text-[var(--brand-charcoal)]">الأجهزة المتصلة لحظياً</h3>
                </div>
                <span className="text-xs font-mono-num font-extrabold text-[var(--brand-red)]">
                  {report.websocket.connected_clients} متصل الآن
                </span>
              </div>

              {report.websocket.connected_users.length === 0 ? (
                <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-4 text-xs text-center text-[var(--brand-charcoal)]/75">
                  لا توجد اتصالات WebSocket نشطة بخلاف جلستك الحالية أو لم تكتمل المزامنة بعد.
                </div>
              ) : (
                <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                  {report.websocket.connected_users.map((cu, idx) => (
                    <div
                      key={`${cu.user_id}-${idx}`}
                      className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <Users className="w-3.5 h-3.5 text-[var(--brand-red)]" />
                        <strong className="text-[var(--brand-charcoal)]">{cu.full_name}</strong>
                        <span className="font-mono-num text-[var(--brand-charcoal)]/70">({cu.username})</span>
                      </div>
                      <span className="font-bold text-[var(--brand-orange)]">
                        {DEPARTMENT_LABELS[cu.department_code as DepartmentCode] || cu.department_code}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Active Audio Summary */}
              <div className="pt-2 border-t border-[var(--brand-gray-light)] space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 font-bold text-[var(--brand-charcoal)]">
                    <Music className="w-4 h-4 text-[var(--brand-red)]" />
                    سياسة الأصوات المعتمدة:
                  </span>
                  {onOpenSoundManagement && (
                    <button
                      type="button"
                      onClick={onOpenSoundManagement}
                      className="text-[var(--brand-red)] font-bold hover:underline"
                    >
                      فتح إعدادات الأصوات
                    </button>
                  )}
                </div>
                <div className="text-[var(--brand-charcoal)]/80">
                  القارئ الآلي للمتصفح:{' '}
                  <strong className="text-[var(--brand-red)]">
                    {report.audio_status.browser_fallback_enabled ? 'مفعل' : 'متوقف نهائياً'}
                  </strong>
                  {' · '}
                  الصوت البشري الذكي:{' '}
                  <strong className="text-[var(--brand-charcoal)]">
                    {report.audio_status.gemini_tts_configured ? 'مفعل وجاهز' : 'يعتمد على الملفات المسجلة/المرفوعة'}
                  </strong>
                </div>
              </div>
            </section>
          </div>

          {/* Verified Backups & Restore Section */}
          <section className="app-card p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-full bg-[var(--brand-charcoal)] text-white flex items-center justify-center shrink-0">
                  <HardDrive className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-[var(--brand-charcoal)]">
                    النسخ الاحتياطية الموثقة واستعادة قاعدة البيانات
                  </h3>
                  <p className="text-xs text-[var(--brand-charcoal)]/75 font-mono-num">
                    المحفوظة: {report.backups.total_count} (موثقة السلامة: {report.backups.verified_count})
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3.5 text-[11px] font-mono-num space-y-1 text-[var(--brand-charcoal)]/80">
              <div dir="ltr" className="break-all">
                <strong>BACKUP_DIR:</strong> {report.backups.backup_dir}
              </div>
              {report.backups.mirror_dir && (
                <div dir="ltr" className="break-all">
                  <strong>MIRROR_DIR:</strong> {report.backups.mirror_dir}
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                value={backupReason}
                onChange={(e) => setBackupReason(e.target.value)}
                placeholder="سبب النسخة الاحتياطية (اختياري — مثال: قبل وردية المساء)..."
                className="flex-1 min-w-[220px] h-[44px] app-input px-3.5 text-sm"
              />
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleCreateBackup()}
                className="min-h-[44px] inline-flex items-center gap-2 app-btn-primary px-5 text-sm disabled:opacity-50"
              >
                <HardDrive className="w-4 h-4" />
                <span>{busyAction === 'create' ? 'جاري النسخ والفحص...' : 'إنشاء نسخة احتياطية موثقة الآن'}</span>
              </button>
            </div>

            <div className="space-y-2.5">
              {backups.length === 0 ? (
                <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-5 text-center text-xs font-semibold text-[var(--brand-charcoal)]/75">
                  لا توجد نسخ احتياطية مسجلة بعد. اضغط على «إنشاء نسخة احتياطية موثقة الآن».
                </div>
              ) : (
                backups.map((b) => {
                  const isConfirming = confirmRestoreId === b.id;
                  return (
                    <div
                      key={b.id}
                      className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-4 space-y-2.5 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="space-y-0.5">
                          <div className="font-mono-num font-extrabold text-[var(--brand-charcoal)] text-sm">
                            {b.filename}
                          </div>
                          <div className="text-[var(--brand-charcoal)]/80">
                            النوع: <strong>{TRIGGER_LABELS[b.trigger_type] || b.trigger_type}</strong>
                            {' · '}
                            السبب: {b.reason}
                            {' · '}
                            بواسطة: <strong>{b.created_by_name}</strong>
                          </div>
                        </div>

                        <div className="text-left font-mono-num space-y-0.5">
                          <div className={b.integrity_status === 'verified' ? 'font-bold text-[var(--brand-charcoal)]' : 'font-bold text-[var(--brand-red)]'}>
                            {b.integrity_status === 'verified' ? 'سليمة وموثقة' : 'تتطلب فحصاً'} · {formatBytes(b.size_bytes)}
                          </div>
                          <div className="text-[11px] text-[var(--brand-charcoal)]/70">
                            {formatAdenDateTime(b.created_at)}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-[var(--brand-gray-light)]/70">
                        <div className="font-mono-num text-[11px] text-[var(--brand-charcoal)]/75 space-x-3 space-x-reverse">
                          <span>SHA256: {b.sha256.slice(0, 16)}…</span>
                          {b.table_counts && (
                            <span>
                              المستخدمون: {b.table_counts.users ?? 0} · البلاغات: {b.table_counts.tickets ?? 0} · السجل:{' '}
                              {b.table_counts.user_activity_logs ?? 0}
                            </span>
                          )}
                          {typeof b.restored_count === 'number' && b.restored_count > 0 && (
                            <span className="text-[var(--brand-orange)] font-bold">
                              استُعيدت {b.restored_count} مرة
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={() => void handleVerifyBackup(b.id)}
                            className="min-h-[36px] inline-flex items-center gap-1.5 app-btn-outline px-3 text-xs disabled:opacity-50"
                          >
                            <ShieldCheck className="w-3.5 h-3.5 text-[var(--brand-red)]" />
                            <span>{busyAction === `verify-${b.id}` ? 'جاري الفحص...' : 'فحص السلامة'}</span>
                          </button>

                          <button
                            type="button"
                            disabled={busyAction !== null || b.file_exists === false}
                            onClick={() => void handleDownloadBackup(b)}
                            className="min-h-[36px] inline-flex items-center gap-1.5 app-btn-outline px-3 text-xs disabled:opacity-50"
                          >
                            <Download className="w-3.5 h-3.5 text-[var(--brand-orange)]" />
                            <span>تحميل</span>
                          </button>

                          {isAdmin && (
                            <button
                              type="button"
                              disabled={busyAction !== null || b.file_exists === false}
                              onClick={() => setConfirmRestoreId(isConfirming ? null : b.id)}
                              className="min-h-[36px] inline-flex items-center gap-1.5 app-btn-secondary px-3 text-xs disabled:opacity-50"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>استعادة</span>
                            </button>
                          )}
                        </div>
                      </div>

                      {isConfirming && isAdmin && (
                        <div className="rounded-xl border border-[var(--brand-red)] bg-white p-3.5 space-y-2.5">
                          <div className="text-xs font-extrabold text-[var(--brand-red)] flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            <span>
                              تنبيه حرج: سيتم حفظ نسخة أمان تلقائية للوضع الحالي أولاً، ثم فحص النسخة المختارة واستبدال قاعدة البيانات الحية بها.
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={busyAction !== null}
                              onClick={() => void handleConfirmRestore(b.id)}
                              className="min-h-[38px] app-btn-primary px-4 text-xs disabled:opacity-50"
                            >
                              {busyAction === `restore-${b.id}`
                                ? 'جاري التحقق والاستعادة...'
                                : 'نعم، تأكيد استعادة قاعدة البيانات الآن'}
                            </button>
                            <button
                              type="button"
                              disabled={busyAction !== null}
                              onClick={() => setConfirmRestoreId(null)}
                              className="min-h-[38px] app-btn-outline px-4 text-xs"
                            >
                              إلغاء
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
};
