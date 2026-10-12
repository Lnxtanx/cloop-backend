const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

// 1. Stub prisma before requiring router so tests are 100% offline and deterministic
const prismaPath = require.resolve('../../lib/prisma');
let deletedUserId = null;
let updatedUserId = null;

require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: {
    users: {
      findUnique: async ({ where }) => {
        if (where.user_id === 101) {
          return {
            user_id: 101,
            name: 'Test Student',
            email: 'student@example.com',
            created_at: new Date().toISOString(),
            num_chats: 5,
            num_lessons: 2,
          };
        }
        return null;
      },
      update: async ({ where, data }) => {
        updatedUserId = where.user_id;
        return { user_id: where.user_id, ...data };
      },
      delete: async ({ where }) => {
        deletedUserId = where.user_id;
        return { user_id: where.user_id };
      },
    },
  },
};

const loginRouter = require('./login');
const { JWT_SECRET } = require('../../middleware/auth');

const app = express();
app.use(express.json());
app.use('/api/login', loginRouter);

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/api/login`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test.beforeEach(() => {
  deletedUserId = null;
  updatedUserId = null;
});

test('DELETE /api/login/users/:id without token returns 401 Access token required', async () => {
  const res = await fetch(`${baseUrl}/users/101`, { method: 'DELETE' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'Access token required');
  assert.equal(deletedUserId, null, 'User must not be deleted');
});

test('GET /api/login/users/:id without token returns 401 Access token required', async () => {
  const res = await fetch(`${baseUrl}/users/101`, { method: 'GET' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'Access token required');
});

test('PUT /api/login/users/:id without token returns 401 Access token required', async () => {
  const res = await fetch(`${baseUrl}/users/101`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hacker' }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'Access token required');
  assert.equal(updatedUserId, null, 'User must not be updated');
});

test('DELETE /api/login/users/:id with token for different user returns 403 Forbidden', async () => {
  const tokenAttacker = jwt.sign({ user_id: 999 }, JWT_SECRET);
  const res = await fetch(`${baseUrl}/users/101`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenAttacker}` },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.ok(body.error.includes('Forbidden'));
  assert.equal(deletedUserId, null, 'Target user must not be deleted');
});

test('GET /api/login/users/:id with token for different user returns 403 Forbidden', async () => {
  const tokenAttacker = jwt.sign({ user_id: 999 }, JWT_SECRET);
  const res = await fetch(`${baseUrl}/users/101`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenAttacker}` },
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.ok(body.error.includes('Forbidden'));
});

test('DELETE /api/login/users/:id with valid owner token successfully deletes account', async () => {
  const tokenOwner = jwt.sign({ user_id: 101 }, JWT_SECRET);
  const res = await fetch(`${baseUrl}/users/101`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenOwner}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(deletedUserId, 101, 'Owner user 101 was successfully deleted');
});
