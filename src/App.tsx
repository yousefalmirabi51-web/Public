import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiRequest,
  getAuthToken,
  getTotalOfflineQueueCount,
  setAuthToken,
  syncAllOfflineQueues,
} from './api/client';
import { LoginScreen } from './components/LoginScreen';
import { MainLayout } from './components/MainLayout';
import { SplashScreen } from './components/SplashScreen';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { CreateTicketScreen } from './screens/CreateTicketScreen';
import { DashboardScreen, type NavView } from './screens/DashboardScreen';
import { NotificationsScreen } from './screens/NotificationsScreen';
import { ReportsScreen } from './screens/ReportsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SoundManagementScreen } from './screens/SoundManagementScreen';
import { SystemReadinessScreen } from './screens/SystemReadinessScreen';
import { TicketDetailScreen } from './screens/TicketDetailScreen';
import { TicketListScreen } from './screens/TicketListScreen';
import { UsersScreen } from './screens/UsersScreen';
import {
  AUDIO_PERMISSION_CODES,
  type NotificationItem,
  type PlaybackDiagnosticStatus,
  type StationAudioSetting,
  type TicketDetail,
  type UserProfile,
  type VoiceReaderSetting,
} from './types/domain';
import {
  enqueueStationAlert,
  getStationCodeForDepartment,
  getVoiceReaderChannelForNotification,
  replayAlertAudio,
  resolveAudioSettingForNotification,
  resolveVoiceReaderSettingForNotification,
  setupGlobalAudioUnlock,
  stopAllAudio,
  type AudioAlertPlaybackResult,
} from './utils/audioAlerts';

const LAST_SPOKEN_PREFIX = 'almazaq_last_spoken_u_';

function loadLastSpokenAlert(userId: number): NotificationItem | null {
  try {
    const raw = localStorage.getItem(`${LAST_SPOKEN_PREFIX}${userId}`);
    return raw ? (JSON.parse(raw) as NotificationItem) : null;
  } catch {
    return null;
  }
}

function saveLastSpokenAlert(userId: number, notif: NotificationItem) {
  try {
    localStorage.setItem(`${LAST_SPOKEN_PREFIX}${userId}`, JSON.stringify(notif));
  } catch {
    // ignore storage errors
  }
}

export default function App() {
  const isOnline = useOnlineStatus();
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [token, setToken] = useState<string | null>(() => getAuthToken());
  const [activeView, setActiveView] = useState<NavView>('dashboard');
  const [selectedTicketId, setSelectedTicketId] = useState<number | null>(null);
  const [detailScope, setDetailScope] = useState<'all' | 'assembly_support'>('all');

  const [supportCreatePrefill, setSupportCreatePrefill] = useState<{
    active: boolean;
    invoice: string;
    item: string;
    parentId: number | null;
  }>({ active: false, invoice: '', item: '', parentId: null });

  const [wsConnected, setWsConnected] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [voiceLibraryRefreshTick, setVoiceLibraryRefreshTick] = useState(0);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [stationAudioSettings, setStationAudioSettings] = useState<StationAudioSetting[]>([]);
  const [voiceReaderSettings, setVoiceReaderSettings] = useState<VoiceReaderSetting[]>([]);
  const [lastSpokenAlert, setLastSpokenAlert] = useState<NotificationItem | null>(null);
  const [liveToast, setLiveToast] = useState<NotificationItem | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [offlineQueueCount, setOfflineQueueCount] = useState(() => getTotalOfflineQueueCount());

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const stationSettingsRef = useRef<StationAudioSetting[]>([]);
  const voiceReaderSettingsRef = useRef<VoiceReaderSetting[]>([]);
  const userRef = useRef<UserProfile | null>(null);
  const tokenRef = useRef<string | null>(token);
  const seenNotifIdsRef = useRef<Set<number>>(new Set());
  const notificationsBootstrappedRef = useRef(false);
  const diagRequestedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    stationSettingsRef.current = stationAudioSettings;
  }, [stationAudioSettings]);

  useEffect(() => {
    voiceReaderSettingsRef.current = voiceReaderSettings;
  }, [voiceReaderSettings]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    setupGlobalAudioUnlock(() => setAudioBlocked(false));
  }, []);

  const bumpRefresh = useCallback(() => {
    setRefreshTick((t) => t + 1);
  }, []);

  const handleSoundSettingsChanged = useCallback((next: StationAudioSetting[]) => {
    stationSettingsRef.current = next;
    setStationAudioSettings(next);
  }, []);

  const handleVoiceReaderSettingsChanged = useCallback((next: VoiceReaderSetting[]) => {
    voiceReaderSettingsRef.current = next;
    setVoiceReaderSettings(next);
  }, []);

  const resolveStationSettingForUser = useCallback((u: UserProfile): StationAudioSetting | null => {
    const code = getStationCodeForDepartment(u.department_code);
    const list = stationSettingsRef.current;
    return list.find((s) => s.station_code === code) || list.find((s) => s.station_code === 'general') || null;
  }, []);

  const resolveVoiceReaderForUser = useCallback((u: UserProfile): VoiceReaderSetting | null => {
    const code = getVoiceReaderChannelForNotification(u.department_code, null);
    const list = voiceReaderSettingsRef.current;
    return list.find((s) => s.channel_code === code) || list.find((s) => s.channel_code === 'general') || null;
  }, []);

  const fetchAudioSettings = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      const [stationRes, readerRes] = await Promise.all([
        apiRequest<{ settings: StationAudioSetting[] }>('/api/audio/settings'),
        apiRequest<{ settings: VoiceReaderSetting[] }>('/api/audio/voice-reader/settings'),
      ]);
      stationSettingsRef.current = stationRes.settings;
      setStationAudioSettings(stationRes.settings);
      voiceReaderSettingsRef.current = readerRes.settings;
      setVoiceReaderSettings(readerRes.settings);
    } catch {
      // ignore transient fetch failure
    }
  }, []);

  const reportAudioDiagnostic = useCallback(
    (payload: {
      client_diag_uid: string;
      notification_id: number | null;
      ticket_id: number | null;
      ticket_number: string | null;
      invoice_number: string | null;
      target_department: string | null;
      channel_code: string | null;
      selected_voice_id: number | null;
      selected_voice_name: string | null;
      selected_prebuilt_voice: string | null;
      selected_tone_name: string | null;
      event_type: string | null;
      spoken_text: string | null;
      alert_arrived_at: string;
      playback_requested: boolean;
      playback_started: boolean;
      playback_completed: boolean;
      playback_status: PlaybackDiagnosticStatus;
      tts_engine?: string | null;
      failure_reason?: string | null;
    }) => {
      if (!getAuthToken()) return;
      void apiRequest('/api/audio/diagnostics', {
        method: 'POST',
        body: JSON.stringify(payload),
      }).catch(() => {});
    },
    []
  );

  const triggerAudioForNotification = useCallback(
    async (notif: NotificationItem, currentUser: UserProfile, currentToken: string | null) => {
      // Strictly play audio ONLY in the receiving target department, NEVER in the sender's department
      if (!notif.should_play_audio) return;
      if (notif.target_department && notif.target_department !== currentUser.department_code) return;
      if (
        notif.event_type !== 'escalated' &&
        notif.sender_department_code &&
        notif.sender_department_code === currentUser.department_code
      ) {
        return;
      }

      if (stationSettingsRef.current.length === 0 || voiceReaderSettingsRef.current.length === 0) {
        await fetchAudioSettings();
      }

      const stationSetting = resolveAudioSettingForNotification(
        stationSettingsRef.current,
        currentUser.department_code,
        notif
      );
      const voiceReaderSetting = resolveVoiceReaderSettingForNotification(
        voiceReaderSettingsRef.current,
        currentUser.department_code,
        notif
      );
      const channelCode = getVoiceReaderChannelForNotification(currentUser.department_code, notif);
      const targetDept = notif.target_department || currentUser.department_code;
      const alertKey = notif.message_uid || `notif-${notif.id}`;
      const diagUid = `${currentUser.id}:${alertKey}`;
      const speechText = notif.spoken_text || `${notif.title}. ${notif.body}`;
      const arrivedAt = notif.created_at || new Date().toISOString();

      const diagBase = {
        client_diag_uid: diagUid,
        notification_id: notif.id,
        ticket_id: notif.ticket_id ?? null,
        ticket_number: notif.ticket_number ?? null,
        invoice_number: notif.invoice_number ?? null,
        target_department: targetDept,
        channel_code: channelCode,
        selected_voice_id:
          voiceReaderSetting?.resolved_human_voice_id ?? voiceReaderSetting?.human_voice_id ?? null,
        selected_voice_name:
          voiceReaderSetting?.resolved_human_voice_name || voiceReaderSetting?.human_voice_name || null,
        selected_prebuilt_voice: voiceReaderSetting?.resolved_prebuilt_voice_name || null,
        selected_tone_name:
          stationSetting?.audio_file_name || stationSetting?.resolved_audio_file_name || null,
        event_type: notif.event_type || null,
        spoken_text: speechText,
        alert_arrived_at: arrivedAt,
      };

      setLastSpokenAlert(notif);
      saveLastSpokenAlert(currentUser.id, notif);

      if (!diagRequestedKeysRef.current.has(diagUid)) {
        diagRequestedKeysRef.current.add(diagUid);
        reportAudioDiagnostic({
          ...diagBase,
          playback_requested: true,
          playback_started: false,
          playback_completed: false,
          playback_status: 'requested',
        });
      }

      enqueueStationAlert({
        userId: currentUser.id,
        alertKey,
        text: speechText,
        stationSetting,
        voiceReaderSetting,
        channelCode,
        departmentCode: targetDept,
        notificationMeta: { urgency_level: notif.urgency_level, event_type: notif.event_type },
        authToken: currentToken,
        onStarted: () => {
          reportAudioDiagnostic({
            ...diagBase,
            playback_requested: true,
            playback_started: true,
            playback_completed: false,
            playback_status: 'started',
          });
        },
        onPlayed: (_key, result: AudioAlertPlaybackResult) => {
          setAudioError(null);
          setAudioBlocked(false);
          reportAudioDiagnostic({
            ...diagBase,
            selected_prebuilt_voice:
              result.selectedVoiceName || diagBase.selected_prebuilt_voice,
            playback_requested: true,
            playback_started: true,
            playback_completed: true,
            playback_status: 'completed',
            tts_engine: result.ttsEngine || null,
          });
          // Confirm delivery without marking notification as read
          if (!notif.delivered_at) {
            void apiRequest(`/api/notifications/${notif.id}/delivered`, {
              method: 'POST',
              body: JSON.stringify({}),
            }).catch(() => {});
          }
        },
        onBlocked: () => {
          setAudioBlocked(true);
          reportAudioDiagnostic({
            ...diagBase,
            playback_requested: true,
            playback_started: false,
            playback_completed: false,
            playback_status: 'blocked',
            failure_reason: 'المتصفح منع التشغيل التلقائي للصوت — بانتظار التفعيل من المستخدم',
          });
        },
        onFailed: (reason, result: AudioAlertPlaybackResult) => {
          setAudioError(reason);
          reportAudioDiagnostic({
            ...diagBase,
            selected_prebuilt_voice:
              result.selectedVoiceName || diagBase.selected_prebuilt_voice,
            playback_requested: true,
            playback_started: true,
            playback_completed: false,
            playback_status: 'failed',
            tts_engine: result.ttsEngine || null,
            failure_reason: reason,
          });
        },
      });
    },
    [fetchAudioSettings, reportAudioDiagnostic]
  );

  const fetchNotifications = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      const res = await apiRequest<{ notifications: NotificationItem[] }>('/api/notifications');
      const incoming = res.notifications || [];
      setNotifications(incoming);

      const newlyDiscoveredUnread: NotificationItem[] = [];
      for (const n of incoming) {
        if (!seenNotifIdsRef.current.has(n.id)) {
          seenNotifIdsRef.current.add(n.id);
          if (notificationsBootstrappedRef.current && !n.is_read) {
            newlyDiscoveredUnread.push(n);
          }
        }
      }
      if (!notificationsBootstrappedRef.current) {
        notificationsBootstrappedRef.current = true;
      } else if (newlyDiscoveredUnread.length > 0) {
        setLiveToast((prev) => prev || newlyDiscoveredUnread[0]);
      }

      // Deliver missed undelivered unread audio alerts created within the last 10 minutes
      const activeUser = userRef.current;
      const activeToken = tokenRef.current;
      if (activeUser) {
        const tenMinsAgo = Date.now() - 10 * 60 * 1000;
        const missedAudioNotifs = [...incoming]
          .filter(
            (n) =>
              !n.delivered_at &&
              !n.is_read &&
              n.should_play_audio &&
              (!n.target_department || n.target_department === activeUser.department_code) &&
              (n.event_type === 'escalated' || n.sender_department_code !== activeUser.department_code) &&
              new Date(n.created_at).getTime() >= tenMinsAgo
          )
          .reverse(); // chronological FIFO order

        if (
          missedAudioNotifs.length > 0 &&
          (stationSettingsRef.current.length === 0 || voiceReaderSettingsRef.current.length === 0)
        ) {
          await fetchAudioSettings();
        }
        for (const n of missedAudioNotifs) {
          await triggerAudioForNotification(n, activeUser, activeToken);
        }
      }
    } catch {
      // ignore transient error
    }
  }, [fetchAudioSettings, triggerAudioForNotification]);

  // Restore session on boot
  useEffect(() => {
    const existingToken = getAuthToken();
    if (!existingToken) {
      setBooting(false);
      return;
    }

    apiRequest<{ user: UserProfile }>('/api/auth/me')
      .then(async (res) => {
        userRef.current = res.user;
        tokenRef.current = existingToken;
        setUser(res.user);
        setToken(existingToken);
        setLastSpokenAlert(loadLastSpokenAlert(res.user.id));
        await fetchAudioSettings();
        await fetchNotifications();
      })
      .catch(() => {
        setAuthToken(null);
        setToken(null);
        setUser(null);
      })
      .finally(() => {
        setTimeout(() => setBooting(false), 350);
      });
  }, [fetchAudioSettings, fetchNotifications]);

  // Sync offline queues (tickets + actions) whenever online returns
  useEffect(() => {
    if (!user || !isOnline) return;
    void syncAllOfflineQueues().then((res) => {
      setOfflineQueueCount(res.remainingCount);
      if (res.synced > 0) {
        bumpRefresh();
        void fetchNotifications();
      }
    });
  }, [user, isOnline, bumpRefresh, fetchNotifications]);

  const userId = user?.id ?? null;

  // WebSocket live connection with automatic reconnect + resilient fallback sync
  useEffect(() => {
    if (!userId || !token) return;

    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!cancelled) {
          setWsConnected(true);
          void fetchAudioSettings();
          void fetchNotifications();
        }
      };

      ws.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data) as {
            type: string;
            notification?: NotificationItem | null;
            data?: {
              settings?: StationAudioSetting[] | VoiceReaderSetting[];
              userId?: number;
            };
          };
          if (payload.type === 'connected') return;

          if (payload.type === 'audio_settings_updated' && payload.data?.settings) {
            const nextStation = payload.data.settings as StationAudioSetting[];
            stationSettingsRef.current = nextStation;
            setStationAudioSettings(nextStation);
            return;
          }
          if (payload.type === 'voice_reader_settings_updated' && payload.data?.settings) {
            const nextReader = payload.data.settings as VoiceReaderSetting[];
            voiceReaderSettingsRef.current = nextReader;
            setVoiceReaderSettings(nextReader);
            return;
          }
          if (payload.type === 'human_voices_updated') {
            setVoiceLibraryRefreshTick((v) => v + 1);
            return;
          }
          if (payload.type === 'user_permissions_updated') {
            if (payload.data?.userId && payload.data.userId === userRef.current?.id) {
              void apiRequest<{ user: UserProfile }>('/api/auth/me')
                .then((res) => {
                  userRef.current = res.user;
                  setUser(res.user);
                })
                .catch(() => {});
            }
            return;
          }
          if (payload.type === 'responsibles_updated' || payload.type === 'escalation_settings_updated') {
            bumpRefresh();
            return;
          }
          if (payload.type === 'system_restored') {
            bumpRefresh();
            void fetchAudioSettings();
            void fetchNotifications();
            return;
          }

          bumpRefresh();
          void fetchNotifications();

          if (payload.notification) {
            seenNotifIdsRef.current.add(payload.notification.id);
            setLiveToast(payload.notification);
            const activeUser = userRef.current;
            if (activeUser) {
              void triggerAudioForNotification(payload.notification, activeUser, tokenRef.current);
            }
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setWsConnected(false);
        reconnectTimerRef.current = window.setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    const syncFallback = () => {
      if (cancelled) return;
      void fetchNotifications();
      void fetchAudioSettings();
    };
    const pollInterval = window.setInterval(syncFallback, 15000);
    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        syncFallback();
      }
    };
    window.addEventListener('focus', onVisibilityOrFocus);
    document.addEventListener('visibilitychange', onVisibilityOrFocus);

    return () => {
      cancelled = true;
      window.clearInterval(pollInterval);
      window.removeEventListener('focus', onVisibilityOrFocus);
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close();
      setWsConnected(false);
    };
  }, [userId, token, bumpRefresh, fetchAudioSettings, fetchNotifications, triggerAudioForNotification]);

  const handleLoginSuccess = async (loggedInUser: UserProfile, newToken: string) => {
    seenNotifIdsRef.current.clear();
    diagRequestedKeysRef.current.clear();
    notificationsBootstrappedRef.current = false;
    setAudioError(null);
    setAudioBlocked(false);
    userRef.current = loggedInUser;
    tokenRef.current = newToken;
    setUser(loggedInUser);
    setToken(newToken);
    setLastSpokenAlert(loadLastSpokenAlert(loggedInUser.id));
    setActiveView('dashboard');
    setSelectedTicketId(null);
    await fetchAudioSettings();
    await fetchNotifications();
  };

  const handleLogout = () => {
    stopAllAudio();
    seenNotifIdsRef.current.clear();
    diagRequestedKeysRef.current.clear();
    notificationsBootstrappedRef.current = false;
    setAudioError(null);
    setAudioBlocked(false);
    setAuthToken(null);
    setToken(null);
    setUser(null);
    userRef.current = null;
    tokenRef.current = null;
    setSelectedTicketId(null);
    setActiveView('dashboard');
    setNotifications([]);
    setStationAudioSettings([]);
    setVoiceReaderSettings([]);
    setLastSpokenAlert(null);
  };

  const handleNavigate = (view: NavView) => {
    setSelectedTicketId(null);
    setSupportCreatePrefill({ active: false, invoice: '', item: '', parentId: null });
    setActiveView(view);
  };

  const handleSelectTicket = (ticketId: number, scope: 'all' | 'assembly_support' = 'all') => {
    setDetailScope(scope);
    setSelectedTicketId(ticketId);
  };

  if (booting) {
    return <SplashScreen />;
  }

  if (!user) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  const unreadCount = notifications.filter((n) => !n.is_read).length;
  const activeStationSetting = resolveStationSettingForUser(user);
  const activeVoiceReaderSetting = resolveVoiceReaderForUser(user);
  const effectiveLastAlert =
    lastSpokenAlert || notifications.find((n) => Boolean(n.spoken_text || n.body)) || null;

  const handleReplayLastAlert = () => {
    if (!effectiveLastAlert) return;
    const stationSetting = resolveAudioSettingForNotification(
      stationSettingsRef.current,
      user.department_code,
      effectiveLastAlert
    );
    const voiceReaderSetting = resolveVoiceReaderSettingForNotification(
      voiceReaderSettingsRef.current,
      user.department_code,
      effectiveLastAlert
    );
    const channelCode = getVoiceReaderChannelForNotification(user.department_code, effectiveLastAlert);
    const text = effectiveLastAlert.spoken_text || `${effectiveLastAlert.title}. ${effectiveLastAlert.body}`;
    void replayAlertAudio({
      text,
      stationSetting,
      voiceReaderSetting,
      channelCode,
      departmentCode: effectiveLastAlert.target_department || user.department_code,
      notificationMeta: {
        urgency_level: effectiveLastAlert.urgency_level,
        event_type: effectiveLastAlert.event_type,
      },
      authToken: token,
    }).then((res) => {
      if (!res.ok) {
        if (res.blocked) setAudioBlocked(true);
        else if (res.error) setAudioError(res.error);
      } else {
        setAudioError(null);
        setAudioBlocked(false);
      }
    });
  };

  const renderContent = () => {
    if (selectedTicketId !== null) {
      return (
        <TicketDetailScreen
          user={user}
          ticketId={selectedTicketId}
          scope={detailScope}
          refreshTick={refreshTick}
          onBack={() => setSelectedTicketId(null)}
          onChanged={() => {
            bumpRefresh();
            void fetchNotifications();
          }}
          onOfflineQueued={() => {
            setOfflineQueueCount(getTotalOfflineQueueCount());
          }}
          onCreateSupportChild={(invoice, item, parentId) => {
            setSelectedTicketId(null);
            setSupportCreatePrefill({ active: true, invoice, item, parentId });
            setActiveView('create');
          }}
        />
      );
    }

    switch (activeView) {
      case 'dashboard':
        return (
          <DashboardScreen
            user={user}
            refreshTick={refreshTick}
            onNavigate={handleNavigate}
            onSelectTicket={(id) => handleSelectTicket(id, 'all')}
          />
        );

      case 'create':
        return (
          <CreateTicketScreen
            user={user}
            viaSupport={supportCreatePrefill.active}
            prefillInvoice={supportCreatePrefill.invoice}
            prefillItem={supportCreatePrefill.item}
            parentTicketId={supportCreatePrefill.parentId}
            onCreated={(ticket: TicketDetail) => {
              setSupportCreatePrefill({ active: false, invoice: '', item: '', parentId: null });
              bumpRefresh();
              setSelectedTicketId(ticket.id);
            }}
            onOfflineQueued={() => {
              setOfflineQueueCount(getTotalOfflineQueueCount());
            }}
            onCancel={() => handleNavigate(supportCreatePrefill.active ? 'assembly_support' : 'dashboard')}
          />
        );

      case 'inbox':
        return (
          <TicketListScreen
            user={user}
            scope="inbox"
            title="صندوق الوارد"
            subtitle="البلاغات الجديدة وقيد المعالجة الموجهة لقسمك فقط"
            refreshTick={refreshTick}
            onSelectTicket={(id) => handleSelectTicket(id, 'all')}
            onCreateNew={() => handleNavigate('create')}
          />
        );

      case 'open':
        return (
          <TicketListScreen
            user={user}
            scope="open"
            title="البلاغات المفتوحة"
            subtitle="جميع البلاغات الجارية التي لم تُغلق بعد ضمن صلاحياتك"
            refreshTick={refreshTick}
            onSelectTicket={(id) => handleSelectTicket(id, 'all')}
            onCreateNew={() => handleNavigate('create')}
          />
        );

      case 'delayed':
        return (
          <TicketListScreen
            user={user}
            scope="delayed"
            title="البلاغات المتأخرة والمصعدة"
            subtitle="الطلبات المتعثرة التي تجاوزت مدة التنبيه الأولى"
            refreshTick={refreshTick}
            onSelectTicket={(id) => handleSelectTicket(id, 'all')}
            onCreateNew={() => handleNavigate('create')}
          />
        );

      case 'history':
        return (
          <TicketListScreen
            user={user}
            scope="all"
            title="سجل البلاغات الكامل"
            subtitle="كافة البلاغات المفتوحة والمغلقة ضمن نطاق صلاحياتك"
            refreshTick={refreshTick}
            onSelectTicket={(id) => handleSelectTicket(id, 'all')}
            onCreateNew={() => handleNavigate('create')}
          />
        );

      case 'assembly_support':
        if (!user.has_assembly_support) {
          return (
            <div className="rounded-2xl border border-[#EF1923] bg-white p-6 text-center text-sm font-bold text-[#EF1923]">
              ليس لديك صلاحية مساندة قسم التجميع
            </div>
          );
        }
        return (
          <TicketListScreen
            user={user}
            scope="assembly_support"
            title="مساندة قسم التجميع"
            subtitle="صلاحية اختيارية لمتابعة أصناف الإنتاج والتجميع المتأخرة والناقصة"
            refreshTick={refreshTick}
            onSelectTicket={(id) => handleSelectTicket(id, 'assembly_support')}
            onCreateSupportTicket={() => {
              setSupportCreatePrefill({ active: true, invoice: '', item: '', parentId: null });
              setActiveView('create');
            }}
          />
        );

      case 'reports':
        return (
          <ReportsScreen
            user={user}
            refreshTick={refreshTick}
            onSelectTicket={(id) => handleSelectTicket(id, 'all')}
          />
        );

      case 'notifications':
        return (
          <NotificationsScreen
            notifications={notifications}
            stationAudioSettings={stationAudioSettings}
            voiceReaderSettings={voiceReaderSettings}
            userDepartment={user.department_code}
            authToken={token}
            onSelectTicket={(id) => handleSelectTicket(id, 'all')}
            onRefresh={() => void fetchNotifications()}
          />
        );

      case 'sounds':
        return (
          <SoundManagementScreen
            user={user}
            refreshSignal={voiceLibraryRefreshTick}
            onSettingsChanged={handleSoundSettingsChanged}
            onVoiceReaderSettingsChanged={handleVoiceReaderSettingsChanged}
          />
        );

      case 'readiness': {
        const canAccessSoundMgmt =
          user.role_code === 'admin' ||
          user.permissions.includes('manage_settings') ||
          AUDIO_PERMISSION_CODES.some((c) => user.permissions.includes(c));
        return (
          <SystemReadinessScreen
            user={user}
            refreshTick={refreshTick}
            onSystemRestored={() => {
              bumpRefresh();
              void fetchAudioSettings();
              void fetchNotifications();
            }}
            onOpenSoundManagement={canAccessSoundMgmt ? () => handleNavigate('sounds') : undefined}
          />
        );
      }

      case 'users':
        return <UsersScreen currentUser={user} />;

      case 'settings': {
        const canAccessSoundMgmt =
          user.role_code === 'admin' ||
          user.permissions.includes('manage_settings') ||
          AUDIO_PERMISSION_CODES.some((c) => user.permissions.includes(c));
        return (
          <SettingsScreen
            user={user}
            stationAudioSettings={stationAudioSettings}
            refreshTick={refreshTick}
            onOpenSoundManagement={canAccessSoundMgmt ? () => handleNavigate('sounds') : undefined}
            onQueueSynced={() => {
              setOfflineQueueCount(getTotalOfflineQueueCount());
              bumpRefresh();
            }}
          />
        );
      }

      default:
        return null;
    }
  };

  return (
    <MainLayout
      user={user}
      activeView={activeView}
      wsConnected={wsConnected}
      isOnline={isOnline}
      offlineQueueCount={offlineQueueCount}
      unreadCount={unreadCount}
      liveToast={liveToast}
      stationAudioSetting={activeStationSetting}
      voiceReaderSetting={activeVoiceReaderSetting}
      hasLastAlert={Boolean(effectiveLastAlert)}
      authToken={token}
      audioBlocked={audioBlocked}
      audioError={audioError}
      onClearAudioError={() => setAudioError(null)}
      onAudioUnlocked={() => {
        setAudioBlocked(false);
        setAudioError(null);
      }}
      onReplayLastAlert={handleReplayLastAlert}
      onStopReading={stopAllAudio}
      onDismissToast={() => setLiveToast(null)}
      onOpenTicketFromToast={(id) => handleSelectTicket(id, 'all')}
      onNavigate={handleNavigate}
      onLogout={handleLogout}
    >
      {renderContent()}
    </MainLayout>
  );
}
