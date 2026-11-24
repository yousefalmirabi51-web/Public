import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Edit3,
  GitCompare,
  Lock,
  Mic,
  Music,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Star,
  Trash2,
  Upload,
  UserCheck,
  Volume2,
} from 'lucide-react';
import { apiRequest, getAuthToken } from '../api/client';
import {
  AUDIO_PERMISSION_CODES,
  GEMINI_PREBUILT_VOICES,
  PLAYBACK_RATE_OPTIONS,
  STATION_CHANNEL_LABELS,
  VOICE_READER_CHANNEL_LABELS,
  type AudioDiagnosticRecord,
  type AudioFileRecord,
  type HumanVoiceRecord,
  type StationAudioSetting,
  type StationCode,
  type UserProfile,
  type VoiceKind,
  type VoiceReaderChannelCode,
  type VoiceReaderSetting,
} from '../types/domain';
import {
  isStationAudioPlaying,
  onAudioPlaybackStateChange,
  previewHumanVoice,
  previewStationAudio,
  stopAllAudio,
} from '../utils/audioAlerts';
import { formatAdenDateTime } from '../utils/time';

interface SoundManagementScreenProps {
  user: UserProfile;
  refreshSignal?: number;
  onSettingsChanged: (settings: StationAudioSetting[]) => void;
  onVoiceReaderSettingsChanged?: (settings: VoiceReaderSetting[]) => void;
}

type SoundTab = 'voice_reader' | 'alert_tones' | 'diagnostics';

const DEPT_LABELS_AR: Record<string, string> = {
  production: 'قسم الإنتاج',
  assembly: 'قسم التجميع والتسليم',
  hall: 'إدارة الصالة',
  admin: 'الإدارة العامة',
  general: 'عام',
};

const DIAG_STATUS_LABELS: Record<string, string> = {
  requested: 'تم طلب التشغيل',
  started: 'بدأ التشغيل',
  completed: 'اكتمل بنجاح',
  blocked: 'محظور من المتصفح',
  failed: 'فشل التشغيل',
};

const ACCEPTED_AUDIO =
  '.mp3,.wav,.m4a,.ogg,.webm,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/ogg,audio/webm';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result);
    };
    reader.onerror = () => reject(new Error('تعذر قراءة الملف الصوتي'));
    reader.readAsDataURL(file);
  });
}

function getVoiceKindBadgeLabel(voice: HumanVoiceRecord): string {
  if (voice.voice_kind === 'ai_human') {
    return `صوت بشري ذكي (${voice.prebuilt_voice_name || 'Kore'})`;
  }
  if (voice.voice_kind === 'recorded_human') {
    return 'تسجيل بشري مرفوع';
  }
  return 'قارئ المتصفح (متوقف)';
}

export const SoundManagementScreen: React.FC<SoundManagementScreenProps> = ({
  user,
  refreshSignal = 0,
  onSettingsChanged,
  onVoiceReaderSettingsChanged,
}) => {
  const [activeTab, setActiveTab] = useState<SoundTab>('voice_reader');
  const [files, setFiles] = useState<AudioFileRecord[]>([]);
  const [stations, setStations] = useState<StationAudioSetting[]>([]);
  const [humanVoices, setHumanVoices] = useState<HumanVoiceRecord[]>([]);
  const [voiceReaders, setVoiceReaders] = useState<VoiceReaderSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ttsConfigured, setTtsConfigured] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(() => isStationAudioPlaying());

  // Audio Alert Diagnostic Log («سجل تشخيص التنبيهات الصوتية»)
  const [diagnostics, setDiagnostics] = useState<AudioDiagnosticRecord[]>([]);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagDeptFilter, setDiagDeptFilter] = useState('');
  const [diagStatusFilter, setDiagStatusFilter] = useState('');
  const [diagSearch, setDiagSearch] = useState('');

  // Apply one human voice to all 5 voice reader channels
  const [applyAllVoiceId, setApplyAllVoiceId] = useState<string>('');

  // Side-by-side human voice comparison
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [compareSampleText, setCompareSampleText] = useState(
    'تنبيه، رسالة جديدة من إدارة الصالة إلى قسم التجميع، رقم المتابعة 105، الصنف شاورما عربي، الكمية 2، يرجى مراجعة البلاغ الوارد فوراً.'
  );
  const [comparingVoiceId, setComparingVoiceId] = useState<number | null>(null);
  const compareCancelledRef = useRef(false);

  // Add new custom human voice profile (AI or recorded)
  const [newVoiceMode, setNewVoiceMode] = useState<VoiceKind>('ai_human');
  const [newVoiceName, setNewVoiceName] = useState('');
  const [newVoiceGender, setNewVoiceGender] = useState<'female' | 'male'>('female');
  const [newVoicePrebuilt, setNewVoicePrebuilt] = useState<string>('Zephyr');
  const [newVoiceDesc, setNewVoiceDesc] = useState('');
  const [newVoiceStyle, setNewVoiceStyle] = useState('');
  const [newVoiceFile, setNewVoiceFile] = useState<File | null>(null);
  const [editingVoiceId, setEditingVoiceId] = useState<number | null>(null);
  const [editingVoiceName, setEditingVoiceName] = useState('');
  const [confirmDeleteVoiceId, setConfirmDeleteVoiceId] = useState<number | null>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<number | null>(null);
  const [playingReaderChannel, setPlayingReaderChannel] = useState<VoiceReaderChannelCode | null>(null);

  // Staged local alert tone file before uploading
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingDisplayName, setPendingDisplayName] = useState('');
  const [pendingBlobUrl, setPendingBlobUrl] = useState<string | null>(null);
  const [replaceTargetId, setReplaceTargetId] = useState<number | null>(null);

  // AI phrase clip generator state (for alert library)
  const [aiDisplayName, setAiDisplayName] = useState('');
  const [aiPhrase, setAiPhrase] = useState('تنبيه عاجل، يوجد طلب متعثر يتطلب المتابعة الفورية');

  // Inline rename / delete confirmation state for alert audio files
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [playingFileId, setPlayingFileId] = useState<number | null>(null);
  const [playingChannelCode, setPlayingChannelCode] = useState<StationCode | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const voiceFileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const onSettingsChangedRef = useRef(onSettingsChanged);
  const onVoiceReaderSettingsChangedRef = useRef(onVoiceReaderSettingsChanged);

  useEffect(() => {
    onSettingsChangedRef.current = onSettingsChanged;
  }, [onSettingsChanged]);

  useEffect(() => {
    onVoiceReaderSettingsChangedRef.current = onVoiceReaderSettingsChanged;
  }, [onVoiceReaderSettingsChanged]);

  useEffect(() => {
    return onAudioPlaybackStateChange((playing) => {
      setAudioPlaying(playing);
    });
  }, []);

  const authToken = getAuthToken();

  const isAdmin = user.role_code === 'admin';
  const hasPerm = (code: string) => isAdmin || user.permissions.includes(code);

  const canAccessScreen =
    isAdmin || hasPerm('manage_settings') || AUDIO_PERMISSION_CODES.some((c) => user.permissions.includes(c));
  const canUpload = hasPerm('audio_upload') || hasPerm('audio_add') || hasPerm('manage_settings');
  const canAddAi = hasPerm('audio_add') || hasPerm('manage_settings');
  const canTest = hasPerm('audio_test') || hasPerm('manage_settings');
  const canSetDefault = hasPerm('audio_set_default') || hasPerm('manage_settings');
  const canDeleteOrEdit = hasPerm('audio_delete') || hasPerm('manage_settings');
  const canAssign = hasPerm('audio_assign') || hasPerm('manage_settings');
  const canVolume = hasPerm('audio_volume') || hasPerm('audio_assign') || hasPerm('manage_settings');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [filesRes, settingsRes, voicesRes, readerRes] = await Promise.all([
        apiRequest<{ files: AudioFileRecord[] }>('/api/audio/files'),
        apiRequest<{ settings: StationAudioSetting[] }>('/api/audio/settings'),
        apiRequest<{ voices: HumanVoiceRecord[]; gemini_tts_configured: boolean }>('/api/audio/human-voices'),
        apiRequest<{ settings: VoiceReaderSetting[] }>('/api/audio/voice-reader/settings'),
      ]);
      setFiles(filesRes.files);
      setStations(settingsRes.settings);
      setHumanVoices(voicesRes.voices);
      setVoiceReaders(readerRes.settings);
      setTtsConfigured(Boolean(voicesRes.gemini_tts_configured));
      onSettingsChangedRef.current(settingsRes.settings);
      onVoiceReaderSettingsChangedRef.current?.(readerRes.settings);

      setCompareIds((prev) => {
        if (prev.length > 0) return prev;
        return voicesRes.voices
          .filter((v) => v.voice_kind === 'ai_human')
          .slice(0, 2)
          .map((v) => v.id);
      });
      setErr(null);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر تحميل إعدادات الأصوات');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    try {
      const qs = new URLSearchParams();
      if (diagDeptFilter) qs.set('department', diagDeptFilter);
      if (diagStatusFilter) qs.set('status', diagStatusFilter);
      if (diagSearch.trim()) qs.set('search', diagSearch.trim());
      qs.set('limit', '100');
      const res = await apiRequest<{ diagnostics: AudioDiagnosticRecord[] }>(
        `/api/audio/diagnostics?${qs.toString()}`
      );
      setDiagnostics(res.diagnostics || []);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر تحميل سجل تشخيص التنبيهات الصوتية');
    } finally {
      setDiagLoading(false);
    }
  }, [diagDeptFilter, diagStatusFilter, diagSearch]);

  useEffect(() => {
    if (canAccessScreen) {
      void loadData();
    } else {
      setLoading(false);
    }
    return () => {
      compareCancelledRef.current = true;
      stopAllAudio();
    };
  }, [canAccessScreen, loadData, refreshSignal]);

  useEffect(() => {
    if (canAccessScreen && activeTab === 'diagnostics') {
      void loadDiagnostics();
    }
  }, [canAccessScreen, activeTab, loadDiagnostics]);

  useEffect(() => {
    return () => {
      if (pendingBlobUrl) URL.revokeObjectURL(pendingBlobUrl);
    };
  }, [pendingBlobUrl]);

  if (!canAccessScreen) {
    return (
      <div className="app-card-urgent p-6 text-center text-sm font-bold text-[var(--brand-red)]">
        إدارة الأصوات والتنبيهات متاحة لمدير النظام أو المستخدمين المصرح لهم فقط
      </div>
    );
  }

  const stopAllSoundsNow = () => {
    compareCancelledRef.current = true;
    stopAllAudio();
    setPlayingFileId(null);
    setPlayingChannelCode(null);
    setPlayingVoiceId(null);
    setPlayingReaderChannel(null);
    setComparingVoiceId(null);
  };

  // ===========================================================================
  // Human Voice Library & Side-by-Side Comparison Handlers
  // ===========================================================================
  const handleCreateHumanVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVoiceName.trim()) {
      setErr('يرجى إدخال اسم واضح للصوت البشري');
      return;
    }
    if (newVoiceMode === 'recorded_human' && !newVoiceFile) {
      setErr('يرجى اختيار ملف تسجيل صوتي بشري للرفع');
      return;
    }

    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      let dataBase64: string | undefined;
      let filename: string | undefined;
      let mimeType: string | undefined;
      if (newVoiceMode === 'recorded_human' && newVoiceFile) {
        dataBase64 = await readFileAsBase64(newVoiceFile);
        filename = newVoiceFile.name;
        mimeType = newVoiceFile.type || 'audio/mpeg';
      }

      const res = await apiRequest<{ voice: HumanVoiceRecord; voices: HumanVoiceRecord[] }>(
        '/api/audio/human-voices',
        {
          method: 'POST',
          body: JSON.stringify({
            voice_kind: newVoiceMode,
            display_name: newVoiceName.trim(),
            description: newVoiceDesc.trim() || null,
            gender: newVoiceGender,
            prebuilt_voice_name: newVoiceMode === 'ai_human' ? newVoicePrebuilt : undefined,
            style_prompt: newVoiceStyle.trim() || null,
            filename,
            mime_type: mimeType,
            data_base64: dataBase64,
          }),
        }
      );

      setHumanVoices(res.voices);
      setNewVoiceName('');
      setNewVoiceDesc('');
      setNewVoiceStyle('');
      setNewVoiceFile(null);
      if (voiceFileInputRef.current) voiceFileInputRef.current.value = '';
      setMsg(`تمت إضافة الصوت البشري (${res.voice.display_name}) إلى المكتبة بنجاح`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر إضافة الصوت البشري');
    } finally {
      setBusy(false);
    }
  };

  const handleTestHumanVoice = async (v: HumanVoiceRecord) => {
    if (!canTest) {
      setErr('ليس لديك صلاحية تجربة الأصوات');
      return;
    }
    compareCancelledRef.current = true;
    setComparingVoiceId(null);
    setErr(null);
    setMsg(null);
    setPlayingVoiceId(v.id);
    try {
      await apiRequest(`/api/audio/human-voices/${v.id}/test`, {
        method: 'POST',
        body: JSON.stringify({ text: compareSampleText }),
      });
      const result = await previewHumanVoice({
        voice: v,
        sampleText: compareSampleText,
        playbackRate: 1,
        volumePercent: 90,
        authToken,
        mode: 'test',
      });
      setPlayingVoiceId((cur) => (cur === v.id ? null : cur));
      if (!result.ok && result.error) {
        setErr(result.error);
      } else if (result.stopped) {
        setMsg(`تم إيقاف تجربة الصوت (${v.display_name})`);
      } else {
        setMsg(`تمت تجربة الصوت البشري (${v.display_name}) بنجاح`);
      }
    } catch (error) {
      setPlayingVoiceId((cur) => (cur === v.id ? null : cur));
      setErr(error instanceof Error ? error.message : 'تعذر تشغيل تجربة الصوت البشري');
    }
  };

  const handleToggleCompare = (voiceId: number) => {
    setCompareIds((prev) =>
      prev.includes(voiceId) ? prev.filter((id) => id !== voiceId) : [...prev, voiceId]
    );
  };

  const handleRunCompare = async () => {
    if (!canTest) {
      setErr('ليس لديك صلاحية مقارنة الأصوات');
      return;
    }
    const selectedVoices = humanVoices.filter((v) => compareIds.includes(v.id));
    if (selectedVoices.length < 2) {
      setErr('يرجى تحديد صوتين بشريين على الأقل للمقارنة بينهما');
      return;
    }
    compareCancelledRef.current = false;
    setErr(null);
    setMsg('بدأت المقارنة بالتتابع — استمع لنفس العبارة بكل صوت محدد');

    for (const v of selectedVoices) {
      if (compareCancelledRef.current) break;
      setComparingVoiceId(v.id);
      try {
        await apiRequest(`/api/audio/human-voices/${v.id}/test`, {
          method: 'POST',
          body: JSON.stringify({ text: compareSampleText }),
        });
        const res = await previewHumanVoice({
          voice: v,
          sampleText: compareSampleText,
          playbackRate: 1,
          volumePercent: 90,
          authToken,
          mode: 'test',
        });
        if (!res.ok || res.stopped || compareCancelledRef.current) {
          if (res.error) setErr(res.error);
          break;
        }
        await new Promise((r) => setTimeout(r, 450));
      } catch (error) {
        setErr(error instanceof Error ? error.message : 'تعذر إكمال المقارنة');
        break;
      }
    }

    setComparingVoiceId(null);
    if (!compareCancelledRef.current) {
      setMsg('انتهت مقارنة الأصوات البشرية المحددة — يمكنك الآن تعيين الصوت الأنسب للأقسام');
    }
  };

  const handlePatchHumanVoice = async (
    v: HumanVoiceRecord,
    payload: { is_favorite?: boolean; is_default?: boolean; display_name?: string }
  ) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiRequest<{
        voice: HumanVoiceRecord;
        voices: HumanVoiceRecord[];
        settings: VoiceReaderSetting[];
      }>(`/api/audio/human-voices/${v.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      setHumanVoices(res.voices);
      setVoiceReaders(res.settings);
      onVoiceReaderSettingsChangedRef.current?.(res.settings);
      setEditingVoiceId(null);
      if (payload.is_default !== undefined) {
        setMsg(
          res.voice.is_default
            ? `تم تعيين (${res.voice.display_name}) كصوت بشري افتراضي للنظام`
            : `تم إلغاء التعيين الافتراضي عن (${res.voice.display_name})`
        );
      } else if (payload.is_favorite !== undefined) {
        setMsg(
          res.voice.is_favorite
            ? `تمت إضافة (${res.voice.display_name}) إلى المفضلة`
            : `تمت إزالة (${res.voice.display_name}) من المفضلة`
        );
      } else {
        setMsg(`تم تحديث اسم الصوت إلى (${res.voice.display_name})`);
      }
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر تحديث بيانات الصوت البشري');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteHumanVoice = async (v: HumanVoiceRecord) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    stopAllSoundsNow();
    try {
      const res = await apiRequest<{ voices: HumanVoiceRecord[]; settings: VoiceReaderSetting[] }>(
        `/api/audio/human-voices/${v.id}`,
        { method: 'DELETE' }
      );
      setHumanVoices(res.voices);
      setVoiceReaders(res.settings);
      onVoiceReaderSettingsChangedRef.current?.(res.settings);
      setConfirmDeleteVoiceId(null);
      setMsg(`تم حذف الصوت البشري (${v.display_name}) وفك ارتباطه بأمان`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر حذف الصوت البشري');
    } finally {
      setBusy(false);
    }
  };

  // ===========================================================================
  // Voice Reader Settings (5 Channels Independent from Alert Tones)
  // ===========================================================================
  const updateLocalVoiceReader = (
    channelCode: VoiceReaderChannelCode,
    patch: Partial<VoiceReaderSetting>
  ) => {
    setVoiceReaders((prev) =>
      prev.map((vr) => (vr.channel_code === channelCode ? { ...vr, ...patch } : vr))
    );
  };

  const handleSaveVoiceReader = async (vr: VoiceReaderSetting) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiRequest<{ setting: VoiceReaderSetting; settings: VoiceReaderSetting[] }>(
        `/api/audio/voice-reader/settings/${vr.channel_code}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            human_voice_id: vr.human_voice_id,
            playback_rate: vr.playback_rate,
            volume_percent: vr.volume_percent,
            is_enabled: vr.is_enabled,
            read_scope: vr.read_scope,
            include_sender_dept: vr.include_sender_dept,
          }),
        }
      );
      setVoiceReaders(res.settings);
      onVoiceReaderSettingsChangedRef.current?.(res.settings);
      setMsg(`تم حفظ إعدادات قراءة البلاغات لقناة (${vr.channel_name_ar})`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر حفظ إعدادات قارئ البلاغات');
    } finally {
      setBusy(false);
    }
  };

  const handleApplyVoiceToAllChannels = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const voiceId = applyAllVoiceId ? Number(applyAllVoiceId) : null;
      const res = await apiRequest<{ settings: VoiceReaderSetting[] }>(
        '/api/audio/voice-reader/apply-all',
        {
          method: 'POST',
          body: JSON.stringify({ human_voice_id: voiceId }),
        }
      );
      setVoiceReaders(res.settings);
      onVoiceReaderSettingsChangedRef.current?.(res.settings);
      const chosen = voiceId ? humanVoices.find((v) => v.id === voiceId)?.display_name : 'الافتراضي';
      setMsg(`تم تطبيق الصوت (${chosen || 'الافتراضي'}) على جميع قنوات قراءة البلاغات بنجاح`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر تطبيق الصوت على جميع القنوات');
    } finally {
      setBusy(false);
    }
  };

  const handleTestVoiceReader = async (vr: VoiceReaderSetting) => {
    if (!canTest) {
      setErr('ليس لديك صلاحية تجربة الأصوات');
      return;
    }
    setErr(null);
    setMsg(null);
    setPlayingReaderChannel(vr.channel_code);
    try {
      await apiRequest(`/api/audio/voice-reader/settings/${vr.channel_code}/test`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const chosenVoice = vr.human_voice_id
        ? humanVoices.find((v) => v.id === vr.human_voice_id)
        : humanVoices.find((v) => v.is_default) || humanVoices[0] || null;
      const matchingStation =
        stations.find((s) => (s.station_code as string) === (vr.channel_code as string)) || null;
      const sampleText = `تنبيه تجريبي لـ ${vr.channel_name_ar}، رسالة واردة من إدارة الصالة إلى قسم التجميع، رقم المتابعة 108، يرجى مراجعة البلاغ الوارد فوراً.`;

      const result = await previewStationAudio({
        fileUrl:
          matchingStation?.audio_file_url || matchingStation?.resolved_audio_file_url || null,
        playbackRate: vr.playback_rate,
        volumePercent: vr.volume_percent,
        sampleText,
        speakTextEnabled: vr.is_enabled,
        voiceOpts: chosenVoice
          ? {
              humanVoiceId: chosenVoice.id,
              voiceName: chosenVoice.prebuilt_voice_name,
              stylePrompt: chosenVoice.style_prompt,
              voiceKind: chosenVoice.voice_kind,
              recordedFileUrl: chosenVoice.audio_file_url,
              playbackMode: 'test',
              cacheBust: chosenVoice.updated_at,
            }
          : undefined,
        authToken,
        cacheBust: vr.updated_at,
        mode: 'test',
      });

      setPlayingReaderChannel((cur) => (cur === vr.channel_code ? null : cur));
      if (!result.ok && result.error) {
        setErr(result.error);
      } else if (result.stopped) {
        setMsg(`تم إيقاف تجربة قراءة البلاغ لقناة (${vr.channel_name_ar})`);
      } else {
        setMsg(
          `تمت تجربة القراءة لـ (${vr.channel_name_ar}) بالصوت (${
            chosenVoice?.display_name || 'الافتراضي'
          })`
        );
      }
    } catch (error) {
      setPlayingReaderChannel((cur) => (cur === vr.channel_code ? null : cur));
      setErr(error instanceof Error ? error.message : 'تعذر تشغيل تجربة قراءة البلاغ');
    }
  };

  // ===========================================================================
  // Existing Alert Tones Library & 6 Station Alert Channels Handlers
  // ===========================================================================
  const handleChooseNewFile = (file: File | null) => {
    if (pendingBlobUrl) {
      URL.revokeObjectURL(pendingBlobUrl);
      setPendingBlobUrl(null);
    }
    if (!file) {
      setPendingFile(null);
      setPendingDisplayName('');
      return;
    }
    setErr(null);
    setMsg(null);
    setPendingFile(file);
    setPendingDisplayName(file.name.replace(/\.[^/.]+$/, ''));
    setPendingBlobUrl(URL.createObjectURL(file));
  };

  const handleUploadPending = async () => {
    if (!pendingFile) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const dataBase64 = await readFileAsBase64(pendingFile);
      const res = await apiRequest<{ file: AudioFileRecord }>('/api/audio/files', {
        method: 'POST',
        body: JSON.stringify({
          filename: pendingFile.name,
          display_name: pendingDisplayName.trim() || pendingFile.name.replace(/\.[^/.]+$/, ''),
          mime_type: pendingFile.type || 'audio/mpeg',
          data_base64: dataBase64,
        }),
      });
      setMsg(`تم رفع وحفظ نغمة التنبيه (${res.file.display_name}) في المكتبة بنجاح`);
      handleChooseNewFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadData();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر رفع الملف الصوتي');
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateAiVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiDisplayName.trim() || !aiPhrase.trim()) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiRequest<{ file: AudioFileRecord }>('/api/audio/files/generate-ai', {
        method: 'POST',
        body: JSON.stringify({
          display_name: aiDisplayName.trim(),
          text: aiPhrase.trim(),
        }),
      });
      setMsg(`تم توليد وحفظ المقطع الصوتي (${res.file.display_name}) في المكتبة بنجاح`);
      setAiDisplayName('');
      await loadData();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر توليد الصوت الذكي');
    } finally {
      setBusy(false);
    }
  };

  const handleRenameFile = async (f: AudioFileRecord) => {
    if (!editingName.trim()) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiRequest<{
        file: AudioFileRecord;
        files: AudioFileRecord[];
        settings: StationAudioSetting[];
      }>(`/api/audio/files/${f.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ display_name: editingName.trim() }),
      });
      setFiles(res.files);
      setStations(res.settings);
      onSettingsChangedRef.current(res.settings);
      setEditingId(null);
      setMsg(`تم تعديل اسم الصوت إلى (${res.file.display_name})`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر تعديل اسم الصوت');
    } finally {
      setBusy(false);
    }
  };

  const handleSetDefaultFile = async (f: AudioFileRecord) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiRequest<{
        file: AudioFileRecord;
        files: AudioFileRecord[];
        settings: StationAudioSetting[];
      }>(`/api/audio/files/${f.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_default: !f.is_default }),
      });
      setFiles(res.files);
      setStations(res.settings);
      onSettingsChangedRef.current(res.settings);
      setMsg(
        res.file.is_default
          ? `تم تعيين (${res.file.display_name}) كنغمة تنبيه افتراضية للنظام`
          : `تم إلغاء التعيين الافتراضي عن (${res.file.display_name})`
      );
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر تعيين الصوت الافتراضي');
    } finally {
      setBusy(false);
    }
  };

  const handleReplaceFile = async (fileId: number, file: File) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const dataBase64 = await readFileAsBase64(file);
      const res = await apiRequest<{ file: AudioFileRecord; settings: StationAudioSetting[] }>(
        `/api/audio/files/${fileId}/replace`,
        {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            mime_type: file.type || 'audio/mpeg',
            data_base64: dataBase64,
          }),
        }
      );
      setStations(res.settings);
      onSettingsChangedRef.current(res.settings);
      setMsg(`تم استبدال الملف الصوتي إلى (${res.file.display_name}) وتحديث المحطات المرتبطة تلقائياً`);
      await loadData();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر استبدال الملف الصوتي');
    } finally {
      setBusy(false);
      setReplaceTargetId(null);
      if (replaceInputRef.current) replaceInputRef.current.value = '';
    }
  };

  const handleDeleteFile = async (f: AudioFileRecord) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    stopAllSoundsNow();
    try {
      const res = await apiRequest<{ files: AudioFileRecord[]; settings: StationAudioSetting[] }>(
        `/api/audio/files/${f.id}`,
        { method: 'DELETE' }
      );
      setFiles(res.files);
      setStations(res.settings);
      onSettingsChangedRef.current(res.settings);
      setConfirmDeleteId(null);
      setMsg(`تم حذف الصوت (${f.display_name}) بأمان وفك ارتباطه عن أي محطة دون أعطال`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر حذف الملف الصوتي');
    } finally {
      setBusy(false);
    }
  };

  const handleTestLibraryFile = async (f: AudioFileRecord) => {
    if (!canTest) {
      setErr('ليس لديك صلاحية تجربة الأصوات');
      return;
    }
    setErr(null);
    setMsg(null);
    setPlayingChannelCode(null);
    setPlayingFileId(f.id);
    try {
      await apiRequest(`/api/audio/files/${f.id}/test`, { method: 'POST', body: JSON.stringify({}) });
      const res = await previewStationAudio({
        fileUrl: f.stream_url,
        playbackRate: 1,
        volumePercent: 90,
        authToken,
        cacheBust: f.updated_at || String(f.id),
        mode: 'test',
      });
      setPlayingFileId((cur) => (cur === f.id ? null : cur));
      if (!res.ok && res.error) {
        setErr(res.error);
      } else if (res.stopped) {
        setMsg(`تم إيقاف تجربة الصوت (${f.display_name})`);
      } else {
        setMsg(`تمت تجربة الصوت (${f.display_name}) بنجاح`);
      }
    } catch (error) {
      setPlayingFileId((cur) => (cur === f.id ? null : cur));
      setErr(error instanceof Error ? error.message : 'تعذر تشغيل الملف الصوتي المختار');
    }
  };

  const updateLocalStation = (stationCode: StationCode, patch: Partial<StationAudioSetting>) => {
    setStations((prev) =>
      prev.map((s) => (s.station_code === stationCode ? { ...s, ...patch } : s))
    );
  };

  const handleSaveStation = async (s: StationAudioSetting) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await apiRequest<{ setting: StationAudioSetting; settings: StationAudioSetting[] }>(
        `/api/audio/settings/${s.station_code}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            audio_file_id: s.audio_file_id,
            playback_rate: s.playback_rate,
            volume_percent: s.volume_percent,
            is_enabled: s.is_enabled,
            speak_text_enabled: s.speak_text_enabled,
          }),
        }
      );
      setStations(res.settings);
      onSettingsChangedRef.current(res.settings);
      setMsg(
        `تم حفظ واعتماد نغمة (${s.station_name_ar}) — سرعة ${s.playback_rate}x ومستوى ${s.volume_percent}%`
      );
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر حفظ إعدادات القناة الصوتية');
    } finally {
      setBusy(false);
    }
  };

  const handleResetStation = async (s: StationAudioSetting) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    stopAllSoundsNow();
    try {
      const res = await apiRequest<{ setting: StationAudioSetting; settings: StationAudioSetting[] }>(
        `/api/audio/settings/${s.station_code}/reset`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      setStations(res.settings);
      onSettingsChangedRef.current(res.settings);
      setMsg(`تمت إعادة إعدادات (${s.station_name_ar}) إلى النغمة الافتراضية (1x · 85%)`);
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'تعذر إعادة الضبط');
    } finally {
      setBusy(false);
    }
  };

  const handleTestStation = async (s: StationAudioSetting) => {
    if (!canTest) {
      setErr('ليس لديك صلاحية تجربة الأصوات');
      return;
    }
    setErr(null);
    setMsg(null);
    setPlayingFileId(null);
    setPlayingChannelCode(s.station_code);
    try {
      await apiRequest(`/api/audio/settings/${s.station_code}/test`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const chosenFile = s.audio_file_id ? files.find((f) => f.id === s.audio_file_id) : null;
      const url = chosenFile ? chosenFile.stream_url : s.audio_file_url || s.resolved_audio_file_url || null;
      const matchingReader =
        voiceReaders.find((vr) => (vr.channel_code as string) === (s.station_code as string)) ||
        null;
      const result = await previewStationAudio({
        fileUrl: url,
        playbackRate: s.playback_rate,
        volumePercent: s.volume_percent,
        sampleText: `تنبيه تجريبي خاص بـ ${s.station_name_ar}`,
        speakTextEnabled: s.speak_text_enabled,
        voiceOpts: matchingReader
          ? {
              humanVoiceId: matchingReader.resolved_human_voice_id ?? matchingReader.human_voice_id,
              voiceName: matchingReader.resolved_prebuilt_voice_name,
              stylePrompt: matchingReader.resolved_style_prompt,
              voiceKind: matchingReader.resolved_human_voice_kind,
              recordedFileUrl: matchingReader.resolved_audio_file_url,
              playbackMode: 'test',
            }
          : undefined,
        authToken,
        cacheBust: s.updated_at,
        mode: 'test',
      });
      setPlayingChannelCode((cur) => (cur === s.station_code ? null : cur));
      if (!result.ok && result.error) {
        setErr(result.error);
      } else if (result.stopped) {
        setMsg(`تم إيقاف التجربة الصوتية لقناة (${s.station_name_ar})`);
      } else {
        setMsg(
          `تمت التجربة الصوتية لـ (${s.station_name_ar}) بسرعة ${s.playback_rate}x ومستوى ${s.volume_percent}%`
        );
      }
    } catch (error) {
      setPlayingChannelCode((cur) => (cur === s.station_code ? null : cur));
      setErr(error instanceof Error ? error.message : 'تعذر تشغيل الصوت للقناة');
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header & Global Stop */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-[var(--brand-charcoal)]">
            إدارة الأصوات البشرية ونغمات التنبيه
          </h2>
          <p className="text-sm text-[var(--brand-charcoal)]/80">
            حرية اختيار ومقارنة الأصوات البشرية لقراءة البلاغات بشكل مستقل عن نغمات التنبيه القصيرة
          </p>
        </div>

        {(canTest || audioPlaying) && (
          <button
            type="button"
            onClick={stopAllSoundsNow}
            className={`min-h-[42px] inline-flex items-center gap-2 px-4 text-xs font-bold rounded-2xl border transition-colors ${
              audioPlaying
                ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
            }`}
          >
            <Square className="w-3.5 h-3.5" />
            <span>إيقاف جميع الأصوات والقراءة</span>
          </button>
        )}
      </div>

      {/* Section Tabs: Independent Human Voice Reader vs Alert Chimes */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setActiveTab('voice_reader')}
          className={`min-h-[46px] inline-flex items-center gap-2 rounded-2xl border px-4 text-xs sm:text-sm font-bold transition-colors ${
            activeTab === 'voice_reader'
              ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
              : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
          }`}
        >
          <Mic className="w-4 h-4" />
          <span>الأصوات البشرية وقراءة البلاغات ({humanVoices.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('alert_tones')}
          className={`min-h-[46px] inline-flex items-center gap-2 rounded-2xl border px-4 text-xs sm:text-sm font-bold transition-colors ${
            activeTab === 'alert_tones'
              ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)] text-white'
              : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-orange)]'
          }`}
        >
          <Music className="w-4 h-4" />
          <span>نغمات التنبيه القصيرة ومكتبة الملفات ({files.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('diagnostics')}
          className={`min-h-[46px] inline-flex items-center gap-2 rounded-2xl border px-4 text-xs sm:text-sm font-bold transition-colors ${
            activeTab === 'diagnostics'
              ? 'border-[var(--brand-charcoal)] bg-[var(--brand-charcoal)] text-white'
              : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-charcoal)]'
          }`}
        >
          <Activity className="w-4 h-4" />
          <span>سجل تشخيص التنبيهات الصوتية</span>
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
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{err}</span>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 1: HUMAN VOICE LIBRARY, SIDE-BY-SIDE COMPARISON & 5 VOICE READERS */}
      {/* ===================================================================== */}
      {activeTab === 'voice_reader' && (
        <div className="space-y-6">
          {/* Independent Section 1: 5 Voice Reader Channels + Apply-All */}
          <section className="space-y-4">
            <div className="app-card p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--brand-gray-light)] pb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
                    <UserCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-extrabold text-[var(--brand-charcoal)]">
                      اختيار صوت قراءة البلاغات والرسائل (مستقل عن نغمة التنبيه)
                    </h3>
                    <p className="text-xs text-[var(--brand-charcoal)]/75">
                      يمكنك اعتماد صوت بشري موحد لجميع الأقسام أو اختيار صوت وسرعة ونطاق قراءة مستقل لكل قسم
                    </p>
                  </div>
                </div>
                <span className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-1.5 text-[11px] font-bold text-[var(--brand-charcoal)]">
                  {ttsConfigured ? 'محرك الأصوات البشرية الذكي نشط' : 'الصوت البشري الذكي بانتظار التفعيل (قارئ المتصفح متوقف)'}
                </span>
              </div>

              {/* Apply One Voice to All Channels */}
              {canAssign && (
                <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3.5 flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[220px] space-y-1">
                    <label className="block text-xs font-bold text-[var(--brand-charcoal)]">
                      تطبيق صوت بشري واحد على جميع الأقسام والجهات:
                    </label>
                    <select
                      value={applyAllVoiceId}
                      onChange={(e) => setApplyAllVoiceId(e.target.value)}
                      className="w-full h-[42px] app-input px-3 text-xs font-bold"
                    >
                      <option value="">الصوت البشري الافتراضي للنظام (تلقائي)</option>
                      {humanVoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.display_name} — {v.gender === 'female' ? 'نسائي' : 'رجالي'} ({getVoiceKindBadgeLabel(v)})
                          {v.is_default ? ' ★' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleApplyVoiceToAllChannels()}
                    className="min-h-[42px] inline-flex items-center gap-2 app-btn-secondary px-4 text-xs disabled:opacity-50"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>تطبيق على جميع القنوات الخمس</span>
                  </button>
                </div>
              )}
            </div>

            {loading ? (
              <div className="h-32 app-card animate-pulse" />
            ) : (
              <div className="space-y-4">
                {voiceReaders.map((vr) => {
                  const activeVoice =
                    (vr.human_voice_id
                      ? humanVoices.find((v) => v.id === vr.human_voice_id)
                      : humanVoices.find((v) => v.is_default)) || null;
                  return (
                    <div key={vr.channel_code} className="app-card p-5 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--brand-gray-light)] pb-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h4 className="text-base font-extrabold text-[var(--brand-red)]">
                              {vr.channel_name_ar || VOICE_READER_CHANNEL_LABELS[vr.channel_code]}
                            </h4>
                            {!vr.human_voice_id && (
                              <span className="rounded-xl border border-[var(--brand-orange)] bg-[var(--brand-orange)]/10 px-2 py-0.5 text-[10px] font-bold text-[var(--brand-orange)]">
                                يعتمد على الافتراضي — يُنصح بتثبيت صوت صريح
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[var(--brand-charcoal)]/75 font-mono-num">
                            الصوت الفعلي للقراءة:{' '}
                            {activeVoice
                              ? `${activeVoice.display_name} (${getVoiceKindBadgeLabel(activeVoice)})`
                              : vr.resolved_human_voice_name
                                ? `${vr.resolved_human_voice_name} (${vr.resolved_prebuilt_voice_name || ''})`
                                : 'غير محدد'}{' '}
                            · آخر تحديث: {formatAdenDateTime(vr.updated_at)}
                          </p>
                        </div>

                        <label className="inline-flex items-center gap-2 rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-1.5 text-xs font-bold text-[var(--brand-charcoal)]">
                          <input
                            type="checkbox"
                            disabled={!canVolume}
                            checked={vr.is_enabled}
                            onChange={(e) =>
                              updateLocalVoiceReader(vr.channel_code, { is_enabled: e.target.checked })
                            }
                            className="w-4 h-4 accent-[#EF1923]"
                          />
                          <span>{vr.is_enabled ? 'قراءة البلاغات مفعلة' : 'القراءة الصوتية متوقفة'}</span>
                        </label>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Select Human Voice */}
                        <div className="space-y-1.5">
                          <label className="block text-xs font-bold text-[var(--brand-charcoal)]">
                            اختيار الصوت البشري لقراءة البلاغ
                          </label>
                          <select
                            disabled={!canAssign}
                            value={vr.human_voice_id ?? ''}
                            onChange={(e) => {
                              const val = e.target.value ? Number(e.target.value) : null;
                              const chosen = val ? humanVoices.find((v) => v.id === val) : null;
                              updateLocalVoiceReader(vr.channel_code, {
                                human_voice_id: val,
                                human_voice_name: chosen ? chosen.display_name : null,
                                human_voice_kind: chosen ? chosen.voice_kind : null,
                              });
                            }}
                            className="w-full h-[46px] app-input px-3 text-sm font-semibold disabled:opacity-70"
                          >
                            <option value="">الصوت البشري الافتراضي للنظام (تلقائي)</option>
                            {humanVoices.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.display_name} {v.is_favorite ? '★' : ''} —{' '}
                                {v.gender === 'female' ? 'نسائي' : 'رجالي'}
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Volume Slider */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs font-bold text-[var(--brand-charcoal)]">
                            <span>مستوى صوت القراءة</span>
                            <span className="font-mono-num text-[var(--brand-red)]">
                              {vr.volume_percent}%
                            </span>
                          </div>
                          <div className="h-[46px] app-input px-3 flex items-center">
                            <input
                              type="range"
                              min={0}
                              max={100}
                              step={5}
                              disabled={!canVolume}
                              value={vr.volume_percent}
                              onChange={(e) =>
                                updateLocalVoiceReader(vr.channel_code, {
                                  volume_percent: Number(e.target.value),
                                })
                              }
                              className="w-full accent-[#EF1923] disabled:opacity-60"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Speed + Read Scope */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
                        <div className="space-y-1.5">
                          <label className="block text-xs font-bold text-[var(--brand-charcoal)]">
                            سرعة قراءة الصوت البشري
                          </label>
                          <div className="flex flex-wrap gap-2">
                            {PLAYBACK_RATE_OPTIONS.map((rate) => {
                              const selected = Number(vr.playback_rate) === rate;
                              return (
                                <button
                                  key={rate}
                                  type="button"
                                  disabled={!canVolume}
                                  onClick={() =>
                                    updateLocalVoiceReader(vr.channel_code, { playback_rate: rate })
                                  }
                                  className={`min-h-[40px] min-w-[60px] rounded-2xl border px-3 text-xs font-mono-num font-extrabold transition-colors disabled:opacity-60 ${
                                    selected
                                      ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                                      : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
                                  }`}
                                >
                                  {rate}x
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <label className="block text-xs font-bold text-[var(--brand-charcoal)]">
                            نطاق قراءة البلاغات لهذه القناة
                          </label>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={!canVolume}
                              onClick={() =>
                                updateLocalVoiceReader(vr.channel_code, { read_scope: 'all' })
                              }
                              className={`min-h-[40px] flex-1 rounded-2xl border px-3 text-xs font-bold transition-colors ${
                                vr.read_scope === 'all'
                                  ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                                  : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)]'
                              }`}
                            >
                              قراءة جميع البلاغات والرسائل
                            </button>
                            <button
                              type="button"
                              disabled={!canVolume}
                              onClick={() =>
                                updateLocalVoiceReader(vr.channel_code, {
                                  read_scope: 'important_only',
                                })
                              }
                              className={`min-h-[40px] flex-1 rounded-2xl border px-3 text-xs font-bold transition-colors ${
                                vr.read_scope === 'important_only'
                                  ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)] text-white'
                                  : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)]'
                              }`}
                            >
                              البلاغات المهمة والحرجة فقط
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-[var(--brand-gray-light)]">
                        {canTest && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleTestVoiceReader(vr)}
                              className="min-h-[42px] inline-flex items-center gap-1.5 app-btn-secondary px-4 text-xs"
                            >
                              {playingReaderChannel === vr.channel_code ? (
                                <RefreshCw className="w-4 h-4" />
                              ) : (
                                <Play className="w-4 h-4" />
                              )}
                              <span>
                                {playingReaderChannel === vr.channel_code
                                  ? 'إعادة التجربة'
                                  : 'تجربة قراءة البلاغ'}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={stopAllSoundsNow}
                              className="min-h-[42px] inline-flex items-center gap-1.5 app-btn-outline px-4 text-xs"
                            >
                              <Square className="w-3.5 h-3.5" />
                              <span>إيقاف القراءة</span>
                            </button>
                          </>
                        )}
                        {(canAssign || canVolume) && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleSaveVoiceReader(vr)}
                            className="min-h-[42px] inline-flex items-center gap-1.5 app-btn-primary px-5 text-xs disabled:opacity-50"
                          >
                            <Save className="w-4 h-4" />
                            <span>حفظ إعدادات القراءة</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Independent Section 2: Human Voices Library & Side-by-Side Comparison */}
          <section className="app-card p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--brand-gray-light)] pb-3">
              <div className="flex items-center gap-2.5">
                <Mic className="w-5 h-5 text-[var(--brand-orange)]" />
                <div>
                  <h3 className="text-base font-extrabold text-[var(--brand-charcoal)]">
                    مكتبة الأصوات البشرية ومقارنتها قبل الاختيار
                  </h3>
                  <p className="text-xs text-[var(--brand-charcoal)]/75">
                    استمع لكل صوت بشري باللغة العربية وقارن بين صوتين أو أكثر بنفس نص البلاغ
                  </p>
                </div>
              </div>
              <span className="text-xs font-mono-num font-bold text-[var(--brand-charcoal)]/75">
                {humanVoices.length} صوت بشري
              </span>
            </div>

            {/* Side-by-Side Comparison Panel */}
            <div className="rounded-2xl border border-[var(--brand-orange)]/40 bg-[var(--brand-orange)]/5 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-extrabold text-[var(--brand-charcoal)]">
                  <GitCompare className="w-4 h-4 text-[var(--brand-orange)]" />
                  <span>مقارنة الأصوات البشرية المحددة ({compareIds.length} محدد)</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {canTest && (
                    <>
                      <button
                        type="button"
                        disabled={compareIds.length < 2}
                        onClick={() => void handleRunCompare()}
                        className="min-h-[38px] inline-flex items-center gap-1.5 app-btn-secondary px-4 text-xs disabled:opacity-50"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>تشغيل المقارنة بالتتابع</span>
                      </button>
                      <button
                        type="button"
                        onClick={stopAllSoundsNow}
                        className="min-h-[38px] inline-flex items-center gap-1 app-btn-outline px-3 text-xs"
                      >
                        <Square className="w-3.5 h-3.5 text-[var(--brand-red)]" />
                        <span>إيقاف</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-[var(--brand-charcoal)] mb-1">
                  العبارة العربية المستخدمة في التجربة والمقارنة:
                </label>
                <input
                  type="text"
                  value={compareSampleText}
                  onChange={(e) => setCompareSampleText(e.target.value)}
                  className="w-full h-[42px] app-input px-3 text-xs font-semibold"
                />
              </div>
            </div>

            {/* Voices List */}
            <div className="space-y-2.5">
              {humanVoices.map((v) => {
                const isSelectedCompare = compareIds.includes(v.id);
                const isSpeakingNow = comparingVoiceId === v.id || playingVoiceId === v.id;
                return (
                  <div
                    key={v.id}
                    className={`rounded-2xl border p-3.5 space-y-2.5 transition-colors ${
                      isSpeakingNow
                        ? 'border-[var(--brand-red)] bg-[var(--brand-red)]/5'
                        : v.is_default
                          ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)]/5'
                          : 'border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <input
                          type="checkbox"
                          checked={isSelectedCompare}
                          onChange={() => handleToggleCompare(v.id)}
                          title="إضافة للمقارنة"
                          className="mt-1 w-4 h-4 accent-[#F8941A] shrink-0"
                        />

                        <div className="min-w-0 flex-1 space-y-1">
                          {editingVoiceId === v.id ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <input
                                type="text"
                                value={editingVoiceName}
                                onChange={(e) => setEditingVoiceName(e.target.value)}
                                className="h-[38px] app-input px-3 text-xs font-bold flex-1 min-w-[180px]"
                              />
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void handlePatchHumanVoice(v, { display_name: editingVoiceName.trim() })
                                }
                                className="min-h-[38px] app-btn-primary px-3 text-xs"
                              >
                                حفظ
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingVoiceId(null)}
                                className="min-h-[38px] app-btn-outline px-3 text-xs"
                              >
                                إلغاء
                              </button>
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-extrabold text-[var(--brand-charcoal)]">
                                {v.display_name}
                              </span>
                              {v.is_default && (
                                <span className="rounded-xl bg-[var(--brand-orange)] text-white px-2.5 py-0.5 text-[10px] font-extrabold">
                                  الصوت الافتراضي لقراءة البلاغات
                                </span>
                              )}
                              <span className="rounded-xl border border-[var(--brand-gray-light)] bg-white px-2 py-0.5 text-[10px] font-bold text-[var(--brand-charcoal)]/85">
                                {getVoiceKindBadgeLabel(v)}
                              </span>
                              <span className="rounded-xl border border-[var(--brand-gray-light)] bg-white px-2 py-0.5 text-[10px] font-bold text-[var(--brand-charcoal)]/75">
                                {v.gender === 'female' ? 'نسائي' : 'رجالي'}
                              </span>
                            </div>
                          )}

                          {v.description && (
                            <p className="text-xs text-[var(--brand-charcoal)]/80">{v.description}</p>
                          )}

                          {v.used_by_channels && v.used_by_channels.length > 0 && (
                            <div className="text-[11px] font-bold text-[var(--brand-red)]">
                              معيّن حالياً لـ:{' '}
                              {v.used_by_channels
                                .map((ch) => VOICE_READER_CHANNEL_LABELS[ch] || ch)
                                .join('، ')}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {canTest && (
                          <button
                            type="button"
                            onClick={() => void handleTestHumanVoice(v)}
                            className={`min-h-[38px] inline-flex items-center gap-1.5 rounded-2xl border px-3 text-xs font-bold transition-colors ${
                              isSpeakingNow
                                ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                                : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
                            }`}
                          >
                            <Play className="w-3.5 h-3.5" />
                            <span>{isSpeakingNow ? 'جاري الاستماع...' : 'تجربة الاستماع'}</span>
                          </button>
                        )}

                        {canSetDefault && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void handlePatchHumanVoice(v, { is_favorite: !v.is_favorite })
                              }
                              title={v.is_favorite ? 'إزالة من المفضلة' : 'إضافة للمفضلة'}
                              className={`min-h-[38px] inline-flex items-center gap-1 rounded-2xl border px-3 text-xs font-bold transition-colors ${
                                v.is_favorite
                                  ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)]/15 text-[var(--brand-orange)]'
                                  : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)]'
                              }`}
                            >
                              <Star className="w-3.5 h-3.5" />
                              <span>{v.is_favorite ? 'مفضل' : 'تفضيل'}</span>
                            </button>

                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void handlePatchHumanVoice(v, { is_default: !v.is_default })
                              }
                              className={`min-h-[38px] inline-flex items-center gap-1.5 rounded-2xl border px-3 text-xs font-bold transition-colors ${
                                v.is_default
                                  ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)] text-white'
                                  : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-orange)]'
                              }`}
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>{v.is_default ? 'افتراضي' : 'تعيين كافتراضي'}</span>
                            </button>
                          </>
                        )}

                        {canDeleteOrEdit && !v.is_system && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setEditingVoiceId(v.id);
                                setEditingVoiceName(v.display_name);
                              }}
                              className="min-h-[38px] inline-flex items-center gap-1 app-btn-outline px-2.5 text-xs"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>تعديل</span>
                            </button>
                            {confirmDeleteVoiceId === v.id ? (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleDeleteHumanVoice(v)}
                                  className="min-h-[38px] rounded-2xl bg-[var(--brand-red)] text-white px-3 text-xs font-bold"
                                >
                                  تأكيد الحذف
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteVoiceId(null)}
                                  className="min-h-[38px] app-btn-outline px-2.5 text-xs"
                                >
                                  إلغاء
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setConfirmDeleteVoiceId(v.id)}
                                className="min-h-[38px] inline-flex items-center gap-1 rounded-2xl border border-[var(--brand-red)] bg-white px-2.5 text-xs font-bold text-[var(--brand-red)] hover:bg-[var(--brand-red)] hover:text-white transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>حذف</span>
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Add Custom Human Voice Profile (AI Persona or Recorded File) */}
            {(canAddAi || canUpload) && (
              <form
                onSubmit={handleCreateHumanVoice}
                className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-4 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-extrabold text-[var(--brand-charcoal)]">
                    <Plus className="w-4 h-4 text-[var(--brand-red)]" />
                    <span>إضافة صوت بشري جديد إلى مكتبة قراءة البلاغات</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canAddAi && (
                      <button
                        type="button"
                        onClick={() => setNewVoiceMode('ai_human')}
                        className={`min-h-[36px] rounded-xl border px-3 text-xs font-bold ${
                          newVoiceMode === 'ai_human'
                            ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                            : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)]'
                        }`}
                      >
                        صوت بشري ذكي (شخصية جديدة)
                      </button>
                    )}
                    {canUpload && (
                      <button
                        type="button"
                        onClick={() => setNewVoiceMode('recorded_human')}
                        className={`min-h-[36px] rounded-xl border px-3 text-xs font-bold ${
                          newVoiceMode === 'recorded_human'
                            ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)] text-white'
                            : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)]'
                        }`}
                      >
                        رفع تسجيل صوتي بشري
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-[var(--brand-charcoal)] mb-1">
                      اسم الصوت البشري *
                    </label>
                    <input
                      type="text"
                      value={newVoiceName}
                      onChange={(e) => setNewVoiceName(e.target.value)}
                      placeholder="مثال: صوت ريم السريع"
                      className="w-full h-[42px] app-input px-3 text-xs font-bold"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-[var(--brand-charcoal)] mb-1">
                      نوع الصوت (الجنس)
                    </label>
                    <select
                      value={newVoiceGender}
                      onChange={(e) =>
                        setNewVoiceGender(e.target.value === 'male' ? 'male' : 'female')
                      }
                      className="w-full h-[42px] app-input px-3 text-xs font-bold"
                    >
                      <option value="female">صوت نسائي</option>
                      <option value="male">صوت رجالي</option>
                    </select>
                  </div>

                  {newVoiceMode === 'ai_human' ? (
                    <div>
                      <label className="block text-[11px] font-bold text-[var(--brand-charcoal)] mb-1">
                        نبرة الشخصية الصوتية
                      </label>
                      <select
                        value={newVoicePrebuilt}
                        onChange={(e) => setNewVoicePrebuilt(e.target.value)}
                        className="w-full h-[42px] app-input px-3 text-xs font-bold"
                      >
                        {GEMINI_PREBUILT_VOICES.map((pv) => (
                          <option key={pv.id} value={pv.id}>
                            {pv.label_ar}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className="block text-[11px] font-bold text-[var(--brand-charcoal)] mb-1">
                        ملف التسجيل البشري *
                      </label>
                      <input
                        ref={voiceFileInputRef}
                        type="file"
                        accept={ACCEPTED_AUDIO}
                        onChange={(e) => setNewVoiceFile(e.target.files?.[0] || null)}
                        className="w-full text-xs text-[var(--brand-charcoal)]"
                      />
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={newVoiceDesc}
                    onChange={(e) => setNewVoiceDesc(e.target.value)}
                    placeholder="وصف مختصر للصوت (اختياري)"
                    className="h-[42px] app-input px-3 text-xs"
                  />
                  <input
                    type="text"
                    value={newVoiceStyle}
                    onChange={(e) => setNewVoiceStyle(e.target.value)}
                    placeholder="ملاحظة الأسلوب والنبرة (اختياري)"
                    className="h-[42px] app-input px-3 text-xs"
                  />
                </div>

                <button
                  type="submit"
                  disabled={busy || !newVoiceName.trim()}
                  className="min-h-[42px] inline-flex items-center gap-2 app-btn-primary px-5 text-xs disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                  <span>إضافة الصوت البشري إلى المكتبة</span>
                </button>
              </form>
            )}
          </section>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 2: ALERT TONES LIBRARY & 6 STATION CHIME CHANNELS                 */}
      {/* ===================================================================== */}
      {activeTab === 'alert_tones' && (
        <div className="space-y-6">
          {/* Upload Sound File to Multi-Sound Library */}
          {canUpload && (
            <section className="app-card p-5 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
                  <Upload className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-[var(--brand-charcoal)]">
                    رفع نغمة أو ملف تنبيه قصير من الجهاز
                  </h3>
                  <p className="text-xs text-[var(--brand-charcoal)]/75">
                    يدعم MP3, WAV, M4A, OGG, WEBM (بحد أقصى 10 ميجابايت) لنغمات التنبيه قبل القراءة البشرية
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_AUDIO}
                  onChange={(e) => handleChooseNewFile(e.target.files?.[0] || null)}
                  className="block w-full sm:w-auto text-xs font-semibold text-[var(--brand-charcoal)] file:ml-3 file:min-h-[42px] file:rounded-2xl file:border file:border-[var(--brand-gray-light)] file:bg-white file:px-4 file:text-xs file:font-bold file:text-[var(--brand-charcoal)] hover:file:border-[var(--brand-red)]"
                />

                {pendingFile && (
                  <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3.5 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
                      <div>
                        <label className="block text-[11px] font-bold text-[var(--brand-charcoal)] mb-1">
                          الاسم الواضح في المكتبة
                        </label>
                        <input
                          type="text"
                          value={pendingDisplayName}
                          onChange={(e) => setPendingDisplayName(e.target.value)}
                          placeholder="مثال: نغمة تنبيه الإنتاج الحرج"
                          className="w-full h-[42px] app-input px-3 text-xs font-bold"
                        />
                      </div>
                      <div className="text-xs font-bold text-[var(--brand-charcoal)] font-mono-num">
                        الملف: {pendingFile.name} ({formatBytes(pendingFile.size)})
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {canTest && (
                        <button
                          type="button"
                          onClick={() =>
                            void previewStationAudio({
                              fileUrl: pendingBlobUrl,
                              playbackRate: 1,
                              volumePercent: 90,
                              mode: 'test',
                            })
                          }
                          className="min-h-[40px] inline-flex items-center gap-1.5 rounded-2xl border border-[var(--brand-orange)] bg-white px-3.5 text-xs font-bold text-[var(--brand-orange)]"
                        >
                          <Play className="w-3.5 h-3.5" />
                          <span>تجربة قبل الحفظ</span>
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleUploadPending()}
                        className="min-h-[40px] inline-flex items-center gap-1.5 app-btn-primary px-4 text-xs disabled:opacity-50"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        <span>{busy ? 'جاري الرفع...' : 'حفظ في المكتبة'}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* AI Spoken Clip Generator for Alert Library */}
          {canAddAi && (
            <form onSubmit={handleGenerateAiVoice} className="app-card p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[var(--brand-orange)] text-white flex items-center justify-center shrink-0">
                    <Mic className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-[var(--brand-charcoal)]">
                      إنشاء مقطع نداء ثابت بالذكاء الاصطناعي وحفظه في مكتبة النغمات
                    </h3>
                    <p className="text-xs text-[var(--brand-charcoal)]/75">
                      توليد عبارة ثابتة محفوظة للاستخدام كتنبيه افتتاحي لأي قسم
                    </p>
                  </div>
                </div>
                <span className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-1 text-[11px] font-bold text-[var(--brand-charcoal)]">
                  {ttsConfigured ? 'محرك الصوت الذكي جاهز' : 'قارئ المتصفح الآلي متوقف — يتطلب محرك الصوت الذكي'}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[var(--brand-charcoal)] mb-1">
                    اسم المقطع
                  </label>
                  <input
                    type="text"
                    value={aiDisplayName}
                    onChange={(e) => setAiDisplayName(e.target.value)}
                    placeholder="مثال: نداء تصعيد الإدارة"
                    className="w-full h-[44px] app-input px-3 text-xs font-bold"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-bold text-[var(--brand-charcoal)] mb-1">
                    نص النداء العربي
                  </label>
                  <input
                    type="text"
                    value={aiPhrase}
                    onChange={(e) => setAiPhrase(e.target.value)}
                    placeholder="اكتب عبارة التنبيه الصوتي المطلوبة..."
                    className="w-full h-[44px] app-input px-3 text-xs font-semibold"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {canTest && (
                  <button
                    type="button"
                    onClick={() =>
                      void previewStationAudio({
                        fileUrl: null,
                        playbackRate: 1,
                        volumePercent: 90,
                        sampleText: aiPhrase,
                        speakTextEnabled: true,
                        authToken,
                      })
                    }
                    className="min-h-[40px] inline-flex items-center gap-1.5 app-btn-secondary px-4 text-xs"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>تجربة النطق</span>
                  </button>
                )}
                <button
                  type="submit"
                  disabled={busy || !aiDisplayName.trim() || !aiPhrase.trim()}
                  className="min-h-[40px] inline-flex items-center gap-1.5 app-btn-primary px-4 text-xs disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>توليد وحفظ في المكتبة</span>
                </button>
              </div>
            </form>
          )}

          {/* Hidden input for replacing an uploaded file */}
          <input
            ref={replaceInputRef}
            type="file"
            accept={ACCEPTED_AUDIO}
            className="hidden"
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              if (chosen && replaceTargetId !== null) {
                void handleReplaceFile(replaceTargetId, chosen);
              }
            }}
          />

          {/* Alert Tone Files Library */}
          <section className="app-card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Music className="w-5 h-5 text-[var(--brand-orange)]" />
                <h3 className="text-base font-bold text-[var(--brand-charcoal)]">
                  مكتبة نغمات التنبيه المعتمدة
                </h3>
              </div>
              <span className="text-xs font-mono-num font-bold text-[var(--brand-charcoal)]/75">
                {files.length} ملف
              </span>
            </div>

            {loading ? (
              <div className="h-24 app-card animate-pulse" />
            ) : files.length === 0 ? (
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-4 text-center text-xs font-semibold text-[var(--brand-charcoal)]/75">
                لا توجد ملفات نغمات مرفوعة حالياً — تعمل القنوات بنغمة التنبيه الافتراضية للنظام.
              </div>
            ) : (
              <div className="space-y-2.5">
                {files.map((f) => (
                  <div
                    key={f.id}
                    className={`rounded-2xl border p-3.5 space-y-2.5 ${
                      f.is_default
                        ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)]/5'
                        : 'border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        {editingId === f.id ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type="text"
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              className="h-[38px] app-input px-3 text-xs font-bold flex-1 min-w-[180px]"
                            />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRenameFile(f)}
                              className="min-h-[38px] app-btn-primary px-3 text-xs"
                            >
                              حفظ الاسم
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="min-h-[38px] app-btn-outline px-3 text-xs"
                            >
                              إلغاء
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-extrabold text-[var(--brand-charcoal)] truncate">
                              {f.display_name}
                            </span>
                            {f.is_default && (
                              <span className="rounded-xl bg-[var(--brand-orange)] text-white px-2.5 py-0.5 text-[10px] font-extrabold">
                                النغمة الافتراضية للنظام
                              </span>
                            )}
                            <span className="rounded-xl border border-[var(--brand-gray-light)] bg-white px-2 py-0.5 text-[10px] font-bold text-[var(--brand-charcoal)]/80">
                              {f.file_category === 'human_voice'
                                ? 'تسجيل بشري'
                                : f.source_type === 'ai_tts'
                                  ? 'مقطع نداء ذكي'
                                  : 'نغمة تنبيه مرفوعة'}
                            </span>
                          </div>
                        )}

                        <div className="text-[11px] text-[var(--brand-charcoal)]/75 font-mono-num">
                          {f.original_name} · {formatBytes(f.size_bytes)} · {formatAdenDateTime(f.created_at)}
                          {f.used_by_stations && f.used_by_stations.length > 0 && (
                            <span className="text-[var(--brand-red)] font-bold">
                              {' '}
                              · مستخدم في:{' '}
                              {f.used_by_stations.map((sc) => STATION_CHANNEL_LABELS[sc] || sc).join('، ')}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {canTest ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleTestLibraryFile(f)}
                              className={`min-h-[38px] inline-flex items-center gap-1.5 rounded-2xl border px-3 text-xs font-bold transition-colors ${
                                playingFileId === f.id
                                  ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)] text-white'
                                  : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
                              }`}
                            >
                              {playingFileId === f.id ? (
                                <RefreshCw className="w-3.5 h-3.5" />
                              ) : (
                                <Play className="w-3.5 h-3.5 text-[var(--brand-red)]" />
                              )}
                              <span>{playingFileId === f.id ? 'إعادة التشغيل' : 'تجربة النغمة'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={stopAllSoundsNow}
                              className="min-h-[38px] inline-flex items-center gap-1 app-btn-outline px-2.5 text-xs"
                              title="إيقاف الصوت"
                            >
                              <Square className="w-3.5 h-3.5 text-[var(--brand-red)]" />
                              <span>إيقاف</span>
                            </button>
                          </>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--brand-charcoal)]/60 px-2">
                            <Lock className="w-3 h-3 text-[var(--brand-orange)]" />
                            <span>التجربة مقفلة</span>
                          </span>
                        )}

                        {canSetDefault && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleSetDefaultFile(f)}
                            className={`min-h-[38px] inline-flex items-center gap-1.5 rounded-2xl border px-3 text-xs font-bold transition-colors ${
                              f.is_default
                                ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)] text-white'
                                : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-orange)]'
                            }`}
                          >
                            <Star className="w-3.5 h-3.5" />
                            <span>{f.is_default ? 'افتراضي' : 'تعيين كافتراضي'}</span>
                          </button>
                        )}

                        {canDeleteOrEdit && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setEditingId(f.id);
                                setEditingName(f.display_name);
                              }}
                              className="min-h-[38px] inline-flex items-center gap-1 app-btn-outline px-2.5 text-xs"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>تعديل</span>
                            </button>

                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setReplaceTargetId(f.id);
                                replaceInputRef.current?.click();
                              }}
                              className="min-h-[38px] inline-flex items-center gap-1 rounded-2xl border border-[var(--brand-orange)] bg-white px-2.5 text-xs font-bold text-[var(--brand-orange)]"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              <span>استبدال</span>
                            </button>

                            {confirmDeleteId === f.id ? (
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleDeleteFile(f)}
                                  className="min-h-[38px] rounded-2xl bg-[var(--brand-red)] text-white px-3 text-xs font-bold"
                                >
                                  تأكيد الحذف
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="min-h-[38px] app-btn-outline px-2.5 text-xs"
                                >
                                  إلغاء
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setConfirmDeleteId(f.id)}
                                className="min-h-[38px] inline-flex items-center gap-1 rounded-2xl border border-[var(--brand-red)] bg-white px-2.5 text-xs font-bold text-[var(--brand-red)] hover:bg-[var(--brand-red)] hover:text-white transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span>حذف</span>
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 6 Independent Station & Alert Chime Channels Configuration */}
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-2">
                <Volume2 className="w-5 h-5 text-[var(--brand-red)]" />
                <h3 className="text-base font-bold text-[var(--brand-charcoal)]">
                  تخصيص نغمة التنبيه لكل قسم ونوع تنبيه (6 قنوات مستقلة عن القارئ البشري)
                </h3>
              </div>
              {!canAssign && !canVolume && (
                <span className="inline-flex items-center gap-1 text-xs text-[var(--brand-charcoal)]/75">
                  <Lock className="w-3.5 h-3.5 text-[var(--brand-orange)]" />
                  <span>للعرض والتجربة فقط</span>
                </span>
              )}
            </div>

            <div className="space-y-4">
              {stations.map((s) => (
                <div key={s.station_code} className="app-card p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--brand-gray-light)] pb-3">
                    <div>
                      <h4 className="text-base font-extrabold text-[var(--brand-red)]">
                        {s.station_name_ar}
                      </h4>
                      <p className="text-xs text-[var(--brand-charcoal)]/75 font-mono-num">
                        النغمة الفعلية:{' '}
                        {s.audio_file_name ||
                          (s.resolved_audio_file_name
                            ? `الافتراضي (${s.resolved_audio_file_name})`
                            : 'نغمة التنبيه الافتراضية للنظام')}{' '}
                        · آخر تحديث: {formatAdenDateTime(s.updated_at)}
                      </p>
                    </div>
                    <label className="inline-flex items-center gap-2 rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-1.5 text-xs font-bold text-[var(--brand-charcoal)]">
                      <input
                        type="checkbox"
                        disabled={!canVolume}
                        checked={s.is_enabled}
                        onChange={(e) =>
                          updateLocalStation(s.station_code, { is_enabled: e.target.checked })
                        }
                        className="w-4 h-4 accent-[#EF1923]"
                      />
                      <span>{s.is_enabled ? 'نغمة التنبيه مفعلة' : 'نغمة التنبيه متوقفة'}</span>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-bold text-[var(--brand-charcoal)]">
                        اختيار نغمة التنبيه من المكتبة لهذه القناة
                      </label>
                      <select
                        disabled={!canAssign}
                        value={s.audio_file_id ?? ''}
                        onChange={(e) => {
                          const val = e.target.value ? Number(e.target.value) : null;
                          const chosen = val ? files.find((f) => f.id === val) : null;
                          updateLocalStation(s.station_code, {
                            audio_file_id: val,
                            audio_file_name: chosen ? chosen.display_name : null,
                            audio_file_url: chosen ? chosen.stream_url : null,
                          });
                        }}
                        className="w-full h-[46px] app-input px-3 text-sm font-semibold disabled:opacity-70"
                      >
                        <option value="">النغمة الافتراضية للنظام (تلقائي)</option>
                        {files.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.display_name} {f.is_default ? '★' : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs font-bold text-[var(--brand-charcoal)]">
                        <span>مستوى صوت النغمة</span>
                        <span className="font-mono-num text-[var(--brand-red)]">{s.volume_percent}%</span>
                      </div>
                      <div className="h-[46px] app-input px-3 flex items-center">
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          disabled={!canVolume}
                          value={s.volume_percent}
                          onChange={(e) =>
                            updateLocalStation(s.station_code, {
                              volume_percent: Number(e.target.value),
                            })
                          }
                          className="w-full accent-[#EF1923] disabled:opacity-60"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-bold text-[var(--brand-charcoal)]">
                        سرعة تشغيل النغمة
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {PLAYBACK_RATE_OPTIONS.map((rate) => {
                          const selected = Number(s.playback_rate) === rate;
                          return (
                            <button
                              key={rate}
                              type="button"
                              disabled={!canVolume}
                              onClick={() => updateLocalStation(s.station_code, { playback_rate: rate })}
                              className={`min-h-[40px] min-w-[60px] rounded-2xl border px-3 text-xs font-mono-num font-extrabold transition-colors disabled:opacity-60 ${
                                selected
                                  ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                                  : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
                              }`}
                            >
                              {rate}x
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <label className="inline-flex items-center gap-2 rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3.5 py-2.5 text-xs font-bold text-[var(--brand-charcoal)]">
                      <input
                        type="checkbox"
                        disabled={!canVolume}
                        checked={s.speak_text_enabled}
                        onChange={(e) =>
                          updateLocalStation(s.station_code, {
                            speak_text_enabled: e.target.checked,
                          })
                        }
                        className="w-4 h-4 accent-[#EF1923]"
                      />
                      <span>تشغيل قراءة البلاغ بالصوت البشري بعد نغمة التنبيه</span>
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-[var(--brand-gray-light)]">
                    {canTest && (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleTestStation(s)}
                          className="min-h-[42px] inline-flex items-center gap-1.5 app-btn-secondary px-4 text-xs"
                        >
                          {playingChannelCode === s.station_code ? (
                            <RefreshCw className="w-4 h-4" />
                          ) : (
                            <Play className="w-4 h-4" />
                          )}
                          <span>
                            {playingChannelCode === s.station_code ? 'إعادة التشغيل' : 'تجربة النغمة'}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={stopAllSoundsNow}
                          className="min-h-[42px] inline-flex items-center gap-1.5 app-btn-outline px-4 text-xs"
                        >
                          <Square className="w-3.5 h-3.5" />
                          <span>إيقاف</span>
                        </button>
                      </>
                    )}

                    {(canAssign || canVolume) && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleSaveStation(s)}
                          className="min-h-[42px] inline-flex items-center gap-1.5 app-btn-primary px-5 text-xs disabled:opacity-50"
                        >
                          <Save className="w-4 h-4" />
                          <span>حفظ واعتماد الإعدادات</span>
                        </button>

                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleResetStation(s)}
                          className="min-h-[42px] inline-flex items-center gap-1.5 app-btn-outline px-4 text-xs"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>إعادة الافتراضي</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 3: AUDIO ALERT DIAGNOSTICS LOG («سجل تشخيص التنبيهات الصوتية»)     */}
      {/* ===================================================================== */}
      {activeTab === 'diagnostics' && (
        <div className="space-y-4">
          <section className="app-card p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--brand-gray-light)] pb-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[var(--brand-charcoal)] text-white flex items-center justify-center shrink-0">
                  <Activity className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-[var(--brand-charcoal)]">
                    سجل تشخيص التنبيهات الصوتية
                  </h3>
                  <p className="text-xs text-[var(--brand-charcoal)]/75">
                    يتتبع لكل بلاغ: رقم البلاغ والفاتورة، القسم المستلم، الصوت المختار، وقت الوصول، طلب التشغيل، بدء التشغيل، الاكتمال أو سبب الفشل الدقيق
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={diagLoading}
                onClick={() => void loadDiagnostics()}
                className="min-h-[40px] inline-flex items-center gap-1.5 app-btn-secondary px-4 text-xs disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${diagLoading ? 'animate-spin' : ''}`} />
                <span>تحديث السجل</span>
              </button>
            </div>

            {/* Summary KPIs */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3 text-center">
                <div className="text-[11px] font-bold text-[var(--brand-charcoal)]/75">إجمالي التنبيهات</div>
                <div className="text-lg font-extrabold font-mono-num text-[var(--brand-charcoal)]">
                  {diagnostics.length}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-white p-3 text-center">
                <div className="text-[11px] font-bold text-[var(--brand-charcoal)]/75">تم التشغيل بنجاح</div>
                <div className="text-lg font-extrabold font-mono-num text-[var(--brand-charcoal)]">
                  {diagnostics.filter((d) => d.playback_status === 'completed').length}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--brand-orange)]/40 bg-[var(--brand-orange)]/10 p-3 text-center">
                <div className="text-[11px] font-bold text-[var(--brand-orange)]">بانتظار التفعيل / محظور</div>
                <div className="text-lg font-extrabold font-mono-num text-[var(--brand-orange)]">
                  {diagnostics.filter((d) => d.playback_status === 'blocked').length}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--brand-red)]/40 bg-[var(--brand-red)]/10 p-3 text-center">
                <div className="text-[11px] font-bold text-[var(--brand-red)]">فشل التشغيل</div>
                <div className="text-lg font-extrabold font-mono-num text-[var(--brand-red)]">
                  {diagnostics.filter((d) => d.playback_status === 'failed').length}
                </div>
              </div>
            </div>

            {/* Filters */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-bold text-[var(--brand-charcoal)] mb-1">
                  تصفية حسب القسم المستلم
                </label>
                <select
                  value={diagDeptFilter}
                  onChange={(e) => setDiagDeptFilter(e.target.value)}
                  className="w-full h-[42px] app-input px-3 text-xs font-bold"
                >
                  <option value="">جميع الأقسام</option>
                  <option value="production">قسم الإنتاج</option>
                  <option value="assembly">قسم التجميع والتسليم</option>
                  <option value="hall">إدارة الصالة</option>
                  <option value="admin">الإدارة العامة</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-[var(--brand-charcoal)] mb-1">
                  تصفية حسب حالة التشغيل
                </label>
                <select
                  value={diagStatusFilter}
                  onChange={(e) => setDiagStatusFilter(e.target.value)}
                  className="w-full h-[42px] app-input px-3 text-xs font-bold"
                >
                  <option value="">جميع الحالات</option>
                  <option value="completed">اكتمل بنجاح</option>
                  <option value="blocked">محظور من المتصفح</option>
                  <option value="failed">فشل التشغيل</option>
                  <option value="started">بدأ التشغيل</option>
                  <option value="requested">تم طلب التشغيل</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-[var(--brand-charcoal)] mb-1">
                  بحث برقم البلاغ أو الفاتورة أو الصوت
                </label>
                <input
                  type="text"
                  value={diagSearch}
                  onChange={(e) => setDiagSearch(e.target.value)}
                  placeholder="ابحث برقم الفاتورة، البلاغ، اسم الصوت..."
                  className="w-full h-[42px] app-input px-3 text-xs font-semibold"
                />
              </div>
            </div>
          </section>

          {diagLoading ? (
            <div className="h-32 app-card animate-pulse" />
          ) : diagnostics.length === 0 ? (
            <div className="app-card p-6 text-center text-xs font-bold text-[var(--brand-charcoal)]/75">
              لا توجد سجلات تشخيص تنبيهات صوتية مطابقة للبحث حالياً — يتم التسجيل تلقائياً فور وصول أي تنبيه صوتي للأقسام.
            </div>
          ) : (
            <div className="space-y-3">
              {diagnostics.map((d) => {
                const isFailed = d.playback_status === 'failed';
                const isBlocked = d.playback_status === 'blocked';
                const isCompleted = d.playback_status === 'completed';
                return (
                  <div
                    key={d.id}
                    className={`rounded-2xl border p-4 space-y-2.5 bg-white ${
                      isFailed
                        ? 'border-[var(--brand-red)]'
                        : isBlocked
                          ? 'border-[var(--brand-orange)]'
                          : 'border-[var(--brand-gray-light)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs font-extrabold">
                        <span className="font-mono-num text-[var(--brand-red)]">
                          {d.ticket_number ? `بلاغ ${d.ticket_number}` : d.ticket_id ? `بلاغ #${d.ticket_id}` : 'رسالة / تنبيه'}
                        </span>
                        {d.invoice_number && (
                          <span className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-2.5 py-0.5 font-mono-num text-[var(--brand-charcoal)]">
                            فاتورة {d.invoice_number}
                          </span>
                        )}
                        <span className="rounded-xl border border-[var(--brand-gray-light)] bg-white px-2.5 py-0.5 text-[var(--brand-charcoal)]">
                          المستلم: {DEPT_LABELS_AR[d.target_department || ''] || d.target_department || '—'}
                        </span>
                        {d.user_name && (
                          <span className="text-[11px] font-semibold text-[var(--brand-charcoal)]/75">
                            ({d.user_name})
                          </span>
                        )}
                      </div>

                      <span
                        className={`rounded-xl px-3 py-1 text-[11px] font-extrabold ${
                          isFailed
                            ? 'bg-[var(--brand-red)] text-white'
                            : isBlocked
                              ? 'bg-[var(--brand-orange)] text-white'
                              : isCompleted
                                ? 'bg-[var(--brand-charcoal)] text-white'
                                : 'bg-[var(--brand-surface-neutral)] text-[var(--brand-charcoal)] border border-[var(--brand-gray-light)]'
                        }`}
                      >
                        {DIAG_STATUS_LABELS[d.playback_status] || d.playback_status}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-[11px] font-semibold text-[var(--brand-charcoal)]">
                      <div className="rounded-xl bg-[var(--brand-surface-neutral)] px-3 py-1.5">
                        الصوت المختار:{' '}
                        <strong className="text-[var(--brand-red)]">
                          {d.selected_voice_name || 'غير محدد'}
                          {d.selected_prebuilt_voice ? ` (${d.selected_prebuilt_voice})` : ''}
                        </strong>
                      </div>
                      <div className="rounded-xl bg-[var(--brand-surface-neutral)] px-3 py-1.5 font-mono-num">
                        وقت الوصول: <strong>{formatAdenDateTime(d.alert_arrived_at)}</strong>
                      </div>
                      <div className="rounded-xl bg-[var(--brand-surface-neutral)] px-3 py-1.5">
                        طلب التشغيل: <strong>{d.playback_requested ? 'نعم' : 'لا'}</strong> · بدأ:{' '}
                        <strong>{d.playback_started ? 'نعم' : 'لا'}</strong> · اكتمل:{' '}
                        <strong>{d.playback_completed ? 'نعم' : 'لا'}</strong>
                      </div>
                      <div className="rounded-xl bg-[var(--brand-surface-neutral)] px-3 py-1.5 font-mono-num">
                        المحرك: <strong>{d.tts_engine || '—'}</strong> · القناة: <strong>{d.channel_code || '—'}</strong>
                      </div>
                    </div>

                    {d.spoken_text && (
                      <div className="text-[11px] text-[var(--brand-charcoal)]/85 bg-[var(--brand-surface-neutral)]/70 rounded-xl px-3 py-2 border border-[var(--brand-gray-light)]">
                        النص المرسل للقراءة: «{d.spoken_text}»
                      </div>
                    )}

                    {d.failure_reason && (
                      <div className="text-xs font-bold text-[var(--brand-red)] bg-[var(--brand-red)]/5 border border-[var(--brand-red)]/30 rounded-xl px-3 py-2 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span>سبب الفشل / المنع: {d.failure_reason}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
