import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';
import { createDatabase } from './server/db.ts';
import {
  BackupManager,
  createDbProxy,
  replaceSqliteFileAtomically,
  type MutableDbHolder,
} from './server/backup.ts';
import { loadUserProfile, verifyAuthToken } from './server/auth.ts';
import { createExpressApp, type WsBroadcaster } from './server/app.ts';
import {
  fetchTicketSummaries,
  getRecipientUserIdsForTicket,
  markTicketsDeliveredToUserDept,
  runEscalationSweep,
} from './server/domain.ts';
import type { DepartmentCode } from './src/types/domain.ts';

interface ClientSocket {
  ws: WebSocket;
  userId: number;
  username: string;
  fullName: string;
  departmentCode: DepartmentCode;
  isTestAccount: boolean;
}

async function startServer() {
  const dbFilePath = path.resolve(process.cwd(), 'data', 'yemeni_taste.db');
  const holder: MutableDbHolder = {
    current: createDatabase(dbFilePath),
    filePath: dbFilePath,
  };
  const db = createDbProxy(holder);
  const backupManager = new BackupManager({ dbFilePath });
  const startedAt = new Date().toISOString();
  const connectedClients = new Set<ClientSocket>();

  const replaceDatabase = (verifiedSourcePath: string) => {
    try {
      holder.current.close();
    } catch {
      // ignore close errors before atomic replacement
    }
    replaceSqliteFileAtomically(verifiedSourcePath, dbFilePath);
    holder.current = createDatabase(dbFilePath);
  };

  const broadcaster: WsBroadcaster = {
    broadcastTicketEvent(eventType, ticket, recipientIds, notifications, actorName) {
      const recipientSet = new Set(recipientIds);
      const notifByUser = new Map(notifications.map((n) => [n.user_id, n]));

      for (const client of connectedClients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        if (!recipientSet.has(client.userId)) continue;
        const payload = {
          type: eventType,
          ticket,
          notification: notifByUser.get(client.userId) ?? null,
          actorName,
          timestamp: new Date().toISOString(),
        };
        client.ws.send(JSON.stringify(payload));
      }
    },
    broadcastSystemEvent(eventType, data) {
      const payload = JSON.stringify({
        type: eventType,
        data,
        timestamp: new Date().toISOString(),
      });
      for (const client of connectedClients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        client.ws.send(payload);
      }
    },
  };

  const app = createExpressApp(db, broadcaster, {
    backupManager,
    replaceDatabase,
    getServerStats: () => {
      const dedup = new Map<
        number,
        {
          user_id: number;
          username: string;
          full_name: string;
          department_code: DepartmentCode;
          is_test_account: boolean;
        }
      >();
      for (const client of connectedClients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        dedup.set(client.userId, {
          user_id: client.userId,
          username: client.username,
          full_name: client.fullName,
          department_code: client.departmentCode,
          is_test_account: client.isTestAccount,
        });
      }
      return {
        startedAt,
        connectedUsers: Array.from(dedup.values()),
      };
    },
  });

  const httpServer = http.createServer(app);

  // Attach WebSocket server on /ws without interfering with Vite HMR if enabled
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      return;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      const decoded = verifyAuthToken(token);
      const user = loadUserProfile(db, decoded.userId);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        const entry: ClientSocket = {
          ws,
          userId: user.id,
          username: user.username,
          fullName: user.full_name,
          departmentCode: user.department_code,
          isTestAccount: Boolean(user.is_test_account),
        };
        connectedClients.add(entry);
        ws.send(JSON.stringify({ type: 'connected', userId: user.id, timezone: 'Asia/Aden' }));

        // Mark pending department tickets as delivered to this user's active session immediately
        try {
          const pendingIds = fetchTicketSummaries(db, { isTest: Boolean(user.is_test_account) })
            .filter(
              (t) =>
                t.status !== 'closed' &&
                !t.delivered_to_dept_at &&
                t.target_department === user.department_code &&
                t.sender_department !== user.department_code
            )
            .map((t) => t.id);
          if (pendingIds.length > 0) {
            const delivered = markTicketsDeliveredToUserDept(db, user, pendingIds, 'websocket');
            for (const dt of delivered) {
              const recipients = getRecipientUserIdsForTicket(db, dt, user.id);
              broadcaster.broadcastTicketEvent('ticket_delivered', dt, recipients, [], user.full_name);
            }
          }
        } catch (err) {
          console.error('WS initial delivery ACK error:', err);
        }

        ws.on('close', () => {
          connectedClients.delete(entry);
        });
        ws.on('error', () => {
          connectedClients.delete(entry);
        });
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    }
  });

  // Run automatic unreceived-reminder & escalation sweep every 20 seconds
  setInterval(() => {
    try {
      runEscalationSweep(db, (notifications, ticket, eventType) => {
        const recipients = getRecipientUserIdsForTicket(db, ticket);
        broadcaster.broadcastTicketEvent(
          eventType || 'ticket_escalated',
          ticket,
          recipients,
          notifications,
          'النظام الآلي'
        );
      });
    } catch (err) {
      console.error('Escalation sweep error:', err);
    }
  }, 20000);

  // Automatic verified backup on startup (if latest verified backup is older than 6h) & scheduled interval
  const ensureStartupBackup = async () => {
    try {
      const backups = backupManager.listBackups();
      const latestVerified = backups.find((b) => b.integrity_status === 'verified' && b.file_exists);
      const sixHoursMs = 6 * 3600 * 1000;
      if (!latestVerified || Date.now() - new Date(latestVerified.created_at).getTime() > sixHoursMs) {
        await backupManager.createVerifiedBackup(db, {
          trigger_type: 'startup',
          reason: 'نسخة احتياطية تلقائية موثقة عند تشغيل الخادم',
        });
      }
    } catch (err) {
      console.error('Startup backup warning:', err);
    }
  };
  void ensureStartupBackup();

  const backupIntervalMinutes = Math.max(5, Number(process.env.BACKUP_INTERVAL_MINUTES) || 60);
  setInterval(() => {
    void backupManager
      .createVerifiedBackup(db, {
        trigger_type: 'scheduled',
        reason: `نسخة احتياطية مجدولة كل ${backupIntervalMinutes} دقيقة`,
      })
      .catch((err) => {
        console.error('Scheduled backup warning:', err);
      });
  }, backupIntervalMinutes * 60000);

  // Serve Android TWA Digital Asset Links cleanly in both development and production
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const assetLinksPath =
      process.env.NODE_ENV === 'production'
        ? path.resolve(process.cwd(), 'dist', '.well-known', 'assetlinks.json')
        : path.resolve(process.cwd(), 'public', '.well-known', 'assetlinks.json');
    res.type('application/json').sendFile(assetLinksPath);
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: {
          server: httpServer,
          path: '/__vite_hmr',
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir, { dotfiles: 'allow' }));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const portArgIdx = process.argv.indexOf('--port');
  const cliPort = portArgIdx !== -1 ? Number(process.argv[portArgIdx + 1]) : NaN;
  const PORT = Number.isFinite(cliPort) && cliPort > 0 ? cliPort : Number(process.env.PORT) || 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Al-Mazaq Al-Yamani Smart Ops server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
