import React, { useEffect, useState } from 'react';
import { Bell, CheckCheck, ChevronLeft, Square, Volume2 } from 'lucide-react';
import { apiRequest } from '../api/client';
import type {
  DepartmentCode,
  NotificationItem,
  StationAudioSetting,
  VoiceReaderSetting,
} from '../types/domain';
import {
  isStationAudioPlaying,
  onAudioPlaybackStateChange,
  replayAlertAudio,
  resolveAudioSettingForNotification,
  resolveVoiceReaderSettingForNotification,
  stopAllAudio,
} from '../utils/audioAlerts';
import { formatAdenDateTime } from '../utils/time';

interface NotificationsScreenProps {
  notifications: NotificationItem[];
  stationAudioSettings?: StationAudioSetting[];
  voiceReaderSettings?: VoiceReaderSetting[];
  userDepartment?: DepartmentCode | null;
  authToken?: string | null;
  onSelectTicket: (ticketId: number) => void;
  onRefresh: () => void;
}

export const NotificationsScreen: React.FC<NotificationsScreenProps> = ({
  notifications,
  stationAudioSettings = [],
  voiceReaderSettings = [],
  userDepartment,
  authToken,
  onSelectTicket,
  onRefresh,
}) => {
  const unreadCount = notifications.filter((n) => !n.is_read).length;
  const [audioPlaying, setAudioPlaying] = useState(() => isStationAudioPlaying());
  const [readingId, setReadingId] = useState<number | null>(null);

  useEffect(() => {
    return onAudioPlaybackStateChange((playing) => {
      setAudioPlaying(playing);
      if (!playing) setReadingId(null);
    });
  }, []);

  const markAllRead = async () => {
    await apiRequest('/api/notifications/read-all', { method: 'POST' });
    onRefresh();
  };

  const handleOpen = async (n: NotificationItem) => {
    if (!n.is_read) {
      await apiRequest(`/api/notifications/${n.id}/read`, { method: 'POST' });
      onRefresh();
    }
    if (n.ticket_id) {
      onSelectTicket(n.ticket_id);
    }
  };

  const handleReadNotification = async (e: React.MouseEvent, n: NotificationItem) => {
    e.stopPropagation();
    setReadingId(n.id);
    const stationSetting = resolveAudioSettingForNotification(stationAudioSettings, userDepartment, n);
    const voiceReaderSetting = resolveVoiceReaderSettingForNotification(voiceReaderSettings, userDepartment, n);
    const text = n.spoken_text || `${n.title}. ${n.body}`;
    await replayAlertAudio({
      text,
      stationSetting,
      voiceReaderSetting,
      notificationMeta: { urgency_level: n.urgency_level, event_type: n.event_type },
      authToken,
    });
    setReadingId((cur) => (cur === n.id ? null : cur));
  };

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-[var(--brand-charcoal)]">مركز التنبيهات والإشعارات</h2>
          <p className="text-sm text-[var(--brand-charcoal)]/80 font-mono-num">
            {unreadCount > 0 ? `لديك ${unreadCount} تنبيه غير مقروء` : 'جميع التنبيهات مقروءة'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {audioPlaying && (
            <button
              type="button"
              onClick={() => {
                stopAllAudio();
                setReadingId(null);
              }}
              className="min-h-[44px] inline-flex items-center gap-2 rounded-2xl bg-[var(--brand-red)] px-4 text-sm font-bold text-white hover:bg-[var(--brand-red-dark)] transition-colors"
            >
              <Square className="w-4 h-4" />
              <span>إيقاف القراءة</span>
            </button>
          )}
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="min-h-[44px] inline-flex items-center gap-2 rounded-2xl border border-[var(--brand-red)] bg-white px-4 text-sm font-bold text-[var(--brand-red)] hover:bg-[var(--brand-red)] hover:text-white transition-colors"
            >
              <CheckCheck className="w-4 h-4" />
              <span>تحديد الكل كمقروء</span>
            </button>
          )}
        </div>
      </div>

      {notifications.length === 0 ? (
        <div className="app-card p-10 text-center">
          <Bell className="w-10 h-10 text-[var(--brand-charcoal)]/45 mx-auto" />
          <p className="mt-2 text-base font-bold text-[var(--brand-charcoal)]">لا توجد تنبيهات مسجلة حتى الآن</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {notifications.map((n) => (
            <div
              key={n.id}
              role="button"
              tabIndex={0}
              onClick={() => void handleOpen(n)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void handleOpen(n);
                }
              }}
              className={`w-full text-right p-4 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 cursor-pointer ${
                !n.is_read ? 'app-card-urgent hover:shadow-md transition-shadow' : 'app-card-interactive'
              }`}
            >
              <div className="flex items-start gap-3.5 min-w-0 flex-1">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-white ${
                    !n.is_read ? 'bg-[var(--brand-red)]' : 'bg-[var(--brand-charcoal)]/70'
                  }`}
                >
                  <Bell className="w-5 h-5" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-[var(--brand-charcoal)]">{n.title}</span>
                    {!n.is_read && <span className="text-xs font-extrabold text-[var(--brand-red)]">· جديد</span>}
                  </div>
                  <p className="text-sm text-[var(--brand-charcoal)]/90">{n.body}</p>
                  <div className="text-xs text-[var(--brand-charcoal)]/75 font-mono-num">
                    {formatAdenDateTime(n.created_at)}
                    {n.sender_department ? ` · ${n.sender_department}` : ''}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={(e) => void handleReadNotification(e, n)}
                  className={`min-h-[38px] inline-flex items-center gap-1.5 rounded-xl border px-3 text-xs font-bold transition-colors ${
                    readingId === n.id
                      ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)] text-white'
                      : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-orange)]'
                  }`}
                >
                  <Volume2 className={`w-3.5 h-3.5 ${readingId === n.id ? 'text-white' : 'text-[var(--brand-orange)]'}`} />
                  <span>{readingId === n.id ? 'جاري القراءة...' : 'قراءة البلاغ'}</span>
                </button>
                <ChevronLeft className="w-5 h-5 text-[var(--brand-charcoal)]/60 shrink-0" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
