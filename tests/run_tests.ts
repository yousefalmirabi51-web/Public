import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createDatabase } from '../server/db.ts';
import { createExpressApp, type WsBroadcaster } from '../server/app.ts';
import { loadUserProfile, verifyAuthToken } from '../server/auth.ts';
import { getAdenDateKey, getRecipientUserIdsForTicket, runEscalationSweep } from '../server/domain.ts';
import { normalizeArabicForSpeech } from '../server/tts.ts';
import { BackupManager, createDbProxy, replaceSqliteFileAtomically, type MutableDbHolder } from '../server/backup.ts';

async function runTests() {
  const db = createDatabase(':memory:');
  const connected = new Set<{ ws: WebSocket; userId: number }>();

  const broadcaster: WsBroadcaster = {
    broadcastTicketEvent(eventType, ticket, recipientIds, notifications, actorName) {
      const set = new Set(recipientIds);
      const map = new Map(notifications.map((n) => [n.user_id, n]));
      for (const c of connected) {
        if (c.ws.readyState === WebSocket.OPEN && set.has(c.userId)) {
          c.ws.send(
            JSON.stringify({
              type: eventType,
              ticket,
              notification: map.get(c.userId) ?? null,
              actorName,
            })
          );
        }
      }
    },
    broadcastSystemEvent(eventType, data) {
      const payload = JSON.stringify({
        type: eventType,
        data,
        timestamp: new Date().toISOString(),
      });
      for (const c of connected) {
        if (c.ws.readyState === WebSocket.OPEN) {
          c.ws.send(payload);
        }
      }
    },
  };

  const mainAudioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yemeni-taste-audio-main-'));
  const app = createExpressApp(db, broadcaster, { audioDir: mainAudioDir });
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') return;
    const token = url.searchParams.get('token') || '';
    try {
      const decoded = verifyAuthToken(token);
      const user = loadUserProfile(db, decoded.userId);
      if (!user) return socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) => {
        const entry = { ws, userId: user.id };
        connected.add(entry);
        ws.on('close', () => connected.delete(entry));
      });
    } catch {
      socket.destroy();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function api(path: string, method = 'GET', token?: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  }

  let passed = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    await fn();
    passed++;
    console.log(`PASS [${passed}]: ${name}`);
  };

  const openWs = async (tok: string) => {
    const events: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws?token=${tok}`);
    await new Promise<void>((resolve) => ws.on('open', () => resolve()));
    ws.on('message', (data) => events.push(JSON.parse(data.toString())));
    return { ws, events };
  };

  try {
    // 1. Login tests + Waiter non-destructive abolition
    const tokens: Record<string, string> = {};
    await test('Login succeeds for active roles and blocks abolished waiter accounts while preserving historical records', async () => {
      const bad = await api('/api/auth/login', 'POST', undefined, { username: 'assembly', password: 'wrong' });
      assert.equal(bad.status, 401);

      for (const [uname, pwd] of [
        ['assembly', 'Pass@123'],
        ['production', 'Pass@123'],
        ['hall', 'Pass@123'],
        ['hall2', 'Pass@123'],
        ['admin', 'Admin@123'],
      ]) {
        const res = await api('/api/auth/login', 'POST', undefined, { username: uname, password: pwd });
        assert.equal(res.status, 200);
        assert.ok(res.json.token);
        tokens[uname] = res.json.token;
      }

      // Waiters blocked from login (403)
      const waiterLogin = await api('/api/auth/login', 'POST', undefined, { username: 'waiter1', password: 'Pass@123' });
      assert.equal(waiterLogin.status, 403);

      // Historical waiter user & historical ticket remain preserved in DB!
      const waiterRow = db.prepare("SELECT is_active FROM users WHERE username = 'waiter1'").get() as { is_active: number };
      assert.equal(waiterRow.is_active, 0);
      const histTicket = db.prepare("SELECT invoice_number, assigned_waiter_id FROM tickets WHERE invoice_number = '1247'").get() as any;
      assert.ok(histTicket && histTicket.assigned_waiter_id);

      // Meta hides waiter role/dept
      const meta = await api('/api/meta', 'GET', tokens.admin);
      assert.equal(meta.json.roles.some((r: any) => r.code === 'waiter'), false);
      assert.equal(meta.json.departments.some((d: any) => d.code === 'waiters'), false);

      // Creating waiter user or reactivating waiter1 is rejected (400)
      const createWaiter = await api('/api/users', 'POST', tokens.admin, {
        full_name: 'مباشر تجريبي',
        username: 'waiter_new',
        password: 'Pass@123',
        role_code: 'waiter',
        department_code: 'waiters',
      });
      assert.equal(createWaiter.status, 400);

      // Create second Production device/user for multi-device same-station alert test
      const prod2Create = await api('/api/users', 'POST', tokens.admin, {
        full_name: 'فني إنتاج ثاني',
        username: 'prod2',
        password: 'Pass@123',
        role_code: 'production',
        department_code: 'production',
      });
      assert.equal(prod2Create.status, 201);
      const prod2Login = await api('/api/auth/login', 'POST', undefined, { username: 'prod2', password: 'Pass@123' });
      assert.equal(prod2Login.status, 200);
      tokens.prod2 = prod2Login.json.token;
    });

    // Connect live WebSockets for all stations + second production device
    const prodConn = await openWs(tokens.production);
    const prod2Conn = await openWs(tokens.prod2);
    const asmConn = await openWs(tokens.assembly);
    const hallConn = await openWs(tokens.hall);

    const clearWsEvents = () => {
      prodConn.events.length = 0;
      prod2Conn.events.length = 0;
      asmConn.events.length = 0;
      hallConn.events.length = 0;
    };

    // 2. Create production ticket & verify routing + strict audio targeting (Production ONLY!)
    let prodTicketId = 0;
    await test('Assembly -> Production ticket routes to Production+Assembly visibility, plays audio ONLY in Production (both devices)', async () => {
      clearWsEvents();
      const created = await api('/api/tickets', 'POST', tokens.assembly, {
        client_request_id: 'test-req-9001',
        invoice_number: '9901',
        item_name: 'ربع بروستد حار',
        quantity: 1,
        reason_code: 'production_delay',
        problem_description: 'تأخر خروج البروستد عن الوقت المحدد',
      });
      assert.equal(created.status, 201);
      prodTicketId = created.json.ticket.id;

      // Production inbox sees it
      const prodInbox = await api('/api/tickets?scope=inbox', 'GET', tokens.production);
      assert.ok(prodInbox.json.tickets.some((t: any) => t.id === prodTicketId));

      // Assembly inbox sees it
      const asmInbox = await api('/api/tickets?scope=inbox', 'GET', tokens.assembly);
      assert.ok(asmInbox.json.tickets.some((t: any) => t.id === prodTicketId));

      // Hall supervisor main inbox MUST NOT see production delay ticket
      const hallInbox = await api('/api/tickets?scope=inbox', 'GET', tokens.hall);
      assert.equal(hallInbox.json.tickets.some((t: any) => t.id === prodTicketId), false);

      await new Promise((r) => setTimeout(r, 80));

      // Both Production devices receive should_play_audio = true
      const p1Ev = prodConn.events.find((m) => m.type === 'ticket_created' && m.ticket.id === prodTicketId);
      const p2Ev = prod2Conn.events.find((m) => m.type === 'ticket_created' && m.ticket.id === prodTicketId);
      assert.ok(p1Ev?.notification?.should_play_audio === true);
      assert.ok(p2Ev?.notification?.should_play_audio === true);

      // Assembly (sender) MUST NOT receive audio alert!
      const asmEv = asmConn.events.find((m) => m.type === 'ticket_created' && m.ticket.id === prodTicketId);
      assert.equal(Boolean(asmEv?.notification?.should_play_audio), false);

      // Hall MUST NOT receive notification or audio alert!
      const hallEv = hallConn.events.find((m) => m.type === 'ticket_created' && m.ticket.id === prodTicketId);
      assert.equal(hallEv, undefined);
    });

    // 3. Direct Hall <-> Production, Hall <-> Assembly, Production <-> Assembly message audio isolation
    await test('Strict station-to-station audio routing across all 4 directional flows & consecutive message queueing', async () => {
      // Hall creates assembly_backlog ticket (Hall -> Assembly => Audio ONLY in Assembly)
      clearWsEvents();
      const hallToAsm = await api('/api/tickets', 'POST', tokens.hall, {
        invoice_number: '9950',
        item_name: 'طلب تكدس تجهيز',
        reason_code: 'assembly_backlog',
        target_department: 'assembly',
        problem_description: 'تراكم في التجميع',
      });
      assert.equal(hallToAsm.status, 201);
      const hallToAsmId = hallToAsm.json.ticket.id;

      await new Promise((r) => setTimeout(r, 80));
      assert.equal(asmConn.events.find((e) => e.ticket?.id === hallToAsmId)?.notification?.should_play_audio, true);
      assert.equal(Boolean(prodConn.events.find((e) => e.ticket?.id === hallToAsmId)?.notification?.should_play_audio), false);
      assert.equal(Boolean(hallConn.events.find((e) => e.ticket?.id === hallToAsmId)?.notification?.should_play_audio), false);

      // Hall sends ticket/reply to Production (Hall -> Production => Audio ONLY in Production, NOT Assembly, NOT Hall)
      clearWsEvents();
      const hallToProdTicket = await api('/api/tickets', 'POST', tokens.hall, {
        invoice_number: '9951',
        item_name: 'حبة شواية',
        reason_code: 'production_delay',
        target_department: 'production',
        problem_description: 'تأخر من المطبخ',
      });
      assert.equal(hallToProdTicket.status, 201);
      const hallToProdId = hallToProdTicket.json.ticket.id;

      await new Promise((r) => setTimeout(r, 80));
      assert.equal(prodConn.events.find((e) => e.ticket?.id === hallToProdId)?.notification?.should_play_audio, true);
      assert.equal(Boolean(asmConn.events.find((e) => e.ticket?.id === hallToProdId)?.notification?.should_play_audio), false);
      assert.equal(Boolean(hallConn.events.find((e) => e.ticket?.id === hallToProdId)?.notification?.should_play_audio), false);

      // Consecutive replies Hall -> Production (verify distinct message_uid & delivery tracking without marking is_read)
      clearWsEvents();
      const r1 = await api(`/api/tickets/${hallToProdId}/reply`, 'POST', tokens.hall, {
        message: 'رسالة متتابعة رقم 1',
        recipient_department: 'production',
      });
      const r2 = await api(`/api/tickets/${hallToProdId}/reply`, 'POST', tokens.hall, {
        message: 'رسالة متتابعة رقم 2',
        recipient_department: 'production',
      });
      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);

      await new Promise((r) => setTimeout(r, 80));
      const prodReplies = prodConn.events.filter((e) => e.type === 'ticket_reply' && e.ticket?.id === hallToProdId);
      assert.equal(prodReplies.length, 2);
      assert.notEqual(prodReplies[0].notification.message_uid, prodReplies[1].notification.message_uid);
      assert.equal(prodReplies[0].notification.should_play_audio, true);
      assert.equal(prodReplies[1].notification.should_play_audio, true);

      // Assembly received zero WS reply notifications or audio alerts for Hall -> Production direct replies
      assert.equal(asmConn.events.filter((e) => e.type === 'ticket_reply' && e.notification !== null).length, 0);
      const asmNotifs = await api('/api/notifications', 'GET', tokens.assembly);
      assert.equal(asmNotifs.json.notifications.some((n: any) => n.ticket_id === hallToProdId && n.event_type === 'ticket_reply'), false);
      const asmViewDetail = await api(`/api/tickets/${hallToProdId}`, 'GET', tokens.assembly);
      assert.equal(asmViewDetail.json.ticket.replies.length, 0);

      // Confirm audio delivery does NOT mark notification as read
      const notifId = prodReplies[0].notification.id;
      const deliv = await api(`/api/notifications/${notifId}/delivered`, 'POST', tokens.production, {});
      assert.equal(deliv.status, 200);
      const prodNotifs = await api('/api/notifications', 'GET', tokens.production);
      const checkedNotif = prodNotifs.json.notifications.find((n: any) => n.id === notifId);
      assert.ok(checkedNotif.delivered_at);
      assert.equal(checkedNotif.is_read, false);
    });

    // 4. Hall Supervisor manages readiness/backlog closure directly without Waiter role
    await test('Abolished Waiter endpoints return 403 and Hall Supervisor closes no_waiter_available directly', async () => {
      const created = await api('/api/tickets', 'POST', tokens.assembly, {
        invoice_number: '9902',
        item_name: 'طلب تكدس صالة بدون مباشر',
        reason_code: 'no_waiter_available',
        problem_description: 'تكدس طلبات جاهزة للتسليم',
      });
      assert.equal(created.status, 201);
      const tid = created.json.ticket.id;

      const assignWaiter = await api(`/api/tickets/${tid}/assign-waiter`, 'POST', tokens.hall, { waiter_id: 6 });
      assert.equal(assignWaiter.status, 403);

      const waiterConfirm = await api(`/api/tickets/${tid}/waiter-confirm`, 'POST', tokens.hall, { action: 'delivered' });
      assert.equal(waiterConfirm.status, 403);

      // Hall Supervisor receives, marks dispatched/ready, and closes cleanly without waiter!
      await api(`/api/tickets/${tid}/receive`, 'POST', tokens.hall, {});
      await api(`/api/tickets/${tid}/process`, 'POST', tokens.hall, {
        action_type: 'mark_dispatched',
        action_note: 'تم تنسيق التسليم المباشر عبر مسؤول الصالة',
      });
      const closeHall = await api(`/api/tickets/${tid}/close`, 'POST', tokens.hall, {});
      assert.equal(closeHall.status, 200);
      assert.equal(closeHall.json.ticket.status, 'closed');
    });

    // 5. Unified Hall Supervisor role (no split between with/without support)
    await test('Unified Hall Supervisor role grants combined operational permissions to both hall and hall2', async () => {
      const okHall = await api('/api/tickets?scope=assembly_support', 'GET', tokens.hall);
      assert.equal(okHall.status, 200);
      assert.ok(okHall.json.tickets.some((t: any) => t.id === prodTicketId));

      const okHall2 = await api('/api/tickets?scope=assembly_support', 'GET', tokens.hall2);
      assert.equal(okHall2.status, 200);
      assert.ok(okHall2.json.tickets.some((t: any) => t.id === prodTicketId));

      const meta = await api('/api/meta', 'GET', tokens.admin);
      const hallRoles = meta.json.roles.filter((r: any) => r.code.includes('hall'));
      assert.equal(hallRoles.length, 1);
      assert.equal(hallRoles[0].code, 'hall_supervisor');
      assert.equal(hallRoles[0].name_ar, 'مسؤول الصالة');
    });

    // 6. Strict closure verification gate & Production->Assembly audio check
    await test('Production -> Assembly dispatch notifies Assembly only; Assembly arrival confirmation enables closure', async () => {
      clearWsEvents();
      await api(`/api/tickets/${prodTicketId}/receive`, 'POST', tokens.production, {});
      const proc = await api(`/api/tickets/${prodTicketId}/process`, 'POST', tokens.production, {
        action_type: 'mark_dispatched',
        action_note: 'تم تجهيز ربع البروستد وخروجه من المطبخ',
      });
      assert.equal(proc.status, 200);
      assert.equal(proc.json.ticket.status, 'action_taken_awaiting_confirm');

      await new Promise((r) => setTimeout(r, 80));
      const asmEv = asmConn.events.find((e) => e.type === 'awaiting_confirmation' && e.ticket?.id === prodTicketId);
      assert.equal(asmEv?.notification?.should_play_audio, true);
      assert.equal(Boolean(prodConn.events.find((e) => e.type === 'awaiting_confirmation')?.notification?.should_play_audio), false);

      // Production cannot close; Assembly closes after confirm-arrival
      assert.equal((await api(`/api/tickets/${prodTicketId}/close`, 'POST', tokens.production, {})).status, 403);
      assert.equal((await api(`/api/tickets/${prodTicketId}/close`, 'POST', tokens.assembly, {})).status, 400);

      const confirm = await api(`/api/tickets/${prodTicketId}/confirm-arrival`, 'POST', tokens.assembly, {
        mark_order_complete: true,
      });
      assert.equal(confirm.status, 200);

      const closeOk = await api(`/api/tickets/${prodTicketId}/close`, 'POST', tokens.assembly, {});
      assert.equal(closeOk.status, 200);
      assert.equal(closeOk.json.ticket.status, 'closed');
    });

    // 7. Multiple tickets per invoice + duplicate guard + offline idempotency
    await test('Allow multiple tickets for same invoice, prevent accidental duplicates, and honor idempotent client_request_id', async () => {
      const tA = await api('/api/tickets', 'POST', tokens.assembly, {
        client_request_id: 'offline-sync-1',
        invoice_number: '7777',
        item_name: 'ربع بروستد',
        reason_code: 'production_delay',
        problem_description: 'تأخر البروستد',
      });
      assert.equal(tA.status, 201);

      const tB = await api('/api/tickets', 'POST', tokens.assembly, {
        invoice_number: '7777',
        item_name: 'واحد رز',
        reason_code: 'dispatched_not_arrived',
        problem_description: 'لم يصل الرز',
      });
      assert.equal(tB.status, 201);

      const dup = await api('/api/tickets', 'POST', tokens.assembly, {
        invoice_number: '7777',
        item_name: 'ربع بروستد',
        reason_code: 'production_delay',
        problem_description: 'ضغط مكرر',
      });
      assert.equal(dup.status, 409);

      const retry = await api('/api/tickets', 'POST', tokens.assembly, {
        client_request_id: 'offline-sync-1',
        invoice_number: '7777',
        item_name: 'ربع بروستد',
        reason_code: 'production_delay',
        problem_description: 'تأخر البروستد',
      });
      assert.equal(retry.status, 200);
      assert.equal(retry.json.idempotent, true);
      assert.equal(retry.json.ticket.id, tA.json.ticket.id);
    });

    // 8. Production transfers to Hall Supervisor + Audit history preserved
    await test('Production transfers ticket to Hall -> Hall inbox receives audio alert, Production retains read view', async () => {
      clearWsEvents();
      const created = await api('/api/tickets', 'POST', tokens.assembly, {
        invoice_number: '9910',
        item_name: 'شواية دجاج كاملة',
        reason_code: 'production_delay',
        problem_description: 'بلاغ مرسل للإنتاج ويحتاج تنسيق الصالة',
      });
      const tid = created.json.ticket.id;

      const xfer = await api(`/api/tickets/${tid}/transfer`, 'POST', tokens.production, {
        to_department: 'hall',
        reason: 'يرجى التنسيق مع العميل في الصالة',
      });
      assert.equal(xfer.status, 200);
      assert.equal(xfer.json.ticket.target_department, 'hall');

      await new Promise((r) => setTimeout(r, 80));
      const hallEv = hallConn.events.find((e) => e.type === 'ticket_transferred' && e.ticket?.id === tid);
      assert.equal(hallEv?.notification?.should_play_audio, true);
      assert.equal(Boolean(prodConn.events.find((e) => e.type === 'ticket_transferred' && e.ticket?.id === tid)?.notification?.should_play_audio), false);

      const prodDetail = await api(`/api/tickets/${tid}`, 'GET', tokens.production);
      assert.equal(prodDetail.status, 200);
    });

    // 9. Admin-only Sound & Alert Management (upload, stream, playback speed, volume, replace, safe delete, RBAC)
    await test('Admin-only central Audio Management: RBAC enforcement, upload/stream, speed/volume persistence, replace & safe delete', async () => {
      // Non-admin blocked (403)
      assert.equal((await api('/api/audio/files', 'GET', tokens.production)).status, 403);
      assert.equal(
        (
          await api('/api/audio/settings/production', 'PUT', tokens.assembly, {
            playback_rate: 1.5,
            volume_percent: 80,
          })
        ).status,
        403
      );

      // Admin uploads valid mock MP3 bytes
      const sampleBytes = Buffer.from('ID3-SAMPLE-AUDIO-BYTES-FOR-TEST').toString('base64');
      const uploaded = await api('/api/audio/files', 'POST', tokens.admin, {
        filename: 'kitchen-alert.mp3',
        mime_type: 'audio/mpeg',
        data_base64: sampleBytes,
      });
      assert.equal(uploaded.status, 201);
      const fileId = uploaded.json.file.id;

      // Authenticated stream works (200 & 206 Range)
      const streamRes = await fetch(`${baseUrl}/api/audio/files/${fileId}/stream?token=${encodeURIComponent(tokens.production)}`);
      assert.equal(streamRes.status, 200);
      const rangeRes = await fetch(`${baseUrl}/api/audio/files/${fileId}/stream?token=${encodeURIComponent(tokens.production)}`, {
        headers: { Range: 'bytes=0-3' },
      });
      assert.equal(rangeRes.status, 206);

      // Admin updates production station speed & volume + links uploaded file
      clearWsEvents();
      const updated = await api('/api/audio/settings/production', 'PUT', tokens.admin, {
        audio_file_id: fileId,
        playback_rate: 1.5,
        volume_percent: 65,
        is_enabled: true,
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.json.setting.playback_rate, 1.5);
      assert.equal(updated.json.setting.volume_percent, 65);
      assert.equal(updated.json.setting.audio_file_id, fileId);

      await new Promise((r) => setTimeout(r, 80));
      assert.ok(prodConn.events.some((e) => e.type === 'audio_settings_updated'));

      // Admin replaces file cleanly (station link remains pointing to fileId)
      const replaced = await api(`/api/audio/files/${fileId}/replace`, 'POST', tokens.admin, {
        filename: 'kitchen-alert-v2.wav',
        mime_type: 'audio/wav',
        data_base64: Buffer.from('RIFF-NEW-AUDIO').toString('base64'),
      });
      assert.equal(replaced.status, 200);
      assert.equal(replaced.json.file.original_name, 'kitchen-alert-v2.wav');

      const allSettings = await api('/api/audio/settings', 'GET', tokens.production);
      const prodSetting = allSettings.json.settings.find((s: any) => s.station_code === 'production');
      assert.equal(prodSetting.audio_file_id, fileId);
      assert.equal(prodSetting.playback_rate, 1.5);

      // Safe delete: removes file & cleanly detaches station link without breaking
      const deleted = await api(`/api/audio/files/${fileId}`, 'DELETE', tokens.admin);
      assert.equal(deleted.status, 200);
      const afterDelProd = deleted.json.settings.find((s: any) => s.station_code === 'production');
      assert.equal(afterDelProd.audio_file_id, null);

      const resetRes = await api('/api/audio/settings/production/reset', 'POST', tokens.admin, {});
      assert.equal(resetRes.status, 200);
      assert.equal(resetRes.json.setting.playback_rate, 1);
      assert.equal(resetRes.json.setting.volume_percent, 85);
    });

    // 10. Dashboard Asia/Aden date filtering + multi-ticket invoice independence
    await test('Dashboard Asia/Aden time filtering (today, single date, date range) keeps multiple same-invoice tickets independent', async () => {
      const todayKey = getAdenDateKey(new Date());

      // Backdate ticket 7777#2 to a distinct Aden date for range/single testing
      db.prepare("UPDATE tickets SET created_at = '2026-10-15T18:00:00.000Z' WHERE invoice_number = '7777' AND reason_code = 'dispatched_not_arrived'").run();

      const todayDash = await api('/api/dashboard?mode=today', 'GET', tokens.admin);
      assert.equal(todayDash.status, 200);
      assert.equal(todayDash.json.filter.aden_today, todayKey);
      assert.ok(todayDash.json.tickets.some((t: any) => t.invoice_number === '7777' && t.reason_code === 'production_delay'));
      assert.equal(todayDash.json.tickets.some((t: any) => t.invoice_number === '7777' && t.reason_code === 'dispatched_not_arrived'), false);

      const singleDash = await api('/api/dashboard?mode=single&date=2026-10-15', 'GET', tokens.admin);
      assert.equal(singleDash.status, 200);
      assert.equal(singleDash.json.counts.total, 1);
      assert.equal(singleDash.json.tickets[0].invoice_number, '7777');

      const rangeDash = await api('/api/dashboard?mode=range&date_from=2026-10-14&date_to=2026-10-16', 'GET', tokens.admin);
      assert.equal(rangeDash.status, 200);
      assert.equal(rangeDash.json.counts.total, 1);

      // Verify multiple tickets for same invoice both show independently when mode=all
      const allDash = await api('/api/dashboard?mode=all', 'GET', tokens.admin);
      const inv7777 = allDash.json.tickets.filter((t: any) => t.invoice_number === '7777');
      assert.equal(inv7777.length, 2);
      assert.equal(allDash.json.counts.total, allDash.json.counts.open + allDash.json.counts.closed);
    });

    // 11. Escalation sweep & Reports aggregation
    await test('Automatic escalation sweeps overdue tickets and Reports API aggregates accurately', async () => {
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60000).toISOString();
      db.prepare('UPDATE tickets SET created_at = ?, escalation_level = 0 WHERE id = ?').run(fifteenMinsAgo, 1);

      const swept = runEscalationSweep(db, (notifs, ticket, eventType) => {
        broadcaster.broadcastTicketEvent(
          eventType || 'ticket_escalated',
          ticket,
          getRecipientUserIdsForTicket(db, ticket),
          notifs,
          'النظام الآلي'
        );
      });
      assert.ok(swept >= 0);

      const rep = await api('/api/reports', 'GET', tokens.admin);
      assert.equal(rep.status, 200);
      assert.ok(rep.json.summary.total >= 5);
      assert.ok(Array.isArray(rep.json.by_department));
      assert.ok(Array.isArray(rep.json.by_reason));
    });

    // 12. Responsible names management (decoupled from login accounts/RBAC) + Audit Trail
    await test('Responsible management updates UI/reports/notifications without changing login credentials or RBAC', async () => {
      const upd = await api('/api/responsibles/production', 'PUT', tokens.admin, {
        role_title_ar: 'كبير مسؤولي الإنتاج',
        assigned_person_name: 'أبو عزام القحطاني',
      });
      assert.equal(upd.status, 200);
      assert.equal(upd.json.responsible.assigned_person_name, 'أبو عزام القحطاني');
      assert.equal(upd.json.responsible.role_title_ar, 'كبير مسؤولي الإنتاج');

      // Login account for production remains completely unchanged and functional
      const prodLoginStillWorks = await api('/api/auth/login', 'POST', undefined, { username: 'production', password: 'Pass@123' });
      assert.equal(prodLoginStillWorks.status, 200);
      assert.equal(prodLoginStillWorks.json.user.role_code, 'production');

      // Propagates to dashboard & reports
      const dash = await api('/api/dashboard?mode=all', 'GET', tokens.admin);
      assert.ok(dash.json.responsibles.some((r: any) => r.role_key === 'production' && r.assigned_person_name === 'أبو عزام القحطاني'));
      const rep = await api('/api/reports', 'GET', tokens.admin);
      assert.ok(rep.json.responsibles.some((r: any) => r.role_key === 'production' && r.assigned_person_name === 'أبو عزام القحطاني'));

      // Audit log captures old_value, new_value, and actor_name
      const logs = await api('/api/audit-logs?category=responsibles', 'GET', tokens.admin);
      assert.equal(logs.status, 200);
      const latestRespLog = logs.json.logs.find((l: any) => l.action === 'update_responsible_assignment');
      assert.ok(latestRespLog);
      assert.ok(String(latestRespLog.new_value).includes('أبو عزام القحطاني'));
      assert.ok(latestRespLog.actor_name);
    });

    // 13. Separated Stall Threshold vs Escalation Timing + No-Duplicate Escalation Sweep
    await test('Independent stall threshold and escalation timing apply dynamically without duplicate escalations', async () => {
      // Create fresh open production ticket aged 10 minutes
      const fresh = await api('/api/tickets', 'POST', tokens.assembly, {
        invoice_number: '9988',
        item_name: 'حبة مندي لحم',
        reason_code: 'production_delay',
        problem_description: 'اختبار مدة التعثر والتصعيد المستقلة',
      });
      assert.equal(fresh.status, 201);
      const tid = fresh.json.ticket.id;
      const tenMinsAgo = new Date(Date.now() - 10 * 60000).toISOString();
      db.prepare('UPDATE tickets SET created_at = ?, escalation_level = 0 WHERE id = ?').run(tenMinsAgo, tid);

      // Update ONLY stall threshold to 15 min -> ticket (10m old) should NOT be delayed yet
      const stall15 = await api('/api/settings/escalation', 'PUT', tokens.admin, {
        first_warning_minutes: 15,
      });
      assert.equal(stall15.status, 200);
      assert.equal(stall15.json.settings.first_warning_minutes, 15);
      const delayed15 = await api('/api/tickets?scope=delayed', 'GET', tokens.admin);
      assert.equal(delayed15.json.tickets.some((t: any) => t.id === tid), false);

      // Lower stall threshold to 4 min -> same 10m ticket immediately counts as stalled/delayed!
      const stall4 = await api('/api/settings/escalation', 'PUT', tokens.admin, {
        first_warning_minutes: 4,
      });
      assert.equal(stall4.status, 200);
      const dash4 = await api('/api/dashboard?mode=all', 'GET', tokens.admin);
      assert.equal(dash4.json.stall_threshold_minutes, 4);
      const delayed4 = await api('/api/tickets?scope=delayed', 'GET', tokens.admin);
      assert.ok(delayed4.json.tickets.some((t: any) => t.id === tid));

      // Configure independent escalation timing (start=8m, repeat=5m, max=3)
      const escCfg = await api('/api/settings/escalation', 'PUT', tokens.admin, {
        escalation_start_minutes: 8,
        repeat_interval_minutes: 5,
        max_escalations: 3,
      });
      assert.equal(escCfg.status, 200);

      // First escalation sweep escalates ticket tid to level 1 once
      clearWsEvents();
      const sweep1 = runEscalationSweep(db, (notifs, ticket, eventType) => {
        broadcaster.broadcastTicketEvent(
          eventType || 'ticket_escalated',
          ticket,
          getRecipientUserIdsForTicket(db, ticket),
          notifs,
          'النظام الآلي'
        );
      });
      assert.ok(sweep1 >= 1);

      // Creator department (assembly) MUST receive WS & REST escalation notification with sender_department_code === null and should_play_audio === true
      await new Promise((r) => setTimeout(r, 80));
      const asmEscWs = asmConn.events.find((e) => e.type === 'ticket_escalated' && e.ticket?.id === tid);
      assert.ok(asmEscWs?.notification);
      assert.equal(asmEscWs.notification.sender_department_code, null);
      assert.equal(asmEscWs.notification.should_play_audio, true);
      const asmNotifsAfterEsc = await api('/api/notifications', 'GET', tokens.assembly);
      const asmEscRest = asmNotifsAfterEsc.json.notifications.find(
        (n: any) => n.ticket_id === tid && n.event_type === 'escalated'
      );
      assert.ok(asmEscRest);
      assert.equal(asmEscRest.sender_department_code, null);
      assert.equal(asmEscRest.should_play_audio, true);

      // Second immediate sweep MUST produce 0 duplicate escalations at level 1!
      const sweep2 = runEscalationSweep(db, () => {});
      assert.equal(sweep2, 0);

      // Verify ticket event includes stall occurrence & escalation time + updated responsible name
      const detail = await api(`/api/tickets/${tid}`, 'GET', tokens.admin);
      const escEvents = detail.json.ticket.events.filter((e: any) => e.event_type === 'escalated');
      assert.equal(escEvents.length, 1);
      assert.ok(String(escEvents[0].note).includes('أبو عزام القحطاني'));
    });

    // 14. Multi-sound library, 6 independent channels, fallback default, validation & SQLite restart persistence
    await test('Multi-sound library supports 6 channels, system default fallback, invalid audio rejection, and disk persistence', async () => {
      // Invalid corrupted MP3 payload rejected (400)
      const badAudio = await api('/api/audio/files', 'POST', tokens.admin, {
        display_name: 'ملف تالف',
        filename: 'corrupt.mp3',
        mime_type: 'audio/mpeg',
        data_base64: Buffer.from('NOT-AN-AUDIO-HEADER').toString('base64'),
      });
      assert.equal(badAudio.status, 400);

      // Upload two named library sounds & set second as system default
      const s1 = await api('/api/audio/files', 'POST', tokens.admin, {
        display_name: 'رنة المطبخ السريعة',
        filename: 'prod-bell.mp3',
        mime_type: 'audio/mpeg',
        data_base64: Buffer.from('ID3-SOUND-ONE').toString('base64'),
      });
      assert.equal(s1.status, 201);
      const s2 = await api('/api/audio/files', 'POST', tokens.admin, {
        display_name: 'تنبيه الطوارئ الرسمي',
        filename: 'emergency.wav',
        mime_type: 'audio/wav',
        data_base64: Buffer.from('RIFF-SOUND-TWO').toString('base64'),
      });
      assert.equal(s2.status, 201);

      // Rename s1 & mark s2 as system default
      const renamed = await api(`/api/audio/files/${s1.json.file.id}`, 'PATCH', tokens.admin, {
        display_name: 'رنة المطبخ المعتمدة',
      });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.json.file.display_name, 'رنة المطبخ المعتمدة');

      const setDef = await api(`/api/audio/files/${s2.json.file.id}`, 'PATCH', tokens.admin, {
        is_default: true,
      });
      assert.equal(setDef.status, 200);
      assert.equal(setDef.json.file.is_default, true);

      // Assign s1 to production, s2 to escalation, leave general unassigned -> general resolves to system default fallback!
      await api('/api/audio/settings/production', 'PUT', tokens.admin, {
        audio_file_id: s1.json.file.id,
        volume_percent: 90,
        playback_rate: 1.25,
      });
      await api('/api/audio/settings/delayed_critical', 'PUT', tokens.admin, {
        audio_file_id: s2.json.file.id,
        volume_percent: 100,
      });
      const all = await api('/api/audio/settings', 'GET', tokens.admin);
      assert.equal(all.json.settings.length, 6);
      const generalCh = all.json.settings.find((x: any) => x.station_code === 'general');
      assert.equal(generalCh.uses_default_fallback, true);
      assert.equal(generalCh.resolved_audio_file_id, s2.json.file.id);

      // Real SQLite disk persistence verification (simulate restart)
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yemeni-taste-persist-'));
      const tmpDbFile = path.join(tmpDir, 'ops.db');
      const tmpAudioDir = path.join(tmpDir, 'audio');
      try {
        const db1 = createDatabase(tmpDbFile);
        const app1 = createExpressApp(db1, broadcaster, { audioDir: tmpAudioDir });
        const srv1 = http.createServer(app1);
        await new Promise<void>((r) => srv1.listen(0, '127.0.0.1', r));
        const p1 = (srv1.address() as { port: number }).port;
        const login1 = await fetch(`http://127.0.0.1:${p1}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
        }).then((r) => r.json() as Promise<any>);
        await fetch(`http://127.0.0.1:${p1}/api/responsibles/assembly`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
          body: JSON.stringify({ role_title_ar: 'رئيس التجميع', assigned_person_name: 'صادق اليماني' }),
        });
        const postFile = await fetch(`http://127.0.0.1:${p1}/api/audio/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
          body: JSON.stringify({
            display_name: 'ملف دائم بعد الإعادة',
            filename: 'persist.mp3',
            mime_type: 'audio/mpeg',
            data_base64: Buffer.from('ID3-PERSIST-TEST').toString('base64'),
          }),
        }).then((r) => r.json() as Promise<any>);
        await fetch(`http://127.0.0.1:${p1}/api/audio/files/${postFile.file.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
          body: JSON.stringify({ is_default: true }),
        });
        srv1.close();
        db1.close();

        // Reopen DB from disk
        const db2 = createDatabase(tmpDbFile);
        const persistedResp = db2.prepare("SELECT assigned_person_name FROM responsible_assignments WHERE role_key = 'assembly'").get() as any;
        assert.equal(persistedResp.assigned_person_name, 'صادق اليماني');
        const persistedFile = db2.prepare("SELECT display_name, is_default, stored_filename FROM audio_files WHERE display_name = 'ملف دائم بعد الإعادة'").get() as any;
        assert.ok(persistedFile && persistedFile.is_default === 1);
        db2.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // 15. Granular permissions isolation & dynamic grant/revoke
    await test('Granular admin & sound permissions are strictly isolated per permission and toggle cleanly', async () => {
      // Production has zero admin/sound permissions by default
      assert.equal((await api('/api/responsibles/production', 'PUT', tokens.production, { assigned_person_name: 'غير مصرح' })).status, 403);
      assert.equal((await api('/api/settings/escalation', 'PUT', tokens.production, { first_warning_minutes: 9 })).status, 403);
      assert.equal((await api('/api/audit-logs', 'GET', tokens.production)).status, 403);

      // Find prod2 id & grant ONLY manage_stall_threshold + audio_assign
      const usersList = await api('/api/users', 'GET', tokens.admin);
      const prod2User = usersList.json.users.find((u: any) => u.username === 'prod2');
      assert.ok(prod2User);

      const grant = await api(`/api/users/${prod2User.id}`, 'PATCH', tokens.admin, {
        permission_updates: {
          manage_stall_threshold: true,
          audio_assign: true,
        },
      });
      assert.equal(grant.status, 200);

      // prod2 can change stall threshold (200)
      assert.equal((await api('/api/settings/escalation', 'PUT', tokens.prod2, { first_warning_minutes: 6 })).status, 200);
      // prod2 STILL blocked from changing escalation timing (403) & responsibles (403) & deleting audio (403)
      assert.equal((await api('/api/settings/escalation', 'PUT', tokens.prod2, { escalation_start_minutes: 20 })).status, 403);
      assert.equal((await api('/api/responsibles/production', 'PUT', tokens.prod2, { assigned_person_name: 'محظور' })).status, 403);
      assert.equal((await api('/api/audio/files', 'POST', tokens.prod2, { filename: 'x.mp3', mime_type: 'audio/mpeg', data_base64: Buffer.from('ID3-X').toString('base64') })).status, 403);
      // prod2 can assign audio channel
      assert.equal((await api('/api/audio/settings/hall', 'PUT', tokens.prod2, { audio_file_id: null })).status, 200);

      // Revoke permissions -> immediately 403 again
      await api(`/api/users/${prod2User.id}`, 'PATCH', tokens.admin, {
        permission_updates: {
          manage_stall_threshold: false,
          audio_assign: false,
        },
      });
      assert.equal((await api('/api/settings/escalation', 'PUT', tokens.prod2, { first_warning_minutes: 5 })).status, 403);
      assert.equal((await api('/api/audio/settings/hall', 'PUT', tokens.prod2, { audio_file_id: null })).status, 403);
    });

    // 16. Mandatory verification for existing audio_test (تجربة الأصوات) permission
    await test('audio_test permission strictly governs testing real library/channel audio and persists cleanly without granting extra privileges', async () => {
      // Built-in valid WAV files exist in the library ready for real testing
      const adminFiles = await api('/api/audio/files', 'GET', tokens.admin);
      assert.equal(adminFiles.status, 200);
      const builtInFiles = adminFiles.json.files.filter((f: any) => String(f.original_name).startsWith('system-'));
      assert.equal(builtInFiles.length, 2);
      const sampleFile = builtInFiles[0];

      // Case A1: Regular user WITHOUT audio_test is strictly blocked from testing
      assert.equal((await api(`/api/audio/files/${sampleFile.id}/test`, 'POST', tokens.production, {})).status, 403);
      assert.equal((await api('/api/audio/settings/production/test', 'POST', tokens.production, {})).status, 403);
      const deniedModeTest = await fetch(
        `${baseUrl}/api/audio/files/${sampleFile.id}/stream?mode=test&token=${encodeURIComponent(tokens.production)}`
      );
      assert.equal(deniedModeTest.status, 403);
      // Operational alert stream (without ?mode=test) remains working for ALL station alerts!
      for (const stationTok of [tokens.production, tokens.assembly, tokens.hall]) {
        const operationalStream = await fetch(
          `${baseUrl}/api/audio/files/${sampleFile.id}/stream?token=${encodeURIComponent(stationTok)}`
        );
        assert.equal(operationalStream.status, 200);
        const operationalHdr = await fetch(`${baseUrl}/api/audio/files/${sampleFile.id}/stream`, {
          headers: { Authorization: `Bearer ${stationTok}` },
        });
        assert.equal(operationalHdr.status, 200);
      }

      // Case A2: User with another audio permission (audio_assign) WITHOUT audio_test is STILL blocked from testing (no leak!)
      const usersList = await api('/api/users', 'GET', tokens.admin);
      const prod2User = usersList.json.users.find((u: any) => u.username === 'prod2');
      assert.ok(prod2User);
      await api(`/api/users/${prod2User.id}`, 'PATCH', tokens.admin, {
        permission_updates: { audio_assign: true, audio_test: false },
      });
      assert.equal((await api(`/api/audio/files/${sampleFile.id}/test`, 'POST', tokens.prod2, {})).status, 403);
      assert.equal((await api('/api/audio/settings/production/test', 'POST', tokens.prod2, {})).status, 403);
      assert.equal(
        (await fetch(`${baseUrl}/api/audio/files/${sampleFile.id}/stream?mode=test`, {
          headers: { Authorization: `Bearer ${tokens.prod2}` },
        })).status,
        403
      );

      // Case B: Grant ONLY audio_test to prod2 (and revoke audio_assign)
      await api(`/api/users/${prod2User.id}`, 'PATCH', tokens.admin, {
        permission_updates: { audio_assign: false, audio_test: true },
      });

      // Verify persistence across logout & fresh login
      const relogin = await api('/api/auth/login', 'POST', undefined, { username: 'prod2', password: 'Pass@123' });
      assert.equal(relogin.status, 200);
      assert.ok(relogin.json.user.permissions.includes('audio_test'));
      const freshProd2Token = relogin.json.token;

      // Allowed: list library files, authorize test endpoints, and stream real RIFF/WAV audio bytes
      const libList = await api('/api/audio/files', 'GET', freshProd2Token);
      assert.equal(libList.status, 200);
      assert.ok(libList.json.files.length >= 2);

      for (const libFile of builtInFiles) {
        const testAuthRes = await api(`/api/audio/files/${libFile.id}/test`, 'POST', freshProd2Token, {});
        assert.equal(testAuthRes.status, 200);
        assert.equal(testAuthRes.json.ok, true);

        const audioStreamRes = await fetch(`${baseUrl}/api/audio/files/${libFile.id}/stream?mode=test`, {
          headers: { Authorization: `Bearer ${freshProd2Token}` },
        });
        assert.equal(audioStreamRes.status, 200);
        const bytes = Buffer.from(await audioStreamRes.arrayBuffer());
        assert.ok(bytes.length > 44);
        assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
      }

      // Range replay/seek support check
      const rangeStream = await fetch(`${baseUrl}/api/audio/files/${sampleFile.id}/stream?mode=test`, {
        headers: { Authorization: `Bearer ${freshProd2Token}`, Range: 'bytes=0-15' },
      });
      assert.equal(rangeStream.status, 206);

      // Channel audio test works for audio_test holder
      const chanTest = await api('/api/audio/settings/production/test', 'POST', freshProd2Token, {});
      assert.equal(chanTest.status, 200);

      // Strict isolation: audio_test MUST NOT grant upload, add AI, assign, delete, set default, or volume!
      assert.equal(
        (await api('/api/audio/files', 'POST', freshProd2Token, {
          filename: 'blocked.mp3',
          mime_type: 'audio/mpeg',
          data_base64: Buffer.from('ID3-BLOCKED').toString('base64'),
        })).status,
        403
      );
      assert.equal((await api('/api/audio/files/generate-ai', 'POST', freshProd2Token, { display_name: 'x', text: 'y' })).status, 403);
      assert.equal((await api(`/api/audio/files/${sampleFile.id}`, 'PATCH', freshProd2Token, { is_default: true })).status, 403);
      assert.equal((await api(`/api/audio/files/${sampleFile.id}`, 'DELETE', freshProd2Token)).status, 403);
      assert.equal((await api('/api/audio/settings/production', 'PUT', freshProd2Token, { volume_percent: 50 })).status, 403);

      // Verify persistence on real SQLite disk restart
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yemeni-taste-audiotest-'));
      const tmpDbFile = path.join(tmpDir, 'ops.db');
      const tmpAudioDir = path.join(tmpDir, 'audio');
      try {
        const db1 = createDatabase(tmpDbFile);
        const app1 = createExpressApp(db1, broadcaster, { audioDir: tmpAudioDir });
        const srv1 = http.createServer(app1);
        await new Promise<void>((r) => srv1.listen(0, '127.0.0.1', r));
        const p1 = (srv1.address() as { port: number }).port;
        const adm = await fetch(`http://127.0.0.1:${p1}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
        }).then((r) => r.json() as Promise<any>);
        const users1 = await fetch(`http://127.0.0.1:${p1}/api/users`, {
          headers: { Authorization: `Bearer ${adm.token}` },
        }).then((r) => r.json() as Promise<any>);
        const prodUser1 = users1.users.find((u: any) => u.username === 'production');
        await fetch(`http://127.0.0.1:${p1}/api/users/${prodUser1.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adm.token}` },
          body: JSON.stringify({ permission_updates: { audio_test: true } }),
        });
        srv1.close();
        db1.close();

        // Simulate restart with fresh DB instance
        const db2 = createDatabase(tmpDbFile);
        const app2 = createExpressApp(db2, broadcaster, { audioDir: tmpAudioDir });
        const srv2 = http.createServer(app2);
        await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', r));
        const p2 = (srv2.address() as { port: number }).port;
        const prodAfterRestart = await fetch(`http://127.0.0.1:${p2}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'production', password: 'Pass@123' }),
        }).then((r) => r.json() as Promise<any>);
        assert.ok(prodAfterRestart.user.permissions.includes('audio_test'));
        const lib2 = await fetch(`http://127.0.0.1:${p2}/api/audio/files`, {
          headers: { Authorization: `Bearer ${prodAfterRestart.token}` },
        }).then((r) => r.json() as Promise<any>);
        assert.ok(lib2.files.length >= 2);
        const testAfterRestart = await fetch(`http://127.0.0.1:${p2}/api/audio/files/${lib2.files[0].id}/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prodAfterRestart.token}` },
          body: '{}',
        });
        assert.equal(testAfterRestart.status, 200);
        srv2.close();
        db2.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      // Revoke audio_test -> access blocked immediately
      await api(`/api/users/${prod2User.id}`, 'PATCH', tokens.admin, {
        permission_updates: { audio_test: false },
      });
      assert.equal((await api(`/api/audio/files/${sampleFile.id}/test`, 'POST', freshProd2Token, {})).status, 403);
    });

    await test('17. SQLite Corrupt Recovery (DELETE Mode), Human Voice Library & 5-Channel Voice Reader Settings', async () => {
      // A. Corrupt SQLite DB auto-recovery & DELETE journal mode verification
      const recoverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yemeni-taste-corrupt-recover-'));
      try {
        const corruptDbPath = path.join(recoverDir, 'yemeni_taste.db');
        fs.writeFileSync(corruptDbPath, 'CORRUPT-SQLITE-HEADER-BYTES-FOR-RECOVERY-TEST');
        fs.writeFileSync(`${corruptDbPath}-wal`, Buffer.alloc(64, 0));
        fs.writeFileSync(`${corruptDbPath}-shm`, Buffer.alloc(64, 0));

        const recoveredDb = createDatabase(corruptDbPath);
        const jm = recoveredDb.pragma('journal_mode', { simple: true });
        assert.equal(String(jm).toLowerCase(), 'delete');
        const qc = recoveredDb.pragma('quick_check(1)', { simple: true });
        assert.equal(String(qc).toLowerCase(), 'ok');
        const adminRow = recoveredDb.prepare("SELECT username FROM users WHERE username = 'admin'").get() as
          | { username: string }
          | undefined;
        assert.equal(adminRow?.username, 'admin');
        recoveredDb.close();

        // Corrupt backup file created & stale WAL removed
        const dirFiles = fs.readdirSync(recoverDir);
        assert.ok(dirFiles.some((f) => f.startsWith('yemeni_taste.db.corrupt-')));
        assert.ok(!fs.existsSync(`${corruptDbPath}-wal`));
      } finally {
        fs.rmSync(recoverDir, { recursive: true, force: true });
      }

      // B. Arabic speech normalization sanity
      const normalized = normalizeArabicForSpeech('TRK-000125 | فاتورة 908 — شاورما');
      assert.ok(normalized.includes('رقم المتابعة 125'));
      assert.ok(!normalized.includes('TRK-'));
      assert.ok(!normalized.includes('|'));

      // C. Human Voices Library CRUD + Browser Instant Reader explicitly removed & blocked
      const hvListRes = await api('/api/audio/human-voices', 'GET', tokens.admin);
      assert.equal(hvListRes.status, 200);
      assert.ok(Array.isArray(hvListRes.json.voices));
      assert.ok(hvListRes.json.voices.length >= 6);
      assert.ok(hvListRes.json.voices.some((v: any) => v.voice_kind === 'ai_human' && v.prebuilt_voice_name === 'Kore'));
      assert.ok(!hvListRes.json.voices.some((v: any) => v.voice_kind === 'browser_human'));

      const rejectedBrowserVoice = await api('/api/audio/human-voices', 'POST', tokens.admin, {
        voice_kind: 'browser_human',
        display_name: 'صوت متصفح محظور',
        gender: 'female',
      });
      assert.equal(rejectedBrowserVoice.status, 400);

      const createVoiceRes = await api('/api/audio/human-voices', 'POST', tokens.admin, {
        voice_kind: 'ai_human',
        display_name: 'صوت ريم التجريبي',
        description: 'صوت نسائي واضح للقراءة السريعة',
        gender: 'female',
        prebuilt_voice_name: 'Zephyr',
        style_prompt: 'واضح وسريع الفهم',
      });
      assert.equal(createVoiceRes.status, 201);
      const customVoice = createVoiceRes.json.voice;
      assert.equal(customVoice.display_name, 'صوت ريم التجريبي');
      assert.equal(customVoice.prebuilt_voice_name, 'Zephyr');

      // Favorite & Default toggle
      const favRes = await api(`/api/audio/human-voices/${customVoice.id}`, 'PATCH', tokens.admin, {
        is_favorite: true,
        is_default: true,
      });
      assert.equal(favRes.status, 200);
      assert.equal(favRes.json.voice.is_favorite, true);
      assert.equal(favRes.json.voice.is_default, true);

      // Independent 5-channel Voice Reader settings & per-channel customization
      const readerGet = await api('/api/audio/voice-reader/settings', 'GET', tokens.admin);
      assert.equal(readerGet.status, 200);
      assert.equal(readerGet.json.settings.length, 5);

      const charonVoice = hvListRes.json.voices.find((v: any) => v.prebuilt_voice_name === 'Charon');
      const prodVoiceUpd = await api('/api/audio/voice-reader/settings/production', 'PUT', tokens.admin, {
        human_voice_id: charonVoice.id,
        playback_rate: 1.25,
        volume_percent: 95,
        is_enabled: true,
        read_scope: 'important_only',
      });
      assert.equal(prodVoiceUpd.status, 200);
      assert.equal(prodVoiceUpd.json.setting.human_voice_id, charonVoice.id);
      assert.equal(prodVoiceUpd.json.setting.playback_rate, 1.25);
      assert.equal(prodVoiceUpd.json.setting.volume_percent, 95);
      assert.equal(prodVoiceUpd.json.setting.read_scope, 'important_only');

      // Apply-all updates all 5 channels cleanly
      const applyAllRes = await api('/api/audio/voice-reader/apply-all', 'POST', tokens.admin, {
        human_voice_id: customVoice.id,
      });
      assert.equal(applyAllRes.status, 200);
      assert.ok(applyAllRes.json.settings.every((s: any) => s.human_voice_id === customVoice.id));

      // Verify TTS status & route validation
      const ttsStatusRes = await api('/api/audio/tts-status', 'GET', tokens.admin);
      assert.equal(ttsStatusRes.status, 200);
      assert.ok(Array.isArray(ttsStatusRes.json.prebuilt_voices));

      // Test & RBAC enforcement on human voice + voice reader endpoints
      assert.equal((await api(`/api/audio/human-voices/${customVoice.id}/test`, 'POST', tokens.admin, {})).status, 200);
      assert.equal((await api('/api/audio/voice-reader/settings/assembly/test', 'POST', tokens.admin, {})).status, 200);

      const prodNoAudio = await api('/api/auth/login', 'POST', undefined, { username: 'production', password: 'Pass@123' });
      assert.equal(
        (await api(`/api/audio/human-voices/${customVoice.id}/test`, 'POST', prodNoAudio.json.token, {})).status,
        403
      );
      assert.equal(
        (await api('/api/audio/voice-reader/settings/production/test', 'POST', prodNoAudio.json.token, {})).status,
        403
      );

      // Safe delete detaches channels back to fallback without crash
      const delVoiceRes = await api(`/api/audio/human-voices/${customVoice.id}`, 'DELETE', tokens.admin);
      assert.equal(delVoiceRes.status, 200);
      assert.ok(delVoiceRes.json.settings.every((s: any) => s.human_voice_id === null));

      // Hall -> Production direct message & Hall -> Assembly ticket verify full natural Arabic spoken_text
      const hallMsgRes = await api('/api/messages', 'POST', tokens.hall, {
        recipient_department: 'production',
        invoice_number: '9911',
        message_body: 'تأكد من خروج طبق المندي رقم 2 فوراً',
      });
      assert.equal(hallMsgRes.status, 201);
      const prodNotifs = await api('/api/notifications', 'GET', tokens.production);
      const latestProdNotif = prodNotifs.json.notifications[0];
      assert.ok(latestProdNotif.spoken_text.includes('إدارة الصالة'));
      assert.ok(latestProdNotif.spoken_text.includes('قسم الإنتاج'));
      assert.ok(latestProdNotif.spoken_text.includes('تأكد من خروج طبق المندي رقم 2 فوراً'));
    });

    // 18. Distinct Delivery -> Read -> Receipt lifecycle + Idempotent actions
    await test('18. Distinct Delivery -> Read -> Receipt states, sender visibility, and client_request_id action idempotency', async () => {
      // Configure custom admin sound setting beforehand to also verify preservation later
      const created = await api('/api/tickets', 'POST', tokens.assembly, {
        invoice_number: '8810',
        item_name: 'حبة شواية كاملة',
        quantity: 2,
        reason_code: 'production_delay',
        problem_description: 'تأخر تجهيز الشواية للفاتورة 8810',
      });
      assert.equal(created.status, 201);
      const tid = created.json.ticket.id;

      // Immediately after creation: not read, not received
      const beforeOpen = await api(`/api/tickets/${tid}`, 'GET', tokens.assembly);
      assert.equal(beforeOpen.status, 200);
      assert.equal(beforeOpen.json.ticket.received_at, null);
      // Reading by sender does NOT mark target department receipt!
      assert.equal(beforeOpen.json.ticket.received_by_name, null);

      // Production polls inbox -> marks delivered_to_dept_at WITHOUT marking first_read_at or received_at
      const prodInbox = await api('/api/tickets?scope=inbox', 'GET', tokens.production);
      const inboxItem = prodInbox.json.tickets.find((t: any) => t.id === tid);
      assert.ok(inboxItem);
      assert.ok(inboxItem.delivered_to_dept_at);
      assert.equal(inboxItem.received_at, null);

      // Production opens ticket detail -> records read in ticket_reads & sets first_read_at (still NOT received!)
      clearWsEvents();
      const prodDetail = await api(`/api/tickets/${tid}`, 'GET', tokens.production);
      assert.equal(prodDetail.status, 200);
      assert.ok(prodDetail.json.ticket.first_read_at);
      assert.ok(prodDetail.json.ticket.first_read_by_name);
      assert.ok(Array.isArray(prodDetail.json.ticket.reads));
      assert.ok(prodDetail.json.ticket.reads.some((r: any) => r.department_code === 'production'));
      assert.equal(prodDetail.json.ticket.received_at, null);

      // Production clicks «تأكيد استلام البلاغ» twice with same client_request_id -> idempotent & updates status to received
      const recId = 'idem-receive-8810';
      const rec1 = await api(`/api/tickets/${tid}/receive`, 'POST', tokens.production, {
        client_request_id: recId,
      });
      assert.equal(rec1.status, 200);
      assert.ok(rec1.json.ticket.received_at);
      assert.ok(rec1.json.ticket.received_by_name);
      assert.equal(rec1.json.ticket.status, 'received');

      const rec2 = await api(`/api/tickets/${tid}/receive`, 'POST', tokens.production, {
        client_request_id: recId,
      });
      assert.equal(rec2.status, 200);
      assert.equal(rec2.json.idempotent, true);

      // Idempotent reply check
      const repId = 'idem-reply-8810';
      const rep1 = await api(`/api/tickets/${tid}/reply`, 'POST', tokens.production, {
        client_request_id: repId,
        message: 'بدأنا الشوي الآن',
        recipient_department: 'assembly',
      });
      assert.equal(rep1.status, 200);
      const repCountAfter1 = rep1.json.ticket.replies.length;
      const rep2 = await api(`/api/tickets/${tid}/reply`, 'POST', tokens.production, {
        client_request_id: repId,
        message: 'بدأنا الشوي الآن',
        recipient_department: 'assembly',
      });
      assert.equal(rep2.status, 200);
      assert.equal(rep2.json.idempotent, true);
      assert.equal(rep2.json.ticket.replies.length, repCountAfter1);

      // Sender sees delivery, read, and receipt clearly
      const senderAfter = await api(`/api/tickets/${tid}`, 'GET', tokens.assembly);
      assert.ok(senderAfter.json.ticket.delivered_to_dept_at);
      assert.ok(senderAfter.json.ticket.first_read_at);
      assert.ok(senderAfter.json.ticket.received_at);
      assert.ok(senderAfter.json.ticket.received_by_name);
    });

    // 19. Overdue unacknowledged receipt sweep & concurrent tickets
    await test('19. Overdue unreceived ticket triggers unreceived_reminder without blocking concurrent tickets', async () => {
      const t1 = await api('/api/tickets', 'POST', tokens.assembly, {
        invoice_number: '8821',
        item_name: 'مندي دجاج متأخر الاستلام',
        reason_code: 'production_delay',
        problem_description: 'تأخر تأكيد الاستلام 1',
      });
      const t2 = await api('/api/tickets', 'POST', tokens.assembly, {
        invoice_number: '8822',
        item_name: 'برمة لحم متأخرة الاستلام',
        reason_code: 'production_delay',
        problem_description: 'بلاغ ثانٍ متزامن',
      });
      assert.equal(t1.status, 201);
      assert.equal(t2.status, 201);

      const oldTime = new Date(Date.now() - 7 * 60000).toISOString();
      db.prepare('UPDATE tickets SET created_at = ? WHERE id IN (?, ?)').run(oldTime, t1.json.ticket.id, t2.json.ticket.id);

      const reminderEvents: any[] = [];
      runEscalationSweep(db, (notifs, ticket, eventType) => {
        reminderEvents.push({ eventType, ticketId: ticket.id, notifs });
      });
      const unreceivedReminders = reminderEvents.filter((ev) => ev.eventType === 'ticket_unreceived_reminder');
      assert.ok(unreceivedReminders.length >= 2);
      assert.ok(
        unreceivedReminders.some(
          (ev) =>
            ev.ticketId === t1.json.ticket.id &&
            ev.notifs.some((n: any) => n.should_play_audio === true && n.target_department === 'production')
        )
      );
      assert.ok(unreceivedReminders.some((ev) => ev.ticketId === t2.json.ticket.id));
    });

    // 20. SQLite audit log immutability triggers
    await test('20. Audit log DB triggers strictly block UPDATE and DELETE on user_activity_logs', async () => {
      const sampleLog = db.prepare('SELECT id FROM user_activity_logs LIMIT 1').get() as { id: number } | undefined;
      assert.ok(sampleLog);
      assert.throws(() => {
        db.prepare('DELETE FROM user_activity_logs WHERE id = ?').run(sampleLog.id);
      }, /immutable/i);
      assert.throws(() => {
        db.prepare("UPDATE user_activity_logs SET details = 'tampered' WHERE id = ?").run(sampleLog.id);
      }, /immutable/i);
    });

    // 21. Verified Backup creation, tamper rejection, download, and atomic restore
    await test('21. BackupManager creates verified SHA-256 backups, rejects corrupted files, and restores atomically with pre_restore snapshot', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yemeni-taste-backup-test-'));
      try {
        const dbPath = path.join(tmpDir, 'live.db');
        const backupDir = path.join(tmpDir, 'backups');
        const mirrorDir = path.join(tmpDir, 'mirror');

        const holder: MutableDbHolder = {
          current: createDatabase(dbPath),
          filePath: dbPath,
        };
        const proxiedDb = createDbProxy(holder);
        const manager = new BackupManager({ backupDir, mirrorDir, dbFilePath: dbPath });
        const bkpApp = createExpressApp(proxiedDb, broadcaster, {
          audioDir: path.join(tmpDir, 'audio'),
          backupManager: manager,
          replaceDatabase: (verifiedSourcePath: string) => {
            try {
              holder.current.close();
            } catch {
              // ignore
            }
            replaceSqliteFileAtomically(verifiedSourcePath, dbPath);
            holder.current = createDatabase(dbPath);
          },
        });
        const srv = http.createServer(bkpApp);
        await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
        const port = (srv.address() as { port: number }).port;
        const bUrl = `http://127.0.0.1:${port}`;

        const loginAdm = await fetch(`${bUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'Admin@123' }),
        }).then((r) => r.json() as Promise<any>);

        // Non-admin blocked from readiness & backups
        const loginProd = await fetch(`${bUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'production', password: 'Pass@123' }),
        }).then((r) => r.json() as Promise<any>);
        const deniedReadiness = await fetch(`${bUrl}/api/admin/system-readiness`, {
          headers: { Authorization: `Bearer ${loginProd.token}` },
        });
        assert.equal(deniedReadiness.status, 403);

        // Create verified manual backup BEFORE adding an extra test ticket
        const createBkp = await fetch(`${bUrl}/api/admin/backups`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginAdm.token}` },
          body: JSON.stringify({ reason: 'نسخة اختبار التحقق والاستعادة' }),
        });
        assert.equal(createBkp.status, 201);
        const bkpJson = (await createBkp.json()) as any;
        const backupId = bkpJson.backup.id;
        assert.equal(bkpJson.backup.integrity_status, 'verified');
        assert.ok(fs.existsSync(bkpJson.backup.file_path));
        assert.ok(bkpJson.backup.mirror_path && fs.existsSync(bkpJson.backup.mirror_path));

        // Verify download endpoint returns real SQLite binary header
        const dlRes = await fetch(`${bUrl}/api/admin/backups/${encodeURIComponent(backupId)}/download`, {
          headers: { Authorization: `Bearer ${loginAdm.token}` },
        });
        assert.equal(dlRes.status, 200);
        const dlBuf = Buffer.from(await dlRes.arrayBuffer());
        assert.equal(dlBuf.subarray(0, 15).toString('utf8'), 'SQLite format 3');

        // Insert an extra ticket after backup
        const postTicket = await fetch(`${bUrl}/api/tickets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginAdm.token}` },
          body: JSON.stringify({
            invoice_number: '6060',
            item_name: 'صنف بعد النسخة',
            reason_code: 'production_delay',
            problem_description: 'يجب أن يختفي بعد الاستعادة للنسخة الأقدم',
          }),
        });
        assert.equal(postTicket.status, 201);

        // Readiness endpoint shows counts & backup summary
        const readinessRes = await fetch(`${bUrl}/api/admin/system-readiness`, {
          headers: { Authorization: `Bearer ${loginAdm.token}` },
        });
        assert.equal(readinessRes.status, 200);
        const readinessData = (await readinessRes.json()) as any;
        assert.equal(readinessData.server.status, 'ok');
        assert.equal(readinessData.audio_status.browser_fallback_enabled, false);
        assert.ok(readinessData.backups.total_count >= 1);

        // Restore requires Admin & confirm_restore: true
        const restoreDenied = await fetch(`${bUrl}/api/admin/backups/${encodeURIComponent(backupId)}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginProd.token}` },
          body: JSON.stringify({ confirm_restore: true }),
        });
        assert.equal(restoreDenied.status, 403);

        // Perform real restore
        const restoreOk = await fetch(`${bUrl}/api/admin/backups/${encodeURIComponent(backupId)}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loginAdm.token}` },
          body: JSON.stringify({ confirm_restore: true }),
        });
        assert.equal(restoreOk.status, 200);
        const restoreJson = (await restoreOk.json()) as any;
        assert.equal(restoreJson.ok, true);
        assert.equal(restoreJson.pre_restore_backup.trigger_type, 'pre_restore');

        // Verify post-backup ticket 6060 no longer exists in restored DB, and original tickets are intact
        const ticketsAfter = await fetch(`${bUrl}/api/tickets`, {
          headers: { Authorization: `Bearer ${loginAdm.token}` },
        }).then((r) => r.json() as Promise<any>);
        assert.equal(ticketsAfter.tickets.some((t: any) => t.invoice_number === '6060'), false);
        assert.ok(ticketsAfter.tickets.length >= 5);

        // Tamper backup file and confirm verify catches SHA-256 mismatch
        fs.appendFileSync(bkpJson.backup.file_path, 'TAMPER');
        const verifyTamper = await fetch(`${bUrl}/api/admin/backups/${encodeURIComponent(backupId)}/verify`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${loginAdm.token}` },
        }).then((r) => r.json() as Promise<any>);
        assert.equal(verifyTamper.verification.ok, false);

        srv.close();
        holder.current.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // 22. Isolated Test Accounts Sandbox
    await test('22. Test accounts (test_assembly, test_production, test_hall, test_admin) are completely isolated from production data', async () => {
      const testTokens: Record<string, string> = {};
      for (const uname of ['test_assembly', 'test_production', 'test_hall', 'test_admin']) {
        const res = await api('/api/auth/login', 'POST', undefined, { username: uname, password: 'Test@123' });
        assert.equal(res.status, 200);
        assert.equal(res.json.user.is_test_account, true);
        testTokens[uname] = res.json.token;
      }

      const testCreated = await api('/api/tickets', 'POST', testTokens.test_assembly, {
        invoice_number: 'T-101',
        item_name: 'صنف اختبار معزول',
        reason_code: 'production_delay',
        problem_description: 'بلاغ داخل بيئة الاختبار فقط',
      });
      assert.equal(testCreated.status, 201);
      assert.equal(testCreated.json.ticket.is_test, true);
      const testTid = testCreated.json.ticket.id;

      // Test Production sees test ticket; Real Production & Real Admin MUST NOT see it!
      const testProdTickets = await api('/api/tickets', 'GET', testTokens.test_production);
      assert.ok(testProdTickets.json.tickets.some((t: any) => t.id === testTid));

      const realAdminTickets = await api('/api/tickets', 'GET', tokens.admin);
      assert.equal(realAdminTickets.json.tickets.some((t: any) => t.id === testTid), false);
      const realProdTickets = await api('/api/tickets', 'GET', tokens.production);
      assert.equal(realProdTickets.json.tickets.some((t: any) => t.id === testTid), false);
      const crossRead = await api(`/api/tickets/${testTid}`, 'GET', tokens.admin);
      assert.equal(crossRead.status, 404);

      // Test account cannot read real production ticket id=1
      const testCrossRead = await api('/api/tickets/1', 'GET', testTokens.test_admin);
      assert.equal(testCrossRead.status, 404);
    });

    // 23. Admin Sound & Voice Settings Preservation across migrations
    await test('23. Pre-existing admin station_audio_settings and voice_reader_settings are never overwritten on DB reopen/migration', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yemeni-taste-preserve-audio-'));
      try {
        const dbPath = path.join(tmpDir, 'preserve.db');
        const db1 = createDatabase(dbPath);
        db1.prepare(
          "UPDATE station_audio_settings SET volume_percent = 73, playback_rate = 1.5, speak_text_enabled = 0 WHERE station_code = 'production'"
        ).run();
        db1.prepare(
          "UPDATE voice_reader_settings SET volume_percent = 64, playback_rate = 1.25, read_scope = 'important_only' WHERE channel_code = 'assembly'"
        ).run();
        db1.close();

        const db2 = createDatabase(dbPath);
        const st = db2.prepare("SELECT volume_percent, playback_rate, speak_text_enabled FROM station_audio_settings WHERE station_code = 'production'").get() as any;
        const vr = db2.prepare("SELECT volume_percent, playback_rate, read_scope FROM voice_reader_settings WHERE channel_code = 'assembly'").get() as any;
        assert.equal(st.volume_percent, 73);
        assert.equal(st.playback_rate, 1.5);
        assert.equal(st.speak_text_enabled, 0);
        assert.equal(vr.volume_percent, 64);
        assert.equal(vr.playback_rate, 1.25);
        assert.equal(vr.read_scope, 'important_only');
        db2.close();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // 24. DB-Authoritative TTS route enforcement, returned ticket spoken_text, and Audio Diagnostics Log
    await test('24. Audio Diagnostics Log tracks lifecycle stages, DB-authoritative TTS honors disabled channels, and ticket_returned has full spoken_text', async () => {
      // Return ticket from assembly back to production and verify notification has full spoken_text
      const retTarget = await api('/api/tickets', 'POST', tokens.assembly, {
        invoice_number: '9940',
        item_name: 'حنيذ لحم بلدي',
        quantity: 1,
        reason_code: 'item_shortage',
        problem_description: 'نقص في صحن الحنيذ',
      });
      assert.equal(retTarget.status, 201);
      const rTid = retTarget.json.ticket.id;

      await api(`/api/tickets/${rTid}/receive`, 'POST', tokens.production, {
        client_request_id: 'recv-9940',
      });
      const trRes = await api(`/api/tickets/${rTid}/transfer`, 'POST', tokens.production, {
        to_department: 'assembly',
        reason: 'تحويل تجريبي قبل الإرجاع',
      });
      assert.equal(trRes.status, 200);
      const retRes = await api(`/api/tickets/${rTid}/return`, 'POST', tokens.assembly, {
        reason: 'الكمية لا تزال ناقصة',
      });
      assert.equal(retRes.status, 200);
      const prodNotifsAfterRet = await api('/api/notifications', 'GET', tokens.production);
      const returnNotif = prodNotifsAfterRet.json.notifications.find(
        (n: any) => n.ticket_id === rTid && n.event_type === 'ticket_returned'
      );
      assert.ok(returnNotif, 'Expected ticket_returned notification for production');
      assert.ok(returnNotif.spoken_text && returnNotif.spoken_text.includes('9940'));
      assert.ok(returnNotif.spoken_text.includes('حنيذ لحم بلدي'));

      // Disable production voice reader temporarily and verify POST /api/audio/tts rejects alert mode cleanly
      const origProdVr = (await api('/api/audio/voice-reader/settings', 'GET', tokens.admin)).json.settings.find(
        (s: any) => s.channel_code === 'production'
      );
      await api('/api/audio/voice-reader/settings/production', 'PUT', tokens.admin, {
        human_voice_id: origProdVr.human_voice_id,
        playback_rate: origProdVr.playback_rate,
        volume_percent: origProdVr.volume_percent,
        is_enabled: false,
        read_scope: origProdVr.read_scope,
      });
      const ttsDisabledRes = await api('/api/audio/tts', 'POST', tokens.production, {
        text: 'اختبار قناة متوقفة',
        channelCode: 'production',
        departmentCode: 'production',
        mode: 'alert',
      });
      assert.equal(ttsDisabledRes.status, 200);
      assert.equal(ttsDisabledRes.json.available, false);
      assert.equal(ttsDisabledRes.json.reason, 'channel_disabled');

      // Re-enable production channel
      await api('/api/audio/voice-reader/settings/production', 'PUT', tokens.admin, {
        human_voice_id: origProdVr.human_voice_id,
        playback_rate: origProdVr.playback_rate,
        volume_percent: origProdVr.volume_percent,
        is_enabled: true,
        read_scope: origProdVr.read_scope,
      });

      // Audio Diagnostics Log lifecycle: requested -> failed -> completed
      const diagUid = `test-diag-${Date.now()}`;
      const d1 = await api('/api/audio/diagnostics', 'POST', tokens.production, {
        client_diag_uid: diagUid,
        ticket_id: rTid,
        ticket_number: retTarget.json.ticket.ticket_number,
        invoice_number: '9940',
        target_department: 'production',
        channel_code: 'production',
        selected_voice_name: 'سلمى (واضح ومرتب)',
        selected_prebuilt_voice: 'Kore',
        playback_requested: true,
        playback_started: false,
        playback_completed: false,
        playback_status: 'requested',
      });
      assert.equal(d1.status, 201);

      const d2 = await api('/api/audio/diagnostics', 'POST', tokens.production, {
        client_diag_uid: diagUid,
        playback_requested: true,
        playback_started: true,
        playback_completed: false,
        playback_status: 'failed',
        tts_engine: 'gemini-3.8-flash-lite-tts',
        failure_reason: 'سبب تجريبي',
      });
      assert.equal(d2.status, 201);

      const diagListFail = await api('/api/audio/diagnostics?department=production&status=failed', 'GET', tokens.admin);
      assert.equal(diagListFail.status, 200);
      const foundFail = diagListFail.json.diagnostics.find((d: any) => d.client_diag_uid === diagUid);
      assert.ok(foundFail);
      assert.equal(foundFail.playback_requested, true);
      assert.equal(foundFail.playback_started, true);
      assert.equal(foundFail.playback_completed, false);
      assert.equal(foundFail.failure_reason, 'سبب تجريبي');

      const d3 = await api('/api/audio/diagnostics', 'POST', tokens.production, {
        client_diag_uid: diagUid,
        playback_requested: true,
        playback_started: true,
        playback_completed: true,
        playback_status: 'completed',
        tts_engine: 'gemini-3.8-live',
      });
      assert.equal(d3.status, 201);

      const diagListOk = await api('/api/audio/diagnostics?department=production&status=completed', 'GET', tokens.admin);
      const foundOk = diagListOk.json.diagnostics.find((d: any) => d.client_diag_uid === diagUid);
      assert.ok(foundOk);
      assert.equal(foundOk.playback_completed, true);
      assert.equal(foundOk.failure_reason, null);
    });

    prodConn.ws.close();
    prod2Conn.ws.close();
    asmConn.ws.close();
    hallConn.ws.close();
    console.log(`\nALL ${passed} END-TO-END TESTS PASSED!`);
  } finally {
    wss.close();
    server.close();
    db.close();
    fs.rmSync(mainAudioDir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
