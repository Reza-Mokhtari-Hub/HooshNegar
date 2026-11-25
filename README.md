<div align="center">

# هوش‌نگار (HooshNegar)

**پلتفرم یکپارچه ربات تلگرام، مینی‌اپ و پنل مدیریت مدل‌های متنی، تصویر، صدا و ویدیو**

توسعه و پیاده‌سازی: **[Reza Mokhtari](https://github.com/Reza-Mokhtari-Hub)**

[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflareworkers&logoColor=white)](https://workers.cloudflare.com/)
[![Drizzle ORM](https://img.shields.io/badge/PostgreSQL-Drizzle_ORM-336791?style=flat-square&logo=postgresql&logoColor=white)](https://orm.drizzle.team/)
[![Grammy](https://img.shields.io/badge/Telegram-Grammy_%2B_Mini_App-26A5E4?style=flat-square&logo=telegram&logoColor=white)](https://grammy.dev/)

</div>

---

## درباره پروژه

این مخزن شامل سورس کامل **هوش‌نگار** است؛ سیستمی که برای مدیریت متمرکز سرویس‌های گفتگو، تولید و ویرایش تصویر، پردازش صوت و ساخت ویدیو روی **ربات تلگرام** و **مینی‌اپ تلگرام (Telegram Mini App)** نوشته‌ام.

هدفم در طراحی این پروژه این بود که همه‌چیز در یک ساختار منظم TypeScript کنار هم باشد و بدون وابستگی به زیرساخت‌های پیچیده، هم به‌صورت محلی با Node.js و هم روی **Cloudflare Workers** مستقر شود. از مدیریت کلیدهای API و Failover بین ارائه‌دهنده‌ها گرفته تا پرداخت درون‌برنامه‌ای با **Telegram Stars** و پنل ادمین، همگی مستقیم در همین پروژه پیاده‌سازی شده‌اند.

---

## قابلیت‌ها

### ربات تلگرام و مینی‌اپ (`/miniapp`)
- **چت همگام‌سازی‌شده**: تاریخچه مکالمات بین ربات و مینی‌اپ یکسان است و کاربر می‌تواند مدل فعال یا دستورالعمل دلخواه خود را تغییر دهد.
- **استودیوی چندرسانه‌ای در مینی‌اپ**:
  - ساخت تصویر از روی متن، ویرایش تصویر با دستور متنی و تولید نسخه مشابه (Variation) همراه با بهینه‌سازی خودکار حجم و ابعاد تصویر پیش از ارسال.
  - تبدیل متن به صوت (TTS) و تبدیل ویس یا فایل صوتی به متن (STT).
  - ساخت ویدیو از متن یا تصویر با پیگیری خودکار وضعیت پردازش.
  - دکمه ذخیره مستقیم فایل در دستگاه با نام و پسوند استاندارد و ارسال هم‌زمان تصویر و ویدیوی نهایی به گفتگوی ربات کاربر.
- **دستورات و رابط ربات**: پشتیبانی از `/start`، `/help`، `/models`، `/plan`، `/balance`، `/buy`، `/referral`، `/history`، `/settings`، `/cancel` و `/paysupport` با منوهای شیشه‌ای.

### مسیریابی مدل‌ها و مدیریت کلیدها (Key Pool & Failover)
- اتصال به **OpenAI-compatible**، **Google Gemini**، **Anthropic**، **Cloudflare Workers AI**، **Hugging Face (Inference & Spaces / Gradio)**، **Replicate** و **fal.ai**.
- پشتیبانی از چند کلید هم‌زمان برای هر ارائه‌دهنده، تست سلامت دقیق، فعال و غیرفعال‌سازی دستی یا خودکار کلیدهای دارای خطا و جابه‌جایی سریع به کلید یا مدل پشتیبان هنگام محدودیت سهمیه.
- مدیریت کارهای طولانی و ناهمگام (تصویر و ویدیو) از طریق صف **Upstash QStash** و بازیابی خودکار سشن در صورت انقضا.

### پرداخت، اشتراک و کیف‌پول
- **پرداخت Telegram Stars (`XTR`)**: پیاده‌سازی مستقیم با امضای HMAC-SHA256 روی پیلود فاکتور، پاسخ سریع به `pre_checkout_query`، جلوگیری از ثبت تراکنش تکراری و امکان لغو تمدید دوره‌ای و بازپرداخت (Refund) از پنل ادمین.
- **کیف‌پول اعتبار اتمی**: قفل سطری در دیتابیس برای جلوگیری از تداخل موجودی، رزرو اعتبار پیش از شروع پردازش و بازگشت خودکار ۱۰۰٪ اعتبار هنگام خطا یا لغو درخواست.
- **پلن‌ها، معرفی دوستان و کوپن**: تعریف محدودیت‌های روزانه/ماهانه برای هر پلن، لینک دعوت اختصاصی با کنترل ضدتقلب و کدهای تخفیف یا هدیه.

### امنیت و داشبورد مدیریت
- ورود مدیران با هش **Argon2id** (و `scrypt` بومی در محیط Worker)، سشن‌های سمت سرور، کوکی‌های امن، محافظت **CSRF** و محدودیت تلاش ناموفق ورود.
- رمزنگاری کلیدهای API و توکن ربات با **AES-256-GCM** و پنهان‌سازی کامل مقادیر محرمانه در خروجی‌ها و لاگ‌ها.
- کنترل دسترسی بر اساس نقش (`super_admin`، `admin`، `operator`، `auditor`)، ثبت گزارش عملکرد (`audit_logs`) و محافظت **SSRF**.
- گزارش‌گیری مالی و مصرف، مدیریت کاربران و تیکت‌های پشتیبانی با ارسال پاسخ مستقیم به ربات کاربر.

---

## تکنولوژی‌های استفاده‌شده

| بخش | ابزارها و کتابخانه‌ها |
| --- | --- |
| **فرانت‌اند و مینی‌اپ** | React 19، TypeScript، Vite، Tailwind CSS v4، Recharts، Lucide Icons |
| **بک‌اند و ربات** | Express، Grammy، Zod |
| **اجرای لبه (Edge)** | Cloudflare Workers (`worker.ts`)، Durable Objects (`HooshNegarStore`)، Cron Triggers |
| **دیتابیس** | Drizzle ORM، PostgreSQL (Neon در محیط تولید / PGlite در توسعه محلی) |
| **صف و فایل** | Upstash QStash، Cloudflare R2 / S3 Storage |
| **تست و بررسی کد** | Vitest، Node Test Runner (`node:test`)، `tsc --noEmit` |

---

## ساختار پروژه

```text
├── src/
│   ├── components/         # بخش‌های پنل مدیریت و نمودارهای وضعیت
│   ├── miniapp/            # رابط کاربری و منطق مینی‌اپ تلگرام (چت، استودیو، فروشگاه، پروفایل)
│   ├── db/                 # اسکیماهای Drizzle، میگریشن‌ها و آداپتور Neon / PGlite / Durable Object
│   ├── server/
│   │   ├── providers/      # موتور اتصال به مدل‌ها، کشف خودکار و مدیریت کلیدها
│   │   ├── routes/         # مسیرهای API پنل مدیریت، مینی‌اپ، کرون و QStash
│   │   ├── security/       # رمزنگاری AES-256-GCM، احراز هویت، CSRF و SSRF
│   │   ├── services/       # منطق کیف‌پول، اشتراک، پرداخت Stars، معرفی دوستان و نگهداری
│   │   ├── storage/        # لایه ذخیره‌سازی رسانه (R2 / محلی)
│   │   └── telegram/       # هسته ربات Grammy، اجرای صف کارها و کیبوردهای اینلاین
│   └── shared/             # اسکیماهای اعتبارسنجی و تایپ‌های مشترک
├── drizzle/                # فایل‌های Migration پایگاه‌داده
├── server.ts               # نقطه ورود سرور Node.js و توسعه محلی
├── worker.ts               # نقطه ورود Cloudflare Workers، Cron و Durable Object
└── wrangler.jsonc          # تنظیمات استقرار روی کلودفلر
```

---

## نصب و اجرا روی سیستم شخصی

### پیش‌نیازها
- Node.js 20+
- npm

### اجرای محلی

```bash
git clone https://github.com/Reza-Mokhtari-Hub/hooshnegar.git
cd hooshnegar

npm install
cp .env.example .env

# اجرای میگریشن‌ها (بدون DATABASE_URL به‌صورت خودکار از PGlite محلی استفاده می‌شود)
npm run db:migrate

# اجرای هم‌زمان بک‌اند و فرانت‌اند روی پورت 3000
npm run dev
```

### تست و ساخت خروجی

```bash
npm run lint    # بررسی تایپ‌های TypeScript
npm test        # اجرای مجموعه تست‌های واحد و یکپارچه
npm run build   # ساخت باندل نهایی کلاینت
```

---

## متغیرهای محیطی

پیش از اجرا یا استقرار در محیط واقعی، متغیرهای `.env.example` را مقداردهی کنید:

| متغیر | کاربرد |
| --- | --- |
| `DATABASE_URL` | رشته اتصال PostgreSQL (در محیط محلی می‌تواند خالی بماند) |
| `ENCRYPTION_MASTER_KEY` | کلید ۶۴ کاراکتری هگز برای رمزنگاری AES-256-GCM (`openssl rand -hex 32`) |
| `SESSION_SECRET` | کلید تصادفی حداقل ۳۲ کاراکتری برای نشست‌ها (`openssl rand -base64 48`) |
| `PAYMENT_PAYLOAD_SECRET` | کلید HMAC-SHA256 برای امضای پیلود فاکتورهای Telegram Stars |
| `APP_URL` | آدرس عمومی HTTPS برنامه برای تنظیم وب‌هوک و مینی‌اپ |
| `QSTASH_TOKEN` / `QSTASH_*_SIGNING_KEY` | مشخصات Upstash QStash برای صف پس‌زمینه و Retry |
| `R2_*` | مشخصات باکت Cloudflare R2 جهت ذخیره‌سازی فایل‌ها |
| `CRON_SECRET` | توکن Bearer برای فراخوانی مسیر نگهداری `/api/cron/maintenance` |

---

## استقرار روی Cloudflare Workers

تنظیمات استقرار کامل در فایل `wrangler.jsonc` قرار دارد:

1. یک دیتابیس PostgreSQL در **Neon** بسازید و میگریشن‌ها را اعمال کنید:
   ```bash
   DATABASE_URL="postgresql://..." npm run db:migrate
   ```
2. متغیرها و Secretهای مورد نیاز را در تنظیمات Worker ثبت کنید.
3. پروژه را بسازید و مستقر کنید:
   ```bash
   npm run cf:deploy
   ```
4. پس از استقرار، وارد پنل مدیریت شوید، توکن دریافتی از `@BotFather` را وارد کنید و گزینه **همگام‌سازی وب‌هوک** را بزنید.
5. کرون ساعتی (`0 * * * *`) به‌صورت خودکار در `wrangler.jsonc` فعال است و وظایفی مثل بررسی اشتراک‌های منقضی‌شده و پاک‌سازی فایل‌های موقت را انجام می‌دهد.

---

## سازنده

توسعه‌یافته توسط **[Reza Mokhtari (Reza-Mokhtari-Hub)](https://github.com/Reza-Mokhtari-Hub)**
