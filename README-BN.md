# EarnHub Backend — বাংলা নির্দেশনা

## কী আছে
- User Registration/Login
- Password bcrypt hash
- JWT authentication
- User balance
- Referral code
- Deposit request
- Withdrawal request
- Micro jobs + proof submission
- Admin login
- Admin user list
- Deposit approve/reject
- Withdrawal approve/reject
- Job submission approve/reject
- New job creation
- Dashboard statistics

## 1) Node.js ইনস্টল
Windows PC-তে Node.js LTS ইনস্টল করুন।

## 2) PostgreSQL
PostgreSQL-এ `earnhub` নামে database বানান।

তারপর `schema.sql` চালান।

## 3) Environment
`.env.example` কপি করে `.env` বানান এবং নিজের তথ্য দিন:

DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/earnhub
JWT_SECRET=একটি_লম্বা_গোপন_কী
ADMIN_EMAIL=আপনার_admin_email
ADMIN_PASSWORD=আপনার_admin_password

## 4) Run
টার্মিনালে project folder-এ:

npm install
npm start

সফল হলে:
http://localhost:5000/api/health

## 5) গুরুত্বপূর্ণ
এই starter project-এ bKash/Nagad-এ সরাসরি টাকা পাঠানো/নেওয়ার API নেই।
Deposit হলো request + admin verification।
বাস্তব payment automation করতে official merchant/payment gateway API এবং ব্যবসায়িক/আইনি compliance লাগবে।

## 6) Frontend
আগের EarnHub HTML-এর fetch/API URL-গুলোকে backend URL-এ বসাতে হবে।

Local:
http://localhost:5000

Production-এ:
https://YOUR-BACKEND-DOMAIN.com

## 7) নিরাপত্তা
- `.env` কখনও public GitHub-এ দেবেন না।
- Production-এ HTTPS ব্যবহার করুন।
- Admin password শক্তিশালী রাখুন।
- Rate limiting, audit log, email/OTP verification এবং CSRF/CORS policy production-এর আগে যোগ করুন।
