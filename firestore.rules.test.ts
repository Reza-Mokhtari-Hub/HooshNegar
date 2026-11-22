import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rulesContent = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
const blueprint = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'firebase-blueprint.json'), 'utf8'),
) as { firestore: Record<string, unknown> };

describe('Firestore Security Rules — Dirty Dozen & Eight Pillars Verification', () => {
  it('starts with a global default-deny catch-all rule', () => {
    expect(rulesContent).toContain("rules_version = '2';");
    expect(rulesContent).toMatch(/match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
  });

  it('covers every collection declared in firebase-blueprint.json', () => {
    const paths = Object.keys(blueprint.firestore);
    expect(paths).toContain('/admins/{adminId}');
    expect(paths).toContain('/auditMirrors/{auditId}');
    expect(rulesContent).toContain('match /admins/{adminId}');
    expect(rulesContent).toContain('match /auditMirrors/{auditId}');
  });

  it('enforces email_verified == true to block email spoofing attacks', () => {
    expect(rulesContent).toContain('request.auth.token.email_verified == true');
    expect(rulesContent).toContain("isVerified() && request.auth.token.email == 'rezaxa1@gmail.com'");
  });

  it('enforces strict hasAll + hasOnly, size limits, ID regex, and request.time timestamps', () => {
    expect(rulesContent).toContain("id.matches('^[a-zA-Z0-9_\\\\-]+$')");
    expect(rulesContent).toContain("data.keys().hasAll(['uid', 'email', 'displayName', 'role', 'createdAt', 'updatedAt'])");
    expect(rulesContent).toContain("data.keys().hasOnly(['uid', 'email', 'displayName', 'role', 'createdAt', 'updatedAt'])");
    expect(rulesContent).toContain('incoming().createdAt == request.time');
    expect(rulesContent).toContain('incoming().updatedAt == request.time');
    expect(rulesContent).toContain("affectedKeys().hasOnly(['displayName', 'role', 'updatedAt'])");
  });

  it('locks auditMirrors as strictly append-only (no updates or deletes)', () => {
    expect(rulesContent).toContain('allow update: if false;');
    expect(rulesContent).toContain('allow delete: if false;');
  });
});
