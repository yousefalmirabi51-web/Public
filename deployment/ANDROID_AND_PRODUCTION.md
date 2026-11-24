# دليل التشغيل والإنتاج وبناء نسخة Android

## 1. التشغيل الفوري (بيئة التطوير / المعاينة)
```bash
npm install
npm run dev
```
يعمل الخادم على المنفذ `3000` شاملاً واجهة React + Vite، وواجهة REST API، وخادم WebSocket (`/ws`)، وقاعدة البيانات العلائقية.

## 2. تشغيل الاختبارات الشاملة
```bash
npm test
```

## 3. التشغيل الإنتاجي عبر Docker + PostgreSQL + Nginx
```bash
cd deployment
docker compose up -d --build
```
- `postgres`: قاعدة بيانات PostgreSQL 16 مستقلة مع وحدة تخزين دائمة `postgres_data`.
- `app`: خادم التطبيق المبني للإنتاج.
- `nginx`: خادم عكسي على المنفذ 80 مع دعم ترقية WebSocket.

### النسخ الاحتياطي والاستعادة لقاعدة PostgreSQL
- **نسخ احتياطي**:
  ```bash
  docker exec almazaq_postgres pg_dump -U almazaq_user almazaq_ops > backup_$(date +%F).sql
  ```
- **استعادة**:
  ```bash
  cat backup_YYYY-MM-DD.sql | docker exec -i almazaq_postgres psql -U almazaq_user -d almazaq_ops
  ```

## 4. تجهيز وبناء تطبيق Android عبر Capacitor
تم إعداد ملف `capacitor.config.ts` وأيقونات التطبيق الرسمية (`public/pwa-192x192.png`, `public/pwa-512x512.png`, `public/pwa-maskable-512x512.png`).
لبناء حزمة `APK` أو `AAB` على جهاز يحتوي Android SDK / Android Studio:
```bash
npm install @capacitor/cli @capacitor/android
npm run build
npx cap add android
npx cap sync android
npx cap open android
```
ثم من Android Studio اختر:
- **Build > Build Bundle(s) / APK(s) > Build APK(s)** لإصدار ملف التثبيت المباشر، أو **Generate Signed Bundle / APK** لإصدار `AAB`.
