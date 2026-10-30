import test from 'node:test';
import assert from 'node:assert/strict';
import { app, db, server, resetDatabase } from './main.ts';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

test('KIỂM THỬ TOÀN BỘ LOGIC TRONG 1 FILE MAIN.TS', async (t) => {
  resetDatabase();

  await t.test('1. Đặt 2 Vé Vinwonders qua tiketid: 1, quantity: 2', async () => {
    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiketid: 1, quantity: 2 })
    });
    const data = await res.json();
    assert.equal(res.status, 201);
    assert.ok(data.orderCode);
    assert.equal(data.totalAmount, 1500000);
    assert.equal(data.discountamoun, 150000);
    assert.equal(data.finalamoun, 1350000);
    assert.equal(data.remainingStock, 3);
  });

  await t.test('2. Đặt 2 Vé Safari theo tên name: "Safari", quantity: 2', async () => {
    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Safari', quantity: 2 })
    });
    const data = await res.json();
    assert.equal(res.status, 201);
    assert.equal(data.totalAmount, 1300000);
    assert.equal(data.discountamoun, 130000);
    assert.equal(data.finalamoun, 1170000);
    assert.equal(data.remainingStock, 1);
  });

  await t.test('3. Lỗi khi đặt quá tồn kho Vé Safari (còn 1 đặt 2)', async () => {
    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiketid: 2, quantity: 2 })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.error, 'Không đủ vé');
  });

  await t.test('4. Lỗi khi input không hợp lệ', async () => {
    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiketid: 1, quantity: -5 })
    });
    const data = await res.json();
    assert.equal(res.status, 400);
    assert.equal(data.error, 'Input không hợp lệ');
  });

  server.close();
});
