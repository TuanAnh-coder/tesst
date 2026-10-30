import express, { type Request, type Response } from 'express';
import { DatabaseSync } from 'node:sqlite';

// =============================================================
// 1. CẤU HÌNH SERVER & MIDDLEWARE
// =============================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Tự động parse nếu client gửi raw JSON dạng text hoặc quên header Content-Type
app.use(express.text({ type: '*/*' }));
app.use((req, _res, next) => {
  if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      // bỏ qua nếu parse lỗi
    }
  }
  next();
});

// =============================================================
// 2. KHỞI TẠO CƠ SỞ DỮ LIỆU SQLITE (app.db)
// =============================================================
export const db = new DatabaseSync('app.db');

// Tạo cấu trúc các bảng
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    quantity INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_code TEXT NOT NULL UNIQUE,
    ticket_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    total_amount REAL NOT NULL,
    discount_amount REAL NOT NULL DEFAULT 0,
    final_amount REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id)
  );

  CREATE TABLE IF NOT EXISTS booking_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_code TEXT NOT NULL,
    ticket_id INTEGER NOT NULL,
    ticket_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    total_price REAL NOT NULL,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id)
  );

  CREATE TABLE IF NOT EXISTS discount_settings (
    id INTEGER PRIMARY KEY,
    min_order_amount REAL NOT NULL,
    discount_percent REAL NOT NULL,
    max_discount_amount REAL NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );
`);

// Migration tự động nếu DB cũ chưa có các cột giảm giá
const bookingCols = db.prepare('PRAGMA table_info(bookings)').all() as { name: string }[];
const colNames = bookingCols.map(c => c.name);
if (!colNames.includes('discount_amount')) {
  db.exec('ALTER TABLE bookings ADD COLUMN discount_amount REAL DEFAULT 0');
}
if (!colNames.includes('final_amount')) {
  db.exec('ALTER TABLE bookings ADD COLUMN final_amount REAL DEFAULT 0');
}

// Hàm khởi tạo/reset toàn bộ dữ liệu ban đầu
export function resetDatabase() {
  db.exec(`
    DELETE FROM booking_items;
    DELETE FROM bookings;
    DELETE FROM tickets;
    DELETE FROM sqlite_sequence WHERE name IN ('bookings', 'booking_items', 'tickets');

    -- Khởi tạo đúng 2 loại vé theo yêu cầu
    INSERT INTO tickets (id, name, price, quantity) VALUES 
      (1, 'Vé Vinwonders', 750000, 5),
      (2, 'Vé Safari', 650000, 3);

    -- Khởi tạo cấu hình giảm giá: đơn từ 1.000.000đ trở lên giảm 10%, tối đa 200.000đ
    INSERT INTO discount_settings (id, min_order_amount, discount_percent, max_discount_amount, is_active)
    VALUES (1, 1000000, 10, 200000, 1)
    ON CONFLICT(id) DO UPDATE SET 
      min_order_amount = 1000000, 
      discount_percent = 10, 
      max_discount_amount = 200000, 
      is_active = 1;
  `);
}

// Khởi tạo vé mẫu nếu bảng tickets rỗng
const ticketsCount = (db.prepare('SELECT count(*) as count FROM tickets').get() as { count: number }).count;
if (ticketsCount === 0) {
  resetDatabase();
}

// =============================================================
// 3. PREPARED STATEMENTS & HELPER FUNCTIONS
// =============================================================
const findTicketById = db.prepare('SELECT id, name, price, quantity FROM tickets WHERE id = ?');
const findTicketByExactName = db.prepare('SELECT id, name, price, quantity FROM tickets WHERE LOWER(name) = LOWER(?) LIMIT 1');
const findTicketByLikeName = db.prepare('SELECT id, name, price, quantity FROM tickets WHERE LOWER(name) LIKE LOWER(?) LIMIT 1');
const getAllTickets = db.prepare('SELECT id, name, price, quantity FROM tickets');
const insertTicket = db.prepare('INSERT INTO tickets (name, price, quantity) VALUES (?, ?, ?)');
const updateTicket = db.prepare('UPDATE tickets SET name = ?, price = ?, quantity = ? WHERE id = ?');
const deleteTicket = db.prepare('DELETE FROM tickets WHERE id = ?');
const updateTicketStock = db.prepare('UPDATE tickets SET quantity = quantity - ? WHERE id = ? AND quantity >= ?');
const refundTicketStock = db.prepare('UPDATE tickets SET quantity = quantity + ? WHERE id = ?');

const getAllBookings = db.prepare('SELECT * FROM bookings ORDER BY id DESC');
const findBookingByCode = db.prepare('SELECT * FROM bookings WHERE order_code = ?');
const findBookingItemsByCode = db.prepare('SELECT * FROM booking_items WHERE order_code = ?');
const updateBookingStatus = db.prepare('UPDATE bookings SET status = ? WHERE order_code = ?');
const insertBooking = db.prepare(`
  INSERT INTO bookings (order_code, ticket_id, quantity, unit_price, total_amount, discount_amount, final_amount, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertBookingItem = db.prepare(`
  INSERT INTO booking_items (order_code, ticket_id, ticket_name, quantity, unit_price, total_price)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const getDiscountSetting = db.prepare('SELECT * FROM discount_settings WHERE id = 1');
const updateDiscountSetting = db.prepare(`
  UPDATE discount_settings 
  SET min_order_amount = ?, discount_percent = ?, max_discount_amount = ?, is_active = ? 
  WHERE id = 1
`);

// Tìm vé động trong Database (theo ID số hoặc theo Tên chữ)
export function findTicketInDatabase(identifier: { id?: any; name?: any }) {
  if (identifier.id !== undefined && identifier.id !== null && identifier.id !== '') {
    const numId = Number(identifier.id);
    if (Number.isInteger(numId) && numId > 0) {
      const ticket = findTicketById.get(numId) as any;
      if (ticket) return ticket;
    }
  }

  if (identifier.name && typeof identifier.name === 'string' && identifier.name.trim() !== '') {
    const rawName = identifier.name.trim();
    let ticket = findTicketByExactName.get(rawName) as any;
    if (ticket) return ticket;

    ticket = findTicketByLikeName.get(`%${rawName}%`) as any;
    if (ticket) return ticket;
  }

  return undefined;
}

// Tạo mã đơn hàng duy nhất
function generateOrderCode(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `BK-${timestamp}-${random}`;
}

// Tính toán giảm giá động dựa trên cấu hình trong database
export function calculateDiscount(totalAmount: number): { discountAmount: number; finalAmount: number } {
  const setting = getDiscountSetting.get() as any;

  const minOrderAmount = setting?.min_order_amount ?? 1_000_000;
  const discountRate = (setting?.discount_percent ?? 10) / 100;
  const maxDiscount = setting?.max_discount_amount ?? 200_000;
  const isActive = setting ? setting.is_active === 1 : true;

  let discountAmount = 0;
  if (isActive && totalAmount >= minOrderAmount) {
    discountAmount = Math.min(totalAmount * discountRate, maxDiscount);
  }

  const finalAmount = totalAmount - discountAmount;
  return { discountAmount, finalAmount };
}

// =============================================================
// 4. API CHÍNH: POST /api/bookings (ĐẶT VÉ)
// Request: { tiketid: 1, quantity: 2 } hoặc { name: "Safari", quantity: 2 }
// =============================================================
app.post('/api/bookings', (req: Request, res: Response) => {
  const body = req.body;
  const query = req.query;

  // 1. Chuẩn hóa danh sách các mục đặt vé (Hỗ trợ Object đơn, Mảng, hoặc { items: [...] })
  interface RequestItem {
    rawId?: any;
    rawName?: any;
    rawQuantity?: any;
  }

  const rawItems: RequestItem[] = [];

  if (Array.isArray(body)) {
    for (const el of body) {
      if (typeof el === 'object' && el !== null) {
        rawItems.push({
          rawId: el.tiketid ?? el.ticketid ?? el.ticketId ?? el.ticket_id ?? el.id,
          rawName: el.name ?? el.ticketName ?? el.ticket_name ?? el.ten_ve,
          rawQuantity: el.quantity ?? el.qty ?? el.so_luong ?? el.amount ?? el.count
        });
      }
    }
  } else if (body && Array.isArray(body.items)) {
    for (const el of body.items) {
      if (typeof el === 'object' && el !== null) {
        rawItems.push({
          rawId: el.tiketid ?? el.ticketid ?? el.ticketId ?? el.ticket_id ?? el.id,
          rawName: el.name ?? el.ticketName ?? el.ticket_name ?? el.ten_ve,
          rawQuantity: el.quantity ?? el.qty ?? el.so_luong ?? el.amount ?? el.count
        });
      }
    }
  } else {
    const payload = (typeof body === 'object' && body !== null) ? { ...query, ...body } : { ...query };
    rawItems.push({
      rawId: payload.tiketid ?? payload.ticketid ?? payload.ticketId ?? payload.tiketId ?? payload.ticket_id ?? payload.tiket_id ?? payload.id,
      rawName: payload.name ?? payload.ticketName ?? payload.ticket_name ?? payload.ten_ve ?? payload.title,
      rawQuantity: payload.quantity ?? payload.qty ?? payload.so_luong ?? payload.soluong ?? payload.amount ?? payload.count
    });
  }

  if (rawItems.length === 0) {
    return res.status(400).json({ error: 'Input không hợp lệ', message: 'Dữ liệu đặt vé không được rỗng' });
  }

  // 2. Validate sơ bộ từng item
  const validatedItems: { id?: any; name?: any; quantity: number }[] = [];
  for (const item of rawItems) {
    if ((item.rawId === undefined || item.rawId === null || item.rawId === '') && 
        (!item.rawName || typeof item.rawName !== 'string' || item.rawName.trim() === '')) {
      return res.status(400).json({
        error: 'Input không hợp lệ',
        message: 'tiketid hoặc tên vé là bắt buộc'
      });
    }

    if (item.rawQuantity === undefined || item.rawQuantity === null || item.rawQuantity === '') {
      return res.status(400).json({
        error: 'Input không hợp lệ',
        message: 'quantity là bắt buộc'
      });
    }

    const qty = Number(item.rawQuantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({
        error: 'Input không hợp lệ',
        message: 'quantity phải là số nguyên dương lớn hơn 0'
      });
    }

    validatedItems.push({
      id: item.rawId,
      name: item.rawName,
      quantity: qty
    });
  }

  try {
    db.exec('BEGIN TRANSACTION');

    const resolvedItems: { ticket: any; quantity: number; totalPrice: number }[] = [];

    // 3. Kiểm tra động trong Database cho từng vé
    for (const item of validatedItems) {
      const ticket = findTicketInDatabase({ id: item.id, name: item.name });

      // Kiểm tra vé có tồn tại trong Database không
      if (!ticket) {
        db.exec('ROLLBACK');
        const identifierStr = item.id ? `ID ${item.id}` : `tên "${item.name}"`;
        return res.status(404).json({
          error: 'Input không hợp lệ',
          message: `Vé với ${identifierStr} không tồn tại trong hệ thống`
        });
      }

      // Kiểm tra tồn kho trong Database
      if (ticket.quantity < item.quantity) {
        db.exec('ROLLBACK');
        return res.status(400).json({
          error: 'Không đủ vé',
          message: `Số lượng vé "${ticket.name}" trong kho (${ticket.quantity}) không đủ cho yêu cầu (${item.quantity})`
        });
      }

      // Trừ tồn kho nguyên tử trong Database
      const updateResult = updateTicketStock.run(item.quantity, ticket.id, item.quantity);
      if (updateResult.changes === 0) {
        db.exec('ROLLBACK');
        return res.status(400).json({
          error: 'Không đủ vé',
          message: `Vé "${ticket.name}" vừa hết hoặc không đủ tồn kho`
        });
      }

      const itemTotal = ticket.price * item.quantity;
      resolvedItems.push({
        ticket,
        quantity: item.quantity,
        totalPrice: itemTotal
      });
    }

    // 4. Tính tổng tiền trước giảm theo giá backend lưu trong database
    const totalAmount = resolvedItems.reduce((sum, it) => sum + it.totalPrice, 0);

    // 5. Áp dụng chính sách giảm giá
    const { discountAmount, finalAmount } = calculateDiscount(totalAmount);

    // 6. Tạo đơn hàng và lưu chi tiết vào Database
    const orderCode = generateOrderCode();
    const status = 'SUCCESS';
    const createdAt = new Date().toISOString();

    insertBooking.run(
      orderCode,
      resolvedItems[0].ticket.id,
      resolvedItems.reduce((sum, it) => sum + it.quantity, 0),
      resolvedItems[0].ticket.price,
      totalAmount,
      discountAmount,
      finalAmount,
      status,
      createdAt
    );

    for (const it of resolvedItems) {
      insertBookingItem.run(
        orderCode,
        it.ticket.id,
        it.ticket.name,
        it.quantity,
        it.ticket.price,
        it.totalPrice
      );
    }

    db.exec('COMMIT');

    // 7. Định dạng Response trả về
    if (resolvedItems.length === 1) {
      const item = resolvedItems[0];
      return res.status(201).json({
        orderCode,
        totalAmount,
        discountAmount,
        discountamoun: discountAmount,
        finalAmount,
        finalamoun: finalAmount,
        status,
        ticketId: item.ticket.id,
        ticketName: item.ticket.name,
        quantity: item.quantity,
        unitPrice: item.ticket.price,
        remainingStock: item.ticket.quantity - item.quantity
      });
    } else {
      return res.status(201).json({
        orderCode,
        totalAmount,
        discountAmount,
        discountamoun: discountAmount,
        finalAmount,
        finalamoun: finalAmount,
        status,
        items: resolvedItems.map(it => ({
          ticketId: it.ticket.id,
          ticketName: it.ticket.name,
          quantity: it.quantity,
          unitPrice: it.ticket.price,
          totalPrice: it.totalPrice,
          remainingStock: it.ticket.quantity - it.quantity
        }))
      });
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    console.error('Lỗi khi đặt vé:', error);
    return res.status(500).json({
      error: 'Lỗi hệ thống',
      message: 'Không thể xử lý yêu cầu đặt vé lúc này'
    });
  }
});

// =============================================================
// 5. CÁC API PHỤ TRỢ (TICKETS CRUD, BOOKINGS, SETTINGS, RESET)
// =============================================================

// GET /api/tickets: Xem danh sách vé và tồn kho
app.get('/api/tickets', (_req: Request, res: Response) => {
  const tickets = getAllTickets.all();
  res.json({ total: tickets.length, data: tickets });
});

// GET /api/tickets/:id: Xem chi tiết 1 vé
app.get('/api/tickets/:id', (req: Request, res: Response) => {
  const ticket = findTicketById.get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Vé không tồn tại' });
  res.json(ticket);
});

// POST /api/tickets: Thêm vé mới
app.post('/api/tickets', (req: Request, res: Response) => {
  const { name, price, quantity } = req.body ?? {};
  if (!name || typeof name !== 'string' || name.trim() === '') {
    return res.status(400).json({ error: 'Input không hợp lệ', message: 'Tên vé là bắt buộc' });
  }
  const parsedPrice = Number(price);
  const parsedQuantity = Number(quantity);
  if (isNaN(parsedPrice) || parsedPrice < 0 || !Number.isInteger(parsedQuantity) || parsedQuantity < 0) {
    return res.status(400).json({ error: 'Input không hợp lệ', message: 'Giá hoặc số lượng vé không hợp lệ' });
  }

  const result = insertTicket.run(name.trim(), parsedPrice, parsedQuantity);
  return res.status(201).json({
    message: 'Tạo vé mới thành công',
    ticket: { id: Number(result.lastInsertRowid), name: name.trim(), price: parsedPrice, quantity: parsedQuantity }
  });
});

// PUT /api/tickets/:id: Sửa vé
app.put('/api/tickets/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const ticket = findTicketById.get(id) as any;
  if (!ticket) return res.status(404).json({ error: 'Vé không tồn tại' });

  const name = req.body.name ?? ticket.name;
  const price = req.body.price !== undefined ? Number(req.body.price) : ticket.price;
  const quantity = req.body.quantity !== undefined ? Number(req.body.quantity) : ticket.quantity;

  updateTicket.run(name, price, quantity, id);
  return res.json({ message: 'Cập nhật vé thành công', ticket: { id, name, price, quantity } });
});

// DELETE /api/tickets/:id: Xóa vé
app.delete('/api/tickets/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const ticket = findTicketById.get(id);
  if (!ticket) return res.status(404).json({ error: 'Vé không tồn tại' });

  try {
    deleteTicket.run(id);
    return res.json({ message: `Đã xóa vé ID ${id} thành công` });
  } catch (error: any) {
    if (error?.code === 'ERR_SQLITE_ERROR') {
      return res.status(400).json({ error: 'Không thể xóa vé', message: 'Vé này đã có đơn hàng' });
    }
    return res.status(500).json({ error: 'Lỗi khi xóa vé' });
  }
});

// GET /api/bookings: Xem danh sách đơn hàng
app.get('/api/bookings', (_req: Request, res: Response) => {
  const bookings = getAllBookings.all();
  res.json({ total: bookings.length, data: bookings });
});

// GET /api/bookings/:orderCode: Xem chi tiết 1 đơn hàng
app.get('/api/bookings/:orderCode', (req: Request, res: Response) => {
  const booking = findBookingByCode.get(req.params.orderCode);
  if (!booking) return res.status(404).json({ error: 'Đơn hàng không tồn tại' });
  const items = findBookingItemsByCode.all(req.params.orderCode);
  res.json({ ...booking, items });
});

// POST /api/bookings/:orderCode/cancel: Hủy đơn hàng và hoàn tồn kho
app.post('/api/bookings/:orderCode/cancel', (req: Request, res: Response) => {
  const orderCode = req.params.orderCode;
  const booking = findBookingByCode.get(orderCode) as any;
  if (!booking) return res.status(404).json({ error: 'Đơn hàng không tồn tại' });
  if (booking.status === 'CANCELLED') return res.status(400).json({ error: 'Đơn hàng này đã bị hủy trước đó' });

  try {
    db.exec('BEGIN TRANSACTION');
    const items = findBookingItemsByCode.all(orderCode) as any[];
    if (items.length > 0) {
      for (const item of items) {
        refundTicketStock.run(item.quantity, item.ticket_id);
      }
    } else {
      refundTicketStock.run(booking.quantity, booking.ticket_id);
    }
    updateBookingStatus.run('CANCELLED', orderCode);
    db.exec('COMMIT');
    return res.json({ message: 'Hủy đơn hàng và hoàn tồn kho thành công', orderCode, status: 'CANCELLED' });
  } catch {
    try { db.exec('ROLLBACK'); } catch {}
    return res.status(500).json({ error: 'Lỗi khi hủy đơn' });
  }
});

// GET /api/settings/discount: Xem cấu hình giảm giá
app.get('/api/settings/discount', (_req: Request, res: Response) => {
  res.json(getDiscountSetting.get());
});

// PUT /api/settings/discount: Đổi cấu hình giảm giá
app.put('/api/settings/discount', (req: Request, res: Response) => {
  const { minOrderAmount, discountPercent, maxDiscountAmount, isActive } = req.body ?? {};
  const minAmt = Number(minOrderAmount ?? 1000000);
  const percent = Number(discountPercent ?? 10);
  const maxAmt = Number(maxDiscountAmount ?? 200000);
  const active = isActive === false || isActive === 0 ? 0 : 1;
  updateDiscountSetting.run(minAmt, percent, maxAmt, active);
  return res.json({ message: 'Cập nhật cấu hình giảm giá thành công' });
});

// POST /api/reset: Khởi tạo lại toàn bộ dữ liệu mẫu (1 Vé Vinwonders 750k tồn 5, 2 Vé Safari 650k tồn 3)
app.post('/api/reset', (_req: Request, res: Response) => {
  resetDatabase();
  return res.json({
    message: 'Khởi tạo lại toàn bộ dữ liệu thành công!',
    tickets: getAllTickets.all()
  });
});

// =============================================================
// 6. KHỞI CHẠY SERVER
// =============================================================
const PORT = process.env.PORT || 3000;
export const server = app.listen(PORT, () => {
  console.log(`Server đang chạy thành công tại: http://localhost:${PORT}`);
});

export { app };
