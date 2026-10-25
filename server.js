require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));
app.use(express.static(__dirname)); // เพิ่มส่วนนี้เพื่อให้เซิร์ฟเวอร์อ่านไฟล์ .html ใน root directory ได้

// ---------------- ตั้งค่า LINE OA ----------------
const LINE_CHANNEL_ACCESS_TOKEN = 'apoWC0YS2Y164qQsnwGrPv899Dc5sm54AXmxUupCdz68mYMjX354Fi9ZamYEsZxNwfExLtFNZEf9jtzAeF9hl5R6IemodDjYrcQo1Z9wPVpqfvLh+SfS1KHtfZX1EhWeLMyOl4jtnVMo2gn545bpnQdB04t89/1O/w1cDnyilFU=';

// ฟังก์ชันสำหรับส่งข้อความ Push Message หาลูกค้าทาง LINE
function sendLinePushMessage(userId, messageText) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || LINE_CHANNEL_ACCESS_TOKEN.includes('ใส่_CHANNEL_ACCESS_TOKEN')) {
    console.log('⚠️ ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN');
    return;
  }
  if (!userId) return;

  const data = JSON.stringify({
    to: userId,
    messages: [{ type: 'text', text: messageText }]
  });

  const options = {
    hostname: 'api.line.me',
    port: 443,
    path: '/v2/bot/message/push',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const req = https.request(options, (res) => {
    res.on('data', () => {});
  });

  req.on('error', (e) => {
    console.error('❌ LINE Push Error:', e.message);
  });

  req.write(data);
  req.end();
}

// ---------------- ตั้งค่า DB (ดึงค่าจาก .env ปลอดภัย) ----------------
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

function generateOrderId() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomStr = Math.floor(1000 + Math.random() * 9000);
  return `NN-${dateStr}-${randomStr}`;
}

// ---------------- WEBHOOK ENDPOINT (รองรับการ Verify จาก LINE) ----------------
app.post('/webhook', (req, res) => {
  console.log('📥 Received LINE Webhook event:', JSON.stringify(req.body));
  
  const events = req.body.events;
  if (Array.isArray(events)) {
    for (let event of events) {
      console.log('Event type:', event.type);
    }
  }

  return res.status(200).json({ status: 'success' });
});

// ---------------- API ENDPOINTS ----------------

app.get('/api', async (req, res) => {
  const action = req.query.action;
  try {
    if (action === 'getMenu') {
      const [menu] = await db.query('SELECT id, name, price, category, img, status FROM products');
      const [toppings] = await db.query('SELECT id, name, price, status FROM toppings');
      return res.json({ ok: true, data: { menu, toppings } });
    }

    if (action === 'getOrdersByUser') {
      const userId = req.query.userId;
      if (!userId) return res.json({ ok: false, error: 'User ID is required' });

      const [orders] = await db.query('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC', [userId]);
      for (let o of orders) {
        const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [o.order_id]);
        o.orderId = o.order_id;
        o.customerName = o.customer_name;
        o.totalPrice = o.total_price;
        o.paymentMethod = o.payment_method;
        o.paymentStatus = o.payment_status;
        o.orderStatus = o.order_status;
        o.timestamp = o.created_at;
        o.canCancel = (o.order_status === 'รอชง' || o.order_status === 'กำลังชง');
        o.items = items.map(i => ({
          name: i.name,
          qty: i.qty,
          price: i.unit_price,
          subtotal: i.subtotal,
          drinkType: i.drink_type,
          container: i.container,
          sweetness: i.sweetness,
          toppings: i.toppings
        }));
      }
      return res.json({ ok: true, data: orders });
    }

    if (action === 'getAllOrders') {
      const [orders] = await db.query('SELECT * FROM orders ORDER BY created_at DESC');
      for (let o of orders) {
        const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [o.order_id]);
        o.orderId = o.order_id;
        o.customerName = o.customer_name;
        o.telephone = o.telephone;
        o.totalPrice = o.total_price;
        o.paymentMethod = o.payment_method;
        o.paymentStatus = o.payment_status;
        o.orderStatus = o.order_status;
        o.slipUrl = o.slip_url;
        o.timestamp = o.created_at;
        o.items = items.map(i => ({
          name: i.name,
          qty: i.qty,
          drinkType: i.drink_type,
          container: i.container,
          sweetness: i.sweetness,
          toppings: i.toppings
        }));
      }
      return res.json({ ok: true, data: orders });
    }

    if (action === 'getDashboardData') {
      const [soldOutMenus] = await db.query("SELECT id, name FROM products WHERE status = 'soldout'");
      const [soldOutToppings] = await db.query("SELECT id, name FROM toppings WHERE status = 'soldout'");
      const [pendingCancelOrders] = await db.query("SELECT order_id AS orderId FROM orders WHERE order_status = 'รอยืนยันการยกเลิก'");
      
      return res.json({
        ok: true,
        data: { soldOutMenus, soldOutToppings, pendingCancelOrders }
      });
    }

    if (action === 'getReportData') {
      const { startDate, endDate } = req.query;
      const s = `${startDate} 00:00:00`;
      const e = `${endDate} 23:59:59`;

      const [salesRes] = await db.query(
        "SELECT SUM(total_price) as sales, COUNT(*) as orders FROM orders WHERE order_status = 'เสร็จสิ้น' AND created_at BETWEEN ? AND ?",
        [s, e]
      );
      const [cupsRes] = await db.query(
        "SELECT SUM(i.qty) as cups FROM order_items i JOIN orders o ON i.order_id = o.order_id WHERE o.order_status = 'เสร็จสิ้น' AND o.created_at BETWEEN ? AND ?",
        [s, e]
      );
      const [expenseRes] = await db.query(
        "SELECT SUM(amount) as expenses FROM expenses WHERE expense_date BETWEEN ? AND ?",
        [startDate, endDate]
      );

      const sales = Number(salesRes[0].sales || 0);
      const orders = Number(salesRes[0].orders || 0);
      const cups = Number(cupsRes[0].cups || 0);
      const expenses = Number(expenseRes[0].expenses || 0);

      return res.json({
        ok: true,
        data: { sales, orders, cups, expenses, profit: sales - expenses }
      });
    }

    if (action === 'getExpenses') {
      const [expenses] = await db.query('SELECT id, expense_date as date, amount, note FROM expenses ORDER BY expense_date DESC');
      return res.json({ ok: true, data: expenses });
    }

    res.json({ ok: false, error: 'Invalid action' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api', async (req, res) => {
  const body = req.body;
  const action = body.action;

  try {
    if (action === 'adminLogin') {
      const { username, password } = body;
      const [users] = await db.query('SELECT * FROM admin_users WHERE username = ? AND password = ?', [username, password]);
      
      if (users.length > 0) {
        const token = crypto.randomBytes(16).toString('hex');
        await db.query('UPDATE admin_users SET token = ? WHERE id = ?', [token, users[0].id]);
        return res.json({ ok: true, data: { token } });
      }
      return res.json({ ok: false, error: 'Invalid credentials' });
    }

    if (action === 'createOrder') {
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const currentTimeNumber = hours * 60 + minutes;

      const openTimeNumber = 7 * 60 + 30;   
      const closeTimeNumber = 18 * 60 + 30; 

      if (currentTimeNumber < openTimeNumber || currentTimeNumber > closeTimeNumber) {
        return res.json({ 
          ok: false, 
          error: 'ร้านปิดรับคำสั่งซื้อแล้วค่ะ เปิดให้บริการเวลา 07:30 - 18:30 น.' 
        });
      }

      const { userId, name, telephone, items, totalPrice, paymentMethod, image } = body;
      const orderId = generateOrderId();
      const paymentStatus = paymentMethod === 'โอนเงิน' ? 'รอตรวจสอบสลิป' : 'รอชง';

      await db.query(
        'INSERT INTO orders (order_id, user_id, customer_name, telephone, total_price, payment_method, payment_status, slip_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [orderId, userId, name, telephone, totalPrice, paymentMethod, paymentStatus, image || null]
      );

      for (let item of items) {
        await db.query(
          'INSERT INTO order_items (order_id, product_id, name, category, base_price, drink_type, container, container_extra, sweetness, toppings, qty, unit_price, subtotal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [orderId, item.id || null, item.name, item.category || '', item.basePrice || 0, item.drinkType || '', item.container || '', item.containerExtra || 0, item.sweetness || '', item.toppings || '', item.qty, item.price, item.subtotal]
        );
      }

      const notifyText = `🧋 ร้านน้ำชงน้องน้ำ\nได้รับออเดอร์เรียบร้อยแล้วค่ะ!\n\n📌 เลขที่ออเดอร์: ${orderId}\n👤 คุณ: ${name}\n💰 ยอดรวม: ${totalPrice} บาท\n💳 การชำระเงิน: ${paymentMethod}\n\nร้านกำลังดำเนินการให้ค่ะ ขอบคุณค่ะ 🙏`;
      sendLinePushMessage(userId, notifyText);

      return res.json({ ok: true, data: { orderId } });
    }

    if (action === 'requestCancelOrder') {
      const { orderId, userId } = body;
      const [orders] = await db.query('SELECT order_status FROM orders WHERE order_id = ? AND user_id = ?', [orderId, userId]);
      
      if (orders.length > 0) {
        const currentStatus = orders[0].order_status;
        await db.query('UPDATE orders SET previous_status = ?, order_status = ? WHERE order_id = ?', [currentStatus, 'รอยืนยันการยกเลิก', orderId]);
        return res.json({ ok: true });
      }
      return res.json({ ok: false, error: 'Order not found' });
    }

    if (action === 'updateOrderStatus') {
      const { orderId, newStatus } = body;
      await db.query('UPDATE orders SET order_status = ? WHERE order_id = ?', [newStatus, orderId]);

      const [orders] = await db.query('SELECT user_id, customer_name FROM orders WHERE order_id = ?', [orderId]);
      if (orders.length > 0 && orders[0].user_id) {
        let msg = `📣 อัปเดตสถานะคำสั่งซื้อ\n📌 เลขที่ออเดอร์: ${orderId}\n\nสถานะล่าสุด: 👉 [ ${newStatus} ] 👈`;
        if (newStatus === 'กำลังชง') {
          msg += '\n\nทางร้านกำลังชงเครื่องดื่มให้คุณอยู่นะคะ 🥤';
        } else if (newStatus === 'พร้อมรับ') {
          msg += '\n\nเครื่องดื่มของคุณพร้อมรับแล้วค่ะ! มารับที่ร้านได้เลยนะคะ 🥳';
        } else if (newStatus === 'เสร็จสิ้น') {
          msg += '\n\nขอบคุณที่อุดหนุนร้านน้ำชงน้องน้ำค่ะ โอกาสหน้าเชิญใหม่นะคะ ❤️';
        }
        sendLinePushMessage(orders[0].user_id, msg);
      }

      return res.json({ ok: true });
    }

    if (action === 'updatePaymentStatus') {
      const { orderId, newStatus } = body;
      await db.query('UPDATE orders SET payment_status = ? WHERE order_id = ?', [newStatus, orderId]);

      const [orders] = await db.query('SELECT user_id FROM orders WHERE order_id = ?', [orderId]);
      if (orders.length > 0 && orders[0].user_id) {
        const msg = `💳 อัปเดตสถานะการชำระเงิน\n📌 เลขที่ออเดอร์: ${orderId}\nสถานะการชำระเงิน: [ ${newStatus} ]`;
        sendLinePushMessage(orders[0].user_id, msg);
      }

      return res.json({ ok: true });
    }

    if (action === 'confirmCancelOrder') {
      const { orderId } = body;
      await db.query("UPDATE orders SET order_status = 'ยกเลิกแล้ว', payment_status = 'ยกเลิก' WHERE order_id = ?", [orderId]);
      
      const [orders] = await db.query('SELECT user_id FROM orders WHERE order_id = ?', [orderId]);
      if (orders.length > 0 && orders[0].user_id) {
        sendLinePushMessage(orders[0].user_id, `❌ คำสั่งซื้อเลขที่ ${orderId} ได้รับการยืนยันการยกเลิกเรียบร้อยแล้วค่ะ`);
      }

      return res.json({ ok: true });
    }

    if (action === 'rejectCancelOrder') {
      const { orderId } = body;
      const [orders] = await db.query('SELECT previous_status, user_id FROM orders WHERE order_id = ?', [orderId]);
      const prev = orders[0]?.previous_status || 'รอชง';
      await db.query('UPDATE orders SET order_status = ?, previous_status = NULL WHERE order_id = ?', [prev, orderId]);
      
      if (orders.length > 0 && orders[0].user_id) {
        sendLinePushMessage(orders[0].user_id, `⚠️ คำขอยกเลิกออเดอร์เลขที่ ${orderId} ไม่อนุมัติ\nระบบได้ปรับสถานะกลับเป็น [ ${prev} ] ค่ะ`);
      }

      return res.json({ ok: true, data: { orderStatus: prev } });
    }

    if (action === 'addMenu') {
      const { name, price, category, status, image } = body;
      const [r] = await db.query('INSERT INTO products (name, price, category, status, img) VALUES (?, ?, ?, ?, ?)', [name, price, category, status, image || null]);
      return res.json({ ok: true, data: { id: r.insertId, name, price, category, status, img: image || null } });
    }

    if (action === 'updateMenu') {
      const { id, name, price, category, status, image } = body;
      if (image) {
        await db.query('UPDATE products SET name = ?, price = ?, category = ?, status = ?, img = ? WHERE id = ?', [name, price, category, status, image, id]);
      } else {
        await db.query('UPDATE products SET name = ?, price = ?, category = ?, status = ? WHERE id = ?', [name, price, category, status, id]);
      }
      return res.json({ ok: true });
    }

    if (action === 'updateMenuStatus') {
      await db.query('UPDATE products SET status = ? WHERE id = ?', [body.status, body.id]);
      return res.json({ ok: true });
    }

    if (action === 'deleteMenu') {
      await db.query('DELETE FROM products WHERE id = ?', [body.id]);
      return res.json({ ok: true });
    }

    if (action === 'addTopping') {
      const { name, price, status } = body;
      const [r] = await db.query('INSERT INTO toppings (name, price, status) VALUES (?, ?, ?)', [name, price, status]);
      return res.json({ ok: true, data: { id: r.insertId, name, price, status } });
    }

    if (action === 'updateTopping') {
      const { id, name, price, status } = body;
      await db.query('UPDATE toppings SET name = ?, price = ?, status = ? WHERE id = ?', [name, price, status, id]);
      return res.json({ ok: true });
    }

    if (action === 'updateToppingStatus') {
      await db.query('UPDATE toppings SET status = ? WHERE id = ?', [body.status, body.id]);
      return res.json({ ok: true });
    }

    if (action === 'deleteTopping') {
      await db.query('DELETE FROM toppings WHERE id = ?', [body.id]);
      return res.json({ ok: true });
    }

    if (action === 'addExpense') {
      const { date, amount, note } = body;
      await db.query('INSERT INTO expenses (expense_date, amount, note) VALUES (?, ?, ?)', [date, amount, note]);
      return res.json({ ok: true });
    }

    if (action === 'deleteExpense') {
      await db.query('DELETE FROM expenses WHERE id = ?', [body.id]);
      return res.json({ ok: true });
    }

    res.json({ ok: false, error: 'Invalid action' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});