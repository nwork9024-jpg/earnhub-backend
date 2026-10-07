require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function signUser(user) {
  return jwt.sign({ id: user.id, role: "user" }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Login required" });
    req.auth = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function adminAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Admin login required" });
    const data = jwt.verify(token, process.env.JWT_SECRET);
    if (data.role !== "admin") return res.status(403).json({ error: "Admin only" });
    req.auth = data;
    next();
  } catch {
    res.status(401).json({ error: "Invalid admin token" });
  }
}

function makeReferralCode() {
  return "EH" + Math.random().toString(36).slice(2, 9).toUpperCase();
}

app.get("/api/health", (req, res) => res.json({ ok: true, service: "EarnHub API" }));

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, phone, email, password, referralCode } = req.body;
    if (!name || !phone || !password)
      return res.status(400).json({ error: "name, phone and password are required" });
    if (password.length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });

    const exists = await pool.query("SELECT id FROM users WHERE phone=$1 OR ($2::text IS NOT NULL AND email=$2)", [phone, email || null]);
    if (exists.rowCount) return res.status(409).json({ error: "Phone or email already registered" });

    let referredBy = null;
    if (referralCode) {
      const ref = await pool.query("SELECT id FROM users WHERE referral_code=$1", [referralCode]);
      if (ref.rowCount) referredBy = ref.rows[0].id;
    }

    const hash = await bcrypt.hash(password, 12);
    let code = makeReferralCode();
    while ((await pool.query("SELECT 1 FROM users WHERE referral_code=$1", [code])).rowCount) code = makeReferralCode();

    const result = await pool.query(
      `INSERT INTO users(name,phone,email,password_hash,referral_code,referred_by)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id,name,phone,email,referral_code,balance`,
      [name, phone, email || null, hash, code, referredBy]
    );
    const user = result.rows[0];

    if (referredBy) {
      await pool.query(
        "INSERT INTO referrals(referrer_id,referred_user_id,commission) VALUES($1,$2,0)",
        [referredBy, user.id]
      );
    }

    res.json({ token: signUser(user), user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { phone, password } = req.body;
    const r = await pool.query("SELECT * FROM users WHERE phone=$1", [phone]);
    if (!r.rowCount) return res.status(401).json({ error: "Invalid login" });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid login" });

    res.json({
      token: signUser(user),
      user: {
        id:user.id,name:user.name,phone:user.phone,email:user.email,
        referral_code:user.referral_code,balance:user.balance
      }
    });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

app.get("/api/me", auth, async (req, res) => {
  const r = await pool.query(
    "SELECT id,name,phone,email,referral_code,balance,created_at FROM users WHERE id=$1",
    [req.auth.id]
  );
  res.json(r.rows[0] || null);
});

app.get("/api/jobs", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM jobs WHERE active=true ORDER BY id DESC");
  res.json(r.rows);
});

app.post("/api/jobs/:id/submit", auth, async (req, res) => {
  const { proof } = req.body;
  const job = await pool.query("SELECT id FROM jobs WHERE id=$1 AND active=true", [req.params.id]);
  if (!job.rowCount) return res.status(404).json({ error: "Job not found" });
  const r = await pool.query(
    "INSERT INTO job_submissions(job_id,user_id,proof) VALUES($1,$2,$3) RETURNING *",
    [req.params.id, req.auth.id, proof || ""]
  );
  res.json(r.rows[0]);
});

app.post("/api/deposits", auth, async (req, res) => {
  const { amount, method, transactionId } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "Invalid amount" });
  const r = await pool.query(
    `INSERT INTO deposits(user_id,amount,method,transaction_id)
     VALUES($1,$2,$3,$4) RETURNING *`,
    [req.auth.id, amount, method || "manual", transactionId || null]
  );
  res.json({ message: "Deposit request submitted for admin verification", deposit: r.rows[0] });
});

app.post("/api/withdrawals", auth, async (req, res) => {
  const { amount, method, accountNumber } = req.body;
  if (!amount || Number(amount) <= 0 || !accountNumber)
    return res.status(400).json({ error: "Invalid withdrawal request" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [req.auth.id]);
    if (!u.rowCount || Number(u.rows[0].balance) < Number(amount)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient balance" });
    }
    await client.query(
      "UPDATE users SET balance=balance-$1 WHERE id=$2",
      [amount, req.auth.id]
    );
    const r = await client.query(
      `INSERT INTO withdrawals(user_id,amount,method,account_number)
       VALUES($1,$2,$3,$4) RETURNING *`,
      [req.auth.id, amount, method || "bKash", accountNumber]
    );
    await client.query("COMMIT");
    res.json({ message: "Withdrawal request submitted", withdrawal: r.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Withdrawal failed" });
  } finally {
    client.release();
  }
});

app.get("/api/referrals", auth, async (req, res) => {
  const r = await pool.query(
    `SELECT r.id,r.commission,r.created_at,u.name,u.phone
     FROM referrals r JOIN users u ON u.id=r.referred_user_id
     WHERE r.referrer_id=$1 ORDER BY r.id DESC`,
    [req.auth.id]
  );
  res.json(r.rows);
});

/* Admin login */
app.post("/api/admin/login", async (req, res) => {
  const { email, password } = req.body;
  if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD)
    return res.status(401).json({ error: "Invalid admin credentials" });
  const token = jwt.sign({ role:"admin", email }, process.env.JWT_SECRET, { expiresIn:"12h" });
  res.json({ token });
});

app.get("/api/admin/users", adminAuth, async (req, res) => {
  const r = await pool.query(
    "SELECT id,name,phone,email,referral_code,balance,created_at FROM users ORDER BY id DESC"
  );
  res.json(r.rows);
});

app.get("/api/admin/deposits", adminAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT d.*,u.name,u.phone FROM deposits d JOIN users u ON u.id=d.user_id
     ORDER BY d.id DESC`
  );
  res.json(r.rows);
});

app.post("/api/admin/deposits/:id/approve", adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const d = await client.query("SELECT * FROM deposits WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!d.rowCount) return res.status(404).json({ error:"Deposit not found" });
    if (d.rows[0].status !== "pending") return res.status(400).json({ error:"Already processed" });

    await client.query("UPDATE deposits SET status='approved' WHERE id=$1", [req.params.id]);
    await client.query("UPDATE users SET balance=balance+$1 WHERE id=$2", [d.rows[0].amount,d.rows[0].user_id]);

    await client.query("COMMIT");
    res.json({ message:"Deposit approved" });
  } catch {
    await client.query("ROLLBACK");
    res.status(500).json({ error:"Approval failed" });
  } finally { client.release(); }
});

app.post("/api/admin/deposits/:id/reject", adminAuth, async (req, res) => {
  const r = await pool.query(
    "UPDATE deposits SET status='rejected' WHERE id=$1 AND status='pending' RETURNING *",
    [req.params.id]
  );
  res.json(r.rowCount ? {message:"Deposit rejected"} : {error:"Not found or already processed"});
});

app.get("/api/admin/withdrawals", adminAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT w.*,u.name,u.phone FROM withdrawals w JOIN users u ON u.id=w.user_id
     ORDER BY w.id DESC`
  );
  res.json(r.rows);
});

app.post("/api/admin/withdrawals/:id/approve", adminAuth, async (req, res) => {
  const r = await pool.query(
    "UPDATE withdrawals SET status='approved' WHERE id=$1 AND status='pending' RETURNING *",
    [req.params.id]
  );
  res.json(r.rowCount ? {message:"Withdrawal approved"} : {error:"Not found or already processed"});
});

app.post("/api/admin/withdrawals/:id/reject", adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const w = await client.query("SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!w.rowCount || w.rows[0].status !== "pending")
      return res.status(400).json({error:"Not found or already processed"});
    await client.query("UPDATE withdrawals SET status='rejected' WHERE id=$1", [req.params.id]);
    await client.query("UPDATE users SET balance=balance+$1 WHERE id=$2", [w.rows[0].amount,w.rows[0].user_id]);
    await client.query("COMMIT");
    res.json({message:"Withdrawal rejected and balance restored"});
  } catch {
    await client.query("ROLLBACK");
    res.status(500).json({error:"Reject failed"});
  } finally { client.release(); }
});

app.get("/api/admin/submissions", adminAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT s.*,j.title,j.reward,u.name,u.phone
     FROM job_submissions s
     JOIN jobs j ON j.id=s.job_id
     JOIN users u ON u.id=s.user_id
     ORDER BY s.id DESC`
  );
  res.json(r.rows);
});

app.post("/api/admin/submissions/:id/approve", adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const s = await client.query(
      "SELECT * FROM job_submissions WHERE id=$1 FOR UPDATE", [req.params.id]
    );
    if (!s.rowCount || s.rows[0].status !== "pending")
      return res.status(400).json({error:"Not found or already processed"});
    const job = await client.query("SELECT reward FROM jobs WHERE id=$1", [s.rows[0].job_id]);
    await client.query("UPDATE job_submissions SET status='approved' WHERE id=$1", [req.params.id]);
    await client.query("UPDATE users SET balance=balance+$1 WHERE id=$2", [job.rows[0].reward,s.rows[0].user_id]);
    await client.query("COMMIT");
    res.json({message:"Submission approved and reward credited"});
  } catch {
    await client.query("ROLLBACK");
    res.status(500).json({error:"Approval failed"});
  } finally { client.release(); }
});

app.post("/api/admin/submissions/:id/reject", adminAuth, async (req, res) => {
  const r = await pool.query(
    "UPDATE job_submissions SET status='rejected' WHERE id=$1 AND status='pending' RETURNING *",
    [req.params.id]
  );
  res.json(r.rowCount ? {message:"Submission rejected"} : {error:"Not found or already processed"});
});

app.post("/api/admin/jobs", adminAuth, async (req, res) => {
  const { title, description, reward } = req.body;
  if (!title || !description || Number(reward) < 0)
    return res.status(400).json({error:"Invalid job"});
  const r = await pool.query(
    "INSERT INTO jobs(title,description,reward) VALUES($1,$2,$3) RETURNING *",
    [title,description,reward]
  );
  res.json(r.rows[0]);
});

app.get("/api/admin/stats", adminAuth, async (req, res) => {
  const q = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM users"),
    pool.query("SELECT COALESCE(SUM(balance),0) AS balance FROM users"),
    pool.query("SELECT COUNT(*)::int AS count FROM deposits WHERE status='pending'"),
    pool.query("SELECT COUNT(*)::int AS count FROM withdrawals WHERE status='pending'"),
    pool.query("SELECT COUNT(*)::int AS count FROM job_submissions WHERE status='pending'")
  ]);
  res.json({
    users:q[0].rows[0].count,
    totalBalance:q[1].rows[0].balance,
    pendingDeposits:q[2].rows[0].count,
    pendingWithdrawals:q[3].rows[0].count,
    pendingSubmissions:q[4].rows[0].count
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`EarnHub API running on port ${PORT}`));