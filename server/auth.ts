import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { DepartmentCode, RoleCode, UserProfile } from '../src/types/domain.ts';

function resolveJwtSecret(): string {
  const envSecret = (process.env.JWT_SECRET || '').trim();
  if (envSecret && envSecret !== 'replace_with_strong_random_secret') {
    return envSecret;
  }
  try {
    const secretFile = path.resolve(process.cwd(), 'data', '.jwt_secret');
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    const generated = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, generated, { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch {
    return 'almazaq-yemeni-smart-ops-secret-key-2026';
  }
}

const JWT_SECRET = resolveJwtSecret();

export interface AuthTokenPayload {
  userId: number;
  username: string;
}

export interface AuthedRequest extends Request {
  authUser?: UserProfile;
}

export function signAuthToken(userId: number, username: string): string {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '24h' });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
}

export function loadUserProfile(db: Database.Database, userId: number): UserProfile | null {
  const row = db.prepare(`
    SELECT
      u.id,
      u.full_name,
      u.username,
      u.email,
      u.is_active,
      COALESCE(u.is_test_account, 0) AS is_test_account,
      r.code AS role_code,
      r.name_ar AS role_name_ar,
      d.code AS department_code,
      d.name_ar AS department_name_ar
    FROM users u
    JOIN roles r ON r.id = u.role_id
    JOIN departments d ON d.id = u.department_id
    WHERE u.id = ?
  `).get(userId) as
    | {
        id: number;
        full_name: string;
        username: string;
        email: string | null;
        is_active: number;
        is_test_account: number;
        role_code: RoleCode;
        role_name_ar: string;
        department_code: DepartmentCode;
        department_name_ar: string;
      }
    | undefined;

  if (!row || row.is_active !== 1 || row.role_code === 'waiter') return null;

  const rolePerms = db.prepare(`
    SELECT p.code
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    JOIN roles r ON r.id = rp.role_id
    WHERE r.code = ?
  `).all(row.role_code) as { code: string }[];

  const userPerms = db.prepare(`
    SELECT p.code, up.granted
    FROM user_permissions up
    JOIN permissions p ON p.id = up.permission_id
    WHERE up.user_id = ?
  `).all(row.id) as { code: string; granted: number }[];

  const rolePermCodes = rolePerms.map((p) => p.code);
  const permSet = new Set<string>(rolePermCodes);
  const explicitPermissions: Record<string, boolean> = {};
  for (const up of userPerms) {
    explicitPermissions[up.code] = up.granted === 1;
    if (up.granted === 1) permSet.add(up.code);
    else permSet.delete(up.code);
  }

  const permissions = Array.from(permSet);
  return {
    id: row.id,
    full_name: row.full_name,
    username: row.username,
    email: row.email,
    role_code: row.role_code,
    role_name_ar: row.role_name_ar,
    department_code: row.department_code,
    department_name_ar: row.department_name_ar,
    is_active: row.is_active === 1,
    is_test_account: row.is_test_account === 1,
    permissions,
    role_permissions: rolePermCodes,
    explicit_permissions: explicitPermissions,
    has_assembly_support: permissions.includes('assembly_support') || row.role_code === 'admin',
  };
}

export function createAuthMiddleware(db: Database.Database) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول للوصول إلى هذا المورد' });
    }
    const token = authHeader.slice(7).trim();
    try {
      const decoded = verifyAuthToken(token);
      const user = loadUserProfile(db, decoded.userId);
      if (!user) {
        return res.status(401).json({ error: 'الحساب غير نشط أو غير موجود' });
      }
      req.authUser = user;
      next();
    } catch {
      return res.status(401).json({ error: 'جلسة الدخول غير صالحة أو منتهية' });
    }
  };
}

export function hasAnyPermission(user: UserProfile, ...permissionCodes: string[]): boolean {
  if (user.role_code === 'admin') return true;
  return permissionCodes.some((code) => user.permissions.includes(code));
}

export function requirePermission(permissionCode: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({ error: 'غير مصرح' });
    }
    if (!req.authUser.permissions.includes(permissionCode) && req.authUser.role_code !== 'admin') {
      return res.status(403).json({ error: 'ليس لديك صلاحية لتنفيذ هذه العملية' });
    }
    next();
  };
}

export function requireAnyPermission(...permissionCodes: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({ error: 'غير مصرح' });
    }
    if (!hasAnyPermission(req.authUser, ...permissionCodes)) {
      return res.status(403).json({ error: 'ليس لديك صلاحية لتنفيذ هذه العملية' });
    }
    next();
  };
}
