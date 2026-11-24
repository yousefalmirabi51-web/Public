import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Bell,
  ChevronLeft,
  ChevronRight,
  Clock,
  FilePlus2,
  FolderOpen,
  Handshake,
  History,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Music,
  RotateCcw,
  Settings,
  ShieldCheck,
  Square,
  Users,
  Volume2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { PWAInstallButton } from './PWAInstallButton';
import type { NavView } from '../screens/DashboardScreen';
import {
  AUDIO_PERMISSION_CODES,
  type NotificationItem,
  type StationAudioSetting,
  type UserProfile,
  type VoiceReaderSetting,
} from '../types/domain';
import { formatAdenDateHeader, formatAdenTimeOnly } from '../utils/time';
import {
  isStationAudioPlaying,
  isStationAudioUnlocked,
  onAudioPlaybackStateChange,
  onAudioUnlockChange,
  previewStationAudio,
  stopAllAudio,
  unlockStationAudio,
} from '../utils/audioAlerts';

interface MainLayoutProps {
  user: UserProfile;
  activeView: NavView;
  wsConnected: boolean;
  isOnline: boolean;
  offlineQueueCount: number;
  unreadCount: number;
  liveToast: NotificationItem | null;
  stationAudioSetting?: StationAudioSetting | null;
  voiceReaderSetting?: VoiceReaderSetting | null;
  hasLastAlert?: boolean;
  authToken?: string | null;
  audioBlocked?: boolean;
  audioError?: string | null;
  onClearAudioError?: () => void;
  onAudioUnlocked?: () => void;
  onReplayLastAlert?: () => void;
  onStopReading?: () => void;
  onDismissToast: () => void;
  onOpenTicketFromToast: (ticketId: number) => void;
  onNavigate: (view: NavView) => void;
  onLogout: () => void;
  children: React.ReactNode;
}

export const MainLayout: React.FC<MainLayoutProps> = ({
  user,
  activeView,
  wsConnected,
  isOnline,
  offlineQueueCount,
  unreadCount,
  liveToast,
  stationAudioSetting,
  voiceReaderSetting,
  hasLastAlert = false,
  authToken,
  audioBlocked = false,
  audioError = null,
  onClearAudioError,
  onAudioUnlocked,
  onReplayLastAlert,
  onStopReading,
  onDismissToast,
  onOpenTicketFromToast,
  onNavigate,
  onLogout,
  children,
}) => {
  const [now, setNow] = useState(() => new Date());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [audioUnlocked, setAudioUnlocked] = useState(() => isStationAudioUnlocked());
  const [audioPlaying, setAudioPlaying] = useState(() => isStationAudioPlaying());
  const [enableError, setEnableError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setAudioUnlocked(isStationAudioUnlocked() && !audioBlocked);
  }, [audioBlocked]);

  useEffect(() => {
    return onAudioUnlockChange((unlocked) => {
      setAudioUnlocked(unlocked && !audioBlocked);
    });
  }, [audioBlocked]);

  useEffect(() => {
    return onAudioPlaybackStateChange((playing) => {
      setAudioPlaying(playing);
    });
  }, []);

  const canCreate = user.permissions.includes('create_ticket') || user.role_code === 'admin';
  const canReports = user.permissions.includes('view_reports') || user.role_code === 'admin';
  const canUsers =
    user.permissions.includes('manage_users') ||
    user.permissions.includes('manage_roles') ||
    user.role_code === 'admin';
  const canSounds =
    user.role_code === 'admin' ||
    user.permissions.includes('manage_settings') ||
    AUDIO_PERMISSION_CODES.some((c) => user.permissions.includes(c));
  const canReadiness = user.role_code === 'admin' || user.permissions.includes('manage_settings');

  const navItems: Array<{
    id: NavView;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
    visible: boolean;
  }> = [
    { id: 'dashboard', label: 'لوحة المتابعة', icon: LayoutDashboard, visible: true },
    { id: 'create', label: 'إنشاء بلاغ', icon: FilePlus2, visible: canCreate },
    { id: 'inbox', label: 'صندوق الوارد', icon: Inbox, visible: true },
    { id: 'open', label: 'البلاغات المفتوحة', icon: FolderOpen, visible: true },
    { id: 'delayed', label: 'البلاغات المتأخرة', icon: AlertTriangle, visible: true },
    { id: 'history', label: 'سجل البلاغات', icon: History, visible: true },
    { id: 'assembly_support', label: 'مساندة قسم التجميع', icon: Handshake, visible: user.has_assembly_support },
    { id: 'reports', label: 'تقارير التشغيل', icon: BarChart3, visible: canReports },
    { id: 'notifications', label: 'التنبيهات', icon: Bell, badge: unreadCount, visible: true },
    { id: 'sounds', label: 'إدارة الأصوات والتنبيهات', icon: Music, visible: canSounds },
    { id: 'readiness', label: 'جاهزية النظام والنسخ', icon: ShieldCheck, visible: canReadiness },
    { id: 'users', label: 'المستخدمون والصلاحيات', icon: Users, visible: canUsers },
    { id: 'settings', label: 'الإعدادات', icon: Settings, visible: true },
  ];

  const visibleNav = navItems.filter((n) => n.visible);

  const handleEnableAudio = async () => {
    setEnableError(null);
    onClearAudioError?.();
    const unlocked = await unlockStationAudio();
    setAudioUnlocked(unlocked);
    if (unlocked) {
      onAudioUnlocked?.();
    }
    const res = await previewStationAudio({
      fileUrl: stationAudioSetting?.audio_file_url || stationAudioSetting?.resolved_audio_file_url || null,
      playbackRate: voiceReaderSetting?.playback_rate ?? stationAudioSetting?.playback_rate ?? 1,
      volumePercent: voiceReaderSetting?.volume_percent ?? stationAudioSetting?.volume_percent ?? 85,
      sampleText: 'تم تفعيل التنبيهات الصوتية وقراءة البلاغات لهذه المحطة بنجاح',
      speakTextEnabled: voiceReaderSetting?.is_enabled ?? stationAudioSetting?.speak_text_enabled ?? true,
      voiceOpts: voiceReaderSetting
        ? {
            humanVoiceId: voiceReaderSetting.resolved_human_voice_id ?? voiceReaderSetting.human_voice_id,
            voiceName: voiceReaderSetting.resolved_prebuilt_voice_name,
            stylePrompt: voiceReaderSetting.resolved_style_prompt,
            voiceKind: voiceReaderSetting.resolved_human_voice_kind,
            recordedFileUrl: voiceReaderSetting.resolved_audio_file_url,
            channelCode: voiceReaderSetting.channel_code,
            departmentCode: user.department_code,
            playbackMode: 'alert',
          }
        : undefined,
      authToken,
      cacheBust: stationAudioSetting?.updated_at,
      mode: 'alert',
    });
    if (!res.ok && res.error) {
      setEnableError(res.error);
    } else if (res.ok) {
      setAudioUnlocked(true);
      onAudioUnlocked?.();
    }
  };

  const effectiveAudioError = audioError || enableError;

  const handleSelectNav = (view: NavView) => {
    setMobileMenuOpen(false);
    onNavigate(view);
  };

  const userInitial = user.full_name?.trim().charAt(0) || 'م';

  return (
    <div className="min-h-screen w-full bg-[var(--brand-surface-neutral)] text-[var(--brand-charcoal)] flex flex-col lg:flex-row">
      {/* Desktop Right Collapsible Animated Sidebar (Matches Reference Screenshot 100%) */}
      <aside
        className={`hidden lg:flex lg:shrink-0 lg:flex-col lg:justify-between bg-[var(--brand-red)] text-white sticky top-0 h-screen overflow-hidden transition-all duration-300 ease-in-out shadow-lg no-print ${
          sidebarCollapsed ? 'lg:w-[84px]' : 'lg:w-[276px]'
        }`}
      >
        {/* Top Dark-Red Brand & Active User Block */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="bg-[var(--brand-red-dark)] px-4 pt-4 pb-3.5 border-b border-white/15 space-y-3 shrink-0">
            {/* Brand Header */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-11 h-11 rounded-full bg-white p-1 flex items-center justify-center shrink-0 shadow-sm">
                  <BrandLogo size="sm" className="h-8 w-8" />
                </div>
                {!sidebarCollapsed && (
                  <div className="min-w-0">
                    <div className="text-base font-extrabold leading-tight truncate text-white">
                      المذاق اليمني
                    </div>
                    <div className="text-[11px] font-medium text-white/85 truncate">
                      نظام متابعة الطلبات والربط اللحظي
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {!sidebarCollapsed && (
                  <span className="rounded-lg bg-[var(--brand-orange)] px-2 py-1 text-[10px] font-extrabold text-white leading-tight text-center shadow-2xs">
                    التشغيل
                    <br />
                    الذكي
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed((c) => !c)}
                  aria-label={sidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'}
                  title={sidebarCollapsed ? 'توسيع القائمة' : 'طي القائمة'}
                  className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 text-white flex items-center justify-center transition-colors"
                >
                  {sidebarCollapsed ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Active User Card */}
            {!sidebarCollapsed ? (
              <div className="pt-2 border-t border-white/15 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] text-white/75">المستخدم الحالي:</div>
                  <div className="text-sm font-extrabold text-white truncate">{user.full_name}</div>
                  <div className="text-[11px] text-white/80 truncate">{user.department_name_ar}</div>
                </div>
                <span className="shrink-0 rounded-full bg-[var(--brand-orange)] px-2.5 py-1 text-[11px] font-bold text-white shadow-2xs">
                  {user.role_name_ar}
                </span>
              </div>
            ) : (
              <div className="pt-2 border-t border-white/15 flex justify-center">
                <span
                  title={`${user.full_name} · ${user.role_name_ar}`}
                  className="w-9 h-9 rounded-full bg-[var(--brand-orange)] text-white text-sm font-extrabold flex items-center justify-center"
                >
                  {userInitial}
                </span>
              </div>
            )}
          </div>

          {/* Scrollable Vertical Navigation List */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
            {!sidebarCollapsed && (
              <div className="text-xs font-bold text-white/85 px-2 pb-0.5">أقسام النظام</div>
            )}
            <nav className="space-y-1">
              {visibleNav.map((item) => {
                const Icon = item.icon;
                const isActive = activeView === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    title={sidebarCollapsed ? item.label : undefined}
                    onClick={() => handleSelectNav(item.id)}
                    className={`w-full min-h-[44px] rounded-2xl px-3.5 py-2 flex items-center ${
                      sidebarCollapsed ? 'justify-center' : 'justify-between'
                    } gap-2 text-sm font-bold transition-all duration-200 whitespace-nowrap ${
                      isActive
                        ? 'bg-white text-[var(--brand-red)] shadow-sm'
                        : 'text-white hover:bg-[var(--brand-red-dark)]/75'
                    }`}
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-[var(--brand-red)]' : 'text-white'}`} />
                      {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                    </span>
                    {!sidebarCollapsed && typeof item.badge === 'number' && item.badge > 0 && (
                      <span
                        className={`text-xs font-mono-num font-extrabold px-2 py-0.5 rounded-full ${
                          isActive
                            ? 'bg-[var(--brand-red)] text-white'
                            : 'bg-[var(--brand-orange)] text-white'
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>
        </div>

        {/* Bottom Actions */}
        <div className="p-3 space-y-2 border-t border-white/15 bg-[var(--brand-red-dark)]/60 shrink-0">
          {!sidebarCollapsed && <PWAInstallButton variant="sidebar" />}
          <button
            type="button"
            title={sidebarCollapsed ? 'تسجيل الخروج' : undefined}
            onClick={onLogout}
            className={`w-full min-h-[42px] rounded-2xl bg-white/12 hover:bg-white/22 text-white px-3.5 py-2 text-sm font-bold flex items-center ${
              sidebarCollapsed ? 'justify-center' : 'gap-2.5'
            } transition-colors`}
          >
            <LogOut className="w-4 h-4 shrink-0" />
            {!sidebarCollapsed && <span>تسجيل الخروج</span>}
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar */}
        <header className="sticky top-0 z-30 bg-white border-b border-[var(--brand-gray-light)] px-4 py-2.5 flex items-center justify-between gap-3 shadow-2xs no-print">
          {/* Right Zone: Mobile Menu + Brand on Mobile / Asia-Aden Clock */}
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="فتح القائمة"
              className="lg:hidden min-h-[42px] min-w-[42px] rounded-2xl border border-[var(--brand-gray-light)] bg-white flex items-center justify-center text-[var(--brand-charcoal)] hover:border-[var(--brand-red)] transition-colors"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="lg:hidden flex items-center gap-2">
              <BrandLogo size="sm" />
              <span className="text-sm font-extrabold text-[var(--brand-red)] whitespace-nowrap">المذاق اليمني</span>
            </div>

            {/* Asia/Aden Clock & Date */}
            <div className="hidden sm:flex items-center gap-2 rounded-2xl border border-[var(--brand-gray-light)] bg-white px-3.5 py-1.5 text-xs shadow-2xs">
              <Clock className="w-4 h-4 text-[var(--brand-red)] shrink-0" />
              <div className="flex items-center gap-2 whitespace-nowrap">
                <span className="text-[var(--brand-charcoal)]/75">توقيت اليمن:</span>
                <span className="font-extrabold font-mono-num text-[var(--brand-charcoal)]">{formatAdenTimeOnly(now)}</span>
                <span className="text-[var(--brand-charcoal)]/40">·</span>
                <span className="text-[var(--brand-charcoal)]/80 hidden md:inline">{formatAdenDateHeader(now)}</span>
              </div>
            </div>
          </div>

          {/* Left Zone: Connection + Audio + Notifications + User Avatar */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Connection status */}
            <div
              className={`min-h-[38px] px-3 rounded-2xl border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap ${
                isOnline && wsConnected
                  ? 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)]'
                  : 'border-[var(--brand-orange)] bg-[var(--brand-orange)]/10 text-[var(--brand-charcoal)]'
              }`}
            >
              {isOnline ? (
                <Wifi className={`w-4 h-4 ${wsConnected ? 'text-[var(--brand-charcoal)]' : 'text-[var(--brand-orange)]'}`} />
              ) : (
                <WifiOff className="w-4 h-4 text-[var(--brand-red)]" />
              )}
              <span className="hidden sm:inline">
                {!isOnline
                  ? 'غير متصل'
                  : wsConnected
                    ? 'متصل مباشر'
                    : 'جاري الربط...'}
              </span>
              {offlineQueueCount > 0 && (
                <span className="font-mono-num text-[var(--brand-red)]">({offlineQueueCount})</span>
              )}
            </div>

            {/* Replay Last Alert & Stop Reading Quick Controls */}
            {audioPlaying && (
              <button
                type="button"
                onClick={() => (onStopReading ? onStopReading() : stopAllAudio())}
                title="إيقاف القراءة الصوتية الحالية"
                className="min-h-[38px] px-3 rounded-2xl border border-[var(--brand-red)] bg-[var(--brand-red)] text-white text-xs font-bold flex items-center gap-1.5 whitespace-nowrap transition-colors hover:bg-[var(--brand-red-dark)]"
              >
                <Square className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">إيقاف القراءة</span>
              </button>
            )}

            {hasLastAlert && onReplayLastAlert && (
              <button
                type="button"
                onClick={onReplayLastAlert}
                title="إعادة قراءة آخر بلاغ بالصوت البشري المختار"
                className="min-h-[38px] px-3 rounded-2xl border border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)] hover:text-[var(--brand-red)] text-xs font-bold flex items-center gap-1.5 whitespace-nowrap transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5 text-[var(--brand-red)]" />
                <span className="hidden lg:inline">إعادة قراءة آخر بلاغ</span>
              </button>
            )}

            {/* Audio Readiness Button */}
            <button
              type="button"
              onClick={() => void handleEnableAudio()}
              title="تفعيل أو اختبار التنبيه الصوتي لهذه المحطة"
              className={`min-h-[38px] px-3 rounded-2xl border text-xs font-bold flex items-center gap-1.5 whitespace-nowrap transition-colors ${
                effectiveAudioError || audioBlocked
                  ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                  : audioUnlocked
                    ? 'border-[var(--brand-orange)]/40 bg-[var(--brand-orange)]/10 text-[var(--brand-orange)] hover:bg-[var(--brand-orange)]/20'
                    : 'border-[var(--brand-orange)] bg-[var(--brand-orange)] text-white'
              }`}
            >
              <Volume2 className="w-4 h-4" />
              <span className="hidden md:inline">
                {effectiveAudioError
                  ? 'فشل تشغيل الصوت'
                  : audioBlocked
                    ? 'اضغط لتشغيل الصوت'
                    : audioUnlocked
                      ? 'الصوت مفعل وجاهز'
                      : 'تفعيل استقبال الصوت'}
              </span>
            </button>

            {/* Notifications Bell with Red Badge */}
            <button
              type="button"
              onClick={() => onNavigate('notifications')}
              aria-label="التنبيهات"
              className="relative min-h-[38px] min-w-[40px] px-2.5 rounded-2xl border border-[var(--brand-gray-light)] bg-white flex items-center justify-center text-[var(--brand-charcoal)] hover:border-[var(--brand-red)] transition-colors"
            >
              <Bell className="w-4 h-4" />
              {unreadCount > 0 && (
                <span className="absolute -top-1.5 -left-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--brand-red)] text-white text-[10px] font-mono-num font-extrabold flex items-center justify-center">
                  {unreadCount}
                </span>
              )}
            </button>

            {/* User Initial Circle */}
            <div
              title={`${user.full_name} · ${user.role_name_ar}`}
              className="hidden sm:flex w-9 h-9 rounded-full bg-[var(--brand-red)] text-white text-sm font-extrabold items-center justify-center shrink-0"
            >
              {userInitial}
            </div>
          </div>
        </header>

        {/* Isolated Test Account Banner */}
        {user.is_test_account && (
          <div className="mx-4 mt-3 rounded-2xl border border-[var(--brand-orange)] bg-[var(--brand-orange)]/15 px-4 py-2.5 text-xs font-extrabold text-[var(--brand-charcoal)] flex items-center justify-between gap-3 no-print">
            <span>
              بيئة اختبار معزولة: هذا الحساب التجريبي مفصول تماماً عن بيانات المطعم الحقيقية وبلاغاتها وتنبيهاتها.
            </span>
            <span className="font-mono-num text-[var(--brand-red)] shrink-0">TEST SANDBOX</span>
          </div>
        )}

        {/* Audio Failure Banner (Real-time Speech / Playback Failure Visibility) */}
        {effectiveAudioError && (
          <div className="mx-4 mt-3 rounded-2xl border border-[var(--brand-red)] bg-[var(--brand-red)] px-4 py-3 text-white flex flex-wrap items-center justify-between gap-3 shadow-sm no-print">
            <div className="flex items-center gap-2.5 text-xs sm:text-sm font-bold min-w-0">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span>تعذر تشغيل القراءة الصوتية للبلاغ: {effectiveAudioError}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void handleEnableAudio()}
                className="min-h-[36px] rounded-xl bg-white px-3.5 text-xs font-extrabold text-[var(--brand-red)] hover:opacity-95"
              >
                إعادة المحاولة والتفعيل
              </button>
              <button
                type="button"
                onClick={() => {
                  setEnableError(null);
                  onClearAudioError?.();
                }}
                aria-label="إغلاق تنبيه الصوت"
                className="min-h-[36px] min-w-[36px] rounded-xl border border-white/40 flex items-center justify-center text-white hover:bg-white/15"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Prominent Audio Autoplay Blocked Notice */}
        {!effectiveAudioError && audioBlocked && (
          <div className="mx-4 mt-3 rounded-2xl border border-[var(--brand-red)] bg-[var(--brand-red)] px-4 py-3 text-white flex flex-wrap items-center justify-between gap-3 shadow-sm no-print">
            <div className="flex items-center gap-2.5 text-xs sm:text-sm font-bold">
              <Volume2 className="w-5 h-5 shrink-0" />
              <span>المتصفح منع التشغيل التلقائي للتنبيه الصوتي — يرجى الضغط لتفعيل الصوت الفوري على هذا الجهاز.</span>
            </div>
            <button
              type="button"
              onClick={() => void handleEnableAudio()}
              className="min-h-[38px] rounded-xl bg-white px-4 text-xs font-extrabold text-[var(--brand-red)] hover:opacity-95"
            >
              تفعيل الصوت الآن
            </button>
          </div>
        )}

        {/* Proactive Entry Audio Initialization Prompt (when browser has not unlocked WebAudio yet) */}
        {!effectiveAudioError && !audioBlocked && !audioUnlocked && (
          <div className="mx-4 mt-3 rounded-2xl border border-[var(--brand-orange)] bg-[var(--brand-orange)]/10 px-4 py-2.5 text-[var(--brand-charcoal)] flex flex-wrap items-center justify-between gap-3 no-print">
            <div className="flex items-center gap-2.5 text-xs font-bold min-w-0">
              <Volume2 className="w-4 h-4 text-[var(--brand-orange)] shrink-0" />
              <span>
                حالة الصوت: <strong className="text-[var(--brand-red)]">بانتظار التفعيل</strong> — لتفادي حظر المتصفح، اضغط لتفعيل استقبال وقراءة البلاغات صوتياً فور دخولك.
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleEnableAudio()}
              className="min-h-[36px] rounded-xl bg-[var(--brand-orange)] px-4 text-xs font-extrabold text-white hover:opacity-95 shrink-0"
            >
              تفعيل استقبال التنبيهات الصوتية
            </button>
          </div>
        )}

        {/* Live WebSocket Alert Toast */}
        {liveToast && (
          <div className="mx-4 mt-3 rounded-2xl border border-[var(--brand-red)] bg-white p-3.5 flex flex-wrap items-center justify-between gap-3 shadow-sm no-print">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-9 h-9 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
                <Bell className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-extrabold text-[var(--brand-red)]">{liveToast.title}</div>
                <div className="text-xs font-semibold text-[var(--brand-charcoal)]">{liveToast.body}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {liveToast.ticket_id && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenTicketFromToast(liveToast.ticket_id!);
                    onDismissToast();
                  }}
                  className="min-h-[36px] rounded-xl bg-[var(--brand-red)] px-3 text-xs font-bold text-white"
                >
                  فتح البلاغ
                </button>
              )}
              <button
                type="button"
                onClick={onDismissToast}
                className="min-h-[36px] min-w-[36px] rounded-xl border border-[var(--brand-gray-light)] flex items-center justify-center text-[var(--brand-charcoal)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Main Viewport */}
        <main className="flex-1 p-4 sm:p-6 pb-24 lg:pb-8">{children}</main>
      </div>

      {/* Mobile Bottom Thumb-Zone Bar */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-[var(--brand-gray-light)] h-16 pb-safe grid grid-cols-4 items-center px-2 no-print">
        <button
          type="button"
          onClick={() => handleSelectNav('dashboard')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${
            activeView === 'dashboard' ? 'text-[var(--brand-red)]' : 'text-[var(--brand-charcoal)]'
          }`}
        >
          <LayoutDashboard className="w-5 h-5" />
          <span>الرئيسية</span>
        </button>

        <button
          type="button"
          onClick={() => handleSelectNav('inbox')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${
            activeView === 'inbox' ? 'text-[var(--brand-red)]' : 'text-[var(--brand-charcoal)]'
          }`}
        >
          <Inbox className="w-5 h-5" />
          <span>الوارد</span>
        </button>

        <button
          type="button"
          onClick={() => handleSelectNav(canCreate ? 'create' : 'open')}
          className={`flex flex-col items-center justify-center gap-0.5 text-[11px] font-bold ${
            activeView === 'create' || activeView === 'open'
              ? 'text-[var(--brand-red)]'
              : 'text-[var(--brand-charcoal)]'
          }`}
        >
          {canCreate ? <FilePlus2 className="w-5 h-5" /> : <FolderOpen className="w-5 h-5" />}
          <span>{canCreate ? 'بلاغ جديد' : 'المفتوحة'}</span>
        </button>

        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className="flex flex-col items-center justify-center gap-0.5 text-[11px] font-bold text-[var(--brand-charcoal)]"
        >
          <Menu className="w-5 h-5" />
          <span>القائمة</span>
        </button>
      </nav>

      {/* Mobile / Tablet Animated Slide-Over Sidebar (Unified Red Brand Identity) */}
      <div
        className={`lg:hidden fixed inset-0 z-50 flex justify-start no-print transition-opacity duration-300 ${
          mobileMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden={!mobileMenuOpen}
      >
        {/* Backdrop */}
        <div
          onClick={() => setMobileMenuOpen(false)}
          className="absolute inset-0 bg-black/45 transition-opacity duration-300"
        />

        {/* Sliding Drawer Panel */}
        <aside
          className={`relative w-full max-w-[290px] bg-[var(--brand-red)] text-white h-full flex flex-col justify-between shadow-2xl transform transition-transform duration-300 ease-out ${
            mobileMenuOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="bg-[var(--brand-red-dark)] p-4 border-b border-white/15 space-y-3 shrink-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center shrink-0">
                    <BrandLogo size="sm" className="h-7 w-7" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-extrabold text-white truncate">المذاق اليمني</div>
                    <div className="text-[11px] text-white/85 truncate">التشغيل الذكي</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="إغلاق القائمة"
                  className="min-h-[38px] min-w-[38px] rounded-xl bg-white/15 hover:bg-white/25 text-white flex items-center justify-center"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="pt-2 border-t border-white/15 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] text-white/75">المستخدم الحالي:</div>
                  <div className="text-xs font-extrabold text-white truncate">{user.full_name}</div>
                </div>
                <span className="rounded-full bg-[var(--brand-orange)] px-2.5 py-0.5 text-[10px] font-bold text-white shrink-0">
                  {user.role_name_ar}
                </span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              <div className="text-xs font-bold text-white/85 px-2 pb-0.5">أقسام النظام</div>
              {visibleNav.map((item) => {
                const Icon = item.icon;
                const isActive = activeView === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectNav(item.id)}
                    className={`w-full min-h-[46px] rounded-2xl px-3.5 py-2 flex items-center justify-between text-sm font-bold transition-colors ${
                      isActive
                        ? 'bg-white text-[var(--brand-red)] shadow-sm'
                        : 'text-white hover:bg-[var(--brand-red-dark)]/80'
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon className={`w-4 h-4 ${isActive ? 'text-[var(--brand-red)]' : 'text-white'}`} />
                      <span>{item.label}</span>
                    </span>
                    {typeof item.badge === 'number' && item.badge > 0 && (
                      <span
                        className={`font-mono-num text-xs font-extrabold px-2 py-0.5 rounded-full ${
                          isActive ? 'bg-[var(--brand-red)] text-white' : 'bg-[var(--brand-orange)] text-white'
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="p-3 border-t border-white/15 bg-[var(--brand-red-dark)]/60 space-y-2 shrink-0">
            <PWAInstallButton variant="sidebar" />
            <button
              type="button"
              onClick={onLogout}
              className="w-full min-h-[44px] rounded-2xl bg-white/15 hover:bg-white/25 text-white font-bold text-sm flex items-center justify-center gap-2"
            >
              <LogOut className="w-4 h-4" />
              <span>تسجيل الخروج</span>
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
};
