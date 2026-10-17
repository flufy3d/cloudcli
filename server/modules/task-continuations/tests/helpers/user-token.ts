import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken') as {
  sign(payload: Record<string, number | string>, secret: string, options: { expiresIn: string }): string;
};

export function createTestUserToken(userId: number, username: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET must be set by the isolated test fixture.');
  return jwt.sign({ userId, username }, secret, { expiresIn: '7d' });
}
