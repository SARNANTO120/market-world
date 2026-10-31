# كريمسون — سوق البيع والشراء

## التشغيل
1. Node.js 22.13 أو أحدث (لا توجد أي اعتمادات للتثبيت).
2. انسخ `.env.example` إلى `.env` وعبّئ المفاتيح:
   - `SESSION_SECRET` نص عشوائي طويل
   - `PAYPAL_CLIENT_ID` و `PAYPAL_CLIENT_SECRET` من https://developer.paypal.com (ابدأ بـ sandbox)
3. `node server.js` ثم افتح http://localhost:3000

## الشخصية في الخلفية
ضع صورتك (PNG بخلفية شفافة) باسم `public/img/character.png` — تظهر بعد تسجيل الدخول. وإلا تُستخدم `character.svg`.

## الأمان المطبّق
- كلمات المرور: scrypt + salt، مقارنة ثابتة الزمن، قفل الحساب 15 دقيقة بعد 5 محاولات فاشلة
- جلسات HttpOnly + SameSite=Strict (+Secure في الإنتاج)، تجديد المعرّف عند الدخول، انتهاء بعد 8 ساعات
- حماية CSRF (رمز لكل جلسة + فحص Origin)، تحديد معدل الطلبات
- CSP صارمة وترويسات أمان، لا innerHTML (حماية XSS)، استعلامات SQL مُحضّرة
- السعر يؤخذ دائماً من قاعدة البيانات، ويُتحقق من المبلغ بعد الالتقاط من PayPal

## للإنتاج
استخدم HTTPS خلف proxy مع `NODE_ENV=production`.
