# Security Specification — Payload-First Firestore Rules TDD

## 1. Data Invariants
1. **Default Deny**: All unmapped paths under `/databases/{database}/documents` are denied for both reads and writes.
2. **Verified Admin Only**: Every read and write to `/admins/{adminId}` and `/auditMirrors/{auditId}` requires an authenticated Firebase user with `request.auth.token.email_verified == true` who is either the bootstrapped super admin (`rezaxa1@gmail.com`) or has an existing document in `/admins/{request.auth.uid}`.
3. **No Self-Privilege Escalation**: Non-admin users cannot create, read, update, or delete `/admins/{adminId}` records or assign themselves an admin role.
4. **Strict Key & Size Bounds**: Every document enforces `hasAll` + `hasOnly`, strict string `.size()` limits matching `firebase-blueprint.json`, valid document ID regex (`^[a-zA-Z0-9_\-]+$`), and strict server timestamps (`request.time`).
5. **Immutable Audit Trail**: Documents in `/auditMirrors/{auditId}` are append-only (`allow update, delete: if false`) and never accept secrets or ghost fields.
6. **Zero Raw Credentials in Firestore**: API keys, Telegram bot tokens, and Argon2id hashes are strictly server-side in PostgreSQL with AES-256-GCM encryption and are never stored in Firestore.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Be Denied)
1. **Unauthenticated Read** on `/admins/admin-1` (`auth: null`).
2. **Email Spoofing** (`auth.token.email == 'rezaxa1@gmail.com'`, `email_verified: false`).
3. **Self-Assigned Admin Role** (regular user writing `/admins/{ownUid}` with `role: 'super_admin'`).
4. **Shadow / Ghost Field Injection** on `/admins/admin-2` (adding `isGodMode: true`).
5. **Path ID Poisoning** (document ID with spaces, slashes, or length > 128 chars).
6. **Denial-of-Wallet Oversized String** (`displayName` > 160 chars or `action` > 120 chars).
7. **Forged Client Timestamp** (`createdAt` != `request.time`).
8. **Actor UID Spoofing** on `/auditMirrors/evt-1` (`actorUid` != `request.auth.uid`).
9. **Audit Log Tampering** (`update` on `/auditMirrors/evt-1`).
10. **Audit Log Deletion** (`delete` on `/auditMirrors/evt-1`).
11. **Invalid Enum Injection** (`role: 'root'` or `severity: 'debug'`).
12. **Immutable Field Mutation** (updating `createdAt` or `uid` on `/admins/admin-2`).
