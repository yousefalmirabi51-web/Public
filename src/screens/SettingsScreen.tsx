import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  ClipboardList,
  Clock,
  Copy,
  Lock,
  RefreshCw,
  Save,
  Share2,
  ShieldCheck,
  Sliders,
  UserCog,
  Volume2,
  WifiOff,
} from 'lucide-react';
import { apiRequest, getAuthToken, getTotalOfflineQueueCount, syncAllOfflineQueues } from '../api/client';
import { PWAInstallButton } from '../components/PWAInstallButton';
import type {
  AuditLogEntry,
  EscalationSettings,
  ResponsibleAssignment,
  ResponsibleRoleKey,
  RoleCode,
  StationAudioSetting,
  UserProfile,
} from '../types/domain';
import {
  getStationCodeForDepartment,
  previewStationAudio,
  stopAllAudio,
  unlockStationAudio,
} from '../utils/audioAlerts';
import { formatAdenDateTime } from '../utils/time';

interface SettingsScreenProps {
  user: UserProfile;
  stationAudioSettings: StationAudioSetting[];
  refreshTick?: number;
  onOpenSoundManagement?: () => void;
  onQueueSynced: () => void;
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  update_responsible_assignment: 'تعديل مسؤول وظيفي',
  update_role: 'تعديل دور وظيفي',
  update_stall_threshold: 'تعديل مدة تعثر الطلبات',
  update_escalation_timing: 'تعديل زمن التصعيد التلقائي',
  update_escalation_settings: 'تحديث إعدادات التعثر والتصعيد',
  upload_audio_file: 'رفع ملف صوتي',
  add_ai_audio_file: 'إضافة صوت ذكي للمكتبة',
  rename_audio_file: 'تعديل اسم صوت',
  set_default_audio_file: 'تعيين الصوت الافتراضي',
  replace_audio_file: 'استبدال ملف صوتي',
  delete_audio_file: 'حذف ملف صوتي',
  update_station_audio: 'تخصيص صوت قسم/حدث',
  reset_station_audio: 'إعادة ضبط صوت محطة',
  update_user: 'تعديل بيانات مستخدم',
  update_user_permissions: 'تعديل صلاحيات مستخدم',
  create_user: 'إنشاء حساب مستخدم',
  create_backup: 'إنشاء نسخة احتياطية موثقة',
  verify_backup: 'فحص سلامة نسخة احتياطية',
  download_backup: 'تنزيل نسخة احتياطية',
  restore_backup: 'استعادة قاعدة البيانات',
  create_ticket: 'إنشاء بلاغ تعثر',
  receive_ticket: 'تأكيد استلام البلاغ',
  process_ticket: 'معالجة البلاغ',
  reply_ticket: 'إرسال رد على البلاغ',
  transfer_ticket: 'تحويل البلاغ لقسم آخر',
  confirm_arrival: 'تأكيد وصول الصنف للتجميع',
  send_to_hall: 'إرسال الطلب الجاهز للصالة',
  hall_confirm_receipt: 'تأكيد استلام الصالة النهائي',
  close_ticket: 'إغلاق البلاغ',
  reopen_ticket: 'إعادة فتح البلاغ',
};

export const SettingsScreen: React.FC<SettingsScreenProps> = ({
  user,
  stationAudioSettings,
  refreshTick = 0,
  onOpenSoundManagement,
  onQueueSynced,
}) => {
  const [esc, setEsc] = useState<EscalationSettings | null>(null);
  const [responsibles, setResponsibles] = useState<ResponsibleAssignment[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditCategory, setAuditCategory] = useState<'all' | 'responsibles' | 'escalation' | 'audio' | 'users' | 'backups' | 'tickets'>('all');

  const [savingStall, setSavingStall] = useState(false);
  const [savingEsc, setSavingEsc] = useState(false);
  const [savingRoleKey, setSavingRoleKey] = useState<ResponsibleRoleKey | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [offlineCount, setOfflineCount] = useState(() => getTotalOfflineQueueCount());

  const isAdmin = user.role_code === 'admin';
  const hasPerm = (code: string) => isAdmin || user.permissions.includes(code);

  const canManageResponsibles = hasPerm('manage_responsibles') || hasPerm('manage_settings');
  const canEditStall = hasPerm('manage_stall_threshold') || hasPerm('manage_settings');
  const canEditEscTiming = hasPerm('manage_escalation_timing') || hasPerm('manage_settings');
  const canTestAudio = hasPerm('audio_test') || hasPerm('manage_settings');
  const canViewAuditLogs =
    hasPerm('manage_users') ||
    hasPerm('manage_responsibles') ||
    hasPerm('manage_roles') ||
    hasPerm('manage_stall_threshold') ||
    hasPerm('manage_escalation_timing') ||
    hasPerm('manage_settings');

  const loadSettingsData = useCallback(async () => {
    try {
      const [escRes, respRes] = await Promise.all([
        apiRequest<{ settings: EscalationSettings }>('/api/settings/escalation'),
        apiRequest<{ responsibles: ResponsibleAssignment[] }>('/api/responsibles'),
      ]);
      setEsc(escRes.settings);
      setResponsibles(respRes.responsibles);
    } catch {
      // keep existing state on transient error
    }
  }, []);

  const loadAuditLogs = useCallback(async () => {
    if (!canViewAuditLogs) return;
    try {
      const res = await apiRequest<{ logs: AuditLogEntry[] }>(
        `/api/audit-logs?category=${encodeURIComponent(auditCategory)}&limit=80`
      );
      setAuditLogs(res.logs);
    } catch {
      // ignore if user lacks audit access
    }
  }, [canViewAuditLogs, auditCategory]);

  useEffect(() => {
    void loadSettingsData();
  }, [loadSettingsData, refreshTick]);

  useEffect(() => {
    void loadAuditLogs();
  }, [loadAuditLogs, refreshTick]);

  const myStationCode = getStationCodeForDepartment(user.department_code);
  const myStationSetting =
    stationAudioSettings.find((s) => s.station_code === myStationCode) ||
    stationAudioSettings.find((s) => s.station_code === 'general') ||
    null;

  const handleTestStationAudio = async () => {
    if (!canTestAudio) {
      setErr('ليس لديك صلاحية تجربة الأصوات');
      return;
    }
    setErr(null);
    setMsg(null);
    try {
      await apiRequest(`/api/audio/settings/${myStationSetting?.station_code || myStationCode}/test`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await unlockStationAudio();
      const res = await previewStationAudio({
        fileUrl: myStationSetting?.audio_file_url || myStationSetting?.resolved_audio_file_url || null,
        playbackRate: myStationSetting?.playback_rate ?? 1,
        volumePercent: myStationSetting?.volume_percent ?? 85,
        sampleText: `تنبيه تجريبي لمحطة ${user.department_name_ar}. الصوت مفعل ويعمل وفق الإعدادات المركزية.`,
        speakTextEnabled: myStationSetting?.speak_text_enabled ?? true,
        authToken: getAuthToken(),
        cacheBust: myStationSetting?.updated_at,
        mode: 'test',
      });
      if (!res.ok && res.error) {
        setErr(res.error);
      } else if (res.stopped) {
        setMsg('تم إيقاف تجربة صوت المحطة');
      } else {
        setMsg('تم تشغيل وتجربة الصوت المعتمد لهذه المحطة بنجاح');
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر تجربة الصوت');
    }
  };

  const handleUnlockAudioOnly = async () => {
    setErr(null);
    await unlockStationAudio();
    setMsg('تم تفعيل استقبال التنبيهات الصوتية التلقائية على هذا المتصفح');
  };

  const handleResponsibleFieldChange = (
    roleKey: ResponsibleRoleKey,
    field: 'role_title_ar' | 'assigned_person_name',
    value: string
  ) => {
    setResponsibles((prev) =>
      prev.map((item) => (item.role_key === roleKey ? { ...item, [field]: value } : item))
    );
  };

  const handleSaveResponsible = async (item: ResponsibleAssignment) => {
    setSavingRoleKey(item.role_key);
    setMsg(null);
    setErr(null);
    try {
      const res = await apiRequest<{ responsible: ResponsibleAssignment; responsibles: ResponsibleAssignment[] }>(
        `/api/responsibles/${item.role_key}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            role_title_ar: item.role_title_ar,
            assigned_person_name: item.assigned_person_name,
          }),
        }
      );
      setResponsibles(res.responsibles);
      setMsg(`تم حفظ تعديل المسؤول (${res.responsible.role_title_ar}: ${res.responsible.assigned_person_name}) وتسجيله في سجل الرقابة`);
      void loadAuditLogs();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر حفظ بيانات المسؤول');
    } finally {
      setSavingRoleKey(null);
    }
  };

  const handleSaveStallThreshold = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!esc) return;
    setSavingStall(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await apiRequest<{ settings: EscalationSettings }>('/api/settings/escalation', {
        method: 'PUT',
        body: JSON.stringify({ first_warning_minutes: esc.first_warning_minutes }),
      });
      setEsc(res.settings);
      setMsg(`تم اعتماد مدة تعثر الطلبات الجديدة (${res.settings.first_warning_minutes} دقائق) وتطبيقها على لوحة المتابعة والمراقبة`);
      void loadAuditLogs();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر حفظ مدة تعثر الطلبات');
    } finally {
      setSavingStall(false);
    }
  };

  const handleSaveEscalationTiming = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!esc) return;
    setSavingEsc(true);
    setMsg(null);
    setErr(null);
    try {
      const res = await apiRequest<{ settings: EscalationSettings }>('/api/settings/escalation', {
        method: 'PUT',
        body: JSON.stringify({
          escalation_start_minutes: esc.escalation_start_minutes,
          repeat_interval_minutes: esc.repeat_interval_minutes,
          max_escalations: esc.max_escalations,
          escalation_target_role: esc.escalation_target_role,
        }),
      });
      setEsc(res.settings);
      setMsg('تم حفظ إعدادات زمن التصعيد التلقائي وتحديث نظام الرقابة بنجاح');
      void loadAuditLogs();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر حفظ إعدادات التصعيد التلقائي');
    } finally {
      setSavingEsc(false);
    }
  };

  const handleSyncQueue = async () => {
    const res = await syncAllOfflineQueues();
    setOfflineCount(res.remainingCount);
    if (res.synced > 0) {
      setMsg(`تمت مزامنة ${res.synced} عملية/بلاغ مع الخادم بنجاح`);
      onQueueSynced();
    } else {
      setMsg('لا توجد عمليات معلقة أو لا يزال الاتصال بالخادم متعذراً');
    }
  };

  const currentAppUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const handleCopyShareLink = async () => {
    if (!currentAppUrl) return;
    try {
      await navigator.clipboard.writeText(currentAppUrl);
      setMsg('تم نسخ رابط التطبيق بنجاح — يمكنك إرساله عبر واتساب لفتحه من أي جوال');
    } catch {
      setErr('تعذر النسخ التلقائي، يمكنك نسخ الرابط الظاهر يدوياً');
    }
  };

  const handleNativeShare = async () => {
    if (!currentAppUrl) return;
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'التشغيل الذكي – مطعم المذاق اليمني',
          text: 'رابط الدخول إلى نظام متابعة الطلبات – مطعم المذاق اليمني:',
          url: currentAppUrl,
        });
      } catch {
        // user cancelled native share dialog
      }
    } else {
      await handleCopyShareLink();
    }
  };

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <div>
        <h2 className="text-xl font-extrabold text-[var(--brand-charcoal)]">إعدادات الإدارة والمحطة والتصعيد والرقابة</h2>
        <p className="text-sm text-[var(--brand-charcoal)]/80">
          إدارة المسؤولين، مدة تعثر الطلبات، زمن التصعيد التلقائي، الأصوات المعتمدة، وسجل التدقيق والرقابة
        </p>
      </div>

      {msg && (
        <div className="app-card px-4 py-3 text-sm font-bold text-[var(--brand-charcoal)] flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-[var(--brand-red)] shrink-0" />
          <span>{msg}</span>
        </div>
      )}

      {err && (
        <div className="app-card-urgent px-4 py-3 text-sm font-bold text-[var(--brand-red)]">
          {err}
        </div>
      )}

      {/* Section 1: إدارة المسؤولين وتوزيع الصلاحيات */}
      <section className="app-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
              <UserCog className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[var(--brand-charcoal)]">إدارة المسؤولين وتوزيع الصلاحيات</h3>
              <p className="text-xs text-[var(--brand-charcoal)]/75">
                تعديل أسماء المسؤولين والمكلفين بالمسؤوليات وتطبيقها مباشرة في الرسائل والتنبيهات والتقارير
              </p>
            </div>
          </div>

          <span className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-1.5 text-[11px] font-bold text-[var(--brand-charcoal)]">
            مستقل عن حسابات الدخول والصلاحيات
          </span>
        </div>

        <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3.5 py-2.5 text-xs text-[var(--brand-charcoal)]/85 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[var(--brand-orange)] shrink-0" />
          <span>
            ملاحظة: تعديل المسمى أو اسم الشخص المكلف هنا يحدّث الواجهات والتنبيهات والتقارير فقط دون تغيير حساب الدخول أو كلمة المرور أو الصلاحيات.
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {responsibles.map((item) => (
            <div
              key={item.role_key}
              className="rounded-2xl border border-[var(--brand-gray-light)] bg-white p-4 space-y-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-extrabold text-[var(--brand-red)]">{item.role_title_ar}</span>
                {item.updated_by_name && (
                  <span className="text-[10px] font-mono-num text-[var(--brand-charcoal)]/65">
                    آخر تعديل: {item.updated_by_name}
                  </span>
                )}
              </div>

              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] font-bold text-[var(--brand-charcoal)]/80 mb-1">
                    المسمى الوظيفي للمسؤول
                  </label>
                  <input
                    type="text"
                    disabled={!canManageResponsibles}
                    value={item.role_title_ar}
                    onChange={(e) => handleResponsibleFieldChange(item.role_key, 'role_title_ar', e.target.value)}
                    className="w-full h-[42px] app-input px-3 text-xs font-bold disabled:opacity-70"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-[var(--brand-charcoal)]/80 mb-1">
                    الشخص المكلف بالمسؤولية
                  </label>
                  <input
                    type="text"
                    disabled={!canManageResponsibles}
                    value={item.assigned_person_name}
                    onChange={(e) => handleResponsibleFieldChange(item.role_key, 'assigned_person_name', e.target.value)}
                    className="w-full h-[42px] app-input px-3 text-xs font-semibold disabled:opacity-70"
                  />
                </div>
              </div>

              {canManageResponsibles && (
                <button
                  type="button"
                  disabled={savingRoleKey === item.role_key}
                  onClick={() => void handleSaveResponsible(item)}
                  className="w-full min-h-[40px] inline-flex items-center justify-center gap-1.5 app-btn-primary text-xs disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{savingRoleKey === item.role_key ? 'جاري الحفظ...' : 'حفظ التعديل'}</span>
                </button>
              )}
            </div>
          ))}
        </div>

        {!canManageResponsibles && (
          <div className="flex items-center gap-2 text-xs text-[var(--brand-charcoal)]/75 px-1">
            <Lock className="w-3.5 h-3.5 text-[var(--brand-orange)]" />
            <span>تعديل أسماء المسؤولين متاح لمدير النظام أو من يملك صلاحية تعديل المسؤولين.</span>
          </div>
        )}
      </section>

      {/* Read-only Central Station Audio Settings View for Staff */}
      <div className="app-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center">
              <Volume2 className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[var(--brand-charcoal)]">صوت التنبيه المركزي المعتمد لهذه المحطة</h3>
              <p className="text-xs text-[var(--brand-charcoal)]/75">
                تُضبط الأصوات والسرعة مركزياً من مدير النظام أو المخولين لضمان التزام جميع أجهزة القسم بنفس التنبيه
              </p>
            </div>
          </div>

          {onOpenSoundManagement && (
            <button
              type="button"
              onClick={onOpenSoundManagement}
              className="min-h-[40px] app-btn-primary px-4 text-xs"
            >
              إدارة الأصوات والتنبيهات
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-4 py-3">
            <div className="text-[var(--brand-charcoal)]/70">ملف الصوت المعتمد</div>
            <div className="font-bold text-[var(--brand-charcoal)] mt-1 truncate">
              {myStationSetting?.audio_file_name ||
                myStationSetting?.resolved_audio_file_name ||
                'الصوت الافتراضي للنظام'}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-4 py-3">
            <div className="text-[var(--brand-charcoal)]/70">سرعة التشغيل</div>
            <div className="font-bold font-mono-num text-[var(--brand-red)] mt-1">
              {myStationSetting?.playback_rate ?? 1}x
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-4 py-3">
            <div className="text-[var(--brand-charcoal)]/70">مستوى الصوت والحالة</div>
            <div className="font-bold font-mono-num text-[var(--brand-charcoal)] mt-1">
              {myStationSetting?.volume_percent ?? 85}% ·{' '}
              {myStationSetting?.is_enabled === false ? 'متوقف' : 'مفعل'}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {canTestAudio ? (
            <>
              <button
                type="button"
                onClick={() => void handleTestStationAudio()}
                className="min-h-[46px] inline-flex items-center gap-2 app-btn-primary px-5 text-sm"
              >
                <BellRing className="w-4 h-4" />
                <span>تجربة الصوت</span>
              </button>
              <button
                type="button"
                onClick={() => stopAllAudio()}
                className="min-h-[46px] app-btn-outline px-4 text-xs"
              >
                إيقاف
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void handleUnlockAudioOnly()}
                className="min-h-[44px] inline-flex items-center gap-2 app-btn-outline px-4 text-xs"
              >
                <BellRing className="w-4 h-4 text-[var(--brand-orange)]" />
                <span>تفعيل استقبال التنبيهات في المتصفح</span>
              </button>
              <span className="inline-flex items-center gap-1.5 text-xs text-[var(--brand-charcoal)]/75">
                <Lock className="w-3.5 h-3.5 text-[var(--brand-orange)]" />
                <span>تجربة الأصوات تتطلب صلاحية «تجربة الأصوات»</span>
              </span>
            </>
          )}
        </div>
      </div>

      {/* Section 3: إعداد مدة تعثر الطلبات (مستقل عن زمن التصعيد) */}
      {esc && (
        <form onSubmit={handleSaveStallThreshold} className="app-card p-5 space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full bg-[var(--brand-orange)] text-white flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[var(--brand-charcoal)]">إعداد مدة تعثر الطلبات</h3>
              <p className="text-xs text-[var(--brand-charcoal)]/75">
                تحديد عدد الدقائق التي يُعتبر الطلب بعدها متعثراً في لوحة التحكم ومؤشرات المراقبة وقائمة البلاغات المتأخرة
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-bold text-[var(--brand-charcoal)] mb-1">
                مدة اعتبار الطلب متعثراً (بالدقائق)
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!canEditStall || esc.first_warning_minutes <= 1}
                  onClick={() =>
                    setEsc({ ...esc, first_warning_minutes: Math.max(1, esc.first_warning_minutes - 1) })
                  }
                  className="h-[46px] w-[46px] rounded-2xl border border-[var(--brand-gray-light)] bg-white text-lg font-extrabold text-[var(--brand-charcoal)] hover:border-[var(--brand-red)] disabled:opacity-50"
                >
                  -
                </button>
                <input
                  type="number"
                  min={1}
                  disabled={!canEditStall}
                  value={esc.first_warning_minutes}
                  onChange={(e) => setEsc({ ...esc, first_warning_minutes: Math.max(1, Number(e.target.value) || 1) })}
                  className="flex-1 h-[46px] app-input px-3 text-sm font-mono-num font-extrabold text-center"
                />
                <button
                  type="button"
                  disabled={!canEditStall}
                  onClick={() => setEsc({ ...esc, first_warning_minutes: esc.first_warning_minutes + 1 })}
                  className="h-[46px] w-[46px] rounded-2xl border border-[var(--brand-gray-light)] bg-white text-lg font-extrabold text-[var(--brand-charcoal)] hover:border-[var(--brand-red)] disabled:opacity-50"
                >
                  +
                </button>
              </div>
            </div>

            {canEditStall ? (
              <button
                type="submit"
                disabled={savingStall}
                className="min-h-[46px] inline-flex items-center gap-2 app-btn-primary px-5 text-sm disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                <span>{savingStall ? 'جاري الحفظ...' : 'حفظ مدة التعثر'}</span>
              </button>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-[var(--brand-charcoal)]/75 pb-2">
                <Lock className="w-3.5 h-3.5 text-[var(--brand-orange)]" />
                <span>يتطلب صلاحية إدارة مدة تعثر الطلبات</span>
              </div>
            )}
          </div>
        </form>
      )}

      {/* Section 4: إعداد زمن التصعيد التلقائي (مستقل عن مدة التعثر) */}
      {esc && (
        <form onSubmit={handleSaveEscalationTiming} className="app-card p-5 space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-[var(--brand-charcoal)]">إعداد زمن التصعيد التلقائي</h3>
              <p className="text-xs text-[var(--brand-charcoal)]/75">
                التحكم المستقل في موعد بدء التصعيد التلقائي ومدة الانتظار والتكرار دون نقل ملكية البلاغ أو تكرار التنبيه لنفس المستوى
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[var(--brand-charcoal)] mb-1">
                زمن بدء التصعيد التلقائي (دقائق)
              </label>
              <input
                type="number"
                min={1}
                disabled={!canEditEscTiming}
                value={esc.escalation_start_minutes}
                onChange={(e) => setEsc({ ...esc, escalation_start_minutes: Math.max(1, Number(e.target.value) || 1) })}
                className="w-full h-[46px] app-input px-3 text-sm font-mono-num"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--brand-charcoal)] mb-1">
                فاصل تكرار التصعيد (دقائق)
              </label>
              <input
                type="number"
                min={1}
                disabled={!canEditEscTiming}
                value={esc.repeat_interval_minutes}
                onChange={(e) => setEsc({ ...esc, repeat_interval_minutes: Math.max(1, Number(e.target.value) || 1) })}
                className="w-full h-[46px] app-input px-3 text-sm font-mono-num"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--brand-charcoal)] mb-1">
                الحد الأقصى لمستويات التصعيد
              </label>
              <input
                type="number"
                min={1}
                disabled={!canEditEscTiming}
                value={esc.max_escalations}
                onChange={(e) => setEsc({ ...esc, max_escalations: Math.max(1, Number(e.target.value) || 1) })}
                className="w-full h-[46px] app-input px-3 text-sm font-mono-num"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[var(--brand-charcoal)] mb-1">
                الجهة المستقبلة للتصعيد
              </label>
              <select
                disabled={!canEditEscTiming}
                value={esc.escalation_target_role}
                onChange={(e) => setEsc({ ...esc, escalation_target_role: e.target.value as RoleCode })}
                className="w-full h-[46px] app-input px-3 text-sm font-semibold"
              >
                <option value="admin">مدير النظام والتشغيل</option>
                <option value="hall_supervisor">مسؤول الصالة</option>
                <option value="assembly">مسؤول التجميع والتسليم</option>
                <option value="production">مسؤول الإنتاج</option>
              </select>
            </div>
          </div>

          {canEditEscTiming ? (
            <button
              type="submit"
              disabled={savingEsc}
              className="min-h-[46px] inline-flex items-center gap-2 app-btn-primary px-5 text-sm disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{savingEsc ? 'جاري الحفظ...' : 'حفظ إعدادات التصعيد التلقائي'}</span>
            </button>
          ) : (
            <div className="flex items-center gap-2 text-xs text-[var(--brand-charcoal)]/75">
              <Lock className="w-3.5 h-3.5 text-[var(--brand-orange)]" />
              <span>تعديل زمن التصعيد التلقائي يتطلب صلاحية إدارة زمن التصعيد التلقائي.</span>
            </div>
          )}
        </form>
      )}

      {/* Section 7: سجل التدقيق والرقابة */}
      {canViewAuditLogs && (
        <section className="app-card p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-full bg-[var(--brand-charcoal)] text-white flex items-center justify-center shrink-0">
                <ClipboardList className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-[var(--brand-charcoal)]">سجل التدقيق والرقابة</h3>
                <p className="text-xs text-[var(--brand-charcoal)]/75">
                  توثيق كامل لجميع تعديلات المسؤولين، مدة التعثر، التصعيد التلقائي، والأصوات مع القيمة السابقة والحالية ومنفذ التعديل
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void loadAuditLogs()}
              className="min-h-[38px] inline-flex items-center gap-1.5 app-btn-outline px-3 text-xs"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>تحديث السجل</span>
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {(
              [
                ['all', 'الكل'],
                ['responsibles', 'المسؤولون والأدوار'],
                ['escalation', 'مدة التعثر والتصعيد'],
                ['audio', 'الأصوات والتنبيهات'],
                ['users', 'المستخدمون والصلاحيات'],
                ['tickets', 'البلاغات والإجراءات'],
                ['backups', 'النسخ الاحتياطي والاستعادة'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setAuditCategory(key)}
                className={`min-h-[36px] rounded-2xl border px-3 text-xs font-bold transition-colors ${
                  auditCategory === key
                    ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                    : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1">
            {auditLogs.length === 0 ? (
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-4 text-center text-xs font-semibold text-[var(--brand-charcoal)]/75">
                لا توجد سجلات رقابة مطابقة لهذه الفئة حتى الآن
              </div>
            ) : (
              auditLogs.map((log) => (
                <div
                  key={log.id}
                  className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3.5 space-y-1.5 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-extrabold text-[var(--brand-red)]">
                        {AUDIT_ACTION_LABELS[log.action] || log.action}
                      </span>
                      <span className="text-[var(--brand-charcoal)]/60">·</span>
                      <span className="font-bold text-[var(--brand-charcoal)]">
                        المنفذ: {log.actor_name || log.username}
                      </span>
                    </div>
                    <span className="font-mono-num text-[11px] text-[var(--brand-charcoal)]/70">
                      {formatAdenDateTime(log.created_at)}
                    </span>
                  </div>

                  {log.details && <div className="font-semibold text-[var(--brand-charcoal)]">{log.details}</div>}

                  {(log.old_value || log.new_value) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-[11px] font-mono-num">
                      {log.old_value && (
                        <div className="rounded-xl border border-[var(--brand-gray-light)] bg-white px-2.5 py-1.5 text-[var(--brand-charcoal)]/80 break-all">
                          <strong className="text-[var(--brand-charcoal)]">السابق:</strong> {log.old_value}
                        </div>
                      )}
                      {log.new_value && (
                        <div className="rounded-xl border border-[var(--brand-orange)]/40 bg-white px-2.5 py-1.5 text-[var(--brand-charcoal)] break-all">
                          <strong className="text-[var(--brand-red)]">الجديد:</strong> {log.new_value}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* Share & Open on Mobile Card */}
      <div className="app-card p-5 space-y-3">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-full bg-[var(--brand-orange)] text-white flex items-center justify-center">
            <Share2 className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-[var(--brand-charcoal)]">مشاركة رابط التطبيق للفتح من أي جوال</h3>
            <p className="text-xs text-[var(--brand-charcoal)]/75">انسخ الرابط التالي أو شاركه عبر واتساب لفتحه على هواتف القسم وتثبيته كتطبيق</p>
          </div>
        </div>

        <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3.5 py-2.5 text-xs font-mono-num text-[var(--brand-charcoal)] break-all" dir="ltr">
          {currentAppUrl}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => void handleNativeShare()}
            className="min-h-[44px] inline-flex items-center gap-2 app-btn-primary px-5 text-xs"
          >
            <Share2 className="w-4 h-4" />
            <span>مشاركة الرابط الآن</span>
          </button>
          <button
            type="button"
            onClick={() => void handleCopyShareLink()}
            className="min-h-[44px] inline-flex items-center gap-2 app-btn-outline px-4 text-xs"
          >
            <Copy className="w-4 h-4" />
            <span>نسخ الرابط</span>
          </button>
        </div>
      </div>

      {/* Timezone, Offline Sync & PWA */}
      <div className="app-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Clock className="w-5 h-5 text-[var(--brand-charcoal)]" />
            <span className="text-sm font-bold text-[var(--brand-charcoal)]">التوقيت المعتمد: Asia/Aden (توقيت اليمن)</span>
          </div>
          <PWAInstallButton variant="card" />
        </div>

        <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm">
            <WifiOff className="w-4 h-4 text-[var(--brand-orange)]" />
            <span className="font-semibold text-[var(--brand-charcoal)]">
              البلاغات المحفوظة مؤقتاً بانتظار المزامنة:{' '}
              <strong className="font-mono-num text-[var(--brand-red)]">{offlineCount}</strong>
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleSyncQueue()}
            className="min-h-[40px] inline-flex items-center gap-1.5 app-btn-outline px-3.5 text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>مزامنة الآن</span>
          </button>
        </div>
      </div>
    </div>
  );
};
