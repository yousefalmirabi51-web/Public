import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Save,
  Shield,
  Sliders,
  UserPlus,
  Users,
} from 'lucide-react';
import { apiRequest } from '../api/client';
import {
  ACTIVE_USER_DEPARTMENTS,
  ACTIVE_USER_ROLES,
  DEPARTMENT_LABELS,
  GRANULAR_PERMISSIONS,
  ROLE_LABELS,
  type DepartmentCode,
  type GranularPermissionMeta,
  type RoleCode,
  type UserProfile,
} from '../types/domain';

interface RoleRecord {
  id: number;
  code: string;
  name_ar: string;
  description: string;
}

interface UsersScreenProps {
  currentUser: UserProfile;
}

export const UsersScreen: React.FC<UsersScreenProps> = ({ currentUser }) => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [availablePerms, setAvailablePerms] = useState<GranularPermissionMeta[]>(GRANULAR_PERMISSIONS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleCode, setRoleCode] = useState<RoleCode>('hall_supervisor');
  const [deptCode, setDeptCode] = useState<DepartmentCode>('hall');
  const [createPerms, setCreatePerms] = useState<Record<string, boolean>>({});

  const [expandedUserId, setExpandedUserId] = useState<number | null>(null);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [savingRoleCode, setSavingRoleCode] = useState<string | null>(null);

  const isAdmin = currentUser.role_code === 'admin';
  const canManageUsers = isAdmin || currentUser.permissions.includes('manage_users');
  const canManageRoles = isAdmin || currentUser.permissions.includes('manage_roles');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, rolesRes] = await Promise.all([
        apiRequest<{ users: UserProfile[]; available_permissions?: GranularPermissionMeta[] }>('/api/users'),
        apiRequest<{ roles: RoleRecord[] }>('/api/roles').catch(() => ({ roles: [] })),
      ]);
      setUsers(usersRes.users);
      if (usersRes.available_permissions && usersRes.available_permissions.length > 0) {
        setAvailablePerms(usersRes.available_permissions);
      }
      setRoles(rolesRes.roles);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل المستخدمين والصلاحيات');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleToggleActive = async (u: UserProfile) => {
    if (u.id === currentUser.id) return;
    setMsg(null);
    setError(null);
    try {
      await apiRequest(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !u.is_active }),
      });
      setMsg(`تم تحديث حالة الحساب للموظف ${u.full_name}`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث حالة الحساب');
    }
  };

  const handleToggleGranularPermission = async (u: UserProfile, permCode: string) => {
    setSavingUserId(u.id);
    setMsg(null);
    setError(null);
    const currentlyGranted = u.permissions.includes(permCode);
    try {
      const res = await apiRequest<{ user: UserProfile }>(`/api/users/${u.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          permission_updates: {
            [permCode]: !currentlyGranted,
          },
        }),
      });
      setUsers((prev) => prev.map((item) => (item.id === u.id ? res.user : item)));
      const meta = availablePerms.find((p) => p.code === permCode);
      setMsg(
        `${!currentlyGranted ? 'تم منح' : 'تم سحب'} صلاحية (${meta?.label_ar || permCode}) للموظف ${u.full_name}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحديث الصلاحية');
    } finally {
      setSavingUserId(null);
    }
  };

  const handleRoleTitleSave = async (role: RoleRecord) => {
    setSavingRoleCode(role.code);
    setMsg(null);
    setError(null);
    try {
      const res = await apiRequest<{ role: RoleRecord }>(`/api/roles/${role.code}`, {
        method: 'PATCH',
        body: JSON.stringify({ name_ar: role.name_ar, description: role.description }),
      });
      setRoles((prev) => prev.map((r) => (r.code === role.code ? res.role : r)));
      setMsg(`تم حفظ المسمى الوظيفي للدور (${res.role.name_ar}) وتسجيل التغيير في سجل الرقابة`);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر حفظ تعديل الدور');
    } finally {
      setSavingRoleCode(null);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMsg(null);
    const selectedPerms = Object.entries(createPerms)
      .filter(([, val]) => val)
      .map(([k]) => k);
    try {
      await apiRequest('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          full_name: fullName,
          username,
          email: email || undefined,
          password,
          role_code: roleCode,
          department_code: deptCode,
          assembly_support: roleCode === 'hall_supervisor',
          granted_permissions: selectedPerms,
        }),
      });
      setMsg('تم إنشاء حساب الموظف وتوزيع صلاحياته بنجاح');
      setShowCreate(false);
      setFullName('');
      setUsername('');
      setEmail('');
      setPassword('');
      setCreatePerms({});
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إنشاء الحساب');
    }
  };

  const adminPerms = availablePerms.filter((p) => p.category === 'admin');
  const audioPerms = availablePerms.filter((p) => p.category === 'audio');

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-[var(--brand-charcoal)]">إدارة المستخدمين والأدوار وتوزيع الصلاحيات</h2>
          <p className="text-sm text-[var(--brand-charcoal)]/80">
            إدارة حسابات الموظفين وتوزيع صلاحيات الإدارة والأصوات والتوقيت بشكل مستقل ودقيق — بدور موحد لمسؤول الصالة
          </p>
        </div>
        {canManageUsers && (
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="min-h-[44px] inline-flex items-center gap-2 app-btn-primary px-4 text-sm"
          >
            <UserPlus className="w-4 h-4" />
            <span>{showCreate ? 'إلغاء الإضافة' : 'إضافة موظف جديد'}</span>
          </button>
        )}
      </div>

      {msg && (
        <div className="app-card px-4 py-3 text-sm font-bold text-[var(--brand-charcoal)] flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-[var(--brand-red)] shrink-0" />
          <span>{msg}</span>
        </div>
      )}

      {error && (
        <div className="app-card-urgent px-4 py-3 text-sm font-bold text-[var(--brand-red)]">
          {error}
        </div>
      )}

      {/* Unified Roles Management Panel */}
      {canManageRoles && roles.length > 0 && (
        <section className="app-card p-5 space-y-3">
          <div className="flex items-center gap-2.5">
            <Sliders className="w-5 h-5 text-[var(--brand-orange)]" />
            <div>
              <h3 className="text-base font-bold text-[var(--brand-charcoal)]">الأدوار الوظيفية المعتمدة (موحدة)</h3>
              <p className="text-xs text-[var(--brand-charcoal)]/75">
                تم توحيد دور مسؤول الصالة ليجمع كامل الصلاحيات التشغيلية دون تقسيم، مع إمكانية تعديل المسمى الوظيفي لكل دور
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {roles.map((r) => (
              <div
                key={r.code}
                className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3.5 space-y-2"
              >
                <div className="flex items-center justify-between text-[11px] font-mono-num text-[var(--brand-charcoal)]/70">
                  <span>الرمز: {r.code}</span>
                  {r.code === 'hall_supervisor' && (
                    <span className="rounded-xl bg-[var(--brand-red)] text-white px-2 py-0.5 text-[10px] font-bold">
                      دور موحد شامل الصلاحيات
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  value={r.name_ar}
                  onChange={(e) =>
                    setRoles((prev) =>
                      prev.map((item) => (item.code === r.code ? { ...item, name_ar: e.target.value } : item))
                    )
                  }
                  className="w-full h-[40px] app-input px-3 text-xs font-bold"
                />
                <input
                  type="text"
                  value={r.description}
                  onChange={(e) =>
                    setRoles((prev) =>
                      prev.map((item) => (item.code === r.code ? { ...item, description: e.target.value } : item))
                    )
                  }
                  className="w-full h-[38px] app-input px-3 text-[11px]"
                />
                <button
                  type="button"
                  disabled={savingRoleCode === r.code}
                  onClick={() => void handleRoleTitleSave(r)}
                  className="min-h-[36px] inline-flex items-center gap-1.5 app-btn-outline px-3 text-xs"
                >
                  <Save className="w-3.5 h-3.5 text-[var(--brand-red)]" />
                  <span>{savingRoleCode === r.code ? 'جاري الحفظ...' : 'حفظ المسمى'}</span>
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {showCreate && canManageUsers && (
        <form onSubmit={handleCreateUser} className="app-card p-5 space-y-4">
          <h3 className="text-base font-bold text-[var(--brand-charcoal)]">بيانات الحساب الجديد</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="الاسم الكامل *"
              className="h-[48px] app-input px-4 text-sm"
            />
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="اسم المستخدم *"
              className="h-[48px] app-input px-4 text-sm"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="البريد الإلكتروني (اختياري)"
              className="h-[48px] app-input px-4 text-sm"
            />
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="كلمة المرور *"
              className="h-[48px] app-input px-4 text-sm"
            />
            <select
              value={roleCode}
              onChange={(e) => setRoleCode(e.target.value as RoleCode)}
              className="h-[48px] app-input px-4 text-sm font-semibold"
            >
              {ACTIVE_USER_ROLES.map((k) => (
                <option key={k} value={k}>
                  {ROLE_LABELS[k]}
                </option>
              ))}
            </select>
            <select
              value={deptCode}
              onChange={(e) => setDeptCode(e.target.value as DepartmentCode)}
              className="h-[48px] app-input px-4 text-sm font-semibold"
            >
              {ACTIVE_USER_DEPARTMENTS.map((k) => (
                <option key={k} value={k}>
                  {DEPARTMENT_LABELS[k]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2 pt-1">
            <div className="text-xs font-extrabold text-[var(--brand-charcoal)]">
              منح صلاحيات إدارية أو صوتية إضافية (اختياري ومستقل عن الدور):
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {availablePerms.map((p) => (
                <label
                  key={p.code}
                  className="flex items-center gap-2 rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2 text-xs font-semibold text-[var(--brand-charcoal)]"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(createPerms[p.code])}
                    onChange={(e) => setCreatePerms((prev) => ({ ...prev, [p.code]: e.target.checked }))}
                    className="w-4 h-4 accent-[#EF1923]"
                  />
                  <span>{p.label_ar}</span>
                </label>
              ))}
            </div>
          </div>

          <button type="submit" className="min-h-[48px] app-btn-primary px-6 text-sm">
            حفظ الحساب
          </button>
        </form>
      )}

      {loading ? (
        <div className="h-48 app-card animate-pulse" />
      ) : (
        <div className="space-y-3">
          {users.map((u) => {
            const isExpanded = expandedUserId === u.id;
            const isWaiter = u.role_code === 'waiter';
            return (
              <div key={u.id} className="app-card p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="w-11 h-11 rounded-full bg-[var(--brand-charcoal)] text-white flex items-center justify-center shrink-0">
                      {u.role_code === 'admin' ? <Shield className="w-5 h-5" /> : <Users className="w-5 h-5" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-[var(--brand-charcoal)]">
                        {u.full_name} · <span className="font-mono-num text-[var(--brand-red)]">{u.username}</span>
                        {u.is_test_account && (
                          <span className="text-xs font-extrabold text-[var(--brand-orange)]"> · حساب اختبار معزول</span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--brand-charcoal)]/80">
                        {u.role_name_ar} · {u.department_name_ar} ·{' '}
                        <span className={u.is_active ? 'text-[var(--brand-charcoal)] font-bold' : 'text-[var(--brand-red)] font-bold'}>
                          {u.is_active ? 'نشط' : 'معطل'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {!isWaiter && (
                      <button
                        type="button"
                        onClick={() => setExpandedUserId(isExpanded ? null : u.id)}
                        className={`min-h-[40px] inline-flex items-center gap-1.5 rounded-2xl border px-3.5 text-xs font-bold transition-colors ${
                          isExpanded
                            ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                            : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
                        }`}
                      >
                        <KeyRound className="w-3.5 h-3.5" />
                        <span>صلاحيات الإدارة والأصوات</span>
                        {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    )}

                    {isWaiter ? (
                      <span className="min-h-[40px] inline-flex items-center rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3.5 text-xs font-bold text-[var(--brand-charcoal)]">
                        حساب تاريخي محفوظ (الدور ملغى)
                      </span>
                    ) : (
                      u.id !== currentUser.id &&
                      canManageUsers && (
                        <button
                          type="button"
                          onClick={() => void handleToggleActive(u)}
                          className="min-h-[40px] app-btn-outline px-3.5 text-xs"
                        >
                          {u.is_active ? 'تعطيل الحساب' : 'تفعيل الحساب'}
                        </button>
                      )
                    )}
                  </div>
                </div>

                {/* Granular Permission Controls Drawer */}
                {isExpanded && !isWaiter && (
                  <div className="pt-3 border-t border-[var(--brand-gray-light)] space-y-3">
                    {u.role_code === 'admin' ? (
                      <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3.5 py-2.5 text-xs font-bold text-[var(--brand-charcoal)]">
                        يمتلك مدير النظام كامل الصلاحيات الإدارية وصلاحيات الأصوات بشكل افتراضي.
                      </div>
                    ) : (
                      <>
                        <div className="space-y-1.5">
                          <div className="text-xs font-extrabold text-[var(--brand-red)]">
                            صلاحيات الإدارة والمسؤولين وأوقات التعثر والتصعيد
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {adminPerms.map((p) => {
                              const checked = u.permissions.includes(p.code);
                              return (
                                <label
                                  key={p.code}
                                  className={`flex items-center gap-2.5 rounded-2xl border px-3 py-2 text-xs font-bold cursor-pointer transition-colors ${
                                    checked
                                      ? 'border-[var(--brand-orange)] bg-[var(--brand-orange)]/10 text-[var(--brand-charcoal)]'
                                      : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)]/85'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    disabled={savingUserId === u.id}
                                    checked={checked}
                                    onChange={() => void handleToggleGranularPermission(u, p.code)}
                                    className="w-4 h-4 accent-[#EF1923]"
                                  />
                                  <span>{p.label_ar}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <div className="text-xs font-extrabold text-[var(--brand-orange)]">
                            صلاحيات إدارة الأصوات والتنبيهات الصوتية
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {audioPerms.map((p) => {
                              const checked = u.permissions.includes(p.code);
                              return (
                                <label
                                  key={p.code}
                                  className={`flex items-center gap-2.5 rounded-2xl border px-3 py-2 text-xs font-bold cursor-pointer transition-colors ${
                                    checked
                                      ? 'border-[var(--brand-red)] bg-[var(--brand-red)]/10 text-[var(--brand-charcoal)]'
                                      : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)]/85'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    disabled={savingUserId === u.id}
                                    checked={checked}
                                    onChange={() => void handleToggleGranularPermission(u, p.code)}
                                    className="w-4 h-4 accent-[#EF1923]"
                                  />
                                  <span>{p.label_ar}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
